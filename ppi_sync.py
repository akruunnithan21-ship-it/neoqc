"""
ppi_sync.py — Compute the Price-to-Performance Index for a ticket and store it.

Bridges the whole data layer end-to-end:
  1. Load the ticket's free-text specs from Supabase (tickets.specs).
  2. Resolve each spec to a catalog SKU with matcher.py (token-set fuzzy match
     against component_prices).
  3. Attach PassMark reference scores: component_performance uses REF-<slug>
     SKUs derived from PassMark names, NOT pcstudio SKUs — so each priced
     cpu/gpu in the relevant price band is name-matched to its PassMark entry
     (assets/benchmarks/*.json) to build the benchmark_scores dict ppi() needs.
  4. Call ppi() (pure function, ppi.py) and upsert the result into ticket_ppi.

The Electron app and customer dashboard only READ ticket_ppi — no PPI math
exists in JavaScript anywhere.

Usage:
    python ppi_sync.py --ticket-id <id>
    python ppi_sync.py --ticket-id <id> --use-case gaming-1440p --use-case streaming
    python ppi_sync.py --ticket-id <id> --dry-run     # print, don't write
"""

import argparse
import io
import json
import sys
from pathlib import Path

# matcher.py re-wraps sys.stdout at import time; creating our own TextIOWrapper
# here too would leave an orphaned wrapper whose GC closes the shared buffer.
# reconfigure() mutates in place instead — safe alongside matcher's wrap.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from matcher import Matcher, _score, _tokenize
from ppi import ppi, USE_CASE_WEIGHTS

try:
    from supabase import create_client
except ImportError:
    raise SystemExit("pip install supabase")

SUPABASE_URL = "https://ggsxkhenzdhaachubrsc.supabase.co"
SUPABASE_KEY = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
    ".eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdnc3hraGVuemRoYWFjaHVicnNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3MTEwNjEsImV4cCI6MjA5NzI4NzA2MX0"
    ".bDhUK-qJSgcBEcNdEdOaZGg5vsUF6jH2gbSRQaMhjBo"
)

BENCH_DIR = Path("assets/benchmarks")

# Legacy / UI-shorthand use-case names → canonical taxonomy keys
USE_CASE_ALIASES = {
    "gaming": "gaming-1440p",
    "editing": "video-editing",
    "renders": "cad-3d",
    "general": "office",
}


def _load_component_prices(sb) -> dict:
    """component_prices → {sku: {name, category, price_inr}} (paged)."""
    out = {}
    offset = 0
    while True:
        rows = (
            sb.table("component_prices")
            .select("sku,name,category,price_inr")
            .range(offset, offset + 999)
            .execute()
        ).data or []
        for r in rows:
            out[r["sku"]] = {
                "name": r["name"],
                "category": r["category"],
                "price_inr": float(r["price_inr"]) if r["price_inr"] is not None else None,
            }
        if len(rows) < 1000:
            break
        offset += 1000
    return out


def _passmark_matchers():
    """Load the PassMark name lists, pre-tokenized for the reverse-direction
    bridge match (see _bridge_match below)."""
    cpu_data = json.loads((BENCH_DIR / "cpu_passmark.json").read_text(encoding="utf-8"))
    gpu_data = json.loads((BENCH_DIR / "gpu_passmark.json").read_text(encoding="utf-8"))

    def prepared(data):
        return [(name, _tokenize(name)) for name in data], data

    cpu_tok, cpu_entries = prepared(cpu_data)
    gpu_tok, gpu_entries = prepared(gpu_data)
    return {"cpu": (cpu_tok, cpu_entries), "gpu": (gpu_tok, gpu_entries)}


def _bridge_match(retail_name: str, pm_tokenized) -> tuple[str | None, float]:
    """
    Match a RETAIL catalog name to a PassMark reference name.

    Direction matters: Matcher.match() scores how much of the QUERY the
    candidate covers — right for "technician types short text, catalog has the
    long name", but exactly backwards here. Retail names are long ("Zotac RTX
    5070 Ti AMP Extreme Infinity 16Gb Graphics Card") and PassMark names are
    short ("GeForce RTX 5070 Ti"), so query-coverage dilutes below the 0.55
    threshold and strong builds ended up with NO benchmark score at all
    (index 0.0 — the 9950X/5070 Ti field bug, 2026-07-11). Score instead by
    how much of the REFERENCE name appears inside the retail name.
    """
    q_set = set(_tokenize(retail_name))
    if not q_set:
        return None, 0.0
    best_name, best_score = None, 0.0
    for pm_name, pm_tokens in pm_tokenized:
        if not pm_tokens:
            continue
        s = _score(pm_tokens, q_set)
        if s > best_score:
            best_score, best_name = s, pm_name
    return best_name, best_score


def _benchmark_scores_for_pool(component_prices, build_specs, price_band_pct):
    """
    Name-match PassMark scores for every priced cpu/gpu inside the build's
    price bands (plus the build's own components). Returns
    {sku: {"passmark-cpu": n, "passmark-cpu-st": n?}} for CPUs (single-thread
    is included whenever cpu_passmark.json has it — ppi.py's use-case-aware
    blend needs it) and {sku: {"passmark-g3d": n}} for GPUs.
    """
    pm = _passmark_matchers()
    scores: dict[str, dict] = {}

    for category, bench_key in (("cpu", "passmark-cpu"), ("gpu", "passmark-g3d")):
        own_sku = build_specs.get(category)
        own = component_prices.get(own_sku) if own_sku else None
        pm_tokenized, name_entries = pm[category]

        # candidate pool: own component + anything in its price band
        candidates = []
        if own:
            candidates.append((own_sku, own))
            if own.get("price_inr"):
                lo = own["price_inr"] * (1 - price_band_pct)
                hi = own["price_inr"] * (1 + price_band_pct)
                candidates += [
                    (sku, e) for sku, e in component_prices.items()
                    if e["category"] == category
                    and e.get("price_inr") is not None
                    and lo <= e["price_inr"] <= hi
                    and sku != own_sku
                ]

        for sku, entry in candidates:
            if sku in scores:
                continue
            pm_name, confidence = _bridge_match(entry["name"], pm_tokenized)
            if pm_name and confidence >= 0.55:
                bench_entry = name_entries[pm_name]
                if category == "cpu":
                    scores[sku] = {bench_key: float(bench_entry["passmark_score"])}
                    if bench_entry.get("single_thread_score"):
                        scores[sku]["passmark-cpu-st"] = float(bench_entry["single_thread_score"])
                else:
                    scores[sku] = {bench_key: float(bench_entry["g3d_score"])}
    return scores


