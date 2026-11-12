# SOTRANS HUB — BÁO CÁO THỰC THI PHÁT HÀNH PRODUCTION CÓ KIỂM SOÁT
## CONTROLLED PRODUCTION GO-LIVE EXECUTION REPORT
**Mã công việc:** `SOTRANS-PROD-GOLIVE-EXECUTE-09`  
**Dự án:** `D:\hoso-chat`  
**Cơ sở phát hành (Release Baseline):** `SOTRANS-PROD-READINESS-FINAL-08`  
**Thời điểm thực thi:** 2026-10-29T23:04:00+07:00 -> 2026-10-29T23:06:20+07:00  
**Trạng thái phát hành cuối cùng:** **`DEPLOYED AND HEALTHY` (ĐÃ TRIỂN KHAI THỰC TẾ & HOẠT ĐỘNG ỔN ĐỊNH)**  
**Phạm vi áp dụng:** Triển khai có kiểm soát toàn bộ các bản vá kỹ thuật bảo vệ CCCD, kiểm soát giao dịch, RBAC Admin thống nhất và ẩn danh PII. Duy trì chốt chặn Fail-Closed đối với 2 hạng mục chờ phê duyệt nghiệp vụ.

---

## 1. THÔNG SỐ PHIÊN BẢN VÀ HẠ TẦNG TRIỂN KHAI

