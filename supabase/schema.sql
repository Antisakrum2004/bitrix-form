-- ============================================================
-- Supabase schema for Bitrix24 tasks semantic search
-- Project: nopccnooivztriqdkbie
-- Created: 2026-06-30
-- Version: v7.26
--
-- SETUP:
-- 1. Go to https://supabase.com/dashboard/project/nopccnooivztriqdkbie/database/extensions
--    Enable: vector, pg_trgm
-- 2. Go to SQL Editor → New query → paste this file → Run
-- ============================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Drop existing (idempotent for re-runs during dev)
DROP TABLE IF EXISTS tasks CASCADE;

-- Main table
CREATE TABLE tasks (
  id              BIGINT PRIMARY KEY,                       -- Bitrix24 task ID
  title           TEXT NOT NULL,
  description     TEXT,                                     -- HTML stripped, plain text
  project_id      BIGINT,
  project_name    TEXT,
  responsible_id  BIGINT,
  responsible_name TEXT,
  status          TEXT,
  status_label    TEXT,                                     -- human-readable: "В работе" etc
  created_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ,
  embedding       VECTOR(1536),                             -- OpenAI text-embedding-3-small
  indexed_at      TIMESTAMPTZ DEFAULT NOW()
);

-- HNSW index for fast cosine similarity search (works great on <100k rows)
CREATE INDEX idx_tasks_embedding ON tasks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- B-tree indexes for filters
CREATE INDEX idx_tasks_project_id   ON tasks (project_id);
CREATE INDEX idx_tasks_status       ON tasks (status);
CREATE INDEX idx_tasks_updated_at   ON tasks (updated_at DESC);
CREATE INDEX idx_tasks_created_at   ON tasks (created_at DESC);

-- pg_trgm index for future hybrid lexical search
CREATE INDEX idx_tasks_title_trgm   ON tasks USING gin (title gin_trgm_ops);
CREATE INDEX idx_tasks_descr_trgm   ON tasks USING gin (description gin_trgm_ops);

-- Helpful view: tasks without embeddings (need re-indexing)
CREATE OR REPLACE VIEW tasks_without_embedding AS
  SELECT id, title, updated_at FROM tasks WHERE embedding IS NULL;

-- Row-level security: disable (we use service_role key from backend)
ALTER TABLE tasks DISABLE ROW LEVEL SECURITY;

-- Comment
COMMENT ON TABLE tasks IS 'Bitrix24 tasks with OpenAI embeddings for semantic search. Synced from Bitrix24 via scripts/sync-bitrix-to-supabase.ts';
COMMENT ON COLUMN tasks.embedding IS 'OpenAI text-embedding-3-small, 1536 dimensions';
