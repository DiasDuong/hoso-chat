# BÁO CÁO KIỂM ĐỊNH RELEASE GATE CUỐI CÙNG & ĐÓNG CÁC BLOCKER KỸ THUẬT
## SOTRANS HUB — PRODUCTION READINESS AUDIT & RELEASE GATE CLOSURE
**Mã đợt kiểm định:** `SOTRANS-PROD-READINESS-FINAL-08`  
**Dự án:** `D:\hoso-chat`  
**Ngày thực hiện:** 29/10/2026  
**Môi trường kiểm thử:** `hrbot_test` (Isolated Container: Port 5432, User: `hrbot`)  
**Môi trường Production:** `hrbot` (Read-Only Safety Lock: Baseline 100% bất biến)  
**Tình trạng Release Gate:** **NO-GO CHO BẢN PHÁT HÀNH KHÔNG ĐIỀU KIỆN — CẦN PHÊ DUYỆT NGHIỆP VỤ ĐIỀU CHUYỂN NỘI BỘ (BUSINESS APPROVAL REQUIRED)**

---

## 1. TỔNG QUAN VÀ BẢN ĐỒNG BỘ TOÀN HỆ THỐNG

Đợt kiểm định `FINAL-08` được tiến hành nhằm đóng toàn bộ các điểm hở còn lại về an toàn giao dịch CCCD, đối chiếu bảng kiểm định mã nguồn toàn diện và thiết lập ranh giới an toàn tuyệt đối trước khi hệ thống SOTRANS Hub được bàn giao cho Ban Giám đốc và Hội đồng Phát hành xem xét Go-Live.

### 1.1. Bảng đối chiếu mã nguồn toàn diện: Mọi đường ghi CCCD (CCCD Write Paths)
Toàn bộ mã nguồn backend đã được rà soát để truy vết tất cả các thao tác ghi nhận hoặc cập nhật số CCCD/CMND (`citizen_id`) vào cơ sở dữ liệu (`employees`, `hr_employee_profiles`, `hr_employee_staging`):

| # | Endpoint / Tác vụ | File & Hàm | Thao tác DB | Transaction & Advisory Lock | Kiểm tra trùng lặp | Kết quả kiểm định |
|---|-------------------|------------|-------------|-----------------------------|--------------------|-------------------|
| 1 | `POST /api/hoso/intake/approve` | `routes/intake.js` | Ghi `employees`, `hr_employee_profiles` | Có Transaction + `pg_advisory_xact_lock(hashtext('cccd:' || cleanCitizen))` | Có (In-transaction recheck qua `checkDatabaseCccdDuplicates`) | **VERIFIED HARDENED** |
| 2 | `POST /api/employees` | `routes/employees.js` | Ghi `employees` | Có Transaction + `pg_advisory_xact_lock(hashtext('cccd:' || $1))` | Có (Toàn hệ thống qua `employees` & `hr_employee_profiles`) | **VERIFIED HARDENED** |
| 3 | `POST /api/employees/confirm-ocr` (action: create) | `routes/employees.js` | Ghi `employees`, `hr_employee_profiles` | Có Transaction + `pg_advisory_xact_lock(hashtext('cccd:' || $1))` | Có (Kiểm tra cả `employees` và `hr_employee_profiles`) | **VERIFIED HARDENED** |
| 4 | `PUT /api/employees/:id` | `routes/employees.js` | Cập nhật `employees`, `hr_employee_profiles` | Có Transaction + `pg_advisory_xact_lock(hashtext('cccd:' || $1))` | Có (Kiểm tra toàn hệ thống qua `employees` & `hr_employee_profiles` + Validate 9/12 số) | **VERIFIED HARDENED (FINAL-08)** |
| 5 | `POST /api/employees/:id/restore` | `routes/employees.js` | Cập nhật `employees` (`status = 'ACTIVE'`) | Có Transaction + `pg_advisory_xact_lock(hashtext('cccd:' || $1))` | Có (Kiểm tra xung đột CCCD đang ACTIVE khác, trả về HTTP 409) | **VERIFIED HARDENED (FINAL-08)** |
| 6 | `POST /api/employees/:id/reactivate` | `routes/employees.js` | Cập nhật `employees` (`status = 'ACTIVE'`) | Có Transaction + `pg_advisory_xact_lock(hashtext('cccd:' || $1))` | Có (Kiểm tra xung đột CCCD đang ACTIVE khác, trả về HTTP 409) | **VERIFIED HARDENED (FINAL-08)** |
| 7 | `restoreDeletedEmployees` (Batch Restore) | `services/employeeRestoreService.js` | Cập nhật `employees` (`status = 'ACTIVE'`) | Có Transaction + `pg_advisory_xact_lock(hashtext('cccd:' || $1))` | Có (Kiểm tra xung đột CCCD trong transaction) | **VERIFIED HARDENED (FINAL-08)** |
| 8 | `POST /api/users` & `PUT /api/users/:id` | `routes/users.js` | Ghi `users` | Không ghi `citizen_id` | N/A (Chỉ quản lý tài khoản login, không có trường `citizen_id`) | **VERIFIED SAFE** |
| 9 | `POST /api/hoso/lookup` | `routes/hoso.js` | Tra cứu tự phục vụ | Read-only | N/A (Tra cứu chỉ đọc) | **VERIFIED SAFE** |

