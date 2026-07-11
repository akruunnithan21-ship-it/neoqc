"""
ppi.py — Layer 4: Price-to-Performance Index engine.

Pure function, no I/O. Everything it needs (prices, benchmark scores, the
matched build) is passed in as plain dicts so it can be unit-tested without
touching Supabase or the filesystem. Callers (Layer 5 report renderer, CLI
tools, tests) are responsible for loading data and passing it in.

Usage:
    from ppi import ppi

    result = ppi(
        build_specs={"cpu": "SKU-CPU-1", "gpu": "SKU-GPU-1", "ram": "SKU-RAM-1"},
        component_prices={
            "SKU-CPU-1": {"name": "Ryzen 7 9800X3D", "category": "cpu", "price_inr": 42000},
            "SKU-GPU-1": {"name": "RTX 4070 Super",  "category": "gpu", "price_inr": 58000},
            ...
        },
        benchmark_scores={
            "SKU-CPU-1": {"passmark-cpu": 42000},
            "SKU-GPU-1": {"passmark-g3d": 28000},
        },
        use_cases=["gaming-1440p"],
    )
    print(result.index, result.flags)
"""

from dataclasses import dataclass, field
from typing import Optional

# ─── Use-case taxonomy ────────────────────────────────────────────────────
# Component weights per use-case. Rows must sum to 1.0.
# gaming-1440p / video-editing / cad-3d / office / ai-ml are the values the
# boss reviewed in HANDOFF.md. gaming-1080p, gaming-4k, streaming, and
# content-creation are engineering-judgment interpolations pending sign-off —
# see HANDOFF.md "Open items" #4.
USE_CASE_WEIGHTS: dict[str, dict[str, float]] = {
    "gaming-1080p":      {"cpu": 0.25, "gpu": 0.40, "ram": 0.10, "storage": 0.10, "other": 0.15},
    "gaming-1440p":      {"cpu": 0.20, "gpu": 0.45, "ram": 0.10, "storage": 0.10, "other": 0.15},
    "gaming-4k":         {"cpu": 0.15, "gpu": 0.55, "ram": 0.10, "storage": 0.10, "other": 0.10},
    "streaming":         {"cpu": 0.35, "gpu": 0.30, "ram": 0.15, "storage": 0.10, "other": 0.10},
    "video-editing":     {"cpu": 0.35, "gpu": 0.25, "ram": 0.20, "storage": 0.10, "other": 0.10},
    "cad-3d":            {"cpu": 0.45, "gpu": 0.20, "ram": 0.20, "storage": 0.05, "other": 0.10},
    "office":            {"cpu": 0.30, "gpu": 0.05, "ram": 0.20, "storage": 0.20, "other": 0.25},
    "ai-ml":             {"cpu": 0.15, "gpu": 0.55, "ram": 0.10, "storage": 0.05, "other": 0.15},
    "content-creation":  {"cpu": 0.25, "gpu": 0.20, "ram": 0.20, "storage": 0.20, "other": 0.15},
}

# Which build_specs / component_prices "category" values roll up into each
# weight bucket. "other" absorbs psu/case/cooler — components that affect
# reliability/thermals but have no comparable benchmark score.
CATEGORY_TO_BUCKET = {
    "cpu": "cpu",
    "gpu": "gpu",
    "ram": "ram",
    "storage": "storage",
    "psu": "other",
    "case": "other",
    "cooler": "other",
    "motherboard": "other",
}

# Only these categories have an objective benchmark to score performance by.
BENCHMARK_KEY_BY_CATEGORY = {
    "cpu": "passmark-cpu",
    "gpu": "passmark-g3d",
}

