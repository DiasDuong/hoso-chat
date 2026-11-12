-- ============================================================================
-- SOTRANS HUB - MIGRATION: DOC RISK REMEDIATION (BATCH 1)
-- Date: 2026-11-04
-- Purpose:
--   1. Create document_retrieval_controls for temporary policy governance
--   2. Configure QC-DXM-2026-FLEX as pilot_unverified with disclaimer
--   3. Extend approval_status constraint to support 'pending_review'
--   4. Reset 3 migration relationships to pending_review
--   5. Record audit logs
-- ============================================================================

BEGIN;

-- 1. Create table document_retrieval_controls
CREATE TABLE IF NOT EXISTS public.document_retrieval_controls (
    control_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_version_id UUID NOT NULL REFERENCES public.documents(doc_version_id) ON DELETE CASCADE,
    doc_code TEXT NOT NULL,
    is_official_policy BOOLEAN NOT NULL DEFAULT TRUE,
    is_restricted_general BOOLEAN NOT NULL DEFAULT FALSE,
    retrieval_mode TEXT NOT NULL DEFAULT 'standard', -- 'standard', 'pilot_unverified', 'restricted'
    disclaimer_text TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by TEXT DEFAULT 'system',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_retrieval_control_version UNIQUE (doc_version_id)
);

CREATE INDEX IF NOT EXISTS idx_retrieval_controls_version ON public.document_retrieval_controls (doc_version_id);
CREATE INDEX IF NOT EXISTS idx_retrieval_controls_mode ON public.document_retrieval_controls (retrieval_mode, is_active);

-- 2. Configure control for QC-DXM-2026-FLEX
INSERT INTO public.document_retrieval_controls (
    doc_version_id,
    doc_code,
    is_official_policy,
    is_restricted_general,
    retrieval_mode,
    disclaimer_text,
    is_active,
    created_by
)
SELECT 
    doc_version_id,
    doc_code,
    FALSE AS is_official_policy,
    TRUE AS is_restricted_general,
    'pilot_unverified' AS retrieval_mode,
    'Văn bản là Dự thảo thử nghiệm mô hình làm việc số 2026, áp dụng thí điểm cho Khối Chuyển đổi số, chưa được Ban Nhân sự / Tập đoàn ban hành chính thức thành chính sách chung toàn doanh nghiệp.' AS disclaimer_text,
    TRUE AS is_active,
    'migration_risk_remediation' AS created_by
FROM public.documents
WHERE doc_code = 'QC-DXM-2026-FLEX'
ON CONFLICT (doc_version_id) DO UPDATE SET
    is_official_policy = EXCLUDED.is_official_policy,
    is_restricted_general = EXCLUDED.is_restricted_general,
    retrieval_mode = EXCLUDED.retrieval_mode,
    disclaimer_text = EXCLUDED.disclaimer_text,
    is_active = EXCLUDED.is_active,
    updated_at = NOW();

-- 3. Extend check constraint for approval_status to support 'pending_review'
ALTER TABLE public.document_relationships
    DROP CONSTRAINT IF EXISTS document_relationships_approval_status_check;

ALTER TABLE public.document_relationships
    ADD CONSTRAINT document_relationships_approval_status_check
    CHECK (approval_status = ANY (ARRAY['pending'::text, 'pending_review'::text, 'approved'::text, 'rejected'::text]));

-- 4. Transition the 3 migration relationships to 'pending_review'
UPDATE public.document_relationships
SET approval_status = 'pending_review',
    approved_by = NULL,
    approved_at = NULL,
    notes = COALESCE(notes, '') || ' [Trạng thái: Chờ HR/Legal xác minh và phê duyệt chính thức]'
WHERE approval_status = 'approved' AND approved_by = 'system';

-- 5. Audit Log
INSERT INTO public.document_audit_logs (
    id,
    doc_version_id,
    document_id,
    action,
    actor_user_id,
    actor_username,
    actor_role,
    status_before,
    status_after,
    reason,
    detail,
    created_at
)
VALUES (
    gen_random_uuid(),
    'b8e88d94-b790-4122-be56-99a8b3ae8b74',
    'QUY_CHE_QUY_TRINH',
    'POLICY_GOVERNANCE_RISK_REMEDIATION',
    NULL,
    'system_remediation',
    'SYSTEM',
    'approved',
    'pending_review',
    'Đợt 1: Khắc phục rủi ro QC-DXM-2026-FLEX và chuyển 3 quan hệ migration sang pending_review',
    '{"affected_doc": "QC-DXM-2026-FLEX", "retrieval_mode": "pilot_unverified", "relationships_reset": 3}'::jsonb,
    NOW()
);

COMMIT;
