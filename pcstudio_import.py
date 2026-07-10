"""
pcstudio_import.py — Price catalog importer for pcstudio.in + fallback retailers.

PRIMARY SOURCE: pcstudio.in (our supplier — scraping is authorised).
FALLBACK SOURCES: mdcomputers.in, vedantcomputers.com, primeabgb.com
  — used only when a component from a build ticket is NOT found in pcstudio's catalog.
  — fallback sources are labelled with source='fallback-<site>' so the QC report
    can show provenance clearly.

3-TIER FALLBACK (within pcstudio.in):
  Tier 1: WooCommerce REST API  (/wp-json/wc/v3/products)
           — requires consumer_key/consumer_secret (leave blank to skip)
  Tier 2: Product sitemap + JSON-LD extraction  ← this is what works
  Tier 3: Category HTML scraping                ← last resort

Output:
  output/catalog.json          — full record list (one dict per product)
  output/catalog.csv           — same, flat CSV
  output/import_report.txt     — summary (totals, per-category, tier used)

CLI:
  python pcstudio_import.py --limit 50           # smoke test
  python pcstudio_import.py                      # full pcstudio run
  python pcstudio_import.py --fallback "RTX 4090 Founders Edition"
                                                 # search fallback sites for one item

Each record:
  {
    "name": str,
    "category": str,
    "price_inr": float|null,
    "sku": str|null,
    "url": str,
    "fetched_at": ISO-8601,
    "source": "pcstudio.in" | "mdcomputers.in" | "vedantcomputers.com" | "primeabgb.com",
    "source_method": "woocommerce-api" | "sitemap-jsonld" | "html-scrape" | "fallback-search"
  }
"""

import sys
# Force UTF-8 on Windows consoles so ₹ / ⚠ don't crash cp1252 stdout.
# reconfigure() mutates in place rather than replacing sys.stdout with a new
# TextIOWrapper — matcher.py (imported below) does the same UTF-8 fix, and
# two independent wrappers around the same buffer causes the second one's
# garbage collection to close the buffer out from under the first ("I/O
# operation on closed file").
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import argparse
import csv
import json
import re
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError:
    raise SystemExit(
        "Missing deps. Run:\n"
        "  pip install requests beautifulsoup4 lxml"
    )

# Reused for consolidate_and_upsert()'s cross-site listing clustering — same
# token-weighted scorer used everywhere else in this codebase (ppi_sync.py,
# shared/matcher.js).
from matcher import SUGGEST_THRESHOLD, _score, _tokenize  # noqa: E402

# ─── Config ───────────────────────────────────────────────────────────────────

BASE_URL = "https://pcstudio.in"
REQUEST_DELAY = 1.2      # seconds between HTTP requests (be polite)
REQUEST_TIMEOUT = 20     # seconds
RETRY_MAX = 3            # total attempts per URL before giving up (survives transient DNS/network blips)
RETRY_BACKOFF = 2.0      # base seconds for exponential backoff between retries (2s, 4s, …)
CHECKPOINT_EVERY = 100   # flush catalog.json every N products so a mid-run drop never loses progress

HEADERS = {
    "User-Agent": "NeoQC-PriceIndexBot/1.0 (internal tool; contact akruunnithan21@gmail.com)",
    "Accept-Language": "en-IN,en;q=0.9",
}

# WooCommerce credentials — leave empty to skip Tier 1
WC_CONSUMER_KEY    = ""
WC_CONSUMER_SECRET = ""

# Category slug → canonical name mapping (extend as needed)
CATEGORY_SLUGS = {
    # Try multiple possible slug variants per category
    "cpu": [
        "processor", "processors", "cpu", "cpus",
        "amd-processors", "intel-processors",
    ],
    "gpu": [
        "graphics-card", "graphics-cards", "gpu", "vga",
        "nvidia-graphics-card", "amd-graphics-card",
    ],
    "motherboard": [
        "motherboard", "motherboards", "mobo",
    ],
    "ram": [
        "ram", "memory", "desktop-ram", "ddr4-ram", "ddr5-ram",
    ],
    "storage": [
        "solid-state-drive", "ssd", "hard-disk-drive", "hdd",
        "nvme-ssd", "sata-ssd", "storage",
    ],
    "psu": [
        "power-supply", "psu", "smps", "power-supply-unit",
    ],
    "case": [
        "cabinet", "cabinets", "case", "cases", "computer-case",
        "pc-case", "cpu-cabinet",
    ],
    "cooler": [
        "cpu-cooler", "cpu-coolers", "cooler", "cooling",
        "air-cooler", "liquid-cooler", "aio-cooler",
    ],
}

