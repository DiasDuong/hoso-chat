-- ========================================================
-- SOTRANS HUB — MIGRATION 005: F-02 RETRY LEASES & GENERATION ISOLATION
-- Non-destructive, idempotent, zero-downtime migration
-- ========================================================

-- 1. Create durable retry lease table
CREATE TABLE IF NOT EXISTS document_retry_leases (
  doc_version_id UUID PRIMARY KEY REFERENCES documents(doc_version_id) ON DELETE CASCADE,
  generation_id UUID NOT NULL,
  fencing_token BIGINT NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'ACQUIRED' CHECK (status IN ('ACQUIRED', 'PROCESSING', 'STAGED', 'PUBLISHED', 'FAILED', 'EXPIRED')),
  acquired_by TEXT NOT NULL,
  retry_reason TEXT,
  retry_idempotency_key TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_retry_leases_status ON document_retry_leases(status);
CREATE INDEX IF NOT EXISTS idx_retry_leases_expires_at ON document_retry_leases(expires_at);

-- 2. Add generation tracking columns to documents
ALTER TABLE documents 
  ADD COLUMN IF NOT EXISTS active_generation_id UUID,
  ADD COLUMN IF NOT EXISTS active_fencing_token BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS retry_count INT DEFAULT 0;

-- 3. Add generation tracking and publication flag to chunks
ALTER TABLE chunks 
  ADD COLUMN IF NOT EXISTS generation_id UUID,
  ADD COLUMN IF NOT EXISTS fencing_token BIGINT,
  ADD COLUMN IF NOT EXISTS is_published BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_chunks_generation ON chunks(doc_version_id, generation_id);
CREATE INDEX IF NOT EXISTS idx_chunks_published ON chunks(doc_version_id, is_published);

-- 4. Safe backward-compatible initialization for existing data
UPDATE documents 
SET active_generation_id = COALESCE(active_generation_id, doc_version_id)
WHERE active_generation_id IS NULL;

UPDATE chunks c
SET generation_id = COALESCE(c.generation_id, d.active_generation_id, d.doc_version_id),
    is_published = TRUE
FROM documents d
WHERE c.doc_version_id = d.doc_version_id AND (c.generation_id IS NULL OR c.is_published IS FALSE);