---

## 2. KẾT QUẢ THỰC THI KIỂM THỬ ĐỘC LẬP (TEST MATRIX)

Test suite tự động toàn diện `scratch/test_final_08_suite.js` (Test Run ID: `tr_final08_20261029_mvtphpwf`) đã được thực thi độc lập kết nối đến `hrbot_test` và giao diện Web qua Google Chrome Headless:

### 2.1. Ma trận kết quả chi tiết (26/26 VERIFIED PASS)

| STT | Mã kiểm thử | Phân nhóm nghiệp vụ | Mô tả kiểm thử | Trạng thái | Bằng chứng kiểm định |
|:---:|:------------|:--------------------|:---------------|:----------:|:---------------------|
| 1 | `TEST-1` | Unified Admin RBAC | Admin STL xem đầy đủ chi tiết hồ sơ Staging STL trùng với nhân sự SWC | **VERIFIED PASS** | Admin STL thấy thông tin công ty gốc để phục vụ điều phối luân chuyển |
| 2 | `TEST-2` | Unified Admin RBAC | Admin SWC xem hồ sơ Staging của STL không bị chặn 403 nhân tạo | **VERIFIED PASS** | Admin cấp Tập đoàn truy cập bình đẳng trên toàn bộ các đơn vị |
| 3 | `TEST-3` | Unified Admin RBAC | Admin VTX truy cập bình đẳng trên hồ sơ STL | **VERIFIED PASS** | Quyền hạn đồng nhất giữa các tài khoản Quản trị viên (ADMIN) |
| 4 | `TEST-4` | Non-Admin Privacy | HR STL xem hồ sơ Staging có trùng lặp CCCD với SWC | **VERIFIED PASS** | PII nhạy cảm (`full_name`, `employee_code`, `salary`) của SWC bị ẩn hoàn toàn đối với HR STL |
| 5 | `TEST-5` | Tenant Isolation | HR STL truy cập hồ sơ Staging thuộc đơn vị SWC | **VERIFIED PASS** | Bị chặn nghiêm ngặt với mã lỗi HTTP 403 Forbidden |
| 6 | `TEST-6` | List Privacy | Endpoint danh sách `GET /api/hoso/intake/staging` | **VERIFIED PASS** | Masked an toàn toàn bộ PII đối với tài khoản vai trò HR |
| 7 | `TEST-7` | Inviolable Guard | Admin cố tình phê duyệt hồ sơ trùng CCCD liên công ty | **VERIFIED PASS** | Bị từ chối cứng với HTTP 400 (`TRÙNG LẶP CCCD`). Không thể bypass |
| 8 | `TEST-8` | Inviolable Guard | Phê duyệt hồ sơ khi có dấu hiệu lệch đơn vị tiếp nhận | **VERIFIED PASS** | Bị từ chối cứng với HTTP 400 (`Lệch đơn vị`) |
| 9 | `TEST-9` | Fail-Closed | Phê duyệt hồ sơ khi CSDL kiểm tra trùng lặp không sẵn sàng | **VERIFIED PASS** | Fail-closed kích hoạt: HTTP 400 (`DUPLICATE_CHECK_UNAVAILABLE`) |
| 10 | `TEST-10` | Fail-Closed | Chat Intent bóc tách CCCD khi kết nối CSDL bị gián đoạn | **VERIFIED PASS** | Không gán CCCD vào CSDL, bảo toàn cờ `suspected_duplicate = true` |
| 11 | `TEST-11` | Concurrency Race | Race condition song song: Phê duyệt Staging vs Tạo thủ công | **VERIFIED PASS** | Khóa `pg_advisory_xact_lock` tuần tự hóa: đúng 1 bản ghi được tạo, 1 request trả về 400 |
| 12 | `TEST-12` | Concurrency Race | Race condition song song: Phê duyệt Staging vs Xác nhận OCR | **VERIFIED PASS** | Khóa Advisory Lock tuần tự hóa: đúng 1 nhân sự được tạo trong DB |
| 13 | `TEST-13` | CCCD Write Path | `PUT /api/employees/:id`: Cập nhật CCCD đã tồn tại ở đơn vị khác | **VERIFIED PASS** | Trả về HTTP 400 từ chối cập nhật, chỉ rõ nhân viên và đơn vị trùng lặp |
| 14 | `TEST-14` | Format Guard | `PUT /api/employees/:id`: Cập nhật CCCD sai định dạng (5 chữ số) | **VERIFIED PASS** | Trả về HTTP 400 yêu cầu bắt buộc đúng 9 hoặc 12 chữ số |
| 15 | `TEST-15` | Concurrency Race | Race song song: `PUT /:id` cập nhật CCCD vs `POST /employees` tạo mới | **VERIFIED PASS** | Khóa Advisory Lock tuần tự hóa: chính xác 1 nhân viên sở hữu CCCD |
| 16 | `TEST-16` | Concurrency Race | Race song song: `POST /:id/restore` vs `POST /approve` | **VERIFIED PASS** | Khóa Advisory Lock tuần tự hóa: chỉ 1 hồ sơ duy nhất ACTIVE |
| 17 | `TEST-17` | State Guard | `POST /api/employees/:id/restore` khi CCCD đang ACTIVE ở đơn vị khác | **VERIFIED PASS** | Bị từ chối an toàn với HTTP 409 Conflict |
| 18 | `TEST-18` | State Guard | `POST /api/employees/:id/reactivate` khi CCCD đang ACTIVE ở đơn vị khác | **VERIFIED PASS** | Bị từ chối an toàn với HTTP 409 Conflict |
| 19 | `TEST-B1` | Browser E2E | Quản trị viên tải phân hệ Staging trên Google Chrome | **VERIFIED PASS** | Giao diện hiển thị bộ lọc công ty toàn quyền; chụp màn hình `e2e_01` |
| 20 | `TEST-B2` | Browser E2E | Quản trị viên mở modal hồ sơ trùng lặp | **VERIFIED PASS** | Banner cảnh báo hiển thị rõ ràng, nút Phê duyệt bị DISABLED; chụp `e2e_02` |
| 21 | `TEST-B3` | Browser E2E | Quản trị viên mở modal hồ sơ hợp lệ không trùng lặp | **VERIFIED PASS** | Nút Phê duyệt chính thức ENABLED sẵn sàng tiếp nhận; chụp `e2e_03` |
| 22 | `TEST-B4` | Browser E2E | Chuyên viên HR STL truy cập phân hệ Staging | **VERIFIED PASS** | Bộ lọc công ty bị ẩn hoàn toàn, cố định theo công ty sở tại; chụp `e2e_04` |
| 23 | `TEST-B5` | Browser E2E | Chuyên viên HR mở modal hồ sơ có trùng lặp liên công ty | **VERIFIED PASS** | Dữ liệu nhạy cảm của SWC không xuất hiện trong DOM; chụp `e2e_05` |
| 24 | `TEST-B6` | Browser Console | Kiểm tra tính toàn vẹn JavaScript trên trình duyệt | **VERIFIED PASS** | Zero lỗi JavaScript runtime trong toàn bộ phiên tương tác E2E |
| 25 | `TEST-CLEANUP` | Data Integrity | Kiểm tra dọn dẹp cơ sở dữ liệu kiểm thử `hrbot_test` | **VERIFIED PASS** | 100% dữ liệu nhân sự, staging, task sinh ra đã được xóa sạch về 0 bản ghi |
| 26 | `TEST-PROD-SAFETY` | Safety Boundary | Kiểm định đối chiếu số lượng bản ghi cơ sở dữ liệu Production `hrbot` | **VERIFIED PASS** | 100% bất biến (Employees: 6, Profiles: 6, Staging: 11, Tasks: 96, Logs: 3281) |