OUTPUT_DIR = Path("output")

# ─── HTTP helpers ─────────────────────────────────────────────────────────────

session = requests.Session()
session.headers.update(HEADERS)

def get(url, params=None, *, tier_label=""):
    """GET with delay, timeout, retry-with-backoff, and error reporting.

    Retries transient network failures (DNS/getaddrinfo, read timeouts,
    connection resets) up to RETRY_MAX times with exponential backoff, so a
    brief connectivity blip during a long unattended run no longer silently
    drops a product. Only returns None after all attempts are exhausted.
    """
    time.sleep(REQUEST_DELAY)
    last_err = None
    for attempt in range(RETRY_MAX):
        try:
            r = session.get(url, params=params, timeout=REQUEST_TIMEOUT, allow_redirects=True)
            print(f"  [{tier_label}] {r.status_code} {url[:90]}")
            return r
        except requests.exceptions.RequestException as e:
            last_err = e
            if attempt < RETRY_MAX - 1:
                wait = RETRY_BACKOFF * (2 ** attempt)
                print(f"  [{tier_label}] retry {attempt + 1}/{RETRY_MAX - 1} in {wait:.0f}s — {url[:70]}: {type(e).__name__}")
                time.sleep(wait)
    print(f"  [{tier_label}] ERROR {url[:80]}: {last_err}")
    return None

# ─── Tier 1: WooCommerce REST API ─────────────────────────────────────────────

def fetch_via_wc_api(limit=None):
    """
    Returns (records, success_bool).
    Requires WC_CONSUMER_KEY / WC_CONSUMER_SECRET — leaves empty to auto-skip.
    """
    if not WC_CONSUMER_KEY:
        print("[Tier 1] WooCommerce API credentials not set — skipping.")
        return [], False

    print("[Tier 1] Trying WooCommerce REST API …")
    records = []
    page = 1
    per_page = 100

    while True:
        r = get(
            f"{BASE_URL}/wp-json/wc/v3/products",
            params={"per_page": per_page, "page": page,
                    "consumer_key": WC_CONSUMER_KEY,
                    "consumer_secret": WC_CONSUMER_SECRET},
            tier_label="Tier1-API",
        )
        if r is None or r.status_code in (401, 403):
            print(f"[Tier 1] Blocked (status {r.status_code if r else 'no-response'}).")
            return [], False
        if r.status_code != 200:
            print(f"[Tier 1] Unexpected status {r.status_code}.")
            return [], False

        try:
            products = r.json()
        except Exception:
            return [], False

        if not products:
            break

        for p in products:
            cat_slug = _wc_api_category(p)
            price_str = p.get("price") or p.get("regular_price") or ""
            records.append({
                "name": p.get("name", "").strip(),
                "category": cat_slug,
                "price_inr": _parse_price(price_str),
                "sku": p.get("sku") or None,
                "url": p.get("permalink", ""),
                "fetched_at": _now(),
                "source_method": "woocommerce-api",
            })

        if limit and len(records) >= limit:
            records = records[:limit]
            break

        if len(products) < per_page:
            break
        page += 1

    print(f"[Tier 1] Got {len(records)} products via API.")
    return records, True


def _wc_api_category(p):
    cats = [c.get("slug", "") for c in p.get("categories", [])]
    for slug in cats:
        for canonical, variants in CATEGORY_SLUGS.items():
            if slug in variants or slug == canonical:
                return canonical
    return cats[0] if cats else "other"

# ─── Tier 2: Sitemap + JSON-LD ────────────────────────────────────────────────

SITEMAP_CANDIDATES = [
    "/sitemap.xml",
    "/sitemap_index.xml",
    "/wp-sitemap.xml",
    "/product-sitemap.xml",
    "/wp-sitemap-posts-product-1.xml",
]

