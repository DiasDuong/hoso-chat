-- ============================================================================
-- SOTRANS HUB — PRODUCTION EMPLOYEE HARD DELETE WORKFLOW MIGRATION
-- Mã công việc: HR-PROD-HARD-DELETE-02
-- Migration Version: 20261030_01
-- Environment: PRODUCTION (hrbot)
-- Safety: Additive only. No DROP/TRUNCATE. No modification of existing employees.
-- ============================================================================

-- 1. Quản lý chính sách lưu trữ (Retention Policies)
CREATE TABLE IF NOT EXISTS employee_retention_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id VARCHAR(32) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    policy_name VARCHAR(255) NOT NULL,
    retention_period VARCHAR(64) NOT NULL, -- e.g. '5_YEARS', '10_YEARS', 'PERMANENT'
    applicable_document_types TEXT[] DEFAULT '{}',
    effective_from DATE,
    effective_until DATE,
    approved_by VARCHAR(255),
    approval_status VARCHAR(32) NOT NULL DEFAULT 'PENDING_APPROVAL', -- 'APPROVED', 'PENDING_APPROVAL', 'REVOKED'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_retention_approval_status CHECK (approval_status IN ('APPROVED', 'PENDING_APPROVAL', 'REVOKED', 'EXPIRED'))
);

CREATE INDEX IF NOT EXISTS idx_retention_policies_company ON employee_retention_policies(company_id);
CREATE INDEX IF NOT EXISTS idx_retention_policies_status ON employee_retention_policies(approval_status);

