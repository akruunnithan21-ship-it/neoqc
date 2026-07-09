"""
matcher.py — Token-set fuzzy matcher for build-ticket text → catalog SKU.

Strategy: order-independent token matching.
  Build ticket may say:  "Ventus 2X RTX 4060 MSI 8GB OC"
  Catalog entry says:    "Msi Rtx 4060 Ventus 2X Black Oc 8Gb Graphics Card"

  We tokenize both, normalize, then score using:
    1. Intersection ratio  (how many ticket tokens appear in the catalog entry)
    2. Semantic weight     (model numbers / spec tokens score higher than generic words)
    3. Category gate       (only match within the right category)

  If confidence >= CONFIRM_THRESHOLD → auto-accepted.
  If confidence >= SUGGEST_THRESHOLD → shown as suggestion, requires staff confirm.
  Below SUGGEST_THRESHOLD → flagged for manual entry.

Usage (as a library):
    from matcher import Matcher
    m = Matcher.from_catalog_json("output/catalog.json")
    result = m.match("RTX 4060 Ventus 2X 8GB", category="gpu")
    print(result.sku, result.confidence, result.matched_name)

Usage (CLI — batch-match every spec field in a ticket):
    python matcher.py --ticket-id <id>
    python matcher.py --text "Ryzen 7 9800X3D" --category cpu
"""

import argparse
import io
import json
import re
import sys
from dataclasses import dataclass

if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
from pathlib import Path
from typing import Optional

CONFIRM_THRESHOLD = 0.82   # auto-accept above this
SUGGEST_THRESHOLD = 0.55   # show as suggestion above this

# Tokens that carry strong signal — model numbers, spec indicators
HIGH_WEIGHT_RE = re.compile(
    r"""
    \b(
        rtx|gtx|rx|arc|rdna|
        [0-9]{3,5}[a-z]*|     # model numbers: 4060, 9800x3d, rm1000x, b650m
        x3d|xt|ti|super|oc|
        ddr[45]?|cl[0-9]+|
        nvme|sata|m2|pcie|
        atx|itx|matx|eatx|
        [0-9]+gb|[0-9]+tb|[0-9]+w|[0-9]+mhz|
        amd|intel|nvidia|corsair|asus|msi|gigabyte|
        ryzen|core|threadripper|xeon|
        radeon|geforce
    )\b
    """,
    re.IGNORECASE | re.VERBOSE,
)

# Words that add almost no signal — ignore them when matching
NOISE_WORDS = {
    "desktop", "gaming", "processor", "graphics", "card", "memory",
    "drive", "internal", "external", "solid", "state", "hard", "disk",
    "supply", "unit", "power", "cabinet", "case", "cooler", "fan",
    "motherboard", "mainboard", "black", "white", "grey", "silver",
    "with", "and", "the", "for", "rgb", "argb", "led",
    "generation", "gen", "series",
}


def _tokenize(text: str) -> list[str]:
    text = text.lower()
    # Normalize wattage so "1000W", "1000 Watts", "1000w" all become "1000w"
    text = re.sub(r"(\d+)\s*w(?:att)?s?\b", r"\1w", text)
    # Normalize GB/TB so "16 GB" and "16GB" both become "16gb"
    text = re.sub(r"(\d+)\s*(gb|tb|mb)\b", r"\1\2", text)
    # Normalize MHz so "6000 MHz" → "6000mhz"
    text = re.sub(r"(\d+)\s*mhz\b", r"\1mhz", text)
    tokens = re.findall(r"[a-z0-9]+", text)
    return [t for t in tokens if len(t) >= 2 and t not in NOISE_WORDS]


def _token_weight(token: str) -> float:
    """Tokens matching high-signal patterns score 2×."""
    return 2.0 if HIGH_WEIGHT_RE.match(token) else 1.0


def _score(query_tokens: list[str], candidate_tokens: set[str]) -> float:
    """
    Weighted intersection score.
    = sum(weight(t) for t in query if t in candidate)
      / sum(weight(t) for t in query)
    Penalizes if the candidate is much longer (very generic entries).
    """
    if not query_tokens:
        return 0.0

    total_weight = sum(_token_weight(t) for t in query_tokens)
    matched_weight = sum(
        _token_weight(t) for t in query_tokens if t in candidate_tokens
    )

    base = matched_weight / total_weight if total_weight else 0.0

    # Length penalty: if candidate has many extra tokens the match is less precise
    extra = max(0, len(candidate_tokens) - len(query_tokens))
    penalty = extra * 0.015  # gentle — long product names shouldn't be harshly penalised
    return max(0.0, min(1.0, base - penalty))


@dataclass
class MatchResult:
    sku: Optional[str]
    matched_name: Optional[str]
    confidence: float
    category: Optional[str]
    price_inr: Optional[float]
    auto_accepted: bool
    needs_confirm: bool


