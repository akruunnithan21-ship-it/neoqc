"""
benchmark_import.py — Fetch commercially-free reference benchmark scores.

LICENSE SUMMARY (checked 2026-07-08):
  PassMark (cpubenchmark.net / videocardbenchmark.net):
    Scores are free to display in commercial tools WITH attribution.
    Required: link back to passmark.com in any UI that shows the score.
    Source: https://www.passmark.com/legal/passmark-software-end-user-license-agreement/
    Section "Benchmark Charts / CPU Mark / G3D Mark" — embedding allowed.

  CPU-Monkey (cpu.userbenchmark.com) — NOT used. UserBenchmark scores are
    controversial (methodology bias) and their ToS restricts redistribution.

  GPU specs (TechPowerUp GPU DB):
    Publicly available spec data; no score data restrictions for non-competing tools.
    Used here only for VRAM/TDP cross-reference, not benchmark scores.

Outputs (saved to assets/benchmarks/):
  cpu_passmark.json   — { "<CPU name>": { "passmark_score": N, "rank": N }, … }
  gpu_passmark.json   — { "<GPU name>": { "g3d_score": N, "rank": N }, … }

Then run:
  python benchmark_import.py --load-supabase
to push into component_performance table (source='reference').
"""

import argparse
import json
import re
import sys
import time
from pathlib import Path

# reconfigure(), never a new TextIOWrapper — see pcstudio_import.py's header
# comment about the shared-buffer GC bug when two scripts wrap stdout.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError:
    raise SystemExit("pip install requests beautifulsoup4 lxml")

HEADERS = {
    "User-Agent": "NeoQC-BenchmarkBot/1.0 (internal; contact akruunnithan21@gmail.com)",
    "Accept-Language": "en-US,en;q=0.9",
}
DELAY = 1.5
OUT_DIR = Path("assets/benchmarks")

# ─── PassMark CPU ─────────────────────────────────────────────────────────────

CPU_LIST_URL  = "https://www.cpubenchmark.net/cpu_list.php"

CPU_MEGA_PAGE = "https://www.cpubenchmark.net/CPU_mega_page.html"
CPU_DATA_URL  = "https://www.cpubenchmark.net/data/"

def fetch_passmark_cpu():
    """Fetch the full CPU Mark list.

    Primary source is the mega-page JSON endpoint (/data/): cpu_list.php was
    discovered on 2026-07-09 to list ONLY Intel CPUs (PassMark split the page),
    which silently produced an AMD-less reference set. The JSON endpoint
    returns everything (~6,700 CPUs incl. all Ryzen) but needs session cookies
    from the mega page first. Falls back to the old cpu_list.php table parse.
    """
    print("[CPU] Fetching PassMark CPU list (mega-page JSON) …")
    time.sleep(DELAY)
    results = {}

    try:
        s = requests.Session()
        s.headers.update(HEADERS)
        s.get(CPU_MEGA_PAGE, timeout=30)  # establish session cookies
        r = s.get(CPU_DATA_URL, headers={
            "Referer": CPU_MEGA_PAGE,
            "X-Requested-With": "XMLHttpRequest",
        }, timeout=60)
        if r.status_code == 200:
            rows = (r.json() or {}).get("data", [])
            for row in rows:
                name = (row.get("name") or "").strip()
                score_text = str(row.get("cpumark") or "").replace(",", "")
                if not name or not score_text.isdigit():
                    continue
                entry = {
                    "passmark_score": int(score_text),
                    "rank": row.get("rank") or len(results) + 1,
                }
                # "thread" = PassMark single-thread rating. Optional but
                # near-universal in the mega-page data; ppi.py blends it into
                # CPU scoring per use-case (fixes X3D undervaluation).
                st_text = str(row.get("thread") or "").replace(",", "")
                if st_text.isdigit():
                    entry["single_thread_score"] = int(st_text)
                results[name] = entry
    except (requests.exceptions.RequestException, ValueError) as e:
        print(f"  [CPU] mega-page JSON failed ({e}) — falling back to cpu_list.php")

    # Sanity gate: the JSON path must include AMD, otherwise treat as failed.
    if results and any("Ryzen" in n for n in results):
        print(f"  [CPU] {len(results)} CPUs (mega-page JSON)")
        return results
    if results:
        print("  [CPU] WARNING: mega-page data had no Ryzen entries — falling back")
        results = {}

    # Fallback: legacy cpu_list.php table parse (known Intel-only as of 2026-07)
    time.sleep(DELAY)
    r = requests.get(CPU_LIST_URL, headers=HEADERS, timeout=30)
    if r.status_code != 200:
        print(f"  [CPU] HTTP {r.status_code} — failed")
        return {}

    soup = BeautifulSoup(r.text, "lxml")
    table = (
        soup.find("table", id="cputable")
        or soup.find("table", id="chart")
        or soup.find("table", {"class": re.compile(r"cpulist|chart", re.I)})
    )
    if table:
        for row in table.find_all("tr")[1:]:  # skip header
            cells = row.find_all("td")
            if len(cells) < 2:
                continue
            name = cells[0].get_text(strip=True)
            score_text = cells[1].get_text(strip=True).replace(",", "")
            try:
                score = int(score_text)
            except ValueError:
                continue
            results[name] = {"passmark_score": score, "rank": len(results) + 1}

    print(f"  [CPU] {len(results)} CPUs (cpu_list.php fallback — may lack AMD!)")
    return results


