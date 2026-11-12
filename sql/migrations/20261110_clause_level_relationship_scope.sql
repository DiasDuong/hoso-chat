-- Migration: 20261110_clause_level_relationship_scope.sql
-- Mô tả: Bổ sung bảng document_relationship_clauses quản lý phạm vi sửa đổi mức điều khoản (AUD-APP-02)

CREATE TABLE IF NOT EXISTS document_relationship_clauses (
    clause_rel_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    relationship_id UUID NOT NULL REFERENCES document_relationships(relationship_id) ON DELETE RESTRICT,
    source_clause_ref TEXT NOT NULL,
    target_clause_ref TEXT NOT NULL,
    modification_type TEXT NOT NULL CHECK (modification_type IN ('MODIFY', 'REPLACE', 'REPEAL', 'SUPPLEMENT')),
    summary_of_change TEXT,
    scope_status TEXT NOT NULL DEFAULT 'UNVERIFIED' CHECK (scope_status IN ('UNVERIFIED', 'VERIFIED', 'DISPUTED')),
    created_by TEXT NOT NULL DEFAULT 'system',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_rel_clause_source_target UNIQUE (relationship_id, source_clause_ref, target_clause_ref)
);

CREATE INDEX IF NOT EXISTS idx_rel_clauses_relationship_id ON document_relationship_clauses(relationship_id);
CREATE INDEX IF NOT EXISTS idx_rel_clauses_target_ref ON document_relationship_clauses(target_clause_ref);
CREATE INDEX IF NOT EXISTS idx_rel_clauses_scope_status ON document_relationship_clauses(scope_status);

COMMENT ON TABLE document_relationship_clauses IS 'Lưu trữ chi tiết phạm vi sửa đổi cấp điều khoản giữa các văn bản chính sách (AUD-APP-02)';
COMMENT ON COLUMN document_relationship_clauses.source_clause_ref IS 'Tham chiếu điều khoản thuộc văn bản mới (ví dụ: Điều 5 Khoản 1)';
COMMENT ON COLUMN document_relationship_clauses.target_clause_ref IS 'Tham chiếu điều khoản thuộc văn bản gốc được sửa đổi (ví dụ: Điều 4 Khoản 2)';
COMMENT ON COLUMN document_relationship_clauses.modification_type IS 'Loại sửa đổi: MODIFY (sửa đổi), REPLACE (thay thế), REPEAL (bãi bỏ), SUPPLEMENT (bổ sung)';
COMMENT ON COLUMN document_relationship_clauses.scope_status IS 'Trạng thái xác minh phạm vi: UNVERIFIED, VERIFIED, DISPUTED';