class Matcher:
    def __init__(self, catalog: list[dict]):
        """
        catalog: list of dicts with keys name, sku, category, price_inr.
        SKU may be None for HTML-scraped entries; those still participate in
        matching but can't be used for Supabase lookup until confirmed.
        """
        self._entries = []
        for entry in catalog:
            name = entry.get("name", "")
            tokens = set(_tokenize(name))
            self._entries.append({
                "sku":       entry.get("sku"),
                "name":      name,
                "category":  entry.get("category", "other"),
                "price_inr": entry.get("price_inr"),
                "tokens":    tokens,
            })

    @classmethod
    def from_catalog_json(cls, path="output/catalog.json"):
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return cls(data)

    def match(
        self,
        query: str,
        category: Optional[str] = None,
        top_k: int = 5,
    ) -> MatchResult:
        """
        Find the best catalog entry for a free-text component name.

        Args:
            query:    The text from the build ticket (e.g. "RTX 4060 Ventus 2X 8GB")
            category: Optional hint (cpu/gpu/ram/…) to restrict the search pool.
                      If None, all categories are searched.
            top_k:    Return this many candidates (for UI suggestion lists).
        """
        q_tokens = _tokenize(query)
        if not q_tokens:
            return MatchResult(None, None, 0.0, None, None, False, False)

        pool = self._entries
        if category:
            pool = [e for e in pool if e["category"] == category]
        if not pool:
            pool = self._entries  # fall back to all if category filter is too tight

        scored = []
        for entry in pool:
            s = _score(q_tokens, entry["tokens"])
            if s > 0:
                scored.append((s, entry))

        scored.sort(key=lambda x: x[0], reverse=True)
        top = scored[:top_k]

        if not top:
            return MatchResult(None, None, 0.0, category, None, False, False)

        best_score, best_entry = top[0]
        return MatchResult(
            sku=best_entry["sku"],
            matched_name=best_entry["name"],
            confidence=round(best_score, 4),
            category=best_entry["category"],
            price_inr=best_entry["price_inr"],
            auto_accepted=best_score >= CONFIRM_THRESHOLD,
            needs_confirm=SUGGEST_THRESHOLD <= best_score < CONFIRM_THRESHOLD,
        )

    def match_build_specs(self, specs: dict) -> dict[str, MatchResult]:
        """
        Match all fields in a ticket's specs dict.
        specs example: {"cpu": "Ryzen 7 9800X3D", "gpu": "RTX 4080 Super", ...}
        Returns a dict of the same keys → MatchResult.
        """
        results = {}
        for field, text in specs.items():
            if not text:
                continue
            # Map common ticket field names to canonical categories
            cat = {
                "cpu": "cpu", "processor": "cpu",
                "gpu": "gpu", "graphics": "gpu",
                "mobo": "motherboard", "motherboard": "motherboard",
                "ram": "ram", "memory": "ram",
                "storage": "storage", "ssd": "storage", "hdd": "storage",
                "psu": "psu", "power_supply": "psu",
                "case": "case", "cabinet": "case",
                "cooler": "cooler", "cpu_cooler": "cooler",
            }.get(field.lower())
            results[field] = self.match(text, category=cat)
        return results


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Match component text to catalog SKU")
    parser.add_argument("--text", help="Free-text component name to match")
    parser.add_argument("--category", help="Hint: cpu/gpu/ram/storage/psu/case/cooler/motherboard")
    parser.add_argument("--catalog", default="output/catalog.json")
    parser.add_argument("--ticket-id", help="Match all spec fields from a Supabase ticket")
    args = parser.parse_args()

    m = Matcher.from_catalog_json(args.catalog)

    if args.text:
        result = m.match(args.text, category=args.category)
        print(f"\nQuery:      {args.text!r}")
        print(f"Category:   {args.category or '(any)'}")
        print(f"Best match: {result.matched_name}")
        print(f"SKU:        {result.sku}")
        print(f"Price:      ₹{result.price_inr}")
        print(f"Confidence: {result.confidence:.0%}")
        status = "AUTO-ACCEPT" if result.auto_accepted else ("NEEDS CONFIRM" if result.needs_confirm else "NO MATCH")
        print(f"Status:     {status}")
        return

    if args.ticket_id:
        try:
            from supabase import create_client
        except ImportError:
            sys.exit("pip install supabase")
        sb = create_client(
            "https://ggsxkhenzdhaachubrsc.supabase.co",
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
            ".eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdnc3hraGVuemRoYWFjaHVicnNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3MTEwNjEsImV4cCI6MjA5NzI4NzA2MX0"
            ".bDhUK-qJSgcBEcNdEdOaZGg5vsUF6jH2gbSRQaMhjBo",
        )
        row = sb.table("tickets").select("specs").eq("id", args.ticket_id).single().execute()
        specs = (row.data or {}).get("specs", {})
        if not specs:
            sys.exit(f"No specs found for ticket {args.ticket_id}")
        results = m.match_build_specs(specs)
        print(f"\nTicket {args.ticket_id} spec matching:")
        for field, r in results.items():
            status = ("✓" if r.auto_accepted else ("?" if r.needs_confirm else "✗"))
            print(f"  {status} {field:<12} → {r.matched_name or 'NO MATCH':<55} ({r.confidence:.0%})")
        return

    parser.print_help()


if __name__ == "__main__":
    main()
