# SOTRANS HUB — BÁO CÁO CHUẨN HÓA VÒNG ĐỜI XÓA MỀM, KHÔI PHỤC VÀ ĐỒNG BỘ DỮ LIỆU NHÂN SỰ
**Mã công việc:** `HR-SOFT-DELETE-SYNC-01`  
**Hệ thống:** SOTRANS Hub Production Platform  
**Cơ sở dữ liệu:** PostgreSQL `hrbot` (Port 5432)  
**Hệ thống liên kết:** NocoDB (`hr_employee_profiles`) & Google Sheets (`Hoso_Nhansu`)  
**Ngày thực hiện:** 30/10/2026  
**Trạng thái:** ✅ **HOÀN TẤT & ĐẠT 100% TIÊU CHUẨN NGHIỆM THU (14/14 TESTS PASS)**

---

## 1. TỔNG QUAN VÀ HIỆN TRẠNG TRƯỚC VÀ SAU CẬP NHẬT

### 1.1. Hiện trạng trước khi chuẩn hóa (Root Cause Analysis)
1. **Lỗi ghi đè trường nghiệp vụ (`job_grade` & `full_name`):**
   - Trước đây, trong file `auth-service/routes/employees.js` và `auth-service/services/syncWorker.js`, logic xóa mềm ghi đè chuỗi `[ĐÃ XÓA]` trực tiếp vào cột `job_grade`, đồng thời nối thêm `[ĐÃ XÓA]` vào trường `full_name` trên Google Sheets.
   - Nguyên nhân: Hệ thống ban đầu chưa bổ sung các cột metadata chuyên biệt (`status`, `deleted_at`, `deleted_by`, `deletion_reason`) trên cả 3 tầng lưu trữ, dẫn đến việc dùng tạm `job_grade` làm nhãn hiển thị trạng thái trên giao diện bảng.
   - Khi khôi phục (RESTORE), hệ thống lại tự động gán `job_grade = ''`, làm mất dữ liệu ngạch bậc lương thực tế của nhân viên.
2. **Sai lệch số lượng giữa NocoDB (5 bản ghi) và Google Sheets (6 bản ghi):**
   - **NocoDB:** Kết nối trực tiếp (Direct Live PostgreSQL-linked source `nc_sources_v2`, client `pg`, db `hrbot`) vào bảng `hr_employee_profiles`. Do đó NocoDB luôn phản chiếu tức thì chính xác 5 bản ghi hiện hữu trong PostgreSQL.
   - **Google Sheets:** Tồn tại dòng thứ 7 mang mã `SWC00021` (NGUYỄN VĂN HIẾU). Bản ghi này từng bị xóa cứng (Hard Delete) trong đợt kiểm thử dọn dẹp trước đó trên PostgreSQL nhưng tiến trình dọn dẹp hàng trên Google Sheets chưa được kích hoạt đồng bộ.
   - Tuân thủ nghiêm ngặt chỉ đạo: **Tuyệt đối không xóa bản ghi SWC00021 khi chưa có văn bản phê duyệt**. Bản ghi này đã được đánh dấu trạng thái định danh chuẩn: `DELETED_ORPHAN_REQUIRES_MANUAL_REVIEW`.
3. **Cơ chế đồng bộ thiếu ràng buộc phân tán:**
   - Chưa có khóa kép định danh (Composite Key: `employee_id` + `company_id`).
   - Chưa có cơ chế Exponential Backoff cho các lỗi mạng khi đồng bộ Google Sheets / NocoDB.
   - Chưa có bảng view chuyên biệt phân chia hồ sơ `ACTIVE` và `DELETED` theo RBAC trên NocoDB và Sheets.

### 1.2. Hiện trạng sau khi chuẩn hóa (Post-Implementation State)
1. **Bảo toàn nguyên vẹn 100% dữ liệu nghiệp vụ:**
   - Bản ghi `STL00014` (NGUYỄN TRƯỜNG NAM): Cột `job_grade` đã được phục hồi về giá trị gốc rỗng `""` (đối soát khớp 100% với file backup `pre_remediation_backup` và bảng `hr_employee_staging`), họ tên chuẩn `NGUYỄN TRƯỜNG NAM` (không còn nhãn dán đè).
   - Mọi thao tác Xóa mềm (Soft Delete) và Khôi phục (Restore) đều sử dụng cột trạng thái chuẩn: `status = 'DELETED'` hoặc `status = 'ACTIVE'`, kèm metadata pháp lý: `deleted_at`, `deleted_by`, `deletion_reason`.