### 1.1. Thông số phiên bản trước và sau phát hành
- **Phiên bản trước triển khai (Pre-Deploy State):**
  - Trạng thái container `hr-auth`: Chạy tiến trình Node.js nạp từ bộ nhớ trước đợt vá (Up 8 hours, container ID `657b54e4f517`).
  - Bản lưu trữ snapshot mã nguồn trước triển khai: [backups/snapshot_final_08_pre_changes](file:///d:/hoso-chat/backups/snapshot_final_08_pre_changes/).
- **Phiên bản sau triển khai (Deployed Release Version):**
  - Trạng thái container `hr-auth`: Đã reload mã nguồn mới và khởi động lại sạch sẽ (Up, port `127.0.0.1:3000`).
  - Bản lưu trữ Release Artifact chính thức: [backups/golive_execute_09/release_artifact_final_09/](file:///d:/hoso-chat/backups/golive_execute_09/release_artifact_final_09/).
  - Tệp tàng thư CSDL logic: [backups/golive_execute_09/hrbot_prod_backup_pre_golive_09.dump](file:///d:/hoso-chat/backups/golive_execute_09/hrbot_prod_backup_pre_golive_09.dump) (15,288,951 bytes).

### 1.2. Danh mục các service thực tế đã cập nhật
1. **`hr-auth` (Backend Express API):**
   - Nền tảng: `node:20-alpine`, bind-mount từ thư mục `D:\hoso-chat\auth-service` -> `/app`.
   - Các module cập nhật trực tiếp:
     - [auth-service/services/intakeValidator.js](file:///d:/hoso-chat/auth-service/services/intakeValidator.js) (Phòng thủ Fail-Closed khi CSDL lỗi/timeout, chuẩn hóa kiểm tra CCCD).
     - [auth-service/routes/intake.js](file:///d:/hoso-chat/auth-service/routes/intake.js) (Khóa giao dịch Advisory Lock CCCD, làm mờ dữ liệu PII liên công ty cho vai trò HR).
     - [auth-service/routes/employees.js](file:///d:/hoso-chat/auth-service/routes/employees.js) (Đồng bộ khóa Advisory Lock trên `PUT /:id`, `POST /:id/restore`, `POST /:id/reactivate`, kiểm tra format CCCD 9/12 số và kiểm tra chống trùng xuyên công ty).
     - [auth-service/services/employeeRestoreService.js](file:///d:/hoso-chat/auth-service/services/employeeRestoreService.js) (Khóa Advisory Lock cho luồng Batch Restore).
   - Thao tác thực thi: `docker restart hr-auth` (Exit code: 0).
2. **`hr-gateway` (Reverse Proxy Nginx Gateway):**
   - Nền tảng: `nginx:alpine`, bind-mount từ thư mục `D:\hoso-chat\chat` -> `/usr/share/nginx/chat`.
   - Giao diện cập nhật: [chat/hr-admin.html](file:///d:/hoso-chat/chat/hr-admin.html) (Ẩn bộ lọc công ty đối với vai trò HR, cố định phân quyền Staging).
   - Thao tác thực thi: `docker exec hr-gateway nginx -s reload` (Exit code: 0).
3. **`hrbot-postgres-1` (Production Database Container):**
   - **HOÀN TOÀN BẤT BIẾN:** Không restart container CSDL, không chạy migration, không `ALTER TABLE`, không tạo/sửa index.

---

## 2. KẾT QUẢ SAO LƯU & XÁC MINH AN TOÀN TRƯỚC PHÁT HÀNH (PRE-DEPLOY BACKUP)

### 2.1. Bản sao lưu CSDL Production `hrbot`
- **Phương thức sao lưu:** Thực thi `pg_dump -U hrbot -d hrbot -F c -b -v` thông qua container `hrbot-postgres-1` và lưu trực tiếp ra thư mục host độc lập `D:\hoso-chat\backups\golive_execute_09\`.
- **Đường dẫn tệp sao lưu:** `D:\hoso-chat\backups\golive_execute_09\hrbot_prod_backup_pre_golive_09.dump`.
- **Dung lượng tệp:** `15,288,951 bytes` (~15 MB).
- **Kết quả xác minh tính toàn vẹn (Verification via `pg_restore --list`):**
  - Số mục lục TOC: `255 entries`.
  - Định dạng: Custom Format, nén Gzip.
  - Kết quả kiểm tra: **100% VALID & READABLE**.

### 2.2. Kiểm tra tính bất biến của CSDL Production trước và sau phát hành
Truy vấn kiểm tra số lượng bản ghi cơ sở trên CSDL `hrbot`:

| Tên bảng CSDL | Trước phát hành | Sau phát hành & Smoke Test | Trạng thái toàn vẹn |
|---|:---:|:---:|:---:|
| `employees` | **6** | **6** | **100% UNTOUCHED** |
| `hr_employee_profiles` | **6** | **6** | **100% UNTOUCHED** |
| `hr_employee_staging` | **11** | **11** | **100% UNTOUCHED** |
| `hr_sync_tasks` | **96** | **96** | **100% UNTOUCHED** |
| `auth_audit_logs` | **3281** | **3284** | **Bình thường** (ghi log kiểm toán truy cập) |

---

## 3. KẾT QUẢ SMOKE TEST TRỰC TIẾP TRÊN MÔI TRƯỜNG PRODUCTION

Sau khi tái khởi động `hr-auth` và reload `hr-gateway`, bộ kịch bản smoke test độc lập [scratch/smoke_test_production_09.js](file:///d:/hoso-chat/scratch/smoke_test_production_09.js) đã được thực thi trực tiếp đối với các endpoint Production:

| Mã kiểm thử | Tên hạng mục Smoke Test | Phương thức & URL | Kết quả HTTP | Chi tiết đánh giá thực tế | Trạng thái |
|:---:|---|---|:---:|---|:---:|
| **SMOKE-1** | Backend Direct Health Endpoint | `GET http://127.0.0.1:3000/api/health` | **200 OK** | Dịch vụ `hr-auth-service` phản hồi trực tiếp trạng thái `ok`, timestamp thời gian thực. | **PASS** |
| **SMOKE-2** | Gateway Proxy Health Endpoint | `GET http://127.0.0.1:8082/api/health` | **200 OK** | Nginx Reverse Proxy chuyển tiếp chuẩn xác tới backend trên cổng 8082. | **PASS** |
| **SMOKE-3** | Admin Staging Catalog Access | `GET /api/hoso/intake/staging` (Token `admin_stl`) | **200 OK** | Trả về 10 hồ sơ staging với quyền quản trị toàn Tập đoàn để phối hợp điều phối. | **PASS** |
| **SMOKE-4** | HR Staging List Data Sanitization | `GET /api/hoso/intake/staging` (Token `hr_stl`) | **200 OK** | Toàn bộ dữ liệu lương (`salary`) và PII của công ty khác bị ẩn hoàn toàn đối với vai trò HR. | **PASS** |
| **SMOKE-5** | HR Tenant Boundary (403 Forbidden) | `GET /api/hoso/intake/staging/:vtx_id` (Token `hr_stl`) | **403 Forbidden** | Chặn cứng tài khoản HR khi cố tình mở hồ sơ thuộc đơn vị khác (VTX). | **PASS** |
| **SMOKE-6** | Admin Dossier Inspection API | `GET /api/hoso/intake/staging/:id` (Token `admin_stl`) | **200 OK** | Admin mở chi tiết hồ sơ `NGUYEN SYNTHETIC REGRESSION` bình thường để thẩm định. | **PASS** |
| **SMOKE-7** | Inviolable Guard: Mismatch/Dup Block | `POST /api/hoso/intake/approve` (Hồ sơ lệch công ty) | **400 Bad Request** | Kích hoạt chốt chặn Fail-Closed: Từ chối phê duyệt hồ sơ có cờ `company_mismatch`. | **PASS** |
| **SMOKE-8** | CCCD 9/12 Digit Format Guard | `PUT /api/employees/:id` (CCCD = '12345') | **400 Bad Request** | Từ chối cập nhật số CCCD sai định dạng, yêu cầu bắt buộc đúng 9 hoặc 12 số. | **PASS** |
| **SMOKE-9** | Production Core Tables Integrity | Đối chiếu SQL trực tiếp trên `hrbot` | **VERIFIED** | Các bảng cốt lõi (`employees`, `profiles`, `staging`, `tasks`) không bị thay đổi. | **PASS** |

---

## 4. TÌNH TRẠNG CÁC CHỐT CHẶN VÀ CÁC GIỚI HẠN NGHIỆP VỤ CÓ CHỦ ĐÍCH

Phiên bản phát hành này duy trì có chủ đích các giới hạn nghiệp vụ nhằm bảo đảm an toàn dữ liệu tuyệt đối trong khi chờ các văn bản phê duyệt của Ban Lãnh đạo Tập đoàn:

### 4.1. Chốt chặn điều chuyển nhân sự nội bộ (Internal Transfer Guard)
- **Hành vi trên Production:** Nếu hồ sơ ứng viên có số CCCD trùng với nhân sự đang làm việc (`ACTIVE`) tại một công ty thành viên khác của Tập đoàn (STL, SWC, VTX), hệ thống **TIẾP TỤC CHẶN CỨNG (FAIL-CLOSED)** với mã lỗi HTTP 400 và vô hiệu hóa nút phê duyệt trên giao diện.
- **Không cho phép bypass:** Cả Quản trị viên (`ADMIN`) và Chuyên viên Nhân sự (`HR`) đều không thể bỏ qua chốt chặn này.
- **Phạm vi phục vụ:** Các luồng tiếp nhận nhân sự thông thường có số CCCD hợp lệ, không trùng lặp và không lệch đơn vị vẫn được tiếp nhận và phê duyệt hoàn toàn bình thường.
- **Tài liệu tham chiếu:** [docs/business-decisions/INTERNAL_EMPLOYEE_TRANSFER_POLICY_REQUIRED.md](file:///d:/hoso-chat/docs/business-decisions/INTERNAL_EMPLOYEE_TRANSFER_POLICY_REQUIRED.md).

### 4.2. Bảo vệ dữ liệu nhạy cảm PII và Lương liên công ty
- **Hành vi trên Production:**
  - Vai trò `HR` bị chặn 100% không thể xem hồ sơ hoặc dữ liệu của đơn vị khác.
  - Các trường lương và thu nhập tiếp tục được bảo vệ nghiêm ngặt.
- **Tài liệu tham chiếu:** [docs/business-decisions/ADMIN_CROSS_COMPANY_DATA_ACCESS_APPROVAL.md](file:///d:/hoso-chat/docs/business-decisions/ADMIN_CROSS_COMPANY_DATA_ACCESS_APPROVAL.md) (`BUSINESS/SECURITY SIGN-OFF REQUIRED`).

---

## 5. KẾT LUẬN CUỐI CÙNG

```
========================================================================================
                      KẾT QUẢ PHÁT HÀNH CHÍNH THỨC
                         DEPLOYED AND HEALTHY
========================================================================================
1. Dịch vụ hr-auth và hr-gateway đã được cập nhật phiên bản vá lỗi mới nhất và đang vận hành ổn định.
2. 100% các đường ghi CCCD trên hệ thống đã được bảo vệ bằng giao dịch và khóa tư vấn tuần tự hóa.
3. Không có bất kỳ thay đổi nào tác động đến cấu trúc bảng (schema) hay tính toàn vẹn CSDL hrbot.
4. Tệp sao lưu logic đã được lưu trữ an toàn ngoài CSDL PostgreSQL đang hoạt động.
5. Hai vấn đề nghiệp vụ chờ quyết định được khoanh vùng bảo vệ an toàn (Fail-Closed).
========================================================================================
```
