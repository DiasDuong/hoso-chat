-- =============================================================================
-- SOTRANS HUB - ROLLBACK 07: HYBRID ONEDRIVE SOURCE ASSOCIATIONS & RBAC
-- Reverts association table and restored agent_id
-- =============================================================================

BEGIN;

-- 1. Xóa các bản ghi association đã tạo
DROP TABLE IF EXISTS public.agent_onedrive_source_associations CASCADE;

-- 2. Khôi phục agent_id của nguồn b0112ae9... về 'excel-data-pro'
UPDATE public.user_onedrive_sources
SET agent_id = 'excel-data-pro',
    source_scope = 'PERSONAL',
    is_shared = FALSE
WHERE id = 'b0112ae9-6035-4af3-b82d-47d1fa21608f';

-- 3. Khôi phục cờ can_contribute_source
ALTER TABLE public.agent_shares DROP COLUMN IF EXISTS can_contribute_source;

-- 4. Khôi phục cờ lưu trữ cho các bản ghi cũ
UPDATE public.user_onedrive_sources
SET is_archived = FALSE
WHERE owner_user_id = 'f2b6606e-3125-409c-b5f9-d3ed82282c26';

COMMIT;