# ─── PassMark GPU ─────────────────────────────────────────────────────────────

GPU_LIST_URL = "https://www.videocardbenchmark.net/gpu_list.php"

def fetch_passmark_gpu():
    print("[GPU] Fetching PassMark G3D GPU list …")
    time.sleep(DELAY)
    r = requests.get(GPU_LIST_URL, headers=HEADERS, timeout=30)
    if r.status_code != 200:
        print(f"  [GPU] HTTP {r.status_code} — failed")
        return {}

    soup = BeautifulSoup(r.text, "lxml")
    results = {}

    # PassMark's GPU list page reuses id="cputable" / class="cpulist" (same template)
    table = (
        soup.find("table", id="cputable")
        or soup.find("table", id="gputable")
        or soup.find("table", {"class": re.compile(r"cpulist|gpulist|chart", re.I)})
    )

    if table:
        for row in table.find_all("tr")[1:]:
            cells = row.find_all("td")
            if len(cells) < 2:
                continue
            name = cells[0].get_text(strip=True)
            score_text = cells[1].get_text(strip=True).replace(",", "")
            try:
                score = int(score_text)
            except ValueError:
                continue
            rank = len(results) + 1
            results[name] = {"g3d_score": score, "rank": rank}
    else:
        for script in soup.find_all("script"):
            text = script.string or ""
            matches = re.findall(r'\["([^"]+)",\s*(\d+),\s*"[^"]*"\]', text)
            if matches:
                for i, (name, score) in enumerate(matches, 1):
                    results[name] = {"g3d_score": int(score), "rank": i}
                break

    print(f"  [GPU] {len(results)} GPUs")
    return results


# ─── Supabase loader ──────────────────────────────────────────────────────────

SUPABASE_URL = "https://ggsxkhenzdhaachubrsc.supabase.co"
SUPABASE_KEY = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
    ".eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdnc3hraGVuemRoYWFjaHVicnNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3MTEwNjEsImV4cCI6MjA5NzI4NzA2MX0"
    ".bDhUK-qJSgcBEcNdEdOaZGg5vsUF6jH2gbSRQaMhjBo"
)

