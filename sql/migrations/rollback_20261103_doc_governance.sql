-- ============================================================================
-- SOTRANS HUB - ROLLBACK: DOCUMENT GOVERNANCE & POLICY RELATIONSHIPS
-- Date: 2026-11-03
-- Purpose:
--   Rollback schema and relationship changes to pre-upgrade state
-- ============================================================================

BEGIN;

-- 1. Khôi phục index ràng buộc cũ
DROP INDEX IF EXISTS public.one_active_per_family;

CREATE UNIQUE INDEX IF NOT EXISTS one_active_per_doc
ON public.documents (document_id)
WHERE status = 'active'::doc_status;

-- 2. Xóa bảng quan hệ tài liệu
DROP TABLE IF EXISTS public.document_relationships CASCADE;

-- 3. Xóa các chỉ mục bổ sung
DROP INDEX IF EXISTS public.idx_documents_family_id;
DROP INDEX IF EXISTS public.idx_documents_doc_code;
DROP INDEX IF EXISTS public.idx_documents_category;

-- 4. Xóa các cột đã thêm
ALTER TABLE public.documents
    DROP COLUMN IF EXISTS document_family_id,
    DROP COLUMN IF EXISTS doc_code,
    DROP COLUMN IF EXISTS category,
    DROP COLUMN IF EXISTS department_scope,
    DROP COLUMN IF EXISTS business_unit_scope,
    DROP COLUMN IF EXISTS location_scope,
    DROP COLUMN IF EXISTS employee_group_scope;

COMMIT;