def main():
    ap = argparse.ArgumentParser(description="Compute + store PPI for a ticket")
    ap.add_argument("--ticket-id", required=True)
    ap.add_argument("--use-case", action="append", default=[],
                    help="Canonical use-case key (repeatable). Defaults to ticket's stored use-case or 'office'.")
    ap.add_argument("--price-band-pct", type=float, default=0.15)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    sb = create_client(SUPABASE_URL, SUPABASE_KEY)

    # 1. Ticket specs
    row = sb.table("tickets").select("specs,diagnostics").eq("id", args.ticket_id).single().execute()
    ticket = row.data or {}
    specs = ticket.get("specs") or {}
    if not specs:
        sys.exit(f"Ticket {args.ticket_id} has no specs — nothing to score.")
    print(f"Ticket {args.ticket_id}: specs = { {k: (v or '')[:40] for k, v in specs.items()} }")

    # Resolve use-cases: CLI > ticket.diagnostics.useCase > default office
    flags_extra = []
    use_cases = [USE_CASE_ALIASES.get(u, u) for u in args.use_case]
    if not use_cases:
        stored = (ticket.get("diagnostics") or {}).get("useCase")
        if stored:
            use_cases = [USE_CASE_ALIASES.get(stored, stored)]
    use_cases = [u for u in use_cases if u in USE_CASE_WEIGHTS]
    if not use_cases:
        use_cases = ["office"]
        flags_extra.append("Use-case not set for this ticket — scored against 'office' defaults")
    print(f"Use-cases: {use_cases}")

    # 2. Catalog + matching
    print("Loading component_prices from Supabase …")
    component_prices = _load_component_prices(sb)
    print(f"  {len(component_prices)} SKUs")

    matcher = Matcher([
        {"sku": sku, **entry} for sku, entry in component_prices.items()
    ])
    # Only actual component fields participate. Tickets also carry metadata in
    # specs (os / windowsKey / windowsActivationState / coolerType / igpu) that
    # used to be fuzzy-matched anyway — producing nonsense matches ("Windows" →
    # an MSI laptop at 84%) and noise flags on the customer-facing report.
    FIELD_CATEGORY = {
        "cpu": "cpu", "gpu": "gpu", "ram": "ram", "storage": "storage",
        "psu": "psu", "case": "case", "mobo": "motherboard",
        "motherboard": "motherboard", "cooler": "cooler", "coolerModel": "cooler",
    }
    build_specs = {}
    for field, text in specs.items():
        category = FIELD_CATEGORY.get(field)
        if not text or not category:
            continue
        m = matcher.match(text, category=category)
        if m.sku and m.confidence >= 0.55:
            build_specs[category] = m.sku
            print(f"  {field:<10} {text[:38]:<40} → {m.matched_name[:44]} ({m.confidence:.0%})")
        else:
            flags_extra.append(f"{field}: '{text[:40]}' not matched to catalog (best {m.confidence:.0%})")
            print(f"  {field:<10} {text[:38]:<40} → NO MATCH ({m.confidence:.0%})")

    if not build_specs:
        sys.exit("No spec matched the catalog — cannot compute PPI.")

    # 3. Benchmark scores (PassMark REF bridge)
    print("Matching PassMark scores for the price-band pools …")
    benchmark_scores = _benchmark_scores_for_pool(component_prices, build_specs, args.price_band_pct)
    print(f"  {len(benchmark_scores)} components scored")

    # 4. Compute + store
    result = ppi(build_specs, component_prices, benchmark_scores, use_cases, args.price_band_pct)
    all_flags = result.flags + flags_extra

    print(f"\nPPI index:          {result.index}")
    print(f"Customer fit score: {result.customer_fit_score}")
    print(f"Per-component:      {result.per_component_scores}")
    for f in all_flags:
        print(f"  ⚠ {f}")

    payload = {
        "ticket_id": args.ticket_id,
        "use_cases": use_cases,
        "price_band_pct": args.price_band_pct,
        "index": result.index,
        "customer_fit_score": result.customer_fit_score,
        "per_component_scores": result.per_component_scores,
        "in_range_comparisons": {
            cat: [
                {"sku": e.sku, "name": e.name, "price_inr": e.price_inr,
                 "score": e.score, "delta_vs_own": e.delta_vs_own}
                for e in entries
            ]
            for cat, entries in result.in_range_comparisons.items()
        },
        "flags": all_flags,
        "source_note": "ppi.py v2 (ratio-to-best in price band; single-thread-aware CPU blend; unscored categories excluded from index)",
    }

    if args.dry_run:
        print("\n[dry-run] Would upsert into ticket_ppi:")
        print(json.dumps(payload, indent=2)[:1500])
        return

    sb.table("ticket_ppi").upsert(payload, on_conflict="ticket_id").execute()
    print(f"\nStored in ticket_ppi for {args.ticket_id}.")


if __name__ == "__main__":
    main()