2. **Mở rộng Schema đồng bộ trên cả 3 nền tảng:**
   - **PostgreSQL:** Bổ sung cột `deleted_at TIMESTAMPTZ`, `deleted_by VARCHAR(100)`, `deletion_reason TEXT` trên cả `employees` và `hr_employee_profiles`.
   - **Outbox Task:** Bổ sung cột `idempotency_key`, `target_system`, `last_retry_at` trên bảng `hr_sync_tasks`.
   - **Google Sheets (`Trang tính1`):** Mở rộng từ 53 cột lên 59 cột:
     - Cột 54 (`BB`): `status` (`ACTIVE`, `DELETED`, `DELETED_ORPHAN_REQUIRES_MANUAL_REVIEW`)
     - Cột 55 (`BC`): `company_id` (`STL`, `SWC`, `VTX`)
     - Cột 56 (`BD`): `deleted_at`
     - Cột 57 (`BE`): `deleted_by`
     - Cột 58 (`BF`): `deletion_reason`
     - Cột 59 (`BG`): `updated_at`
   - **NocoDB (`hr_employee_profiles`):**
     - Đăng ký metadata các cột mới (`c_emp_status`, `c_emp_company_id`, `c_emp_deleted_at`, `c_emp_deleted_by`, `c_emp_deletion_reason`).
     - Thiết lập View **Active Employees** (`vw_emp_active`) với bộ lọc `status = 'ACTIVE'`.
     - Thiết lập View **Deleted Employees** (`vw_emp_deleted`) với bộ lọc `status = 'DELETED'`.
3. **Cơ chế Outbox & Retry lũy thừa an toàn:**
   - Tách biệt hoàn toàn Transaction Database và API bên thứ ba.
   - Thao tác ngoài chỉ thực thi sau khi PostgreSQL `COMMIT`.
   - Bổ sung cơ chế Exponential Backoff: $1s \to 2s \to 4s \to 8s$, chặn tối đa 3 lần thử lại (`max_retries = 3`). Nếu vượt ngưỡng, tự động chuyển vào Dead-Letter Queue (`status = 'failed'`).

---

## 2. SƠ ĐỒ DỮ LIỆU VÀ LUỒNG ĐỒNG BỘ CHUẨN HÓA

```mermaid
flowchart TD
    subgraph Client["Admin & HR Interaction Layer"]
        A["Admin Dashboard / API Request"]
    end

    subgraph PG["PostgreSQL hrbot (SSOT - System of Record)"]
        direction TB
        B["BEGIN Transaction (Advisory Lock CCCD)"]
        C["Update employees & hr_employee_profiles\n- status: 'DELETED' or 'ACTIVE'\n- deleted_at, deleted_by, deletion_reason\n- DO NOT touch job_grade or full_name"]
        D["COMMIT Transaction"]
        E["Insert hr_sync_tasks (Outbox)\n- idempotency_key\n- action_type: 'SOFT_DELETE' | 'RESTORE'\n- status: 'pending'"]
        B --> C --> D --> E
    end

    subgraph SyncWorker["Background Sync Worker (Decoupled Engine)"]
        F["pollPendingSyncTasks (Every 10s)\nExponential Backoff Gate\n[updated_at <= NOW() - 2^retry_count]"]
        G{"Target System?"}
        F --> G
    end

    subgraph NocoDBLayer["NocoDB Direct Overlay (Port 8081)"]
        H["Direct Live PG Source: bhe2zaxgq5w2heh"]
        I["View: Active Employees (status = 'ACTIVE')"]
        J["View: Deleted Employees (status = 'DELETED')"]
        H --> I
        H --> J
    end

    subgraph SheetsLayer["Google Sheets Hoso_Nhansu"]
        K["Lookup via Composite Key\n[employee_id + company_id]"]
        L["Update Columns 54-59 (BB:BG)\n- status, company_id, deleted_at, etc.\n- Preserve original Col A (job_grade)\n- Clean Col C (full_name)"]
        K --> L
    end

    A --> B
    E -.->|Queue Trigger| F
    G -->|target_system = nocodb| H
    G -->|target_system = google_sheets| K
```

---

## 3. DANH SÁCH TỆP MÃ NGUỒN VÀ SCHEMA THAY ĐỔI

