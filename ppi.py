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
    per_component_scores: dict[str, float]              # category -> 0-100
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


def _normalize(value: float, pool: list[float]) -> float:
    """Min-max normalize value against pool to a 0-100 scale."""
    lo, hi = min(pool), max(pool)
    if hi <= lo:
        return 100.0
    return max(0.0, min(100.0, (value - lo) / (hi - lo) * 100))


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
            {"passmark-cpu": 42000} for a CPU, {"passmark-g3d": 28000} for a GPU.
        use_cases: selected entries from USE_CASE_WEIGHTS keys.
        price_band_pct: how wide a "same price range" comparison is (±pct).
    """
    weights = _bucket_weights(use_cases)
    flags: list[str] = []
    per_component_scores: dict[str, float] = {}
    in_range_comparisons: dict[str, list[ComparisonEntry]] = {}
    weighted_sum = 0.0
    weight_total = 0.0
    fit_ratios: list[float] = []

    for category, sku in build_specs.items():
        bucket = CATEGORY_TO_BUCKET.get(category)
        if bucket is None or bucket not in weights:
            continue

        own_entry = component_prices.get(sku)
        if own_entry is None:
            flags.append(f"{category}: SKU {sku} not found in component_prices, skipped")
            continue
        own_price = own_entry.get("price_inr")

        benchmark_key = BENCHMARK_KEY_BY_CATEGORY.get(category)
        if benchmark_key is None:
            # No objective benchmark for this category yet (ram/storage/psu/case/cooler).
            score = 100.0
            flags.append(f"{category}: no benchmark data, scored neutral")
        elif own_price is None:
            score = 100.0
            flags.append(f"{category}: no price on file, scored neutral")
        else:
            pool_entries = _price_band_pool(category, sku, own_price, component_prices, price_band_pct)
            pool_scores = {
                s: benchmark_scores.get(s, {}).get(benchmark_key)
                for s, _ in pool_entries
            }
            pool_scores = {s: v for s, v in pool_scores.items() if v is not None}
            own_score_raw = benchmark_scores.get(sku, {}).get(benchmark_key)

            if own_score_raw is None:
                score = 100.0
                flags.append(f"{category}: no {benchmark_key} score on file, scored neutral")
            elif len(pool_scores) < 2:
                score = 100.0  # not enough peers in the price band to compare against
            else:
                score = _normalize(own_score_raw, list(pool_scores.values()))
                comparisons = []
                for peer_sku, peer_score in sorted(pool_scores.items(), key=lambda kv: kv[1], reverse=True):
                    if peer_sku == sku:
                        continue
                    peer_norm = _normalize(peer_score, list(pool_scores.values()))
                    peer_entry = component_prices[peer_sku]
                    comparisons.append(ComparisonEntry(
                        sku=peer_sku,
                        name=peer_entry.get("name", peer_sku),
                        price_inr=peer_entry.get("price_inr"),
                        score=round(peer_norm, 1),
                        delta_vs_own=round(peer_norm - score, 1),
                    ))
                in_range_comparisons[category] = comparisons[:3]

            if own_score_raw is not None:
                for uc in use_cases:
                    threshold = MIN_RECOMMENDED.get(uc, {}).get(category)
                    if threshold:
                        fit_ratios.append(min(1.0, own_score_raw / threshold))

        per_component_scores[category] = round(score, 1)
        w = weights[bucket]
        weighted_sum += score * w
        weight_total += w

    index = round(weighted_sum / weight_total, 1) if weight_total else 0.0
    customer_fit_score = round(sum(fit_ratios) / len(fit_ratios), 3) if fit_ratios else 0.0

    cpu_score = per_component_scores.get("cpu")
    gpu_score = per_component_scores.get("gpu")
    if cpu_score is not None and gpu_score is not None:
        is_gaming = any(uc.startswith("gaming") or uc == "ai-ml" for uc in use_cases)
        if is_gaming and cpu_score > 0 and gpu_score / max(cpu_score, 1e-6) < 1 / BOTTLENECK_RATIO:
            flags.append("GPU bottlenecked relative to CPU for the selected use-case")
        elif is_gaming and gpu_score > 0 and cpu_score / max(gpu_score, 1e-6) < 1 / BOTTLENECK_RATIO:
            flags.append("CPU bottlenecked relative to GPU for the selected use-case")

    if fit_ratios and customer_fit_score < 0.6:
        flags.append("Build is underpowered for the selected use-case(s)")

    return PPIResult(
        index=index,
        per_component_scores=per_component_scores,
        in_range_comparisons=in_range_comparisons,
        customer_fit_score=customer_fit_score,
        flags=flags,
    )
