# SOTRANS HUB — BÁO CÁO KẾT QUẢ DỌN SẠCH DỮ LIỆU KIỂM THỬ TOÀN DIỆN
## COMPLETE TEST DATA CLEANUP & DATA INTEGRITY REPORT
**Mã công việc:** `SOTRANS-TEST-DATA-CLEANUP-10`  
**Dự án:** `D:\hoso-chat`  
**Thời điểm thực thi:** 2026-10-29T23:20:00+07:00 -> 2026-10-29T23:24:00+07:00  
**Tập tin Manifest thực thi:** [docs/cleanup/TEST_DATA_CLEANUP_MANIFEST.json](file:///d:/hoso-chat/docs/cleanup/TEST_DATA_CLEANUP_MANIFEST.json)  
**Tập tin Kế hoạch Dry-Run:** [docs/cleanup/TEST_DATA_CLEANUP_DRY_RUN.md](file:///d:/hoso-chat/docs/cleanup/TEST_DATA_CLEANUP_DRY_RUN.md)  
**Trạng thái nghiệm thu cuối cùng:** **`CLEANUP COMPLETE` (HOÀN TẤT DỌN SẠCH & BẢO TOÀN DỮ LIỆU PRODUCTION)**

---

## 1. TỔNG KẾT THỰC THI DỌN SẠCH (EXECUTIVE SUMMARY)

Toàn bộ dữ liệu giả lập, dữ liệu phát sinh từ các đợt kiểm thử kỹ thuật gần đây (`SOTRANS-PROD-READINESS-ONEPASS-07`, `SOTRANS-PROD-READINESS-FINAL-08`, `SOTRANS-PROD-GOLIVE-EXECUTE-09`, `HR-STAGING-FAIL-CLOSED-REGRESSION-03`, `HR-STAGING-SECURITY-FIX-05`) đã được rà soát, lập danh mục kiểm kê, tạo bản sao lưu bảo vệ ngoài CSDL, và thực hiện dọn sạch có chọn lọc.

Toàn bộ 100% dữ liệu nhân sự thật, tài khoản quản trị thật, hồ sơ nghiệp vụ hợp lệ và lịch sử kiểm toán tuân thủ được bảo toàn nguyên vẹn.

```
========================================================================================
                      KẾT QUẢ DỌN SẠCH DỮ LIỆU KIỂM THỬ
                              CLEANUP COMPLETE
========================================================================================
  [✓] Tổng số đối tượng kiểm kê trong hệ thống:       33 mục
  [✓] Tổng số đối tượng test xác minh & xóa thành công: 11 mục (1 record DB + 10 files)
  [✓] Số đối tượng đã sạch từ trước (ALREADY CLEAN):   14 mục
  [✓] Số đối tượng nghiệp vụ bảo toàn (PRESERVED):      8 mục (nhân viên, hồ sơ thật)
  [✓] Số đối tượng giữ lại do không rõ nguồn gốc:       0 mục (REVIEW_REQUIRED = 0)
  [✓] Số đối tượng bị chặn tại hệ thống ngoài:          0 mục (BLOCKED = 0)
  [✓] Số lượng mục xóa thất bại:                        0 mục (FAILED = 0)
  [✓] Kiểm định độc lập sau xóa (Independent Verify):   10/10 PASS (100% đạt chuẩn)
========================================================================================
```

---

## 2. BẢNG PHÂN LOẠI CHI TIẾT TỪNG HẠNG MỤC DỮ LIỆU

| Mã đối tượng | Hệ thống / Bảng / Kho | ID / Tên tài nguyên | Phân loại | Hành động thực tế | Ghi chú & Bằng chứng xác minh |
| :--- | :--- | :--- | :---: | :---: | :--- |
| `POSTGRESQL-HRBOT-STAGING-8fff1c43` | PostgreSQL `hrbot` | `8fff1c43-4593-46ea-a00f-a2eeaade87d5` | `DELETED` | Xóa trong Transaction | Hồ sơ giả lập `NGUYEN SYNTHETIC REGRESSION` (CCCD `099205009901`). Đã xóa an toàn, CSDL còn đúng 10 bản ghi baseline. |
| `STORAGE-STAGING-FILE-f1caa806` | Storage `uploads/staging` | `f1caa806...synthetic_swc_candidate.pdf` | `DELETED` | Xóa file vật lý (694 B) | Tệp PDF upload đính kèm bản ghi `8fff1c43`. Đã sao lưu trước khi xóa. |
| `STORAGE-STAGING-FILE-418a1cb6` | Storage `uploads/staging` | `418a1cb6...synthetic_swc_candidate.pdf` | `DELETED` | Xóa file vật lý (694 B) | Tệp test thử nghiệm upload trước đó. Đã sao lưu trước khi xóa. |
| `STORAGE-STAGING-FILE-f12a1ecd` | Storage `uploads/staging` | `f12a1ecd...synthetic_swc_candidate.pdf` | `DELETED` | Xóa file vật lý (694 B) | Tệp test thử nghiệm upload trước đó. Đã sao lưu trước khi xóa. |
| `STORAGE-FIXTURE-3a64aaff` | Storage `uploads` | `3a64aaff...fixture_conflict_pricing.xlsx` | `DELETED` | Xóa file vật lý (17.2 KB) | Fixture test không có liên kết trong CSDL. Đã sao lưu trước khi xóa. |
| `STORAGE-FIXTURE-88d99f8b` | Storage `uploads` | `88d99f8b...fixture_empty.xlsx` | `DELETED` | Xóa file vật lý (15.8 KB) | Fixture test không có liên kết trong CSDL. Đã sao lưu trước khi xóa. |
| `STORAGE-FIXTURE-9fe764d6` | Storage `uploads` | `9fe764d6...fixture_vendor_csv.csv` | `DELETED` | Xóa file vật lý (369 B) | Fixture test không có liên kết trong CSDL. Đã sao lưu trước khi xóa. |
| `STORAGE-FIXTURE-b6e18dcc` | Storage `uploads` | `b6e18dcc...fixture_text_sop.pdf` | `DELETED` | Xóa file vật lý (1.2 KB) | Fixture test không có liên kết trong CSDL. Đã sao lưu trước khi xóa. |
| `STORAGE-FIXTURE-b9cba5db` | Storage `uploads` | `b9cba5db...fixture_conflict_pricing.xlsx` | `DELETED` | Xóa file vật lý (17.2 KB) | Fixture test không có liên kết trong CSDL. Đã sao lưu trước khi xóa. |
| `STORAGE-FIXTURE-cafd1d13` | Storage `uploads` | `cafd1d13...fixture_text_sop.pdf` | `DELETED` | Xóa file vật lý (1.2 KB) | Fixture test không có liên kết trong CSDL. Đã sao lưu trước khi xóa. |
| `STORAGE-FIXTURE-eabaa706` | Storage `uploads` | `eabaa706...fixture_vendor_csv.csv` | `DELETED` | Xóa file vật lý (369 B) | Fixture test không có liên kết trong CSDL. Đã sao lưu trước khi xóa. |
| `POSTGRESQL-HRBOT_TEST-EMPLOYEES` | PostgreSQL `hrbot_test` | Bảng `public.employees` | `ALREADY CLEAN` | Không thao tác | 0 bản ghi (đã sạch sau teardown kiểm thử cô lập). |
| `POSTGRESQL-HRBOT_TEST-PROFILES` | PostgreSQL `hrbot_test` | Bảng `public.hr_employee_profiles` | `ALREADY CLEAN` | Không thao tác | 0 bản ghi (đã sạch sau teardown). |
| `POSTGRESQL-HRBOT_TEST-STAGING` | PostgreSQL `hrbot_test` | Bảng `public.hr_employee_staging` | `ALREADY CLEAN` | Không thao tác | 0 bản ghi (đã sạch sau teardown). |
| `POSTGRESQL-HRBOT_TEST-TASKS` | PostgreSQL `hrbot_test` | Bảng `public.hr_sync_tasks` | `ALREADY CLEAN` | Không thao tác | 0 bản ghi (đã sạch sau teardown). |
| `POSTGRESQL-HRBOT_TEST-LOGS` | PostgreSQL `hrbot_test` | Bảng `public.auth_audit_logs` | `ALREADY CLEAN` | Không thao tác | 0 bản ghi (đã sạch sau teardown). |
| `POSTGRESQL-HRBOT_TEST-CONVERSATIONS` | PostgreSQL `hrbot_test` | Bảng `public.ai_conversations` | `ALREADY CLEAN` | Không thao tác | 0 bản ghi (đã sạch sau teardown). |
| `POSTGRESQL-HRBOT_TEST-MESSAGES` | PostgreSQL `hrbot_test` | Bảng `public.ai_messages` | `ALREADY CLEAN` | Không thao tác | 0 bản ghi (đã sạch sau teardown). |
| `POSTGRESQL-HRBOT_TEST-AGENTS` | PostgreSQL `hrbot_test` | Bảng `public.user_agents` | `ALREADY CLEAN` | Không thao tác | 0 bản ghi (đã sạch sau teardown). |
| `POSTGRESQL-HRBOT-VERSION_TESTS` | PostgreSQL `hrbot` | Bảng `public.version_tests` | `ALREADY CLEAN` | Không thao tác | 0 bản ghi. |
| `POSTGRESQL-HRBOT-GOLDEN_QUESTIONS`| PostgreSQL `hrbot` | Bảng `public.golden_questions` | `ALREADY CLEAN` | Không thao tác | 0 bản ghi. |
| `QDRANT-HR_DOCS-TEST_VECTORS` | Qdrant Vector DB | Collection `hr_docs` | `ALREADY CLEAN` | Không thao tác | 100/100 points đều là tài liệu chính sách thật; 0 vector test. |
| `NOCODB-HOSO_NHANSU-SYNTHETIC` | NocoDB | Bảng `nc_08u4___Hoso_Nhansu` | `ALREADY CLEAN` | Không thao tác | 12 dòng đều là hồ sơ gốc lịch sử; không rò rỉ candidate test. |
| `GOOGLE_SHEETS-SYNTHETIC` | Google Sheets | SOTRANS HR Master Sheet | `ALREADY CLEAN` | Không thao tác | Candidate `8fff1c43` bị chặn duyệt nên không sinh sync task ra ngoài. |
| `POSTGRESQL-HRBOT-PENDING_TASKS` | PostgreSQL `hrbot` | Bảng `public.hr_sync_tasks` (hàng đợi) | `ALREADY CLEAN` | Không thao tác | 0 pending, 0 retry, 0 failed. Không có cơ chế tự tái tạo dữ liệu test. |
| `POSTGRESQL-HRBOT-EMPLOYEES` | PostgreSQL `hrbot` | Bảng `public.employees` (6 nhân viên) | `PRESERVED` | Giữ nguyên 100% | 6 nhân viên chính thức đang hoạt động: NGÔ ĐẶNG TUẤN UYÊN, PHAN DƯƠNG THANH BÌNH, NGUYỄN TRẦN THIỆN NHÂN, LÊ THÀNH NHÂN, NGUYỄN TRƯỜNG NAM, NGUYỄN VĂN HIẾU. |
| `POSTGRESQL-HRBOT-PROFILES` | PostgreSQL `hrbot` | Bảng `public.hr_employee_profiles` (6 hồ sơ) | `PRESERVED` | Giữ nguyên 100% | 6 hồ sơ nhân sự đầy đủ của 6 nhân viên chính thức. |
| `POSTGRESQL-HRBOT-STAGING-BASELINE`| PostgreSQL `hrbot` | Bảng `public.hr_employee_staging` (10 hồ sơ) | `PRESERVED` | Giữ nguyên 100% | 6 hồ sơ onboarding gốc + 4 hồ sơ bằng chứng tuân thủ chốt chặn trùng lặp liên công ty (bao gồm `cae4a233` đơn vị VTX). |
| `POSTGRESQL-HRBOT-SYNC_TASKS` | PostgreSQL `hrbot` | Bảng `public.hr_sync_tasks` (96 tasks) | `PRESERVED` | Giữ nguyên 100% | Lịch sử đồng bộ hợp lệ (status: `success`) của 6 nhân viên. |
| `POSTGRESQL-HRBOT-USERS` | PostgreSQL `hrbot` | Bảng `public.users` (14 tài khoản) | `PRESERVED` | Giữ nguyên 100% | Tài khoản tenant quản trị và nhân sự chuẩn của STL, SWC, VTX. |
| `POSTGRESQL-HRBOT-AUTH_AUDIT_LOGS`| PostgreSQL `hrbot` | Bảng `public.auth_audit_logs` (3,282 logs) | `PRESERVED` | Giữ nguyên 100% | Nhật ký kiểm toán bảo mật và truy vết tuân thủ theo quy định an ninh. |
| `STORAGE-SCREENSHOTS-E2E` | Storage `scratch/screenshots` | 5 ảnh chụp E2E Playwright | `PRESERVED` | Giữ nguyên 100% | Bằng chứng kiểm thử tự động giao diện phục vụ lưu trữ nghiệm thu. |
| `POSTGRESQL-HRBOT-USER_AGENTS` | PostgreSQL `hrbot` | Bảng `public.user_agents` (3 trợ lý) | `PRESERVED` | Giữ nguyên 100% | Trợ lý AI thực tế của người dùng (`Excel-Data-Pro`, `Email-Assistant`). |

---

## 3. BẰNG CHỨNG XÁC NHẬN DỮ LIỆU THẬT KHÔNG BỊ XÓA NHẦM

### 3.1. Đối soát danh sách nhân sự chính thức (`employees`)
Tất cả 6 nhân sự chính thức của Tập đoàn vẫn được bảo toàn nguyên vẹn với đầy đủ thông tin định danh và đơn vị công tác:
1. `062095000277` — NGÔ ĐẶNG TUẤN UYÊN | Công ty: `SWC` | Trạng thái: `ACTIVE`
2. `079204001284` — PHAN DƯƠNG THANH BÌNH | Công ty: `SWC` | Trạng thái: `ACTIVE`
3. `079205001589` — NGUYỄN TRẦN THIỆN NHÂN | Công ty: `SWC` | Trạng thái: `ACTIVE`
4. `080087002353` — LÊ THÀNH NHÂN | Công ty: `SWC` | Trạng thái: `ACTIVE`
5. `036202007139` / `STL00014` — NGUYỄN TRƯỜNG NAM | Công ty: `STL` | Trạng thái: `ACTIVE`
6. `060098011607` / `SWC00021` — NGUYỄN VĂN HIẾU | Công ty: `SWC` | Trạng thái: `ACTIVE`

### 3.2. Đối soát các bảng nhân sự cốt lõi trong `hrbot`

| Tên bảng CSDL | Trước khi dọn dẹp | Sau khi dọn dẹp | Biến động | Kết luận an toàn |
| :--- | :---: | :---: | :---: | :--- |
| **`employees`** | 6 | 6 | 0 | **Nguyên vẹn 100%** |
| **`hr_employee_profiles`** | 6 | 6 | 0 | **Nguyên vẹn 100%** |
| **`hr_employee_staging`** | 11 | 10 | -1 | **Đã loại bỏ chính xác 1 bản ghi test** |
| **`hr_sync_tasks`** | 96 | 96 | 0 | **Nguyên vẹn 100%** |
| **`users`** | 14 | 14 | 0 | **Nguyên vẹn 100%** |
| **`auth_audit_logs`** | 3,282 | 3,282 | 0 | **Lưu trữ toàn vẹn phục vụ kiểm toán** |
| **`documents` (chính sách)** | 19 | 19 | 0 | **Nguyên vẹn 100%** |
| **`chunks` (vector chunk)** | 100 | 100 | 0 | **Nguyên vẹn 100%** |

---

## 4. KẾT QUẢ KIỂM CHỨNG ĐỘC LẬP SAU XÓA (10/10 PASS)

Tập lệnh kiểm chứng độc lập [scratch/verify_post_cleanup_10.js](file:///d:/hoso-chat/scratch/verify_post_cleanup_10.js) đã chạy đối soát toàn bộ các tiêu chí an toàn và đạt kết quả tuyệt đối:

| Mã kiểm chứng | Nội dung kiểm tra | Kết quả | Bằng chứng thực tế |
| :---: | :--- | :---: | :--- |
| `VERIFY-01` | Bản ghi staging giả lập `8fff1c43` đã bị xóa hoàn toàn khỏi `hrbot` | **PASS** | Truy vấn `SELECT COUNT(*)` trả về đúng `0`. |
| `VERIFY-02` | Bảng `hr_employee_staging` còn đúng số lượng baseline hợp lệ (10) | **PASS** | Số lượng bản ghi thực tế: `10/10`. |
| `VERIFY-03` | Toàn bộ 6 nhân viên thật được bảo toàn nguyên vẹn | **PASS** | 6/6 mã nhân viên và CCCD đối chiếu khớp 100%. |
| `VERIFY-04` | Toàn bộ 6 hồ sơ chi tiết (`hr_employee_profiles`) được bảo toàn | **PASS** | Số lượng bản ghi thực tế: `6/6`. |
| `VERIFY-05` | 96 lịch sử đồng bộ giữ nguyên, 0 tác vụ treo/lỗi | **PASS** | 96/96 status: `success`, 0 task retry. |
| `VERIFY-06` | Toàn bộ tệp PDF giả lập trong `auth-service/uploads/staging` đã bị xóa | **PASS** | Thư mục staging uploads còn 0 tệp synthetic. |
| `VERIFY-07` | Toàn bộ tệp fixtures test cũ không gắn CSDL đã bị xóa | **PASS** | 7 tệp fixture test đã bị gỡ bỏ sạch sẽ. |
| `VERIFY-08` | API Live Staging (`GET /api/hoso/intake/staging`) hoạt động bình thường, không rò rỉ dữ liệu test | **PASS** | HTTP 200 OK, trả về đúng 10 hồ sơ hợp lệ. |
| `VERIFY-09` | CSDL test cô lập `hrbot_test` không còn rác nhân sự | **PASS** | `employees`: 0, `staging`: 0. |
| `VERIFY-10` | Bản sao lưu CSDL bảo vệ logic tồn tại ngoài thư mục PostgreSQL | **PASS** | `hrbot_pre_cleanup_10.dump` (15.28 MB, 265 TOCs). |

---

## 5. THÔNG TIN BẢN SAO LƯU BẢO VỆ (BACKUP REPOSITORY)

Để đảm bảo khả năng phục hồi khi có yêu cầu kiểm toán hồi cứu, các bản sao lưu bảo vệ đã được lưu trữ an toàn tại thư mục chuyên biệt:

1. **Bản sao lưu CSDL Logic `hrbot`:**
   - Đường dẫn: [backups/cleanup_data_10/hrbot_pre_cleanup_10.dump](file:///d:/hoso-chat/backups/cleanup_data_10/hrbot_pre_cleanup_10.dump)
   - Kích thước: `15,289,133 bytes`
   - Kiểm chứng catalog: 265 TOC entries, định dạng PostgreSQL Custom Gzip Archive, đã xác minh bằng `pg_restore --list`.
2. **Bản sao lưu các tệp vật lý đã xóa:**
   - Thư mục lưu trữ: [backups/cleanup_data_10/deleted_files_backup/](file:///d:/hoso-chat/backups/cleanup_data_10/deleted_files_backup/)
   - Tổng số tệp đã lưu trữ: 10 tệp (3 tệp PDF synthetic staging và 7 tệp test fixture).
   - Quyền truy cập: Chỉ dành cho Quản trị viên hệ thống.

---

## 6. KẾT LUẬN NGHIỆM THU

Hệ thống SOTRANS Hub đã đạt trạng thái **`CLEANUP COMPLETE`**:
- 100% dữ liệu thử nghiệm phát sinh đã được làm sạch triệt để.
- 100% dữ liệu nhân sự thật và cơ sở dữ liệu Production giữ vững tính toàn vẹn.
- Không tồn tại hàng đợi hay tác vụ nền nào có nguy cơ tái tạo dữ liệu test.
- Hệ thống sẵn sàng vận hành ổn định và phục vụ người dùng chính thức.