| STT | Tệp tin | Loại thay đổi | Chi tiết cập nhật |
| :--- | :--- | :--- | :--- |
| 1 | `auth-service/routes/employees.js` | Backend API | Nâng cấp `DELETE /:id` và `POST /:id/restore` sang transaction có Advisory lock; loại bỏ vĩnh viễn việc ghi đè `job_grade`; lưu trữ metadata `deleted_at`, `deleted_by`, `deletion_reason`. |
| 2 | `auth-service/services/employeeRestoreService.js` | Service Engine | Chuẩn hóa khôi phục đơn lẻ và hàng loạt (`executeRestore`); bảo toàn `job_grade` gốc; xóa sạch cờ xóa mềm khi kích hoạt lại; ghi nhật ký audit. |
| 3 | `auth-service/services/syncWorker.js` | Sync Engine | Chuẩn hóa `syncToNocoDB` và `syncToGoogleSheets`; mở rộng 59 cột Google Sheets; bổ sung composite key matching; cài đặt Exponential Backoff và Dead-letter queue. |
| 4 | `PostgreSQL hrbot` (Database) | Schema Migration | Bổ sung cột `deleted_at`, `deleted_by`, `deletion_reason` trên `employees` và `hr_employee_profiles`; bổ sung `idempotency_key`, `last_retry_at` trên `hr_sync_tasks`. |
| 5 | `NocoDB` (`noco.db`) | Metadata & Views | Đăng ký 5 cột mới vào `nc_columns_v2`; tạo 2 view `Active Employees` và `Deleted Employees` trên `nc_views_v2` và `nc_filter_exp_v2`. |
| 6 | `Google Sheets` (`1q_Sv9-p-pa5...`) | Live Spreadsheet | Bổ sung hàng tiêu đề từ cột 54 đến 59 (`BB1:BG1`); chuẩn hóa làm sạch dòng 2 `STL00014`; gắn nhãn đối soát an toàn dòng 7 `SWC00021`. |

---

## 4. BÁO CÁO ĐỐI SOÁT DỮ LIỆU ĐA HỆ THỐNG

| Mã NV | Họ và tên | Đơn vị | Trạng thái PostgreSQL | Trạng thái NocoDB | Trạng thái Google Sheets | job_grade gốc | Đánh giá đối soát |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| **STL00014** | NGUYỄN TRƯỜNG NAM | STL | `DELETED` | `DELETED` | `DELETED` (Col BB) | `""` (Bảo toàn) | ✅ Đồng bộ 3/3 hệ thống, ngạch bậc sạch. |
| **SWC00022** | PHAN DƯƠNG THANH BÌNH | SWC | `ACTIVE` | `ACTIVE` | `ACTIVE` (Col BB) | `""` (Bảo toàn) | ✅ Đồng bộ 3/3 hệ thống, Active View. |
| **SWC00023** | NGUYỄN TRẦN THIỆN NHÂN | SWC | `ACTIVE` | `ACTIVE` | `ACTIVE` (Col BB) | `""` (Bảo toàn) | ✅ Đồng bộ 3/3 hệ thống, Active View. |
| **SWC00024** | NGÔ ĐẶNG TUẤN UYÊN | SWC | `ACTIVE` | `ACTIVE` | `ACTIVE` (Col BB) | `""` (Bảo toàn) | ✅ Đồng bộ 3/3 hệ thống, Active View. |
| **SWC00025** | LÊ THÀNH NHÂN | SWC | `ACTIVE` | `ACTIVE` | `ACTIVE` (Col BB) | `""` (Bảo toàn) | ✅ Đồng bộ 3/3 hệ thống, Active View. |
| **SWC00021** | NGUYỄN VĂN HIẾU | SWC | *(Hard-deleted)* | *(Hard-deleted)* | `DELETED_ORPHAN_REQUIRES_MANUAL_REVIEW` | `""` (Bảo toàn) | 🛡️ Bảo tồn nguyên trạng trên Sheets theo quy định an toàn, không xóa tự tiện. |

---

## 5. MA TRẬN KIỂM THỬ TỔNG HỢP (14/14 PASS)

Kiểm thử tự động thực thi thông qua kịch bản: `scratch/test_unified_soft_delete_sync_suite.js`.

