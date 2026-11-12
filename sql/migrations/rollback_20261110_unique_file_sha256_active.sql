-- Rollback Migration: rollback_20261110_unique_file_sha256_active.sql
-- Release Candidate Hardening: Production-Grade Safe Rollback
-- Scope: Hoàn tác partial unique index uq_documents_file_sha256_active an toàn, idempotent

BEGIN;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'uq_documents_file_sha256_active'
          AND n.nspname = CURRENT_SCHEMA()
    ) THEN
        RAISE NOTICE 'ROLLING BACK: Đang xóa chỉ mục uq_documents_file_sha256_active...';
        EXECUTE 'DROP INDEX IF EXISTS uq_documents_file_sha256_active';
        RAISE NOTICE 'ROLLBACK COMPLETE: Đã xóa chỉ mục uq_documents_file_sha256_active thành công.';
    ELSE
        RAISE NOTICE 'ROLLBACK NO-OP: Chỉ mục uq_documents_file_sha256_active không tồn tại. Bỏ qua.';
    END IF;
END $$;

COMMIT;
