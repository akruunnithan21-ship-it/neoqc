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