def fetch_via_sitemap_jsonld(limit=None, skip_urls=None, base_records=None):
    """Fetch products via sitemap + JSON-LD.

    skip_urls: URLs to skip (already captured — used by --resume).
    base_records: already-captured records, so checkpoints written mid-run
                  include the full merged set, not just this run's new items.
    """
    print("[Tier 2] Trying sitemap + JSON-LD …")
    product_urls = _discover_product_urls_from_sitemap()
    if not product_urls:
        print("[Tier 2] No product URLs found in sitemaps.")
        return [], False

    skip_urls = skip_urls or set()
    if skip_urls:
        before = len(product_urls)
        product_urls = [u for u in product_urls if u not in skip_urls]
        print(f"[Tier 2] Resume: {before - len(product_urls)} already captured, {len(product_urls)} still to fetch.")

    print(f"[Tier 2] {len(product_urls)} product URLs to fetch. Fetching JSON-LD …")
    if limit:
        product_urls = product_urls[:limit]

    base_records = base_records or []
    records = []
    for i, url in enumerate(product_urls, 1):
        r = get(url, tier_label="Tier2-JSONLD")
        if r is None or r.status_code != 200:
            continue
        rec = _extract_jsonld_product(r.text, url)
        if rec:
            records.append(rec)
        if CHECKPOINT_EVERY and i % CHECKPOINT_EVERY == 0:
            _checkpoint(base_records + records)

    print(f"[Tier 2] Extracted {len(records)} products with JSON-LD.")
    return records, bool(records)


def _discover_product_urls_from_sitemap():
    """Walk sitemap(s) to collect all /product/ URLs."""
    product_urls = []
    sitemap_urls_to_check = [BASE_URL + s for s in SITEMAP_CANDIDATES]

    visited = set()
    queue = list(sitemap_urls_to_check)

    while queue:
        surl = queue.pop(0)
        if surl in visited:
            continue
        visited.add(surl)

        r = get(surl, tier_label="Tier2-Sitemap")
        if r is None or r.status_code != 200:
            continue
        if "xml" not in r.headers.get("content-type", ""):
            continue

        try:
            root = ET.fromstring(r.text)
        except ET.ParseError:
            continue

        ns = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}
        # Sitemap index → more sitemaps
        for loc in root.findall(".//sm:sitemap/sm:loc", ns):
            child = loc.text.strip()
            if "product" in child.lower() and child not in visited:
                queue.append(child)

        # Sitemap → product URLs
        for loc in root.findall(".//sm:url/sm:loc", ns):
            url = loc.text.strip()
            parsed = urlparse(url)
            if "/product/" in parsed.path and url not in product_urls:
                product_urls.append(url)

    return product_urls


def _extract_jsonld_product(html, page_url):
    """Parse JSON-LD schema.org/Product from a product page.

    pcstudio.in emits a single @graph block containing BreadcrumbList,
    Organization, Product, WebPage, WebSite nodes — so we must walk @graph
    rather than treating the top-level object as the Product.
    """
    soup = BeautifulSoup(html, "lxml")
    for script in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(script.string or "")
        except Exception:
            continue

        # Flatten: handle plain dict, list, and @graph wrapper
        candidates = []
        if isinstance(data, list):
            candidates = data
        elif isinstance(data, dict):
            candidates = data.get("@graph", [data])

        for item in candidates:
            if item.get("@type") != "Product":
                continue
            name = item.get("name", "").strip()
            sku = item.get("sku") or None

            offers = item.get("offers", {})
            if isinstance(offers, list):
                offers = offers[0] if offers else {}

            # price is already a number in pcstudio's JSON-LD
            raw_price = offers.get("price")
            price = float(raw_price) if raw_price is not None else None

            # Category detection: WC category → keyword fallback on name → URL slug
            # URL slug is most reliable for badly-categorised products because
            # pcstudio.in sometimes puts AMD Ryzen platform mobos under "processor" category.
            wc_cat = str(offers.get("category") or "").strip()
            cat = (
                _map_wc_category(wc_cat)
                or _guess_category_from_text(name)          # name keywords
                or _guess_category_from_text(page_url)      # URL slug as last resort
                or "other"
            )

            return {
                "name": name,
                "category": cat,
                "price_inr": price,
                "sku": sku,
                "url": page_url,
                "fetched_at": _now(),
                "source_method": "sitemap-jsonld",
            }
    return None


WC_CATEGORY_MAP = {
    "processor": "cpu", "processors": "cpu",
    "graphics card": "gpu", "graphics cards": "gpu",
    "motherboard": "motherboard", "motherboards": "motherboard",
    "ram": "ram", "memory": "ram",
    "solid state drive": "storage", "hard disk drive": "storage",
    "storage": "storage", "ssd": "storage", "hdd": "storage",
    "power supply": "psu", "psu": "psu", "smps": "psu",
    "cabinet": "case", "cabinets": "case", "case": "case",
    "cpu cooler": "cooler", "cooler": "cooler", "cooling": "cooler",
}

