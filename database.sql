-- ==========================================================================
-- NEO QC - SUPABASE CLOUD DATABASE SETUP SCHEMA
-- Copy and paste this script directly into the Supabase SQL Editor
-- ==========================================================================

-- Drop table if exists (uncomment if re-initializing)
-- DROP TABLE IF EXISTS public.tickets;

CREATE TABLE public.tickets (
    id TEXT PRIMARY KEY,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    type TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    deadline TIMESTAMP WITH TIME ZONE,
    technician TEXT,
    missing_components_toggle BOOLEAN DEFAULT false,
    missing_components TEXT,
    build_checks JSONB DEFAULT '{}'::jsonb,
    qc_checks JSONB DEFAULT '{}'::jsonb,
    diagnostics JSONB DEFAULT '{}'::jsonb,
    serials JSONB DEFAULT '{}'::jsonb,
    specs JSONB DEFAULT '{}'::jsonb,
    status TEXT DEFAULT 'awaiting'::text,
    completed_at TIMESTAMP WITH TIME ZONE
);

-- Enable Row Level Security (RLS)
ALTER TABLE public.tickets ENABLE ROW LEVEL SECURITY;

-- Create Policy to allow anonymous read/write (Public Access)
-- Since this is a local shop internal QA tool, we keep access policies open for ease of integration.
CREATE POLICY "Allow anonymous read access" 
    ON public.tickets FOR SELECT 
    USING (true);

CREATE POLICY "Allow anonymous insert access" 
    ON public.tickets FOR INSERT 
    WITH CHECK (true);

CREATE POLICY "Allow anonymous update access" 
    ON public.tickets FOR UPDATE 
    USING (true)
    WITH CHECK (true);

CREATE POLICY "Allow anonymous delete access" 
    ON public.tickets FOR DELETE 
    USING (true);

-- Enable Realtime for the tickets table (for dynamic dashboard updates across staff PCs)
alter publication supabase_realtime add table public.tickets;

-- ==========================================================================
-- PRICE INDEX  (Layer 1)
-- component_prices  — current price per SKU (upsert target)
-- price_history     — append-only log; populated by the loader on every change
-- ==========================================================================