def push_to_supabase(cpu_data, gpu_data):
    try:
        from supabase import create_client
    except ImportError:
        raise SystemExit("pip install supabase")

    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    sb = create_client(SUPABASE_URL, SUPABASE_KEY)
    rows = []

    for name, data in cpu_data.items():
        rows.append({
            "sku":          _name_to_sku(name),
            "benchmark":    "passmark-cpu",
            "score":        data["passmark_score"],
            "source":       "reference",
            "source_detail": "PassMark CPU Mark / cpubenchmark.net (attribution required)",
            "tested_at":    None,
            "recorded_at":  now,
        })
        if data.get("single_thread_score"):
            rows.append({
                "sku":          _name_to_sku(name),
                "benchmark":    "passmark-cpu-st",
                "score":        data["single_thread_score"],
                "source":       "reference",
                "source_detail": "PassMark CPU Single Thread / cpubenchmark.net (attribution required)",
                "tested_at":    None,
                "recorded_at":  now,
            })

    for name, data in gpu_data.items():
        rows.append({
            "sku":          _name_to_sku(name),
            "benchmark":    "passmark-g3d",
            "score":        data["g3d_score"],
            "source":       "reference",
            "source_detail": "PassMark G3D Mark / videocardbenchmark.net (attribution required)",
            "tested_at":    None,
            "recorded_at":  now,
        })

    # De-duplicate by the (sku, benchmark, source) primary key: different
    # PassMark display names can normalize to the same REF-<slug>, and Postgres
    # rejects an upsert batch that touches the same key twice. Keep the highest
    # score on collision (best-known figure for that part).
    deduped = {}
    pre_dedup = len(rows)
    for row in rows:
        key = (row["sku"], row["benchmark"], row["source"])
        if key not in deduped or row["score"] > deduped[key]["score"]:
            deduped[key] = row
    rows = list(deduped.values())
    collisions = pre_dedup - len(rows)
    if collisions:
        print(f"  ({collisions} duplicate reference-SKUs collapsed, kept highest score)")

    print(f"Upserting {len(rows)} benchmark rows …")
    for i in range(0, len(rows), 200):
        sb.table("component_performance").upsert(
            rows[i:i+200],
            on_conflict="sku,benchmark,source"
        ).execute()
        print(f"  … {min(i+200, len(rows))}/{len(rows)}", end="\r")
    print()
    print("Done.")


def _name_to_sku(name):
    """Derive a stable reference SKU from a benchmark name.
    These won't match pcstudio SKUs directly — the matcher bridges them.
    Format: REF-<normalized-name>
    """
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return f"REF-{slug[:80]}"


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--load-supabase", action="store_true",
                        help="Push scores into component_performance table")
    parser.add_argument("--cpu-only", action="store_true")
    parser.add_argument("--gpu-only", action="store_true")
    args = parser.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    cpu_data, gpu_data = {}, {}

    if not args.gpu_only:
        cpu_data = fetch_passmark_cpu()
        if cpu_data:
            path = OUT_DIR / "cpu_passmark.json"
            path.write_text(json.dumps(cpu_data, indent=2, ensure_ascii=False), encoding="utf-8")
            print(f"  Saved → {path}")
        else:
            print("  [CPU] No data fetched — site structure may have changed.")

    if not args.cpu_only:
        gpu_data = fetch_passmark_gpu()
        if gpu_data:
            path = OUT_DIR / "gpu_passmark.json"
            path.write_text(json.dumps(gpu_data, indent=2, ensure_ascii=False), encoding="utf-8")
            print(f"  Saved → {path}")
        else:
            print("  [GPU] No data fetched — site structure may have changed.")

    if args.load_supabase and (cpu_data or gpu_data):
        push_to_supabase(cpu_data, gpu_data)

    total = len(cpu_data) + len(gpu_data)
    print(f"\nBenchmark import complete: {len(cpu_data)} CPUs + {len(gpu_data)} GPUs = {total} scores")
    print("Attribution required when displaying: PassMark® / www.passmark.com")


if __name__ == "__main__":
    main()
