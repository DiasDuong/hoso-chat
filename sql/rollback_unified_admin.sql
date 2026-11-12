-- ============================================================================
-- ROLLBACK: KHÔI PHỤC PHÂN QUYỀN SUPER_ADMIN VÀ COMPANY_ADMIN
-- ============================================================================

BEGIN;

-- 1. Nới rộng check constraint
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check 
  CHECK (role IN ('ADMIN', 'SUPER_ADMIN', 'COMPANY_ADMIN', 'HR', 'EMPLOYEE', 'USER', 'GUEST'));

-- 2. Khôi phục quyền SUPER_ADMIN và COMPANY_ADMIN trong role_permissions
INSERT INTO role_permissions (role, permission)
SELECT 'SUPER_ADMIN', permission FROM role_permissions WHERE role = 'ADMIN'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role, permission)
SELECT 'COMPANY_ADMIN', permission FROM role_permissions WHERE role = 'ADMIN'
AND permission NOT IN ('hr.profile.edit_code', 'hr.profile.transfer_company')
ON CONFLICT DO NOTHING;

-- 3. Khôi phục vai trò các tài khoản
UPDATE users SET role = 'SUPER_ADMIN', company_id = NULL, updated_at = NOW() WHERE username = 'superadmin';
UPDATE users SET role = 'COMPANY_ADMIN', company_id = 'STL', updated_at = NOW() WHERE username = 'admin_stl';
UPDATE users SET role = 'COMPANY_ADMIN', company_id = 'SWC', updated_at = NOW() WHERE username = 'admin_swc';
UPDATE users SET role = 'COMPANY_ADMIN', company_id = 'VTX', updated_at = NOW() WHERE username = 'admin_vtx';
UPDATE users SET role = 'COMPANY_ADMIN', company_id = 'STL', updated_at = NOW() WHERE username = 'duongminh';
UPDATE users SET role = 'COMPANY_ADMIN', company_id = 'SWC', updated_at = NOW() WHERE username = 'swc_admin_66249';

-- 4. Xóa quyền ADMIN
DELETE FROM role_permissions WHERE role = 'ADMIN';

-- 5. Cập nhật lại check constraint ban đầu
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check 
  CHECK (role IN ('SUPER_ADMIN', 'COMPANY_ADMIN', 'HR', 'EMPLOYEE', 'USER', 'GUEST'));

-- 6. Ghi nhật ký rollback
INSERT INTO auth_audit_logs (actor_username, action, status, ip_address, metadata, created_at)
VALUES ('system_rollback', 'UNIFIED_ADMIN_ROLE_ROLLBACK', 'SUCCESS', '127.0.0.1', '{}'::jsonb, NOW());

COMMIT;
