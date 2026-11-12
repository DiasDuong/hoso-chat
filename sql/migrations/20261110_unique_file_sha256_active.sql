-- Migration: 20261110_unique_file_sha256_active.sql
-- Release Candidate Hardening: Production-Grade Safe Migration
-- Target: SOTRANS Hub PostgreSQL
-- Scope: Partial Unique Index on documents(file_sha256) for active/draft/testing documents

BEGIN;

-- 1. PREFLIGHT DUPLICATE CHECK
-- Ngăn chặn triệt để lỗi gián đoạn nếu database đã tồn tại bản ghi trùng lặp vi phạm predicate
DO $$
DECLARE
    duplicate_count INTEGER;
    duplicate_sample TEXT;
BEGIN
    SELECT COUNT(*), COALESCE(string_agg(file_sha256 || ' (' || cnt || ' bản ghi)', ', '), '')
    INTO duplicate_count, duplicate_sample
    FROM (
        SELECT file_sha256, COUNT(*) AS cnt
        FROM documents
        WHERE status NOT IN ('rejected', 'archived', 'trash')
          AND deleted_at IS NULL
          AND file_sha256 IS NOT NULL
        GROUP BY file_sha256
        HAVING COUNT(*) > 1
        LIMIT 5
    ) sub;

    IF duplicate_count > 0 THEN
        RAISE EXCEPTION 'MIGRATION_PREFLIGHT_FAILED: Phát hiện % nhóm file_sha256 trùng lặp vi phạm ràng buộc: %. Vui lòng dọn dẹp hoặc xử lý dữ liệu trước khi tạo unique index.', duplicate_count, duplicate_sample;
    ELSE
        RAISE NOTICE 'PREFLIGHT PASS: Không phát hiện bản ghi trùng lặp vi phạm ràng buộc file_sha256.';
    END IF;
END $$;

-- 2. SAFE IDEMPOTENT INDEX CREATION WITH STRUCTURE & VALIDITY VERIFICATION
-- Không thực hiện DROP INDEX mù quáng; kiểm tra cả tính hợp lệ (indisvalid) và tính chính xác của cấu trúc predicate
DO $$
DECLARE
    index_exists BOOLEAN;
    is_valid BOOLEAN;
    current_def TEXT;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'uq_documents_file_sha256_active'
          AND n.nspname = CURRENT_SCHEMA()
    ) INTO index_exists;

    IF index_exists THEN
        SELECT i.indisvalid, pg_get_indexdef(i.indexrelid)
        INTO is_valid, current_def
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'uq_documents_file_sha256_active'
          AND n.nspname = CURRENT_SCHEMA();

        IF is_valid AND current_def LIKE '%rejected%' THEN
            RAISE NOTICE 'INDEX ALREADY EXISTS: Chỉ mục uq_documents_file_sha256_active đã tồn tại, hợp lệ và đúng cấu trúc. Bỏ qua bước tạo mới.';
            RETURN;
        ELSE
            IF NOT is_valid THEN
                RAISE WARNING 'INVALID INDEX DETECTED: Phát hiện chỉ mục uq_documents_file_sha256_active ở trạng thái không hợp lệ. Đang tiến hành xóa để tạo lại...';
            ELSE
                RAISE WARNING 'OUTDATED INDEX PREDICATE DETECTED: Phát hiện chỉ mục uq_documents_file_sha256_active sai cấu trúc predicate. Đang tiến hành xóa để tạo lại...';
            END IF;
            EXECUTE 'DROP INDEX uq_documents_file_sha256_active';
        END IF;
    END IF;

    RAISE NOTICE 'CREATING INDEX: Đang khởi tạo partial unique index uq_documents_file_sha256_active...';
    EXECUTE '
        CREATE UNIQUE INDEX IF NOT EXISTS uq_documents_file_sha256_active
        ON documents (file_sha256)
        WHERE status NOT IN (''rejected'', ''archived'', ''trash'')
          AND deleted_at IS NULL
          AND file_sha256 IS NOT NULL
    ';
    RAISE NOTICE 'INDEX CREATED: Khởi tạo partial unique index uq_documents_file_sha256_active thành công.';
END $$;

COMMIT;