# Optional secondary CPU benchmark: PassMark single-thread rating. Multithread
# CPU Mark systematically undervalues gaming-focused parts (a 7800X3D loses to
# a 7900 on CPU Mark but beats it in games), so each use-case declares how much
# single-thread performance matters (α). CPU effective performance within a
# price band is the geometric blend  multithread^(1-α) × singlethread^α  —
# scale-free, so the two benchmarks' very different magnitudes don't matter
# for the relative comparison the price band needs.
BENCHMARK_CPU_ST_KEY = "passmark-cpu-st"
CPU_ST_EMPHASIS = {
    "gaming-1080p":     0.60,   # CPU-bound resolutions live on single-thread
    "gaming-1440p":     0.50,
    "gaming-4k":        0.40,   # GPU-bound, but frametime consistency still ST
    "streaming":        0.30,   # encode is parallel, game thread is not
    "video-editing":    0.25,   # exports scale wide
    "cad-3d":           0.45,   # modeling is ST-bound, rendering is MT-bound
    "office":           0.50,   # responsiveness == single-thread
    "ai-ml":            0.20,   # data pipelines scale wide
    "content-creation": 0.30,
}

# Rough minimum-recommended benchmark scores per use-case, used for
# customer_fit_score. Placeholder values pending real-world calibration —
# see HANDOFF.md "Open items" #3/#4.
MIN_RECOMMENDED = {
    "gaming-1080p":     {"cpu": 12000, "gpu": 9000},
    "gaming-1440p":     {"cpu": 15000, "gpu": 15000},
    "gaming-4k":        {"cpu": 18000, "gpu": 24000},
    "streaming":        {"cpu": 20000, "gpu": 12000},
    "video-editing":    {"cpu": 25000, "gpu": 14000},
    "cad-3d":           {"cpu": 28000, "gpu": 14000},
    "office":           {"cpu": 6000,  "gpu": 2000},
    "ai-ml":            {"cpu": 15000, "gpu": 20000},
    "content-creation": {"cpu": 10000, "gpu": 6000},
}

BOTTLENECK_RATIO = 1.6  # one tier this much stronger than the other → flag it


@dataclass
class ComparisonEntry:
    sku: str
    name: str
    price_inr: float
    score: float          # normalized 0-100 within the price band
    delta_vs_own: float    # score - own_score (positive = better value)


@dataclass
class PPIResult:
    index: float                                       # 0-100 composite score
    per_component_scores: dict[str, Optional[float]]    # category -> 0-100, or None = not scoreable
    in_range_comparisons: dict[str, list[ComparisonEntry]]  # category -> top alternatives
    customer_fit_score: float                           # 0-1
    flags: list[str] = field(default_factory=list)


def _bucket_weights(use_cases: list[str]) -> dict[str, float]:
    """Average the weight rows of every selected use-case, renormalized to sum 1."""
    rows = [USE_CASE_WEIGHTS[uc] for uc in use_cases if uc in USE_CASE_WEIGHTS]
    if not rows:
        rows = [USE_CASE_WEIGHTS["office"]]  # neutral fallback

    buckets = set().union(*(row.keys() for row in rows))
    averaged = {b: sum(row.get(b, 0.0) for row in rows) / len(rows) for b in buckets}
    total = sum(averaged.values())
    return {b: w / total for b, w in averaged.items()} if total else averaged


def _st_emphasis(use_cases: list[str]) -> float:
    """Average single-thread emphasis (α) across the selected use-cases."""
    vals = [CPU_ST_EMPHASIS[uc] for uc in use_cases if uc in CPU_ST_EMPHASIS]
    return sum(vals) / len(vals) if vals else CPU_ST_EMPHASIS["office"]