def _map_wc_category(wc_cat):
    return WC_CATEGORY_MAP.get(wc_cat.lower())

# ─── Tier 3: Category HTML scrape ─────────────────────────────────────────────

def fetch_via_html_scrape(limit=None):
    print("[Tier 3] Falling back to category HTML scraping …")
    records = []

    for canonical_cat, slug_list in CATEGORY_SLUGS.items():
        cat_records = []
        for slug in slug_list:
            url = f"{BASE_URL}/product-category/{slug}/"
            r = get(url, tier_label="Tier3-HTML")
            if r is None or r.status_code == 404:
                continue
            if r.status_code != 200:
                continue
            # Verify we landed on a category page, not the homepage.
            # pcstudio.in redirects non-www → www, so check slug in final URL.
            if "/product-category/" not in r.url:
                continue

            items = _scrape_wc_listing(r.text, canonical_cat)
            if items:
                cat_records.extend(items)
                print(f"  [Tier3-HTML] {canonical_cat}/{slug}: {len(items)} products")
                # Build pagination base from the final (post-redirect) URL
                base_cat_url = r.url.rstrip("/")
                page = 2
                while True:
                    if limit and (len(records) + len(cat_records)) >= limit:
                        break
                    purl = f"{base_cat_url}/page/{page}/"
                    pr = get(purl, tier_label="Tier3-HTML-page")
                    if pr is None or pr.status_code != 200:
                        break
                    more = _scrape_wc_listing(pr.text, canonical_cat)
                    if not more:
                        break
                    cat_records.extend(more)
                    print(f"  [Tier3-HTML] {canonical_cat}/{slug} page {page}: {len(more)} more")
                    page += 1
                break  # found a working slug for this category

        records.extend(cat_records)
        if limit and len(records) >= limit:
            break

    if limit:
        records = records[:limit]

    print(f"[Tier 3] Scraped {len(records)} products via HTML.")
    return records, bool(records)


def _scrape_wc_listing(html, canonical_cat):
    """Extract product cards from a WooCommerce shop/category listing page."""
    soup = BeautifulSoup(html, "lxml")
    records = []

    # Standard WooCommerce product list items
    cards = (
        soup.select("li.product")
        or soup.select("ul.products li")
        or soup.select(".product-grid-item")
    )

    for card in cards:
        # Name
        name_el = (
            card.select_one(".woocommerce-loop-product__title")
            or card.select_one("h2.product-title")
            or card.select_one("h2")
            or card.select_one(".product-name")
        )
        name = name_el.get_text(strip=True) if name_el else ""

        # Price — take the *sale* price if present, else regular
        price_el = (
            card.select_one("ins .woocommerce-Price-amount bdi")
            or card.select_one("ins .woocommerce-Price-amount")
            or card.select_one(".woocommerce-Price-amount bdi")
            or card.select_one(".woocommerce-Price-amount")
            or card.select_one(".price")
        )
        price_str = price_el.get_text(strip=True) if price_el else ""

        # URL
        link_el = card.select_one("a.woocommerce-LoopProduct-link") or card.select_one("a[href]")
        url = link_el["href"] if link_el and link_el.get("href") else ""

        if not name:
            continue

        records.append({
            "name": name,
            "category": canonical_cat,
            "price_inr": _parse_price(price_str),
            "sku": None,
            "url": url,
            "fetched_at": _now(),
            "source_method": "html-scrape",
        })

    return records

# ─── Utilities ────────────────────────────────────────────────────────────────

PRICE_RE = re.compile(r"[\d,]+\.?\d*")
# A number immediately followed by "%" is a discount badge (e.g. "Save-45%"),
# not a price — strip these before extracting, otherwise a concatenated
# "Save-45%₹9,975.00" string parses as ₹45 instead of the real price.
PERCENT_RE = re.compile(r"\d+\.?\d*\s*%")

def _parse_price(text):
    text = PERCENT_RE.sub("", str(text))
    text = text.replace("₹", "").replace(",", "").strip()
    m = PRICE_RE.search(text)
    if m:
        try:
            return float(m.group().replace(",", ""))
        except ValueError:
            pass
    return None


def _select_one_priority(card, comma_selector):
    """
    select_one() on a comma-joined "A, B" selector returns whichever matches
    FIRST IN DOCUMENT ORDER, not "prefer A" — so a declared priority like
    ".price-new, .price" doesn't reliably prefer the more specific selector.
    Try each part in the order it was written, returning the first real hit.
    """
    for part in comma_selector.split(","):
        el = card.select_one(part.strip())
        if el is not None:
            return el
    return None