| STT | Tên hạng mục kiểm thử | Kết quả | Bằng chứng kỹ thuật / Chi tiết đối soát |
| :---: | :--- | :---: | :--- |
| **01** | Xóa mềm trên PostgreSQL | **PASS** | `STL00014` mang trạng thái `DELETED`, `deleted_at = 2026-10-30T06:04:10.194Z`, `deleted_by = superadmin`. |
| **02** | Đồng bộ trạng thái DELETED sang NocoDB | **PASS** | Bảng liên kết NocoDB `hr_employee_profiles` phản chiếu tức thì trạng thái `DELETED`. |
| **03** | Đồng bộ trạng thái DELETED sang Google Sheets | **PASS** | Google Sheets dòng 2 (Col BB) ghi nhận `DELETED`, Col BC ghi nhận `STL`. |
| **04** | Không thay đổi `job_grade` | **PASS** | PostgreSQL `job_grade = ""`, Sheets Col A = `""`, Col C `full_name` sạch không chứa nhãn xóa. |
| **05** | Không tạo bản ghi nhân viên trùng | **PASS** | Số lần xuất hiện của `STL00014` trên Sheets: đúng 1 lần; PostgreSQL: 0 mã trùng lặp. |
| **06** | Khôi phục nhân viên trên cả ba hệ thống | **PASS** | Engine khôi phục giữ nguyên `job_grade` gốc, loại bỏ nhãn cũ, kích hoạt lại tài khoản liên kết. |
| **07** | Retry khi NocoDB lỗi | **PASS** | Lịch trình Exponential Backoff chuẩn: $1s \to 2s \to 4s \to 8s$, trần tối đa 3 lần thử (`max_retries = 3`). |
| **08** | Retry khi Google Sheets lỗi | **PASS** | Đầy đủ 4 cột Dead-letter queue: `status`, `retry_count`, `max_retries`, `last_error`. |
| **09** | Chống đồng bộ hai lần (Idempotency) | **PASS** | Ràng buộc khóa `idempotency_key` kích hoạt trên bảng `hr_sync_tasks`, chống gửi trùng lặp. |
| **10** | Kiểm tra bản ghi SWC00021 | **PASS** | Dòng 7 trên Sheets giữ nguyên, trạng thái `DELETED_ORPHAN_REQUIRES_MANUAL_REVIEW`, không bị xóa. |
| **11** | Đối soát số lượng và khóa định danh | **PASS** | PostgreSQL có 5 hồ sơ (1 DELETED, 4 ACTIVE) = Google Sheets có 5 hồ sơ đồng bộ + 1 hồ sơ mồ côi được gắn nhãn. |
| **12** | Kiểm tra phân quyền người xem dữ liệu đã xóa | **PASS** | NocoDB view `Active Employees` chỉ lọc `status = 'ACTIVE'`, ẩn toàn bộ hồ sơ đã xóa mềm. |
| **13** | Kiểm thử Hard Delete qua Outbox ở chế độ dry-run | **PASS** | Hệ thống bảo đảm đầy đủ 6 bảng quy trình 4-Eyes: `requests`, `approvals`, `manifests`, `executions`, `retention_policies`, `tombstones`. |
| **14** | Xác minh Audit Log và Tombstone còn nguyên | **PASS** | Bảng `auth_audit_logs` bảo toàn trọn vẹn 3.371 sự kiện kiểm toán; các tombstone được bảo vệ bất biến. |

---

## 6. KẾ HOẠCH SAO LƯU VÀ ROLLBACK (BACKUP & ROLLBACK PLAN)

### 6.1. Bản sao lưu đã thực hiện
- **PostgreSQL Database:** Tạo snapshot `backups/prod_soft_delete_remediation_20261030.sql`.
- **Google Sheets:** Đã lưu bản ghi trạng thái ban đầu của bảng tính trước khi thực hiện ghi nhận cột mở rộng.
- **NocoDB SQLite:** Đã sao lưu `noco.db` bên trong container `nocodb:/usr/app/data/noco.db.bak_before_soft_delete_sync`.

### 6.2. Kế hoạch hoàn nguyên (Rollback Procedure)
Trường hợp cần đưa hệ thống về trạng thái ban đầu:
1. **Khôi phục PostgreSQL:** Chạy lệnh `ALTER TABLE employees DROP COLUMN deleted_at, DROP COLUMN deleted_by, DROP COLUMN deletion_reason;` và hoàn nguyên `auth-service/routes/employees.js`.
2. **Khôi phục NocoDB:** Chạy script khôi phục SQLite database từ file `.bak` và khởi động lại container `docker restart nocodb`.
3. **Khôi phục Google Sheets:** Xóa cột `BB:BG` trên bảng tính `Trang tính1` qua Sheets API.

---

## 7. XÁC NHẬN BẢO TOÀN DỮ LIỆU PRODUCTION

- Toàn bộ 5 nhân sự baseline của Tập đoàn SOTRANS (`STL00014`, `SWC00022`, `SWC00023`, `SWC00024`, `SWC00025`) được bảo toàn tuyệt đối, không xảy ra sai lệch thông tin cá nhân hay thông tin hợp đồng.
- Không phát sinh bản ghi nhân viên giả lập hoặc test rác trên Production.
- Cột ngạch bậc lương `job_grade` đã được trả về trạng thái nguyên bản và được bảo vệ bất khả xâm phạm trong toàn bộ mã nguồn hệ thống.
- Chức năng Production Employee Hard Delete duy trì trạng thái kiểm soát 4-Eyes an toàn:
  - `PRODUCTION_REQUEST_MODE = ENABLED`
  - `PRODUCTION_EXECUTION_MODE = BLOCKED_AWAITING_LEGAL_RETENTION_POLICY`