def _effective_scores(
    category: str,
    pool: dict[str, dict[str, float]],
    st_alpha: float,
    flags: list[str],
) -> dict[str, float]:
    """
    Collapse each pool member's benchmark dict into one effective number.

    GPU: the G3D score as-is. CPU: geometric blend of multithread and
    single-thread marks (multithread^(1-α) × singlethread^α) — but ONLY when
    every pool member has both, because mixing blended and unblended numbers
    in one pool would make their magnitudes incomparable. If any member lacks
    a single-thread score, the whole pool falls back to multithread-only and
    that is flagged, so the report never silently claims ST-aware scoring.
    """
    key = BENCHMARK_KEY_BY_CATEGORY[category]
    if category != "cpu" or st_alpha <= 0:
        return {sku: b[key] for sku, b in pool.items() if b.get(key) is not None}

    mt = {sku: b.get(key) for sku, b in pool.items()}
    st = {sku: b.get(BENCHMARK_CPU_ST_KEY) for sku, b in pool.items()}
    usable = {sku for sku, v in mt.items() if v is not None}
    if usable and all(st[sku] is not None and st[sku] > 0 for sku in usable):
        return {
            sku: (mt[sku] ** (1 - st_alpha)) * (st[sku] ** st_alpha)
            for sku in usable
        }
    flags.append(
        "cpu: single-thread scores incomplete for this price band — "
        "scored on multithread only (gaming-focused CPUs may rank low)"
    )
    return {sku: mt[sku] for sku in usable}


def _price_band_pool(
    category: str,
    own_sku: str,
    own_price: float,
    component_prices: dict[str, dict],
    price_band_pct: float,
) -> list[tuple[str, dict]]:
    lo, hi = own_price * (1 - price_band_pct), own_price * (1 + price_band_pct)
    return [
        (sku, entry)
        for sku, entry in component_prices.items()
        if entry.get("category") == category
        and entry.get("price_inr") is not None
        and lo <= entry["price_inr"] <= hi
    ]