CREATE TABLE IF NOT EXISTS public.component_prices (
    sku             TEXT        PRIMARY KEY,
    name            TEXT        NOT NULL,
    category        TEXT        NOT NULL,  -- cpu/gpu/ram/storage/psu/case/cooler/motherboard
    price_inr       NUMERIC,
    url             TEXT,
    source          TEXT        NOT NULL DEFAULT 'pcstudio.in',
    source_method   TEXT,                  -- woocommerce-api / sitemap-jsonld / html-scrape / fallback-*
    fetched_at      TIMESTAMPTZ NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.price_history (
    id              BIGSERIAL   PRIMARY KEY,
    sku             TEXT        NOT NULL REFERENCES public.component_prices(sku) ON DELETE CASCADE,
    price_inr       NUMERIC,
    source          TEXT        NOT NULL,
    source_method   TEXT,
    fetched_at      TIMESTAMPTZ NOT NULL,
    recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for quick per-SKU history lookups
CREATE INDEX IF NOT EXISTS price_history_sku_idx ON public.price_history (sku, fetched_at DESC);

-- Index for category-range queries (PPI engine needs all GPUs in a price band, etc.)
CREATE INDEX IF NOT EXISTS component_prices_cat_price_idx ON public.component_prices (category, price_inr);

-- RLS (same open policy as tickets — internal shop tool)
ALTER TABLE public.component_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.price_history    ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow anon read component_prices"  ON public.component_prices FOR SELECT USING (true);
CREATE POLICY "Allow anon insert component_prices" ON public.component_prices FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow anon update component_prices" ON public.component_prices FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "Allow anon delete component_prices" ON public.component_prices FOR DELETE USING (true);

CREATE POLICY "Allow anon read price_history"   ON public.price_history FOR SELECT USING (true);
CREATE POLICY "Allow anon insert price_history" ON public.price_history FOR INSERT WITH CHECK (true);

-- ==========================================================================
-- PERFORMANCE REFERENCE  (Layer 2)
-- component_performance — benchmark scores, source-tagged measured vs reference
-- ==========================================================================

CREATE TABLE IF NOT EXISTS public.component_performance (
    sku             TEXT        NOT NULL,
    benchmark       TEXT        NOT NULL,  -- cinebench-r23-mt, passmark-cpu, passmark-g3d, cdm-seq-read, furmmark-score …
    score           NUMERIC     NOT NULL,
    source          TEXT        NOT NULL   CHECK (source IN ('measured','reference')),
    source_detail   TEXT,                  -- e.g. 'PassMark v11 / cpubenchmark.net', 'our FurMark run 2026-07-08'
    tested_at       TIMESTAMPTZ,           -- null = unknown date (reference data)
    recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (sku, benchmark, source)
);

ALTER TABLE public.component_performance ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow anon read component_performance"   ON public.component_performance FOR SELECT USING (true);
CREATE POLICY "Allow anon insert component_performance" ON public.component_performance FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow anon update component_performance" ON public.component_performance FOR UPDATE USING (true) WITH CHECK (true);

-- ==========================================================================
-- SKU ALIAS MAP  (Layer 3 — matching layer)
-- Maps free-text component names from build tickets to canonical SKUs
-- Staff can confirm/correct these; confirmed=true locks the mapping.
-- ==========================================================================

CREATE TABLE IF NOT EXISTS public.sku_aliases (
    id              BIGSERIAL   PRIMARY KEY,
    raw_text        TEXT        NOT NULL,   -- exactly as typed in the ticket
    sku             TEXT        REFERENCES public.component_prices(sku),
    confidence      NUMERIC,                -- 0–1, from the matcher
    confirmed       BOOLEAN     NOT NULL DEFAULT false,
    confirmed_by    TEXT,
    confirmed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (raw_text)
);

ALTER TABLE public.sku_aliases ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow anon all sku_aliases" ON public.sku_aliases FOR ALL USING (true) WITH CHECK (true);

-- ==========================================================================
-- TICKET PPI  (Layer 4/5 — benchmarking section overhaul)
-- Precomputed Price-to-Performance Index results per ticket, written by
-- ppi_sync.py (calls ppi.py's pure ppi() function). The Electron app and
-- the customer dashboard both only READ this table — no PPI math is
-- duplicated into JavaScript anywhere.
-- ==========================================================================

CREATE TABLE IF NOT EXISTS public.ticket_ppi (
    ticket_id             TEXT        PRIMARY KEY REFERENCES public.tickets(id) ON DELETE CASCADE,
    computed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    use_cases             TEXT[]      NOT NULL,
    price_band_pct        NUMERIC     NOT NULL DEFAULT 0.15,
    index                 NUMERIC,                 -- PPIResult.index, 0-100
    customer_fit_score    NUMERIC,                 -- PPIResult.customer_fit_score, 0-1
    per_component_scores  JSONB,                   -- PPIResult.per_component_scores
    in_range_comparisons  JSONB,                   -- PPIResult.in_range_comparisons (ComparisonEntry lists)
    flags                 TEXT[],                  -- PPIResult.flags
    source_note           TEXT        DEFAULT 'ppi.py v1'
);

ALTER TABLE public.ticket_ppi ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow anon read ticket_ppi"   ON public.ticket_ppi FOR SELECT USING (true);
CREATE POLICY "Allow anon insert ticket_ppi" ON public.ticket_ppi FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow anon update ticket_ppi" ON public.ticket_ppi FOR UPDATE USING (true) WITH CHECK (true);

-- ==========================================================================
-- LIVE WEB LOOKUP  (component_prices additions)
-- When a technician searches for a component not in the catalog,
-- pcstudio_import.py's consolidate_and_upsert() searches fallback retailers,
-- averages the price across matching listings, and upserts here with
-- source='web-lookup' (existing column, new value) so it's distinguishable
-- from pcstudio.in-sourced rows without a separate product-category axis.
-- ==========================================================================

ALTER TABLE public.component_prices
  ADD COLUMN IF NOT EXISTS needs_review      BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS price_listings    JSONB,   -- [{source, url, price_inr, fetched_at}, ...]
  ADD COLUMN IF NOT EXISTS price_sample_size INT;

-- ==========================================================================
-- diagnostics JSONB — new fields (benchmarking section overhaul)
-- public.tickets.diagnostics is schemaless (JSONB DEFAULT '{}'::jsonb), so
-- no DDL is needed for these, but the shape is documented here as the
-- source of truth. All additive — existing tickets/readers are unaffected.
--
-- diagnostics.prime95 = {
--   ranAt, mode: "blend", durationRequestedSec, durationActualSec, workerCount,
--   overallResult: "pass"|"fail"|"aborted"|"not-run",
--   workers: [{ id, result: "pass"|"fail", errors, roundingWarnings, lastIterationMs }],
--   errorSummary: string[], rawLogExcerpt: string|null, toolVersion: string|null
-- }
-- diagnostics.componentPassport = {
--   cpu:     { model, cores, threads, baseClockMHz, boostClockMHz, tempMaxDuringTest, throttled, healthNote },
--   gpu:     { model, vram, driverVersion, tempMaxDuringTest, healthNote },
--   ram:     { modules: [{ manufacturer, partNumber, capacityGB, speedMHz, slot }], totalGB, ddrGen, errorsDuringPrime95, healthNote },
--   storage: { model, mediaType, interface, sizeGB, wear, lifeRemaining, powerOnHours, healthStatus, readErrors, writeErrors }
-- }
-- diagnostics.portCheckV2 = {
--   ranAt, categories: { usb|video|audio: { status: "pass"|"warn"|"fail"|"unverified", beforeDevices, afterDevices, newDevicesDetected } }
-- }
-- diagnostics.rgbSyncV2 = {
--   ranAt, controllerFound, devices: [{ name, zones: [{ name, colorApplied, colorVerified, verified }] }],
--   overallStatus: "pass"|"partial"|"fail"|"not-detected"
-- }
-- diagnostics.ramStress  -- "passed" | "failed", now derived from prime95.overallResult (see HANDOFF.md bug fixes)
-- diagnostics.ramDetail  -- e.g. "Prime95 Blend, 1200s, 0 errors across 8 workers"
-- diagnostics.ramQuickCheck -- optional preliminary, non-authoritative result from ram-stress-worker.js
-- ==========================================================================