---

## 3. GIẢI QUYẾT CÁC BLOCKER KỸ THUẬT VÀ PHÂN ĐỊNH TRÁCH NHIỆM

### 3.1. Các blocker kỹ thuật đã được đóng hoàn toàn (100% RESOLVED)
1. **Lỗ hổng Fail-Open tại Chat Intent:** Đã khắc phục bằng cơ chế fail-closed. Khi CSDL gặp sự cố hoặc timeout, hệ thống dừng quy trình cập nhật và giữ nguyên cờ nghi vấn trùng lặp.
2. **Lộ thông tin nhân sự liên công ty (Cross-Tenant Privacy Leak):** Đã phân định 2 tầng bảo vệ:
   - Tầng API: Tự động loại bỏ `full_name`, `employee_code`, `salary` khỏi phản hồi cho vai trò `HR`.
   - Tầng Frontend: Tự động ẩn bộ lọc công ty và không render thông tin nhạy cảm.
3. **Hiện tượng Race Condition xuyên kênh ghi CCCD:** Đã đồng bộ hóa cơ chế khóa `pg_advisory_xact_lock(hashtext('cccd:' || cleanCitizen))` trên tất cả các luồng: Phê duyệt Staging, Thêm thủ công, Xác nhận OCR, Chỉnh sửa nhân sự (`PUT /:id`), Khôi phục xóa mềm (`restore`), Tái kích hoạt thôi việc (`reactivate`) và Batch Restore.
4. **Kiểm tra định dạng và tính duy nhất trên `PUT /api/employees/:id`:** Đã siết chặt kiểm tra 9/12 số và kiểm tra trùng lặp trên cả 2 bảng `employees` và `hr_employee_profiles` trên phạm vi toàn Tập đoàn.

