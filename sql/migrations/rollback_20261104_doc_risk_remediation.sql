-- ============================================================================
-- SOTRANS HUB - SAFE ROLLBACK: DOC RISK REMEDIATION (BATCH 1 & 1.1)
-- Date: 2026-11-04
-- ============================================================================
-- [CẢNH BÁO AN TOÀN VẬN HÀNH / SAFETY DIRECTIVE]:
-- 1. TUYỆT ĐỐI KHÔNG DROP TABLE `document_retrieval_controls`.
--    Việc xóa bảng sẽ làm gãy truy vấn n8n workflow và Backend API.
-- 2. TUYỆT ĐỐI KHÔNG TỰ ĐỘNG CHUYỂN `pending_review` THÀNH `approved`.
--    Không gán `approved_by = 'system'` hoặc bất kỳ danh tính giả mạo nào.
--    Các quan hệ văn bản PHẢI giữ nguyên `pending_review` cho tới khi có
--    phê duyệt chính thức bằng văn bản của HR / Legal.
-- 3. ĐỌC KỸ RUNBOOK TRƯỚC KHI THỰC HIỆN:
--    `docs/DOC_GOVERNANCE_SAFE_ROLLBACK_RUNBOOK.md`
-- ============================================================================

BEGIN;

-- 1. Safe Feature Rollback: Vô hiệu hóa cấu hình kiểm soát mà không xóa bảng
--    (Đảm bảo tính tương thích ngược với n8n workflow và Backend)
UPDATE public.document_retrieval_controls
SET is_active = false,
    updated_at = NOW()
WHERE doc_code = 'QC-DXM-2026-FLEX';

-- 2. Giữ nguyên trạng thái an toàn của quan hệ văn bản (pending_review)
--    Ghi chú bổ sung lịch sử rollback kỹ thuật nếu có yêu cầu
UPDATE public.document_relationships
SET notes = notes || ' | [Rollback Notice: Cấu hình kiểm soát tạm thời ngắt kích hoạt]'
WHERE approval_status = 'pending_review' 
  AND notes NOT LIKE '%[Rollback Notice%';

-- 3. Ghi audit log chuẩn mực cho thao tác hoàn nguyên tính năng
INSERT INTO public.document_audit_logs (
    id,
    doc_version_id,
    document_id,
    action,
    actor_username,
    actor_role,
    reason,
    detail,
    created_at
)
VALUES (
    gen_random_uuid(),
    'b8e88d94-b790-4122-be56-99a8b3ae8b74',
    'QC-DXM-2026-FLEX',
    'SAFE_FEATURE_ROLLBACK',
    'operator',
    'ADMIN',
    'Thực hiện hoàn nguyên an toàn tính năng kiểm soát truy xuất (Level A: Safe Feature Rollback)',
    '{"mode": "SAFE_FEATURE_ROLLBACK", "table_dropped": false, "relationships_preserved": true}'::jsonb,
    NOW()
);

COMMIT;