def _now():
    return datetime.now(timezone.utc).isoformat()


CATEGORY_KEYWORDS = {
    # Motherboard MUST come before CPU — chipset codes (b650, x670 etc.) are
    # unambiguous; "ryzen" in a mobo name (platform label) must NOT match cpu.
    "motherboard": ["motherboard", "mobo", "b650", "b550", "x670", "z790", "z690",
                    "z490", "z890", "a620", "b760", "b860", "h610", "h770",
                    "x870", "b450", "b350"],
    "cpu": ["processor", "cpu", "threadripper", "xeon",
            "ryzen 3", "ryzen 5", "ryzen 7", "ryzen 9",
            "core i3", "core i5", "core i7", "core i9", "core ultra"],
    "gpu": ["geforce", "radeon", "rtx", "gtx", "rx ", "gpu", "graphics card",
            "vga", "video card", "gaming gpu"],
    "ram": ["ddr4", "ddr5", "dimm", "desktop ram", " ram", "memory kit"],
    "storage": ["ssd", "hdd", "nvme", "sata", "hard disk", "solid state",
                "hard drive", "m.2"],
    "psu": ["power supply", "smps", "psu", " watt ", "650w", "750w", "850w",
            "1000w", "1200w", "80 plus", "modular"],
    "case": ["cabinet", "chassis", "mid tower", "full tower", "mini-itx",
             "mini tower", "atx case", "itx case", "pc case"],
    "cooler": ["cpu cooler", "aio cooler", "liquid cool", "heatsink",
               "air cooler", "tower cooler"],
}

def _guess_category_from_text(text):
    text_lower = text.lower()
    for cat, keywords in CATEGORY_KEYWORDS.items():
        if any(kw in text_lower for kw in keywords):
            return cat
    return None  # Return None, not "other", so callers can chain fallbacks

# ─── Report ───────────────────────────────────────────────────────────────────

def _checkpoint(records):
    """Flush catalog.json mid-run so a network drop doesn't lose progress.

    Only writes catalog.json (the resume source of truth); catalog.csv and the
    report are regenerated in full by write_outputs at the end.
    """
    try:
        OUTPUT_DIR.mkdir(exist_ok=True)
        with open(OUTPUT_DIR / "catalog.json", "w", encoding="utf-8") as f:
            json.dump(records, f, indent=2, ensure_ascii=False)
        print(f"  [checkpoint] saved {len(records)} products to catalog.json")
    except OSError as e:
        print(f"  [checkpoint] failed ({e}) — continuing")


def _load_existing_for_resume():
    """Load the existing catalog.json and return (records, set_of_urls_to_skip)."""
    path = OUTPUT_DIR / "catalog.json"
    if not path.exists():
        print("[Resume] No existing catalog.json found — will fetch the full catalog.")
        return [], set()
    try:
        base = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        print(f"[Resume] Could not read catalog.json ({e}) — will fetch the full catalog.")
        return [], set()
    skip = {r["url"] for r in base if r.get("url")}
    print(f"[Resume] Loaded {len(base)} existing products; {len(skip)} URLs will be skipped.")
    return base, skip


def _merge_records(base, new):
    """Combine base + new, de-duplicating by URL (fallback SKU). New wins on conflict."""
    def key(r):
        return r.get("url") or r.get("sku") or id(r)
    merged = {key(r): r for r in base}
    for r in new:
        merged[key(r)] = r
    return list(merged.values())