def ppi(
    build_specs: dict[str, str],
    component_prices: dict[str, dict],
    benchmark_scores: dict[str, dict[str, float]],
    use_cases: list[str],
    price_band_pct: float = 0.15,
) -> PPIResult:
    """
    Compute the Price-to-Performance Index for a matched build.

    Args:
        build_specs: category -> SKU for the components actually in this build,
            e.g. {"cpu": "SKU-1", "gpu": "SKU-2", "ram": "SKU-3", ...}.
        component_prices: SKU -> {"name", "category", "price_inr"} for every
            catalog component (not just this build) — needed to find
            same-price-band alternatives.
        benchmark_scores: SKU -> {benchmark_name: score}, e.g.
            {"passmark-cpu": 42000, "passmark-cpu-st": 4300} for a CPU,
            {"passmark-g3d": 28000} for a GPU. The single-thread key is
            optional; when present for the whole price band, CPU scoring
            blends it in per the use-case's CPU_ST_EMPHASIS (X3D-style
            gaming CPUs stop being undervalued).
        use_cases: selected entries from USE_CASE_WEIGHTS keys.
        price_band_pct: how wide a "same price range" comparison is (±pct).
    """
    weights = _bucket_weights(use_cases)
    st_alpha = _st_emphasis(use_cases)
    flags: list[str] = []
    per_component_scores: dict[str, Optional[float]] = {}
    in_range_comparisons: dict[str, list[ComparisonEntry]] = {}
    weighted_sum = 0.0
    weight_total = 0.0
    fit_ratios: list[float] = []
    raw_scores: dict[str, float] = {}   # category -> own raw benchmark (absolute, for fit/bottleneck)

    for category, sku in build_specs.items():
        bucket = CATEGORY_TO_BUCKET.get(category)
        if bucket is None or bucket not in weights:
            continue

        own_entry = component_prices.get(sku)
        if own_entry is None:
            flags.append(f"{category}: SKU {sku} not found in component_prices, skipped")
            continue
        own_price = own_entry.get("price_inr")

        # A category only contributes to the index when it can honestly be
        # scored: it has an objective benchmark, a price to define the band,
        # and at least one same-price peer to compare against. Everything
        # else is reported as None (unscored) — a fake "neutral 100" used to
        # inflate the index and read as "best in class" on the report.
        benchmark_key = BENCHMARK_KEY_BY_CATEGORY.get(category)
        score: Optional[float] = None

        if benchmark_key is None:
            flags.append(f"{category}: no objective benchmark exists — shown unscored, not counted in the index")
        elif own_price is None:
            flags.append(f"{category}: no price on file — cannot place in a price band, not counted in the index")
        else:
            own_score_raw = benchmark_scores.get(sku, {}).get(benchmark_key)
            if own_score_raw is not None:
                raw_scores[category] = own_score_raw

            pool_entries = _price_band_pool(category, sku, own_price, component_prices, price_band_pct)
            pool_bench = {
                s: benchmark_scores.get(s, {})
                for s, _ in pool_entries
                if benchmark_scores.get(s, {}).get(benchmark_key) is not None
            }

            if own_score_raw is None:
                flags.append(f"{category}: no {benchmark_key} score on file — not counted in the index")
            elif len(pool_bench) < 2:
                flags.append(f"{category}: no same-price peers with benchmark data — not counted in the index")
            else:
                eff = _effective_scores(category, pool_bench, st_alpha, flags)
                best = max(eff.values())
                # Ratio-to-best: "this part delivers N% of the best performance
                # money buys at this exact price". Unlike min-max, the weakest
                # part in a tight band no longer scores an absurd 0.
                score = 100.0 * eff[sku] / best if best > 0 else None
                if score is not None:
                    comparisons = []
                    for peer_sku, peer_eff in sorted(eff.items(), key=lambda kv: kv[1], reverse=True):
                        if peer_sku == sku:
                            continue
                        peer_norm = 100.0 * peer_eff / best
                        peer_entry = component_prices[peer_sku]
                        comparisons.append(ComparisonEntry(
                            sku=peer_sku,
                            name=peer_entry.get("name", peer_sku),
                            price_inr=peer_entry.get("price_inr"),
                            score=round(peer_norm, 1),
                            delta_vs_own=round(peer_norm - score, 1),
                        ))
                    in_range_comparisons[category] = comparisons[:3]
                    if score >= 100.0 - 1e-9:
                        flags.append(f"{category}: best performer in its price band ✓")

            if own_score_raw is not None:
                for uc in use_cases:
                    threshold = MIN_RECOMMENDED.get(uc, {}).get(category)
                    if threshold:
                        fit_ratios.append(min(1.0, own_score_raw / threshold))

        per_component_scores[category] = round(score, 1) if score is not None else None
        if score is not None:
            w = weights[bucket]
            weighted_sum += score * w
            weight_total += w

    index = round(weighted_sum / weight_total, 1) if weight_total else 0.0
    customer_fit_score = round(sum(fit_ratios) / len(fit_ratios), 3) if fit_ratios else 0.0

    # Bottleneck detection on ABSOLUTE performance vs the use-case's minimums —
    # not on the price-band-relative scores above (a great-value CPU next to a
    # mid-value GPU is a value statement, not a bottleneck).
    cpu_raw = raw_scores.get("cpu")
    gpu_raw = raw_scores.get("gpu")
    if cpu_raw and gpu_raw:
        cpu_fits, gpu_fits = [], []
        for uc in use_cases:
            mins = MIN_RECOMMENDED.get(uc, {})
            if mins.get("cpu"):
                cpu_fits.append(cpu_raw / mins["cpu"])
            if mins.get("gpu"):
                gpu_fits.append(gpu_raw / mins["gpu"])
        if cpu_fits and gpu_fits:
            cpu_fit = sum(cpu_fits) / len(cpu_fits)
            gpu_fit = sum(gpu_fits) / len(gpu_fits)
            if gpu_fit / max(cpu_fit, 1e-6) < 1 / BOTTLENECK_RATIO:
                flags.append("GPU is the limiting component for the selected use-case (CPU has headroom)")
            elif cpu_fit / max(gpu_fit, 1e-6) < 1 / BOTTLENECK_RATIO:
                flags.append("CPU is the limiting component for the selected use-case (GPU has headroom)")

    if fit_ratios and customer_fit_score < 0.6:
        flags.append("Build is underpowered for the selected use-case(s)")

    return PPIResult(
        index=index,
        per_component_scores=per_component_scores,
        in_range_comparisons=in_range_comparisons,
        customer_fit_score=customer_fit_score,
        flags=flags,
    )