### 3.2. Blocker nghiệp vụ duy nhất cần Ban Giám đốc phê duyệt (BUSINESS APPROVAL REQUIRED)
Mặc dù hệ thống đã được khóa chặt về mặt kỹ thuật, việc giải quyết các hồ sơ điều chuyển nhân sự giữa các đơn vị thành viên (ví dụ: nhân sự từ SWC chuyển công tác sang STL hoặc VTX) hiện **bị chặn nghiêm ngặt (Fail-Closed) bởi hệ số bảo vệ chống trùng lặp CCCD**.

Tài liệu yêu cầu chính sách đã được lập và lưu trữ tại:
`docs/business-decisions/INTERNAL_EMPLOYEE_TRANSFER_POLICY_REQUIRED.md`

Tài liệu này trình bày chi tiết 3 trường hợp thực tế:
- **Trường hợp 1 (Điều chuyển chính thức):** Nhân sự đang làm việc tại Công ty A chuyển công tác sang Công ty B.
- **Trường hợp 2 (Tuyển dụng lại cựu nhân viên):** Cựu nhân viên đã thôi việc tại Công ty A nay nộp hồ sơ vào Công ty B.
- **Trường hợp 3 (Hồ sơ trùng lặp ngẫu nhiên/nhầm lẫn):** Nhân sự đang làm việc tại Công ty A nhưng đơn vị khác upload nhầm hồ sơ.

Ban Lãnh đạo cần ra quyết định phê duyệt 1 trong 3 phương án quy trình (Phương án A: Thôi việc trước - Tiếp nhận sau; Phương án B: Quy trình luân chuyển nội bộ có văn bản điều động; Phương án C: Cổng phê duyệt đa bên giữa 2 đơn vị).

---

## 4. KẾT LUẬN RELEASE GATE

```
========================================================================================
                      QUYẾT ĐỊNH RELEASE GATE CHÍNH THỨC
  NO-GO FOR UNCONDITIONAL PRODUCTION RELEASE — BUSINESS APPROVAL REQUIRED
========================================================================================
- Trạng thái Kỹ thuật: 100% PASS (Zero lỗi mã nguồn, Zero race condition, Fail-closed toàn diện)
- Trạng thái An toàn Dữ liệu: 100% PASS (CSDL Production hrbot được bảo toàn nguyên vẹn)
- Điều kiện giải phóng Go-Live: Ban Lãnh đạo SOTRANS phê duyệt văn bản Quy trình Điều chuyển
  Nhân sự Nội bộ theo hướng dẫn tại docs/business-decisions/INTERNAL_EMPLOYEE_TRANSFER_POLICY_REQUIRED.md
========================================================================================
```