def write_outputs(records, tier_used):
    OUTPUT_DIR.mkdir(exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    # JSON
    json_path = OUTPUT_DIR / "catalog.json"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(records, f, indent=2, ensure_ascii=False)

    # CSV
    csv_path = OUTPUT_DIR / "catalog.csv"
    fieldnames = ["name", "category", "price_inr", "sku", "url", "source", "fetched_at", "source_method"]
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(records)

    # Report
    total = len(records)
    with_price = sum(1 for r in records if r["price_inr"] is not None)
    by_cat = {}
    for r in records:
        by_cat.setdefault(r["category"], {"total": 0, "with_price": 0})
        by_cat[r["category"]]["total"] += 1
        if r["price_inr"] is not None:
            by_cat[r["category"]]["with_price"] += 1

    by_tier = {}
    for r in records:
        by_tier[r["source_method"]] = by_tier.get(r["source_method"], 0) + 1

    report_lines = [
        f"pcstudio.in Import Report — {timestamp}",
        "=" * 60,
        f"Tier used:         {tier_used}",
        f"Total products:    {total}",
        f"With price:        {with_price} ({100*with_price//total if total else 0}%)",
        f"Without price:     {total - with_price}",
        "",
        "By category:",
    ]
    for cat, counts in sorted(by_cat.items()):
        pct = 100 * counts["with_price"] // counts["total"] if counts["total"] else 0
        report_lines.append(
            f"  {cat:<15} {counts['total']:>4} total, {counts['with_price']:>4} with price ({pct}%)"
        )

    report_lines += [
        "",
        "By source_method:",
    ]
    for method, count in sorted(by_tier.items()):
        report_lines.append(f"  {method:<22} {count:>4}")

    report_lines += [
        "",
        "⚠  ToS reminder: review pcstudio.in/terms before deploying prices",
        "   in any customer-facing output.",
        "",
        f"Outputs: {json_path}  |  {csv_path}",
    ]

    report_text = "\n".join(report_lines)
    report_path = OUTPUT_DIR / "import_report.txt"
    report_path.write_text(report_text, encoding="utf-8")

    print("\n" + report_text)
    return report_path

# ─── Fallback retailers (when component not in pcstudio catalog) ──────────────

# Each entry: (site_name, search_url_template, result_parser_fn)
# Search URL must accept the query as {q} and return HTML with product cards.

# Selectors below were LIVE-VALIDATED 2026-07-10 against real search result
# pages (all three previously had stale/wrong selectors — mdcomputers.in's
# theme changed entirely, primeabgb.com's discounted-price selector matched
# the wrong <span>, and vedantcomputers.com's search URL was a leftover
# Shopify-style path against a site that's actually since moved to OpenCart —
# none of the three returned a single result before this fix, confirming
# HANDOFF.md's long-standing "needs live testing" caveat).
FALLBACK_SITES = [
    {
        # mdcomputers.in — OpenCart, custom "Ronixa" theme (not stock OpenCart markup)
        "name": "mdcomputers.in",
        "search_url": "https://mdcomputers.in/index.php?route=product/search&search={q}",
        "result_sel": ".product-grid-item",
        "name_sel":   "h3",
        # WooCommerce-style del/ins pricing, but as classes not real <ins>/<del> tags
        "price_sel":  ".price .ins .amount, .price .amount",
        "link_sel":   "a.product-image-link",
    },
    {
        # primeabgb.com — WooCommerce
        "name": "primeabgb.com",
        "search_url": "https://www.primeabgb.com/?s={q}&post_type=product",
        "result_sel": ".type-product",
        "name_sel":   ".product-title a",
        # real <ins>/<del> tags here (unlike mdcomputers.in above)
        "price_sel":  ".price ins .woocommerce-Price-amount, .price .woocommerce-Price-amount",
        "link_sel":   ".woocommerce-LoopProduct-link",
    },
    {
        # vedantcomputers.com — actually OpenCart (React-enhanced), not Shopify;
        # www subdomain required, and the search route is OpenCart's standard
        # index.php?route=product/search, not a Shopify /search path.
        "name": "vedantcomputers.com",
        "search_url": "https://www.vedantcomputers.com/index.php?route=product/search&search={q}",
        "result_sel": ".product-thumb",
        "name_sel":   ".name a",
        "price_sel":  ".price-new, .price",
        "link_sel":   ".name a",
    },
]


def search_fallback_sites(query: str) -> list[dict]:
    """
    Search query across fallback retailers.
    Returns a list of records sorted by price ascending.
    Used when a build-ticket component is missing from pcstudio's catalog.
    """
    from urllib.parse import quote_plus
    results = []
    cat = _guess_category_from_text(query) or "other"

    for site in FALLBACK_SITES:
        url = site["search_url"].replace("{q}", quote_plus(query))
        r = get(url, tier_label=f"Fallback-{site['name']}")
        if r is None or r.status_code != 200:
            continue

        soup = BeautifulSoup(r.text, "lxml")
        cards = soup.select(site["result_sel"])[:10]

        for card in cards:
            name_el  = card.select_one(site["name_sel"])
            # select_one() on a comma-joined "A, B" selector returns whichever
            # matches first in DOCUMENT order, not "prefer A" — for a price
            # this can land on a wrapping container whose full text
            # concatenates a sale badge/original price/discounted price
            # together (e.g. "Save-45%₹9,975.00₹17,999.00"), which then
            # mis-parses. Try each comma-separated part in the declared
            # priority order instead, stopping at the first real hit.
            price_el = _select_one_priority(card, site["price_sel"])
            link_el  = card.select_one(site["link_sel"])

            name  = name_el.get_text(strip=True)  if name_el  else ""
            price = _parse_price(price_el.get_text(strip=True)) if price_el else None
            href  = link_el.get("href", "")        if link_el  else ""

            if not name:
                continue

            # Make href absolute
            if href and not href.startswith("http"):
                from urllib.parse import urljoin
                href = urljoin(url, href)

            results.append({
                "name":          name,
                "category":      cat,
                "price_inr":     price,
                "sku":           None,   # fallback entries have no SKU until confirmed
                "url":           href,
                "fetched_at":    _now(),
                "source":        site["name"],
                "source_method": "fallback-search",
            })

    # Sort by price, nulls last
    results.sort(key=lambda r: (r["price_inr"] is None, r["price_inr"] or 0))
    return results


def _slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug[:80]


def consolidate_and_upsert(query: str, category: str | None = None) -> dict:
    """
    Live web-lookup entry point for a component NOT found in the local
    catalog (called from the Electron app's "Search Online" action via the
    ppi:compute-style IPC bridge, --json CLI mode below).

    1. Search all FALLBACK_SITES for `query`.
    2. Cluster the flat listing results by name-similarity (matcher.py's
       token-weighted scorer — same algorithm used everywhere else in this
       codebase) so listings for "the same" product across different sites
       group together, even though each site phrases the name differently.
    3. Average price_inr across the best-matching cluster. Never overstate
       confidence: price_sample_size is the ACTUAL listing count used, and a
       single-listing result is returned but flagged, not silently promoted
       to look like a multi-site average.
    4. Synthesize a WEB-<slug> SKU (component_prices.sku is NOT NULL PK; raw
       fallback listings have sku=None) and upsert into Supabase directly,
       tagged source='web-lookup', needs_review=true — distinct from
       pcstudio.in-sourced rows without inventing a new category axis.

    Returns a plain dict (JSON-serializable) describing the outcome —
    the --json CLI mode below just json.dumps() this to stdout.
    """
    listings = search_fallback_sites(query)
    if not listings:
        return {"found": False, "query": query, "listings": [], "message": "No listings found on any fallback site."}

    # Cluster by name similarity against the query itself: keep only listings
    # that plausibly describe the same product the technician typed, not
    # every tangential search hit each site returned. Score each listing
    # directly (not via Matcher.match(), which only returns the pool's
    # single best hit) so every listing gets its own confidence.
    query_tokens = _tokenize(query)
    ranked = [(_score(query_tokens, set(_tokenize(l["name"]))), l) for l in listings]
    ranked.sort(key=lambda pair: pair[0], reverse=True)

    # Keep listings within the confident band; require at least
    # SUGGEST_THRESHOLD confidence against the query so a garbage hit from
    # one site doesn't drag the average off.
    cluster = [pair[1] for pair in ranked if pair[0] >= SUGGEST_THRESHOLD]
    if not cluster:
        return {
            "found": False, "query": query, "listings": listings,
            "message": f"Found {len(listings)} listing(s) but none matched the query confidently enough to trust."
        }

    priced = [l for l in cluster if l["price_inr"]]
    sample_size = len(priced)
    avg_price = round(sum(l["price_inr"] for l in priced) / sample_size, 2) if sample_size else None

    best = cluster[0]
    resolved_category = category or best["category"]
    sku = f"WEB-{_slugify(best['name'])}"
    now = _now()

    row = {
        "sku": sku,
        "name": best["name"],
        "category": resolved_category,
        "price_inr": avg_price,
        "url": best["url"],
        "source": "web-lookup",
        "source_method": "fallback-consolidated",
        "fetched_at": now,
        "updated_at": now,
        "needs_review": True,
        "price_sample_size": sample_size,
        "price_listings": [
            {"source": l["source"], "url": l["url"], "price_inr": l["price_inr"], "fetched_at": l["fetched_at"]}
            for l in cluster
        ],
    }

    upserted = False
    upsert_error = None
    try:
        from supabase import create_client
        sb = create_client(
            "https://ggsxkhenzdhaachubrsc.supabase.co",
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
            ".eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdnc3hraGVuemRoYWFjaHVicnNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3MTEwNjEsImV4cCI6MjA5NzI4NzA2MX0"
            ".bDhUK-qJSgcBEcNdEdOaZGg5vsUF6jH2gbSRQaMhjBo",
        )
        sb.table("component_prices").upsert(row, on_conflict="sku").execute()
        upserted = True
    except Exception as e:  # noqa: BLE001 — surface any failure back to the caller, don't crash the CLI
        upsert_error = str(e)

    return {
        "found": True,
        "query": query,
        "sku": sku,
        "name": best["name"],
        "category": resolved_category,
        "price_inr": avg_price,
        "price_sample_size": sample_size,
        "price_listings": row["price_listings"],
        "needs_review": True,
        "upserted": upserted,
        "upsert_error": upsert_error,
    }


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Import price catalog")
    parser.add_argument("--limit", type=int, default=None,
                        help="Max products to fetch (smoke test: --limit 50)")
    parser.add_argument("--fallback", type=str, default=None,
                        metavar="QUERY",
                        help="Search fallback retailers for a single component name")
    parser.add_argument("--resume", action="store_true",
                        help="Load existing output/catalog.json, fetch only the URLs still missing, and merge.")
    parser.add_argument("--web-lookup", type=str, default=None,
                        metavar="QUERY",
                        help="Live web lookup for a component missing from the catalog: search "
                             "fallback sites, average the price across matching listings, and "
                             "upsert into Supabase (source='web-lookup', needs_review=true). "
                             "Prints a single JSON object to stdout — this is the machine-readable "
                             "entry point the Electron app's catalog:web-lookup IPC handler calls.")
    parser.add_argument("--category", type=str, default=None,
                        help="Category hint for --web-lookup (cpu/gpu/ram/storage/psu/case/cooler/motherboard)")
    args = parser.parse_args()

    # ── Live web lookup mode (machine-readable JSON output) ────────────────────
    if args.web_lookup:
        result = consolidate_and_upsert(args.web_lookup, category=args.category)
        print(json.dumps(result))
        return 0 if result.get("found") else 1

    # ── Fallback single-item search mode ──────────────────────────────────────
    if args.fallback:
        print(f"\nSearching fallback retailers for: {args.fallback!r}\n")
        results = search_fallback_sites(args.fallback)
        if not results:
            print("No results found on any fallback site.")
            return 1
        print(f"{'Site':<25} {'Price':>10}  Name")
        print("-" * 80)
        for r in results[:15]:
            price_str = f"₹{r['price_inr']:,.0f}" if r["price_inr"] else "N/A"
            print(f"{r['source']:<25} {price_str:>10}  {r['name'][:45]}")
        return 0

    # ── Resume mode: fetch only the URLs missing from catalog.json ─────────────
    if args.resume:
        print(f"\n{'='*60}")
        print(f"  pcstudio.in Catalog Importer — RESUME")
        print(f"{'='*60}\n")
        base_records, skip_urls = _load_existing_for_resume()
        new_records, _ = fetch_via_sitemap_jsonld(args.limit, skip_urls=skip_urls, base_records=base_records)
        for r in new_records:
            r.setdefault("source", "pcstudio.in")
        merged = _merge_records(base_records, new_records)
        print(f"\n[Resume] {len(base_records)} existing + {len(new_records)} newly fetched = {len(merged)} total.")
        write_outputs(merged, "sitemap-jsonld")
        return 0

    # ── Full pcstudio catalog import ───────────────────────────────────────────
    print(f"\n{'='*60}")
    print(f"  pcstudio.in Catalog Importer")
    print(f"  Limit: {args.limit or 'none (full run)'}")
    print(f"{'='*60}\n")

    records, ok = fetch_via_wc_api(args.limit)
    tier_used = "woocommerce-api"

    if not ok:
        records, ok = fetch_via_sitemap_jsonld(args.limit)
        tier_used = "sitemap-jsonld"

    if not ok:
        records, ok = fetch_via_html_scrape(args.limit)
        tier_used = "html-scrape"

    if not ok or not records:
        print("\n[FAIL] All three tiers failed. Possible causes:")
        print("  • Site is blocking bots (check for Cloudflare)")
        print("  • Domain / URL structure differs from expected")
        print("  • Network connectivity issue")
        return 1

    # Tag all records with the source
    for r in records:
        r.setdefault("source", "pcstudio.in")

    write_outputs(records, tier_used)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
