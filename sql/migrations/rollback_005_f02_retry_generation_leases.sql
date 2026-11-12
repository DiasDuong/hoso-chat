-- ========================================================
-- SOTRANS HUB — ROLLBACK MIGRATION 005
-- Rollback F-02 Retry Leases & Generation Isolation
-- ========================================================

-- 1. Drop indexes
DROP INDEX IF EXISTS idx_chunks_generation;
DROP INDEX IF EXISTS idx_chunks_published;
DROP INDEX IF EXISTS idx_retry_leases_status;
DROP INDEX IF EXISTS idx_retry_leases_expires_at;

-- 2. Drop table
DROP TABLE IF EXISTS document_retry_leases CASCADE;

-- 3. Drop columns from chunks
ALTER TABLE chunks 
  DROP COLUMN IF EXISTS generation_id,
  DROP COLUMN IF EXISTS fencing_token,
  DROP COLUMN IF EXISTS is_published;

-- 4. Drop columns from documents
ALTER TABLE documents 
  DROP COLUMN IF EXISTS active_generation_id,
  DROP COLUMN IF EXISTS active_fencing_token,
  DROP COLUMN IF EXISTS retry_count;
