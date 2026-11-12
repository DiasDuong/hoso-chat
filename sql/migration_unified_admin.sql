-- ============================================================================
-- MIGRATION: TÁI THIẾT KẾ PHÂN QUYỀN SOTRANS HUB — VAI TRÒ ADMIN DUY NHẤT
-- Ngày: 16/10/2026
-- Mục tiêu:
--   1. Tạo ma trận quyền cho vai trò ADMIN mới (toàn quyền hệ thống).
--   2. Di chuyển các tài khoản quản trị sang ADMIN / HR an toàn.
--   3. Cập nhật ràng buộc users_role_check chỉ chấp nhận ADMIN, HR, EMPLOYEE, USER, GUEST.
--   4. Xóa bỏ SUPER_ADMIN và COMPANY_ADMIN khỏi role_permissions.
-- ============================================================================

BEGIN;

-- 1. Thêm đầy đủ 20 quyền nghiệp vụ cho vai trò mới 'ADMIN' trong role_permissions
INSERT INTO role_permissions (role, permission)
SELECT 'ADMIN', p.permission
FROM (
  SELECT DISTINCT permission FROM role_permissions
  UNION
  SELECT 'hr.profile.edit_code'
  UNION
  SELECT 'hr.profile.transfer_company'
) p
ON CONFLICT DO NOTHING;

-- 2. Cập nhật ràng buộc check constraint trên bảng users để tạm thời chấp nhận cả ADMIN và các vai trò cũ
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check 
  CHECK (role IN ('ADMIN', 'SUPER_ADMIN', 'COMPANY_ADMIN', 'HR', 'EMPLOYEE', 'USER', 'GUEST'));

-- 3. Di chuyển tài khoản Quản trị viên sang vai trò ADMIN
-- Tài khoản quản trị toàn hệ thống: superadmin, admin_stl, admin_swc, admin_vtx
UPDATE users 
SET role = 'ADMIN', company_id = NULL, updated_at = NOW() 
WHERE username = 'superadmin';

UPDATE users 
SET role = 'ADMIN', company_id = NULL, updated_at = NOW() 
WHERE username IN ('admin_stl', 'admin_swc', 'admin_vtx');

-- Tài khoản nhân sự đơn vị: duongminh (STL-002), swc_admin_66249 -> chuyển về vai trò HR theo đơn vị
UPDATE users 
SET role = 'HR', updated_at = NOW() 
WHERE username = 'duongminh' AND company_id = 'STL';

UPDATE users 
SET role = 'HR', updated_at = NOW() 
WHERE username = 'swc_admin_66249' AND company_id = 'SWC';

-- 4. Xác minh không còn tài khoản nào ở vai trò cũ SUPER_ADMIN hoặc COMPANY_ADMIN
DO $$
DECLARE
  legacy_count INT;
BEGIN
  SELECT COUNT(*) INTO legacy_count FROM users WHERE role IN ('SUPER_ADMIN', 'COMPANY_ADMIN');
  IF legacy_count > 0 THEN
    RAISE EXCEPTION 'Vẫn còn % tài khoản mang vai trò cũ chưa được chuyển đổi!', legacy_count;
  END IF;
END $$;

-- 5. Xóa bỏ các bản ghi role_permissions của SUPER_ADMIN và COMPANY_ADMIN
DELETE FROM role_permissions WHERE role IN ('SUPER_ADMIN', 'COMPANY_ADMIN');

-- 6. Cập nhật vĩnh viễn ràng buộc users_role_check: CHỈ CHẤP NHẬN ADMIN, HR, EMPLOYEE, USER, GUEST
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check 
  CHECK (role IN ('ADMIN', 'HR', 'EMPLOYEE', 'USER', 'GUEST'));

-- 7. Ghi nhận nhật ký di chuyển dữ liệu vào auth_audit_logs
INSERT INTO auth_audit_logs (actor_username, action, status, ip_address, metadata, created_at)
VALUES (
  'system_migration',
  'UNIFIED_ADMIN_ROLE_MIGRATION',
  'SUCCESS',
  '127.0.0.1',
  jsonb_build_object(
    'migrated_admins', jsonb_build_array('superadmin', 'admin_stl', 'admin_swc', 'admin_vtx'),
    'migrated_hr', jsonb_build_array('duongminh', 'swc_admin_66249'),
    'timestamp', NOW()
  ),
  NOW()
);

COMMIT;
