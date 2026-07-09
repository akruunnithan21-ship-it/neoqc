"""
supabase_loader.py — Load output/catalog.json into Supabase.

Behaviour:
  • Upserts on SKU into component_prices (updates price + fetched_at if changed).
  • Appends a row to price_history whenever the price actually changes (or it's
    the first time we've seen a SKU).
  • Skips rows with null SKU or category == 'other'.

Usage:
    python supabase_loader.py                       # loads output/catalog.json
    python supabase_loader.py --file path/to/f.json
    python supabase_loader.py --dry-run             # print what would happen, no writes
"""

import argparse
import io
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

# Force UTF-8 on Windows consoles so ₹ doesn't crash cp1252 stdout
if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

try:
    from supabase import create_client
except ImportError:
    raise SystemExit("pip install supabase")

# ─── Config ───────────────────────────────────────────────────────────────────

SUPABASE_URL = "https://ggsxkhenzdhaachubrsc.supabase.co"
SUPABASE_KEY = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
    ".eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdnc3hraGVuemRoYWFjaHVicnNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3MTEwNjEsImV4cCI6MjA5NzI4NzA2MX0"
    ".bDhUK-qJSgcBEcNdEdOaZGg5vsUF6jH2gbSRQaMhjBo"
)

BATCH_SIZE = 100
SKIP_CATEGORIES = {"other"}

# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", default="output/catalog.json")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    catalog_path = Path(args.file)
    if not catalog_path.exists():
        sys.exit(f"Not found: {catalog_path}")

    records = json.loads(catalog_path.read_text(encoding="utf-8"))
    print(f"Loaded {len(records)} records from {catalog_path}")

    # Filter out useless rows
    usable = [r for r in records
              if r.get("sku") and r.get("category") not in SKIP_CATEGORIES]
    skipped = len(records) - len(usable)
    print(f"  Usable (have SKU, not 'other'): {len(usable)}  |  Skipped: {skipped}")

    if args.dry_run:
        print("\n[dry-run] First 5 rows that would be upserted:")
        for r in usable[:5]:
            print(f"  {r['sku']:<40} {r['category']:<12} ₹{r['price_inr']}")
        return

    sb = create_client(SUPABASE_URL, SUPABASE_KEY)

    # Fetch existing prices so we can detect actual changes
    existing = {}
    print("Fetching existing SKUs from Supabase …")
    offset = 0
    while True:
        batch = (
            sb.table("component_prices")
            .select("sku,price_inr")
            .range(offset, offset + 999)
            .execute()
        )
        rows = batch.data or []
        for row in rows:
            existing[row["sku"]] = row["price_inr"]
        if len(rows) < 1000:
            break
        offset += 1000
    print(f"  {len(existing)} SKUs already in DB")

    # Build upsert payload and history inserts
    upsert_rows = []
    history_rows = []
    now = datetime.now(timezone.utc).isoformat()
    zero_price_flagged = 0

    for r in usable:
        sku = r["sku"]
        new_price = r.get("price_inr")
        # ₹0 = out-of-stock / no price listed. Store as NULL (price-unknown) so
        # these components still exist (SKU/name/category) but are excluded from
        # PPI price-band comparisons — a real component is never worth ₹0.
        if new_price == 0:
            new_price = None
            zero_price_flagged += 1
        row = {
            "sku":           sku,
            "name":          r["name"],
            "category":      r["category"],
            "price_inr":     new_price,
            "url":           r.get("url"),
            "source":        "pcstudio.in",
            "source_method": r.get("source_method"),
            "fetched_at":    r.get("fetched_at") or now,
            "updated_at":    now,
        }
        upsert_rows.append(row)

        # Log to history if: new SKU, or price changed
        old_price = existing.get(sku)
        if old_price is None or float(old_price or 0) != float(new_price or 0):
            history_rows.append({
                "sku":           sku,
                "price_inr":     new_price,
                "source":        "pcstudio.in",
                "source_method": r.get("source_method"),
                "fetched_at":    r.get("fetched_at") or now,
                "recorded_at":   now,
            })

    print(f"  {zero_price_flagged} ₹0 items stored as price-unknown (NULL).")
    print(f"\nUpserting {len(upsert_rows)} rows into component_prices …")
    _batch_upsert(sb, "component_prices", upsert_rows, conflict_col="sku")

    print(f"Inserting {len(history_rows)} price_history rows (new SKUs + changes) …")
    _batch_insert(sb, "price_history", history_rows)

    print(f"\nDone. component_prices: {len(upsert_rows)} upserted, "
          f"price_history: {len(history_rows)} new entries.")


def _batch_upsert(sb, table, rows, conflict_col):
    for i in range(0, len(rows), BATCH_SIZE):
        batch = rows[i:i + BATCH_SIZE]
        sb.table(table).upsert(batch, on_conflict=conflict_col).execute()
        print(f"  … {min(i + BATCH_SIZE, len(rows))}/{len(rows)}", end="\r")
    print()


def _batch_insert(sb, table, rows):
    if not rows:
        return
    for i in range(0, len(rows), BATCH_SIZE):
        batch = rows[i:i + BATCH_SIZE]
        sb.table(table).insert(batch).execute()
        print(f"  … {min(i + BATCH_SIZE, len(rows))}/{len(rows)}", end="\r")
    print()


if __name__ == "__main__":
    main()
