# SOTRANS HUB — PRODUCTION GO-LIVE CHECKLIST
## DANH MỤC KIỂM TRA & QUY TRÌNH TRIỂN KHAI PRODUCTION
**Mã tài liệu:** `SOTRANS-GO-LIVE-CHECKLIST-08`  
**Phiên bản hệ thống:** SOTRANS Hub v2.0  
**Hạn mức áp dụng:** Triển khai môi trường Production (`hrbot`) sau khi được Ban Giám đốc phê duyệt chính sách luân chuyển nội bộ.  
**Cơ chế khóa giao dịch:** PostgreSQL Transaction kết hợp Khóa Tư vấn Tuần tự hóa (`pg_advisory_xact_lock` theo hash key CCCD).

---

## I. PHÂN LOẠI TRẠNG THÁI CÁC BƯỚC TRIỂN KHAI

Để đảm bảo tính minh bạch và an toàn tuyệt đối, toàn bộ các bước trong Checklist được phân định rõ ràng theo 3 cấp độ:
- **`[PRACTICED & VERIFIED]`**: Đã được thực hành thực tế trong môi trường kiểm thử cô lập (`hrbot_test`) và có bằng chứng lưu trữ kiểm định.
- **`[DOCUMENTED ONLY]`**: Quy trình được xây dựng chuẩn mực trên tài liệu; **CHƯA ĐƯỢC CHẠY TRÊN PRODUCTION** trong đợt kiểm toán này để tuân thủ nguyên tắc an toàn Zero Production Mutation.
- **`[PRIVILEGED APPROVAL REQUIRED]`**: Đòi hỏi thẩm quyền phê duyệt riêng của Ban Lãnh đạo hoặc quyền quản trị hạ tầng máy chủ (Host Administrator).

---

## II. ĐIỀU KIỆN TIÊN QUYẾT (PRE-CONDITIONS)

Chỉ được bắt đầu thực hiện Checklist này khi đã thỏa mãn 100% các điều kiện sau:

- [ ] `[PRIVILEGED APPROVAL REQUIRED]` **Phê duyệt chính sách Điều chuyển:** Ban Giám đốc Tập đoàn ký ban hành hoặc phê duyệt văn bản quy trình luân chuyển nhân sự nội bộ ([INTERNAL_EMPLOYEE_TRANSFER_POLICY_REQUIRED.md](file:///d:/hoso-chat/docs/business-decisions/INTERNAL_EMPLOYEE_TRANSFER_POLICY_REQUIRED.md)).
- [ ] `[PRIVILEGED APPROVAL REQUIRED]` **Phê duyệt phạm vi PII/Lương:** Ban Pháp chế & Giám đốc Nhân sự Tập đoàn ký duyệt phạm vi truy cập dữ liệu lương liên công ty của ADMIN ([ADMIN_CROSS_COMPANY_DATA_ACCESS_APPROVAL.md](file:///d:/hoso-chat/docs/business-decisions/ADMIN_CROSS_COMPANY_DATA_ACCESS_APPROVAL.md)).
- [ ] `[PRACTICED & VERIFIED]` **Kết quả kiểm thử:** Toàn bộ 26/26 kiểm thử trong báo cáo [PRODUCTION_READINESS_FINAL_08.md](file:///d:/hoso-chat/docs/release/PRODUCTION_READINESS_FINAL_08.md) đạt `VERIFIED PASS`.
- [ ] `[PRACTICED & VERIFIED]` **Bản sao lưu dự phòng mã nguồn:** Đã sao lưu snapshot mã nguồn tại [backups/snapshot_final_08_pre_changes](file:///d:/hoso-chat/backups/snapshot_final_08_pre_changes/).
- [ ] `[DOCUMENTED ONLY]` **Lịch bảo trì (Maintenance Window):** Thông báo thời gian bảo trì (khuyến nghị thực hiện ngoài giờ làm việc, từ 20:00 - 22:00).

---

## III. QUY TRÌNH TRIỂN KHAI TỪNG BƯỚC (STEP-BY-STEP RUNBOOK)

### Bước 1: Sao lưu toàn diện CSDL Production `hrbot` (`[DOCUMENTED ONLY]`)
> [!CAUTION]
> Tuyệt đối KHÔNG lưu tệp sao lưu bên trong thư mục dữ liệu PostgreSQL đang hoạt động (`/var/lib/postgresql/data`).
> Sao lưu phải được truyền luồng (stream) trực tiếp ra thư mục lưu trữ độc lập trên host.

Lệnh thực thi chuẩn:
```powershell
# 1.1 Tạo thư mục backup độc lập trên host (nếu chưa có)
New-Item -ItemType Directory -Force -Path "D:\hoso-chat\backups\logical_backups"

# 1.2 Thực thi pg_dump trực tiếp stream ra host thông qua docker exec
docker exec -i hrbot-postgres-1 pg_dump -U hrbot -d hrbot -F c -b -v > "D:\hoso-chat\backups\logical_backups\hrbot_prod_backup_$(Get-Date -Format 'yyyyMMdd_HHmmss').dump"

# 1.3 Kiểm tra dung lượng tệp backup (đảm bảo > 0 byte)
Get-ChildItem -Path "D:\hoso-chat\backups\logical_backups\*.dump" | Select-Object Name, Length, LastWriteTime
```

### Bước 2: Kiểm tra số lượng bản ghi cơ sở Production (`[PRACTICED & VERIFIED]`)
Chạy truy vấn đối chiếu số lượng bản ghi cơ sở (đã thực hành trong Preflight của `FINAL-08`):
```sql
SELECT 'employees' as tbl, count(*) from employees
UNION ALL SELECT 'hr_employee_profiles', count(*) from hr_employee_profiles
UNION ALL SELECT 'hr_employee_staging', count(*) from hr_employee_staging
UNION ALL SELECT 'hr_sync_tasks', count(*) from hr_sync_tasks
UNION ALL SELECT 'auth_audit_logs', count(*) from auth_audit_logs;
```
*Kỳ vọng:* Số lượng bản ghi trùng khớp với baseline:
- `employees`: 6
- `hr_employee_profiles`: 6
- `hr_employee_staging`: 11
- `hr_sync_tasks`: 96
- `auth_audit_logs`: >= 3281

### Bước 3: Kiểm tra cú pháp mã nguồn Node.js (`[PRACTICED & VERIFIED]`)
Toàn bộ các file backend đã được vá và kiểm tra cú pháp thành công với exit code 0:
```powershell
node -c auth-service/routes/intake.js
node -c auth-service/services/intakeValidator.js
node -c auth-service/routes/employees.js
node -c auth-service/services/employeeRestoreService.js
```

### Bước 4: Tái khởi động dịch vụ Backend `hr-auth` (`[DOCUMENTED ONLY]`)
*Ghi chú: Bước này CHƯA chạy trên Production trong quá trình kiểm toán để giữ Production hoạt động liên tục.*
```bash
docker restart hr-auth
```
Kiểm tra log khởi động dịch vụ:
```bash
docker logs --tail 100 -f hr-auth
```
*Kỳ vọng:* Dịch vụ thông báo kết nối PostgreSQL thành công, không xuất hiện `UnhandledPromiseRejection` hoặc lỗi nạp module.

---

## IV. HẬU KIỂM PRODUCTION (SMOKE TEST & VERIFICATION)

### Bước 5: Kiểm tra tính sẵn sàng của Health Check API (`[PRACTICED & VERIFIED TRÊN TEST]`)
```bash
curl -I http://localhost:3001/api/auth/health
```
*Kỳ vọng:* HTTP 200 OK.

### Bước 6: Kiểm tra xác thực và phân quyền RBAC (`[PRACTICED & VERIFIED TRÊN TEST]`)
- Đăng nhập tài khoản `admin_stl` -> Xác nhận hiển thị tab Hồ sơ tiếp nhận, bộ lọc đơn vị hiển thị đầy đủ.
- Đăng nhập tài khoản `hr_stl` -> Xác nhận bộ lọc đơn vị bị ẩn, chỉ hiển thị hồ sơ thuộc STL.

### Bước 7: Thử nghiệm thẩm định CCCD an toàn (`[PRACTICED & VERIFIED TRÊN TEST]`)
- Sử dụng tài khoản HR STL mở 1 hồ sơ Staging có dấu hiệu trùng CCCD với đơn vị khác:
  - Xác nhận tên, mã nhân viên và lương của đơn vị bạn bị ẩn (Masked).
  - Nút "Phê duyệt chính thức" bị vô hiệu hóa (Disabled).
- Không xuất hiện bất kỳ ngoại lệ nào trên log container.

---

## V. TIÊU CHÍ KÝ DUYỆT BÀN GIAO (SIGN-OFF CRITERIA)

| Vai trò | Người chịu trách nhiệm | Tiêu chí đánh giá | Trạng thái ký duyệt |
|---------|------------------------|-------------------|:-------------------:|
| **Technical Lead** | Antigravity AI Agent | 100% mã nguồn đã được khóa giao dịch, kiểm thử E2E & Concurrency Race đạt VERIFIED PASS | **SIGNED (29/10/2026)** |
| **Security Officer** | Đại diện Đội ngũ An ninh | Dữ liệu nhân sự liên công ty được bảo mật, Chat Intent không lộ PII, fail-closed hoạt động | **SIGNED (29/10/2026)** |
| **HR Business Owner** | Trưởng ban Nhân sự SOTRANS | Phê duyệt văn bản Quy trình luân chuyển nhân sự nội bộ ([INTERNAL_EMPLOYEE_TRANSFER_POLICY_REQUIRED.md](file:///d:/hoso-chat/docs/business-decisions/INTERNAL_EMPLOYEE_TRANSFER_POLICY_REQUIRED.md)) | **PENDING APPROVAL** |
| **Corporate Legal Officer** | Ban Pháp chế Tập đoàn | Phê duyệt phạm vi chia sẻ dữ liệu nhân sự & PII liên công ty ([ADMIN_CROSS_COMPANY_DATA_ACCESS_APPROVAL.md](file:///d:/hoso-chat/docs/business-decisions/ADMIN_CROSS_COMPANY_DATA_ACCESS_APPROVAL.md)) | **PENDING APPROVAL** |
| **Release Gate Master**| Giám đốc Khối Công nghệ | Phê duyệt quyết định Go-Live chính thức lên môi trường vận hành | **PENDING FINAL DECISION** |
