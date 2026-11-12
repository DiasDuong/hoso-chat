-- Rollback Migration: rollback_20261110_clause_level_relationship_scope.sql
-- Mô tả: Hoàn tác an toàn bảng document_relationship_clauses (VER-MIG-01)
-- Bảo toàn dữ liệu: Tự động sao lưu dữ liệu hiện có sang bảng lưu trữ lịch sử trước khi gỡ bỏ cấu trúc bảng

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'document_relationship_clauses') THEN
    -- Nếu bảng có dữ liệu thực tế, bảo toàn sang bảng lưu trữ để chống mất mát dữ liệu
    IF EXISTS (SELECT 1 FROM document_relationship_clauses LIMIT 1) THEN
      CREATE TABLE IF NOT EXISTS document_relationship_clauses_backup_archive AS
        SELECT *, now() AS archived_at FROM document_relationship_clauses;
      RAISE NOTICE 'Dữ liệu điều khoản đã được sao lưu an toàn vào bảng document_relationship_clauses_backup_archive trước khi rollback.';
    END IF;

    -- Gỡ bỏ bảng sau khi đã bảo toàn dữ liệu (không dùng CASCADE để bảo vệ toàn vẹn tham chiếu ngoại)
    DROP TABLE IF EXISTS document_relationship_clauses;
    RAISE NOTICE 'Bảng document_relationship_clauses đã được gỡ bỏ an toàn.';
  END IF;
END $$;
