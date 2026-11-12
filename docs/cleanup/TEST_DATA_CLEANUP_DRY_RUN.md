# SOTRANS HUB — KẾ HOẠCH VÀ KẾT QUẢ CHẠY THỬ XÓA DỮ LIỆU TEST (DRY-RUN)
## TEST DATA CLEANUP DRY-RUN & SAFETY VERIFICATION
**Mã công việc:** `SOTRANS-TEST-DATA-CLEANUP-10`  
**Dự án:** `D:\hoso-chat`  
**Thời điểm thực hiện Dry-Run:** 2026-10-29T23:22:00+07:00  
**Tập tin Manifest đối chiếu:** [docs/cleanup/TEST_DATA_CLEANUP_MANIFEST.json](file:///d:/hoso-chat/docs/cleanup/TEST_DATA_CLEANUP_MANIFEST.json)  
**Trạng thái kiểm tra an toàn:** **`APPROVED FOR EXECUTION` (ĐỦ ĐIỀU KIỆN THỰC THI THẬT)**

---

## 1. MỤC TIÊU VÀ PHẠM VI DRY-RUN

Đợt kiểm kê và chạy thử (Dry-Run) này nhằm rà soát toàn bộ các hệ sinh thái lưu trữ của SOTRANS Hub sau các đợt kiểm định kỹ thuật gần đây (`SOTRANS-PROD-READINESS-ONEPASS-07`, `SOTRANS-PROD-READINESS-FINAL-08`, `SOTRANS-PROD-GOLIVE-EXECUTE-09`, `HR-STAGING-FAIL-CLOSED-REGRESSION-03`, `HR-STAGING-SECURITY-FIX-05`).

Mục tiêu là phân loại chính xác 100% tài nguyên thành 3 nhóm rõ ràng:
1. **Dữ liệu kiểm thử cần xóa (`DELETE`)**: Xác định được nguồn gốc từ các bài test, không có ràng buộc khóa ngoại vi phạm, có bản sao lưu trước khi xóa.
2. **Kho lưu trữ đã sạch từ trước (`ALREADY CLEAN`)**: Hệ thống hoặc bảng đã về 0 bản ghi test nhờ cơ chế teardown của test suite.
3. **Dữ liệu thật / nghiệp vụ bảo vệ nghiêm ngặt (`PRESERVED PRODUCTION`)**: Nhân viên thật, hồ sơ đang hoạt động, tài khoản thật, nhật ký kiểm toán tuân thủ.

---

## 2. KẾT QUẢ ĐỐI SOÁT TỪNG HỆ THỐNG LƯU TRỮ

### 2.1. Cơ sở dữ liệu PostgreSQL `hrbot` (Production)
- **Bảng `public.hr_employee_staging` (11 bản ghi):**
  - **1 bản ghi test xác nhận:** `8fff1c43-4593-46ea-a00f-a2eeaade87d5`
    - Họ tên: `NGUYEN SYNTHETIC REGRESSION`
    - CCCD: `099205009901`
    - Tệp tải lên: `synthetic_swc_candidate.pdf`
    - Nguồn gốc: Tạo bởi Mục 2 (`TEST-REG-01`) của script [scratch/test_fail_closed_and_regression_suite.js](file:///d:/hoso-chat/scratch/test_fail_closed_and_regression_suite.js) vào lúc 20:50:20 ngày 29/10/2026.
    - Trạng thái duyệt: `pending_review` (bị chốt chặn `company_mismatch` từ chối).
    - Ràng buộc khóa ngoại: Không có bản ghi nào ở `hr_sync_tasks` hay `hr_employee_profiles` tham chiếu tới.
    - Kế hoạch: **`DELETE` bằng lệnh SQL có kiểm tra ID chính xác**.
  - **10 bản ghi nghiệp vụ hợp lệ:**
    - 6 bản ghi tiếp nhận ban đầu tương ứng 6 nhân viên chính thức đang hoạt động.
    - 4 bản ghi bị từ chối phục vụ làm bằng chứng kiểm toán chốt chặn trùng lặp liên công ty (trong đó có `cae4a233-4615-45a9-b087-7183c1b693b6` của đơn vị VTX).
    - Kế hoạch: **`PRESERVE` (Giữ nguyên 100%)**.

- **Bảng `public.employees` (6 bản ghi) & `public.hr_employee_profiles` (6 bản ghi):**
  - 100% là 6 nhân sự chính thức của Tập đoàn SOTRANS:
    1. `062095000277` — NGÔ ĐẶNG TUẤN UYÊN (SWC)
    2. `079204001284` — PHAN DƯƠNG THANH BÌNH (SWC)
    3. `079205001589` — NGUYỄN TRẦN THIỆN NHÂN (SWC)
    4. `080087002353` — LÊ THÀNH NHÂN (SWC)
    5. `036202007139` / `STL00014` — NGUYỄN TRƯỜNG NAM (STL)
    6. `060098011607` / `SWC00021` — NGUYỄN VĂN HIẾU (SWC)
  - Không có bất kỳ nhân sự giả lập hay nhân sự test nào tồn tại trong bảng `employees`.
  - Kế hoạch: **`PRESERVE` (Tuyệt đối không đụng chạm)**.

- **Bảng `public.hr_sync_tasks` (96 bản ghi):**
  - 100% có trạng thái `success`. Không có tác vụ nào có trạng thái `pending`, `failed` hoặc `retry`.
  - Không có bất kỳ task nào gắn với ID `8fff1c43-4593-46ea-a00f-a2eeaade87d5` (vì hồ sơ test này không bao giờ được duyệt).
  - Kế hoạch: **`PRESERVE` (Lịch sử đồng bộ hợp lệ)**.

- **Bảng `public.users` (14 bản ghi):**
  - Gồm 14 tài khoản người dùng và quản trị viên phân quyền chuẩn (superadmin, admin_stl, admin_swc, admin_vtx, hr_stl, hr_swc, hr_vtx, nhân viên...).
  - Không có tài khoản test rác (`test_user`, `synthetic`).
  - Kế hoạch: **`PRESERVE`**.

- **Bảng `public.auth_audit_logs` (3,282 bản ghi):**
  - Chứa lịch sử kiểm toán bảo mật và truy vết đăng nhập, thao tác hệ thống theo chuẩn an ninh.
  - Kế hoạch: **`PRESERVE` theo quy định lưu trữ nhật ký tuân thủ**.

- **Bảng `public.version_tests` (0 bản ghi) & `public.golden_questions` (0 bản ghi):**
  - Trạng thái: **`ALREADY CLEAN` (Đã sạch từ trước)**.

- **Bảng `public.user_agents` (3 bản ghi):**
  - Gồm 3 trợ lý ảo AI của người dùng tạo từ 16/10 và 21/10 (`Excel-Data-Pro`, `Email-Assistant`).
  - Kế hoạch: **`PRESERVE`**.

---

### 2.2. Cơ sở dữ liệu PostgreSQL `hrbot_test` (Test DB cô lập)
Đối soát toàn bộ 33 bảng trong cơ sở dữ liệu `hrbot_test`:
- `employees`: 0 bản ghi (`ALREADY CLEAN`)
- `hr_employee_profiles`: 0 bản ghi (`ALREADY CLEAN`)
- `hr_employee_staging`: 0 bản ghi (`ALREADY CLEAN`)
- `hr_sync_tasks`: 0 bản ghi (`ALREADY CLEAN`)
- `auth_audit_logs`: 0 bản ghi (`ALREADY CLEAN`)
- `ai_conversations`: 0 bản ghi (`ALREADY CLEAN`)
- `ai_messages`: 0 bản ghi (`ALREADY CLEAN`)
- `user_agents`: 0 bản ghi (`ALREADY CLEAN`)
- `chat_log`: 0 bản ghi (`ALREADY CLEAN`)
- `unanswered_log`: 0 bản ghi (`ALREADY CLEAN`)
- `golden_questions`: 0 bản ghi (`ALREADY CLEAN`)
- `version_tests`: 0 bản ghi (`ALREADY CLEAN`)
- Các bảng khung còn lại: Chỉ giữ 14 tài khoản người dùng tenant mẫu, 3 đơn vị công ty và 32 quyền hạn để làm môi trường chạy kiểm thử cô lập.

---

### 2.3. Kho lưu trữ Vector Qdrant (`hr_docs`)
- Điểm vector hiện có: **100 points**.
- Số lượng tài liệu nguồn: **19 documents** (tương ứng chuẩn xác với 100 đoạn tài liệu trong bảng `chunks` của CSDL `hrbot`).
- Tiến trình tự động đối soát: `[QDRANT RECONCILE] Hoàn tất đối soát: 19/19 tài liệu đã đồng bộ chuẩn xác.`
- Số điểm vector test giả lập: **0 points**.
- Trạng thái: **`ALREADY CLEAN`**.

---

### 2.4. Hệ thống đồng bộ bên ngoài (NocoDB, Google Sheets, OneDrive)
- **NocoDB (`nc_08u4___Hoso_Nhansu`):**
  - Tổng số dòng: 12 dòng (các tệp hồ sơ gốc: `Quyet_dinh_Le_Minh_Duc_STL.txt`, `Ho_so_Vu_Hong_Son_STL.txt`, `SWC00810.pdf`, `SWC00803.pdf`...).
  - Số dòng chứa `synthetic` hoặc test: **0 dòng**.
  - Trạng thái: **`ALREADY CLEAN`**.
- **Google Sheets:**
  - Không có hồ sơ test nào được đồng bộ ra Google Sheets do hồ sơ test `8fff1c43` bị chặn ngay từ cổng kiểm duyệt.
  - Trạng thái: **`ALREADY CLEAN`**.
- **Hàng đợi tái tạo (Queues / Retry):**
  - Không có tác vụ treo (`pending = 0, retry = 0, failed = 0`).
  - n8n workflows không có luồng nào đang chạy lỗi hoặc tự động tái tạo dữ liệu test.
  - Trạng thái: **`ALREADY CLEAN`**.

---

### 2.5. Tệp và tài liệu vật lý trên ổ đĩa
- **Thư mục `auth-service/uploads/staging/`:**
  - Phát hiện 3 tệp PDF giả lập sinh ra từ quá trình test upload:
    1. `f1caa806-7029-4e0a-ae92-bc98e3ba7a66_synthetic_swc_candidate.pdf` (tệp gắn với record staging `8fff1c43`)
    2. `418a1cb6-10d2-49c6-aa47-02f7d8ab5fd5_synthetic_swc_candidate.pdf`
    3. `f12a1ecd-a28c-4f62-9c53-35fefc779535_synthetic_swc_candidate.pdf`
  - Kế hoạch: **`DELETE` sau khi đã backup**.
- **Thư mục `auth-service/uploads/`:**
  - Phát hiện 7 tệp test fixture cũ không gắn với bất kỳ bản ghi CSDL nào:
    1. `3a64aaff-3b11-4c6a-8a18-719ff2df9e13_fixture_conflict_pricing.xlsx`
    2. `88d99f8b-554f-493d-a02e-02d612f5edcb_fixture_empty.xlsx`
    3. `9fe764d6-99b3-4d2a-8861-af76a2566427_fixture_vendor_csv.csv`
    4. `b6e18dcc-e549-4644-be52-89ca8a29c820_fixture_text_sop.pdf`
    5. `b9cba5db-3f1b-4843-9454-8af5ab7f3873_fixture_conflict_pricing.xlsx`
    6. `cafd1d13-52e9-42fb-bd63-bd5754d596d4_fixture_text_sop.pdf`
    7. `eabaa706-5b64-44b5-887d-cd2e006c8a07_fixture_vendor_csv.csv`
  - Kế hoạch: **`DELETE` sau khi đã backup**.
- **Thư mục `scratch/screenshots/`:**
  - Chứa 5 ảnh chụp Playwright E2E (`e2e_01` -> `e2e_05`).
  - Kế hoạch: **`PRESERVE` làm bằng chứng phát hành**.

---

## 3. BẢNG TỔNG HỢP KẾ HOẠCH HÀNH ĐỘNG DRY-RUN

| Hệ thống / Vị trí | Đối tượng | Số lượng | Hành động dự kiến | Cơ chế an toàn |
| :--- | :--- | :---: | :---: | :--- |
| **PostgreSQL `hrbot`** | `hr_employee_staging` (ID: `8fff1c43-4593-46ea-a00f-a2eeaade87d5`) | 1 dòng | **DELETE** | SQL Transaction, WHERE id = '8fff1c43...', Backup dump xác minh |
| **Storage Staging** | `auth-service/uploads/staging/*synthetic*.pdf` | 3 files | **DELETE** | Đã sao lưu vào `backups/cleanup_data_10/deleted_files_backup/` |
| **Storage Uploads** | `auth-service/uploads/*fixture_*` (không liên kết CSDL) | 7 files | **DELETE** | Đã sao lưu vào `backups/cleanup_data_10/deleted_files_backup/` |
| **PostgreSQL `hrbot_test`**| Dữ liệu nhân sự / staging trong CSDL test | 0 dòng | **ALREADY CLEAN** | Teardown test harness đã tự dọn sạch |
| **Qdrant Vector DB** | Điểm vector kiểm thử trong `hr_docs` | 0 points | **ALREADY CLEAN** | 100/100 points thuộc về tài liệu thật |
| **NocoDB / Google Sheets** | Bản ghi kiểm thử đồng bộ ra ngoài | 0 dòng | **ALREADY CLEAN** | Không có bản ghi nào bị rò rỉ ra ngoài |
| **PostgreSQL `hrbot`** | Nhân viên thật (`employees`: 6, `profiles`: 6) | 12 dòng | **PRESERVE** | Không có câu lệnh DELETE nào tác động lên 2 bảng này |
| **PostgreSQL `hrbot`** | Hồ sơ staging gốc hợp lệ (`hr_employee_staging`) | 10 dòng | **PRESERVE** | Giữ nguyên 6 hồ sơ onboarding + 4 hồ sơ bằng chứng tuân thủ |
| **PostgreSQL `hrbot`** | Lịch sử đồng bộ (`hr_sync_tasks`) | 96 dòng | **PRESERVE** | Không xóa lịch sử đồng bộ hợp lệ |
| **PostgreSQL `hrbot`** | Nhật ký kiểm toán an ninh (`auth_audit_logs`) | 3,282 dòng | **PRESERVE** | Lưu giữ phục vụ truy vết và an ninh |

---

## 4. XÁC MINH TRẠNG THÁI SAO LƯU BẢO VỆ TRƯỚC KHI XÓA

1. **Bản sao lưu CSDL Logic `hrbot`:**
   - Đường dẫn: [backups/cleanup_data_10/hrbot_pre_cleanup_10.dump](file:///d:/hoso-chat/backups/cleanup_data_10/hrbot_pre_cleanup_10.dump)
   - Kích thước: `15,289,133 bytes`
   - Kiểm chứng tính toàn vẹn: Đã chạy `pg_restore --list`, trả về chính xác `265 TOC entries`, định dạng gzip nén hợp lệ 100%.
2. **Bản sao lưu các tệp vật lý dự kiến xóa:**
   - Đường dẫn: [backups/cleanup_data_10/deleted_files_backup/](file:///d:/hoso-chat/backups/cleanup_data_10/deleted_files_backup/)
   - Tổng số tệp đã lưu trữ an toàn: 10/10 files.

**KẾT LUẬN DRY-RUN:** Sẵn sàng chuyển sang Giai đoạn Thực thi Xóa an toàn.
