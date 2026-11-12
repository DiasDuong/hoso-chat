-- =========================================================================
-- ROLLBACK MIGRATION: rollback_06_enterprise_agent_sharing.sql
-- Rollback Enterprise Personal AI Agent Sharing System
-- =========================================================================

BEGIN;

-- 1. Xóa các bảng mới tạo
DROP TABLE IF EXISTS public.agent_notifications CASCADE;
DROP TABLE IF EXISTS public.agent_audit_logs CASCADE;
DROP TABLE IF EXISTS public.agent_shares CASCADE;

-- 2. Xóa các cột đã thêm trong user_agent_versions
ALTER TABLE public.user_agent_versions
  DROP COLUMN IF EXISTS version_status,
  DROP COLUMN IF EXISTS published_by,
  DROP COLUMN IF EXISTS published_at;

-- 3. Xóa các cột đã thêm trong user_agents
ALTER TABLE public.user_agents
  DROP COLUMN IF EXISTS origin_agent_id,
  DROP COLUMN IF EXISTS origin_version,
  DROP COLUMN IF EXISTS is_shared,
  DROP COLUMN IF EXISTS allow_cloning;

COMMIT;