-- 2. Quản lý yêu cầu xóa vĩnh viễn (Hard Delete Requests)
CREATE TABLE IF NOT EXISTS employee_hard_delete_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_code VARCHAR(32) NOT NULL UNIQUE, -- e.g. 'REQ-HD-20261030-0001'
    employee_id UUID NOT NULL REFERENCES employees(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    employee_code_snapshot VARCHAR(64) NOT NULL,
    employee_name_snapshot VARCHAR(255) NOT NULL,
    company_id VARCHAR(32) NOT NULL REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    requester_id UUID NOT NULL REFERENCES users(user_id) ON UPDATE CASCADE ON DELETE RESTRICT,
    reason TEXT NOT NULL,
    retention_policy_id UUID REFERENCES employee_retention_policies(id) ON UPDATE CASCADE ON DELETE SET NULL,
    eligibility_status VARCHAR(32) NOT NULL DEFAULT 'ELIGIBLE', -- 'ELIGIBLE', 'INELIGIBLE', 'MANUAL_REVIEW_REQUIRED'
    request_status VARCHAR(32) NOT NULL DEFAULT 'PENDING_APPROVAL', -- 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXECUTING', 'COMPLETED', 'FAILED'
    manifest_id UUID,
    manifest_hash VARCHAR(64), -- SHA-256
    backup_verified_at TIMESTAMPTZ,
    backup_reference VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    CONSTRAINT chk_hd_request_status CHECK (request_status IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXECUTING', 'COMPLETED', 'FAILED')),
    CONSTRAINT chk_hd_eligibility_status CHECK (eligibility_status IN ('ELIGIBLE', 'INELIGIBLE', 'MANUAL_REVIEW_REQUIRED'))
);

CREATE INDEX IF NOT EXISTS idx_hd_requests_emp_id ON employee_hard_delete_requests(employee_id);
CREATE INDEX IF NOT EXISTS idx_hd_requests_company ON employee_hard_delete_requests(company_id);
CREATE INDEX IF NOT EXISTS idx_hd_requests_status ON employee_hard_delete_requests(request_status);
CREATE INDEX IF NOT EXISTS idx_hd_requests_requester ON employee_hard_delete_requests(requester_id);

-- 3. Quản lý phê duyệt độc lập (4-Eyes Approval)
CREATE TABLE IF NOT EXISTS employee_hard_delete_approvals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES employee_hard_delete_requests(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    approver_id UUID NOT NULL REFERENCES users(user_id) ON UPDATE CASCADE ON DELETE RESTRICT,
    decision VARCHAR(32) NOT NULL, -- 'APPROVED', 'REJECTED'
    approval_reason TEXT NOT NULL,
    approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ip_address VARCHAR(64),
    CONSTRAINT chk_hd_approval_decision CHECK (decision IN ('APPROVED', 'REJECTED'))
);

CREATE INDEX IF NOT EXISTS idx_hd_approvals_request ON employee_hard_delete_approvals(request_id);
CREATE INDEX IF NOT EXISTS idx_hd_approvals_approver ON employee_hard_delete_approvals(approver_id);

-- 4. Quản lý phạm vi dữ liệu bị ảnh hưởng (Scope Manifests)
CREATE TABLE IF NOT EXISTS employee_hard_delete_manifests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES employee_hard_delete_requests(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    manifest_version VARCHAR(16) NOT NULL DEFAULT '1.0',
    manifest_json JSONB NOT NULL,
    manifest_hash VARCHAR(64) NOT NULL, -- SHA-256
    generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    generated_by UUID REFERENCES users(user_id) ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_hd_manifests_request ON employee_hard_delete_manifests(request_id);
CREATE INDEX IF NOT EXISTS idx_hd_manifests_hash ON employee_hard_delete_manifests(manifest_hash);

-- 5. Quản lý thực thi xóa (Execution Records)
CREATE TABLE IF NOT EXISTS employee_hard_delete_executions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES employee_hard_delete_requests(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    execution_status VARCHAR(32) NOT NULL DEFAULT 'STARTED', -- 'STARTED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'EXTERNAL_CLEANUP_PENDING'
    execution_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    execution_completed_at TIMESTAMPTZ,
    executed_by UUID NOT NULL REFERENCES users(user_id) ON UPDATE CASCADE ON DELETE RESTRICT,
    database_result JSONB,
    storage_result JSONB,
    external_sync_result JSONB,
    final_reconciliation JSONB,
    error_details TEXT,
    CONSTRAINT chk_hd_execution_status CHECK (execution_status IN ('STARTED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'EXTERNAL_CLEANUP_PENDING', 'REQUIRES_MANUAL_REVIEW'))
);

CREATE INDEX IF NOT EXISTS idx_hd_executions_request ON employee_hard_delete_executions(request_id);
CREATE INDEX IF NOT EXISTS idx_hd_executions_status ON employee_hard_delete_executions(execution_status);

-- 6. Quản lý nhiệm vụ xử lý hậu commit (Outbox Tasks)
CREATE TABLE IF NOT EXISTS employee_hard_delete_outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES employee_hard_delete_requests(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    task_type VARCHAR(64) NOT NULL, -- 'CLEANUP_STORAGE_FILES', 'CLEANUP_EXTERNAL_SYNC_NOCODB', 'CLEANUP_EXTERNAL_SYNC_GSHEETS', 'RECORD_TOMBSTONE'
    payload JSONB NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING', -- 'PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'
    retry_count INTEGER NOT NULL DEFAULT 0,
    next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    CONSTRAINT chk_hd_outbox_status CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'))
);

CREATE INDEX IF NOT EXISTS idx_hd_outbox_status ON employee_hard_delete_outbox(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_hd_outbox_request ON employee_hard_delete_outbox(request_id);

-- 7. Ghi nhận lịch sử nghiệp vụ (Dedicated Audit)
CREATE TABLE IF NOT EXISTS employee_hard_delete_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID REFERENCES employee_hard_delete_requests(id) ON UPDATE CASCADE ON DELETE SET NULL,
    action VARCHAR(64) NOT NULL, -- 'REQUEST_CREATED', 'PREVIEW_GENERATED', 'REQUEST_APPROVED', 'REQUEST_REJECTED', 'REQUEST_CANCELLED', 'EXECUTION_STARTED', 'EXECUTION_COMPLETED', 'EXECUTION_FAILED', 'OUTBOX_PROCESSED'
    actor_id UUID REFERENCES users(user_id) ON UPDATE CASCADE ON DELETE SET NULL,
    actor_role VARCHAR(32),
    reason TEXT,
    manifest_hash VARCHAR(64),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hd_audit_request ON employee_hard_delete_audit(request_id);
CREATE INDEX IF NOT EXISTS idx_hd_audit_action ON employee_hard_delete_audit(action);
CREATE INDEX IF NOT EXISTS idx_hd_audit_created ON employee_hard_delete_audit(created_at);

-- 8. Bảng Tombstone ngăn chặn tái đồng bộ từ Google Sheets / NocoDB
CREATE TABLE IF NOT EXISTS employee_hard_delete_tombstones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_code VARCHAR(64) NOT NULL UNIQUE,
    citizen_id VARCHAR(32),
    company_id VARCHAR(32) NOT NULL,
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    request_id UUID REFERENCES employee_hard_delete_requests(id) ON UPDATE CASCADE ON DELETE SET NULL,
    manifest_hash VARCHAR(64)
);

CREATE INDEX IF NOT EXISTS idx_hd_tombstones_code ON employee_hard_delete_tombstones(employee_code);
CREATE INDEX IF NOT EXISTS idx_hd_tombstones_citizen ON employee_hard_delete_tombstones(citizen_id);
