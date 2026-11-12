# MA TRẬN KIỂM THỬ NGHIỆM THU SAU KHẮC PHỤC SOTRANS HUB
## SOTRANS HUB — POST-REMEDIATION TEST MATRIX (SRTM-20261029)

> **Tài liệu:** Ma trận Kiểm thử Nghiệm thu Sau Sửa lỗi Hệ thống SOTRANS Hub  
> **Phiên bản:** 2.0 (Post-Remediation Verification Standard)  
> **Ngày lập:** 29/10/2026  
> **Nguyên tắc an toàn:** Không sử dụng thao tác phá hủy dữ liệu thật để kiểm chứng; tách biệt rõ Unit, Integration, E2E và Regression.

---

### MỤC LỤC
1. [Khung Tiêu chuẩn Kiểm định Nghiệm thu](#1-khung-tiêu-chuẩn-kiểm-định-nghiệm-thu)
2. [Đợt 1: Kiểm định Bảo mật và Kiểm soát truy cập](#2-đợt-1-kiểm-định-bảo-mật-và-kiểm-soát-truy-cập)
3. [Đợt 2: Kiểm định Toàn vẹn Dữ liệu và Nghiệp vụ Nhân sự](#3-đợt-2-kiểm-định-toàn-vẹn-dữ-liệu-và-nghiệp-vụ-nhân-sự)
4. [Đợt 3: Kiểm định Chatbot AI, Quota và OCR](#4-đợt-3-kiểm-định-chatbot-ai-quota-và-ocr)
5. [Đợt 4: Kiểm định Tích hợp và Vận hành Liên dịch vụ](#5-đợt-4-kiểm-định-tích-hợp-và-vận-hành-liên-dịch-vụ)
6. [Đợt 5: Kiểm định Hiệu năng, Sao lưu và Giao diện Quản trị](#6-đợt-5-kiểm-định-hiệu-năng-sao-lưu-và-giao-diện-quản-trị)
7. [Quy chuẩn Dừng kiểm thử Khẩn cấp (Test Halt Triggers)](#7-quy-chuẩn-dừng-kiểm-thử-khẩn-cấp-test-halt-triggers)

---

### 1. KHUNG TIÊU CHUẨN KIỂM ĐỊNH NGHIỆM THU

Để đảm bảo các bản sửa lỗi không chỉ giải quyết được nguyên nhân gốc rễ mà còn **tuyệt đối không sinh ra lỗi hồi quy (Zero Regression)**, mỗi ca kiểm thử trong ma trận đều tuân thủ 10 tham số kỹ thuật nghiêm ngặt:

```text
[Ca kiểm thử] ──> [Pre-conditions] ──> [Test Data] ──> [Execution Steps] ──> [Expected Results]
                       │                                                        │
                 [Verification Method] <── [Regression Suite] <── [Pass/Fail] <─┘
```

---

### 2. ĐỢT 1: KIỂM ĐỊNH BẢO MẬT VÀ KIỂM SOÁT TRUY CẬP

#### TEST CASE: TC-SEC-01 — Kiểm tra ẩn hoàn toàn Secret trong Docker Compose
- **Mã lỗi liên kết:** `DEF-002` (Lộ `JWT_SECRET` & `GEMINI_API_KEY`).
- **Phân loại tầng test:** Configuration / Integration Test.
- **Điều kiện trước khi chạy (Pre-conditions):** File `.env` đã được cấu hình giá trị bí mật mới; `docker-compose.yml` đã được cập nhật biến nội suy.
- **Dữ liệu kiểm thử:** Cặp biến `${JWT_SECRET}` và `${GEMINI_API_KEY}`.
- **Các bước thực hiện:**
  1. Quét nội dung `docker-compose.yml` bằng lệnh tìm kiếm chuỗi bí mật cũ.
  2. Chạy lệnh: `docker compose config`.
  3. Kiểm tra biến môi trường bên trong container: `docker exec hr-auth env`.
- **Kết quả mong đợi:**
  - File `docker-compose.yml` không chứa bất kỳ chuỗi key dạng plaintext nào.
  - Lệnh `docker exec hr-auth env` hiển thị giá trị secret được nạp chính xác từ file `.env`.
- **Cách xác minh thực tế:** Regex scan `AIzaSy` và `sotrans_secret` trên toàn bộ cây thư mục Git trả về 0 match.
- **Test hồi quy liên quan:** `tests/runtime_acceptance_test.js` (kiểm tra container khởi động thành công).
- **Tiêu chí PASS/FAIL:**
  - *PASS:* Cả 2 biến môi trường hiển thị trong container, không lộ trong git tree.
  - *FAIL:* Còn sót chuỗi secret trong compose hoặc container không nhận được biến môi trường.
- **Điều kiện dừng triển khai:** Container `hr-auth` bị crash loop hoặc không khởi động được sau khi nạp biến môi trường.

#### TEST CASE: TC-SEC-02 — Xác minh Luân chuyển JWT Secret & Chặn Token cũ
- **Mã lỗi liên kết:** `DEF-002`.
- **Phân loại tầng test:** Security / API Integration Test.
- **Điều kiện trước khi chạy:** Secret mới đã có hiệu lực trên `hr-auth`. Đã lưu trữ 1 token được ký bằng Secret cũ (Legacy Token).
- **Dữ liệu kiểm thử:** Legacy Token và New Token (đăng nhập sau khi đổi secret).
- **Các bước thực hiện:**
  1. Gửi request `GET http://127.0.0.1:8082/api/employees` với header: `Authorization: Bearer <LEGACY_TOKEN>`.
  2. Gửi request `POST http://127.0.0.1:8082/api/auth/login` với tài khoản hợp lệ -> Nhận New Token.
  3. Gửi lại request `GET http://127.0.0.1:8082/api/employees` với header: `Authorization: Bearer <NEW_TOKEN>`.
- **Kết quả mong đợi:**
  - Bước 1: Trả về **HTTP 401 Unauthorized** với thông báo lỗi chữ ký không hợp lệ (`invalid signature`).
  - Bước 3: Trả về **HTTP 200 OK** kèm danh sách nhân sự.
- **Cách xác minh thực tế:** Kiểm tra HTTP Status Code và nội dung JSON response.
- **Test hồi quy liên quan:** `tests/test_hr_governance_rbac_security.js`.
- **Tiêu chí PASS/FAIL:**
  - *PASS:* Chặn 100% token cũ, chấp nhận 100% token mới.
  - *FAIL:* Token cũ vẫn truy cập được hoặc token mới bị từ chối.

#### TEST CASE: TC-SEC-03 — Xác minh Gỡ bỏ WebDAV `/chat/history` và Ẩn X-Powered-By
- **Mã lỗi liên kết:** `DEF-011` & `DEF-013`.
- **Phân loại tầng test:** Gateway / Security Header Test.
- **Điều kiện trước khi chạy:** Nginx đã reload cấu hình mới; Express đã cấu hình `app.disable('x-powered-by')`.
- **Dữ liệu kiểm thử:** Request HTTP GET và PUT tới Gateway `8082`.
- **Các bước thực hiện:**
  1. Gọi lệnh: `curl -i http://127.0.0.1:8082/chat/history`.
  2. Gọi lệnh: `curl -i -X PUT http://127.0.0.1:8082/chat/history -d "{}"`.
  3. Gọi lệnh: `curl -i http://127.0.0.1:8082/api/health` -> Kiểm tra response headers.
- **Kết quả mong đợi:**
  - Bước 1 & 2: Nhận mã **HTTP 404 Not Found** (không còn hộp thoại hỏi basic auth `Ho so nhan su`).
  - Bước 3: Header trả về không còn dòng `X-Powered-By: Express`.
- **Cách xác minh thực tế:** Trích xuất curl output header.
- **Tiêu chí PASS/FAIL:**
  - *PASS:* 404 cho WebDAV cũ; không có header framework lộ diện.

---

### 3. ĐỢT 2: KIỂM ĐỊNH TOÀN VẸN DỮ LIỆU VÀ NGHIỆP VỤ NHÂN SỰ

#### TEST CASE: TC-DATA-01 — Kiểm tra Xóa sạch 4 Hồ sơ Nhân sự và Tính toàn vẹn
- **Mã lỗi liên kết:** `DEF-003` (4 Hồ sơ test yêu cầu xóa vĩnh viễn).
- **Phân loại tầng test:** Database & Business Logic / E2E Test.
- **Điều kiện trước khi chạy:** Đã tạo bản backup SQL độc lập của 4 hồ sơ; Ban Quản Trị đã có lệnh phê duyệt.
- **Dữ liệu kiểm thử:** 4 mã CCCD (`062095000277`, `079204001284`, `079205001589`, `080087002353`).
- **Các bước thực hiện:**
  1. Chạy câu truy vấn đếm số lượng hồ sơ còn tồn tại trên 3 bảng: `employees`, `hr_employee_profiles`, `hr_employee_staging`.
  2. Gửi câu hỏi lên Chatbot: `"Thông tin nhân viên Ngô Đặng Tuấn Uyên"`.
  3. Kiểm tra danh sách điểm trong collection Qdrant `hr_docs`.
- **Kết quả mong đợi:**
  - Bước 1: Số lượng bản ghi chứa 4 CCCD trên là **0** trên cả 3 bảng.
  - Tổng số bản ghi thực tế còn lại: `employees` (12 bản ghi) và `hr_employee_profiles` (12 bản ghi).
  - Bước 2: Chatbot trả lời không tìm thấy thông tin nhân sự.
  - Bước 3: Vector liên quan bị xóa hoặc vô hiệu hóa.
- **Cách xác minh thực tế:** Chạy truy vấn SQL kiểm chứng `SELECT count(*) ...` = 0.
- **Test hồi quy liên quan:** `tests/audit_phase2_hr_crud_lifecycle.js`.
- **Tiêu chí PASS/FAIL:**
  - *PASS:* 4 hồ sơ bị loại bỏ hoàn toàn, không ảnh hưởng đến 12 hồ sơ nhân sự thật còn lại.
  - *FAIL:* Còn sót bản ghi trên bất kỳ bảng nào hoặc số lượng hồ sơ thật bị suy giảm ngoài ý muốn.
- **Điều kiện dừng khẩn cấp:** Số lượng bản ghi của 12 nhân viên còn lại bị suy giảm -> Lập tức dừng và import lại bản backup SQL.

#### TEST CASE: TC-DATA-02 — Kiểm định Ràng buộc Khóa Ngoại (Foreign Key Enforcement)
- **Mã lỗi liên kết:** `DEF-004` (Thiếu Foreign Key cứng giữa 2 bảng).
- **Phân loại tầng test:** Database Constraint / Integration Test.
- **Điều kiện trước khi chạy:** TC-DATA-01 đã hoàn thành; script migration tạo Foreign Key đã được thực thi thành công.
- **Dữ liệu kiểm thử:** Bản ghi thử nghiệm với mã nhân viên giả lập `NON_EXISTENT_EMP_999`.
- **Các bước thực hiện:**
  1. Thử chèn bản ghi vào bảng con `hr_employee_profiles` với mã nhân viên không tồn tại trong `employees`:
     `INSERT INTO hr_employee_profiles (employee_id, full_name, ...) VALUES ('NON_EXISTENT_EMP_999', 'Test Non Existent', ...);`
  2. Cập nhật mã nhân viên tại bảng cha `employees` của một nhân sự test -> Kiểm tra bảng con có tự động cập nhật (CASCADE UPDATE).
  3. Xóa một nhân sự test tại bảng cha `employees` -> Kiểm tra bảng con có tự động xóa (CASCADE DELETE).
- **Kết quả mong đợi:**
  - Bước 1: Database từ chối ngay lập tức với mã lỗi PostgreSQL `23503` (`foreign_key_violation`).
  - Bước 2 & 3: Cơ chế CASCADE hoạt động hoàn hảo, không để lại bản ghi mồ côi.
- **Cách xác minh thực tế:** Kiểm tra SQL error code và câu truy vấn mồ côi (`orphan query`) trả về 0 dòng.
- **Tiêu chí PASS/FAIL:**
  - *PASS:* Database chủ động từ chối chèn dữ liệu mồ côi và thực hiện cascade chuẩn xác.

---

### 4. ĐỢT 3: KIỂM ĐỊNH CHATBOT AI, QUOTA VÀ OCR

#### TEST CASE: TC-AI-01 — Kiểm tra Khả năng Chịu tải Hạn ngạch Token và Fallback Router
- **Mã lỗi liên kết:** `DEF-005` (Gemini Token Quota 429).
- **Phân loại tầng test:** AI Router / Performance & Resilience Test.
- **Điều kiện trước khi chạy:** Gói Pay-as-you-go đã liên kết HOẶC module Dynamic Token Budget Truncation đã được kích hoạt trong `aiRouter.js`.
- **Dữ liệu kiểm thử:** Tài liệu nội quy nhân sự dài 25,000 từ đính kèm vào ngữ cảnh chat.
- **Các bước thực hiện:**
  1. Gửi 5 câu hỏi liên tiếp liên quan đến các điều khoản chi tiết trong tài liệu lớn.
  2. Giả lập trường hợp API chính trả về HTTP 429 (Resource Exhausted).
  3. Quan sát log phản hồi của `aiRouter.js`.
- **Kết quả mong đợi:**
  - Câu trả lời của AI phản hồi chính xác trong thời gian < 5 giây.
  - Khi gặp lỗi 429 giả lập, hệ thống tự động fallback mượt mà sang model dự phòng (`gemini-3.5-flash-lite`) mà người dùng trên giao diện web không bị văng lỗi.
- **Cách xác minh thực tế:** Log container ghi nhận: `[AI Router] Fallback to secondary model triggered successfully`.
- **Tiêu chí PASS/FAIL:**
  - *PASS:* Không có thông báo lỗi "Hệ thống AI bận/Quá hạn ngạch" hiển thị cho người dùng.

#### TEST CASE: TC-AI-02 — Kiểm định Trích xuất OCR Tài liệu trên Môi trường Đa nền tảng
- **Mã lỗi liên kết:** `DEF-008` (Cảnh báo native binding `@napi-rs/canvas`).
- **Phân loại tầng test:** OCR / Functional Test.
- **Điều kiện trước khi chạy:** Cấu hình trích xuất OCR đã được cập nhật.
- **Dữ liệu kiểm thử:** File PDF scan hồ sơ nhân sự dạng ảnh mẫu (`sample_id_card_scan.pdf`).
- **Các bước thực hiện:**
  1. Chạy test suite `tests/test_docx_pdf_runtime.js` từ PowerShell máy trạm.
  2. Tải file scan qua API intake `/api/intake/upload`.
- **Kết quả mong đợi:**
  - Không xuất hiện cảnh báo đỏ `Cannot find module` làm văng ứng dụng.
  - Toàn bộ nội dung chữ (Họ tên, CCCD, Ngày sinh) được trích xuất thành công và điền vào form staging.
- **Tiêu chí PASS/FAIL:**
  - *PASS:* Tỷ lệ trích xuất chính xác thông tin trường dữ liệu cốt lõi đạt >= 95%.

---

### 5. ĐỢT 4: KIỂM ĐỊNH TÍCH HỢP VÀ VẬN HÀNH LIÊN DỊCH VỤ

#### TEST CASE: TC-INT-01 — Kiểm định Đồng bộ Google Sheets với Khóa Mới
- **Mã lỗi liên kết:** `DEF-001` (Thu hồi và luân chuyển Google SA Private Key).
- **Phân loại tầng test:** External Integration Test.
- **Điều kiện trước khi chạy:** Khóa mới đã được tạo và lưu tại `credentials/google_service_account.json`; Email service account mới đã được chia sẻ quyền Editor trên Spreadsheet; File `syncWorker.js` đã được cập nhật code nạp file.
- **Dữ liệu kiểm thử:** Trang tính Google Sheets đồng bộ nhân sự thử nghiệm.
- **Các bước thực hiện:**
  1. Chạy hàm kiểm tra kết nối: `node auth-service/services/syncWorker.js --verify-auth`.
  2. Kích hoạt job đồng bộ thử 1 chiều từ Database lên Sheet.
  3. Thu hồi (Delete) khóa cũ trên Google Cloud Console.
  4. Kích hoạt lại job đồng bộ.
- **Kết quả mong đợi:**
  - Lệnh xác thực trả về: `Google Sheets API Connection Established Successfully`.
  - Dữ liệu trên Google Sheet được cập nhật khớp với Database.
  - Sau khi xóa khóa cũ, tiến trình sync vẫn hoạt động bình thường nhờ sử dụng hoàn toàn khóa mới.
- **Tiêu chí PASS/FAIL:**
  - *PASS:* Đồng bộ 2 chiều thành công, không phát sinh lỗi HTTP 401 hoặc 403 từ Google API.
- **Điều kiện dừng triển khai:** Google Sheets API báo lỗi `Permission Denied` kéo dài quá 15 phút -> Kiểm tra lại email chia sẻ trên Spreadsheet.

#### TEST CASE: TC-INT-02 — Chuẩn hóa Đường dẫn Lưu trữ OneDrive Xuyên nền tảng
- **Mã lỗi liên kết:** `DEF-007` (Đường dẫn Windows tuyệt đối trong bảng OneDrive).
- **Phân loại tầng test:** Integration / Cross-Platform File System Test.
- **Điều kiện trước khi chạy:** Hàm xử lý đường dẫn trong `onedriveSyncService.js` đã được chuẩn hóa sang Relative/POSIX path; dữ liệu trong bảng đã được convert.
- **Dữ liệu kiểm thử:** Bản ghi nguồn OneDrive mẫu.
- **Các bước thực hiện:**
  1. Kiểm tra trường `storage_path` trong bảng `user_onedrive_sources`.
  2. Đọc file tệp tin đã đồng bộ thông qua đường dẫn mới từ cả máy host Windows và bên trong container Linux `hr-auth`.
- **Kết quả mong đợi:**
  - 100% bản ghi không còn chứa ký tự `D:\`.
  - Cả môi trường Windows và Docker Linux đều mở và đọc được nội dung tệp tin không gặp lỗi `ENOENT`.
- **Tiêu chí PASS/FAIL:**
  - *PASS:* Tệp tin mở thành công trên cả 2 môi trường.

#### TEST CASE: TC-INT-03 — Kiểm định Rate Limiting Nginx Proxy Webhook n8n
- **Mã lỗi liên kết:** `DEF-014` (Rate limiting webhook proxy).
- **Phân loại tầng test:** Network / Security Rate-limit Test.
- **Điều kiện trước khi chạy:** Cấu hình `limit_req` đã được thêm vào location `/webhook/` trong `nginx/default.conf`.
- **Dữ liệu kiểm thử:** 40 requests HTTP POST liên tiếp trong 10 giây từ cùng một IP.
- **Các bước thực hiện:** Chạy script gửi request dồn dập vào `http://127.0.0.1:8082/webhook/test-endpoint`.
- **Kết quả mong đợi:** 30 requests đầu tiên trả về HTTP 200/404 từ n8n; các request thứ 31 trở đi bị Nginx từ chối với mã **HTTP 503 Service Temporarily Unavailable** hoặc **HTTP 429**.
- **Tiêu chí PASS/FAIL:**
  - *PASS:* Nginx chặn đứng lưu lượng vượt ngưỡng, bảo vệ container n8n khỏi quá tải CPU.

---

### 6. ĐỢT 5: KIỂM ĐỊNH HIỆU NĂNG, SAO LƯU VÀ GIAO DIỆN QUẢN TRỊ

#### TEST CASE: TC-PERF-01 — Kiểm định Tự động hóa Sao lưu Database Hàng ngày
- **Mã lỗi liên kết:** `DEF-006` (Sao lưu CSDL tự động `pg_dump`).
- **Phân loại tầng test:** Operational / Disaster Recovery Test.
- **Điều kiện trước khi chạy:** Script `scripts/backup_database_daily.ps1` đã hoàn thiện; Task Scheduler đã được đăng ký.
- **Dữ liệu kiểm thử:** Toàn bộ cơ sở dữ liệu `hr_auth` thực tế.
- **Các bước thực hiện:**
  1. Kích hoạt cưỡng bức tác vụ: `Start-ScheduledTask -TaskName "SotransHub_Daily_Postgres_Backup"`.
  2. Chờ 30 giây và kiểm tra thư mục `D:\hoso-chat\backups\`.
  3. Thử nghiệm khôi phục file nén vừa tạo vào một database thử nghiệm tạm thời `hr_auth_restore_test`.
- **Kết quả mong đợi:**
  - File nén định dạng `backup_hr_auth_YYYYMMDD_HHmmss.sql.gz` xuất hiện, kích thước > 0.
  - Quá trình khôi phục vào database test thành công 100%, số lượng bảng và dữ liệu khớp 100% với database gốc.
- **Tiêu chí PASS/FAIL:**
  - *PASS:* File backup toàn vẹn, có thể khôi phục được dữ liệu hoạt động bình thường.

#### TEST CASE: TC-PERF-02 — Kiểm định Dọn dẹp Schema `public` và Chuyển Schema `archive`
- **Mã lỗi liên kết:** `DEF-009` (Bảng backup tàn dư trong schema public).
- **Phân loại tầng test:** Database Metadata Inspection.
- **Điều kiện trước khi chạy:** Script chuyển schema đã được thực thi.
- **Các bước thực hiện:**
  1. Truy vấn danh mục bảng trong schema `public`:
     `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';`
  2. Truy vấn danh mục bảng trong schema `archive`:
     `SELECT table_name FROM information_schema.tables WHERE table_schema = 'archive';`
- **Kết quả mong đợi:**
  - Schema `public` chỉ chứa các bảng nghiệp vụ cốt lõi: `employees`, `hr_employee_profiles`, `hr_employee_staging`, `users`, v.v. (không còn `chat_log_backup_*`).
  - Schema `archive` lưu trữ đầy đủ dữ liệu lịch sử của 2 bảng cũ mà không làm mất thông tin.
- **Tiêu chí PASS/FAIL:**
  - *PASS:* Schema sạch sẽ; toàn bộ ứng dụng web và API hoạt động bình thường không phụ thuộc vào các bảng đã di chuyển.

#### TEST CASE: TC-PERF-03 — Kiểm định Phân trang Server-side trên Giao diện Quản trị
- **Mã lỗi liên kết:** `DEF-010` (Phân trang Admin tải 100% hồ sơ vào RAM).
- **Phân loại tầng test:** Frontend / Performance Integration Test.
- **Điều kiện trước khi chạy:** API `GET /api/employees` đã hỗ trợ `page` & `limit`; file `chat/hr-admin.html` đã được cập nhật logic tải theo trang.
- **Dữ liệu kiểm thử:** Request phân trang với `page=1&limit=5` và `page=2&limit=5`.
- **Các bước thực hiện:**
  1. Mở trang Quản trị `http://127.0.0.1:8082/hr-admin.html` trên trình duyệt.
  2. Bật DevTools tab Network -> Quan sát request API được kích hoạt.
  3. Bấm chuyển sang Trang 2 -> Quan sát payload mạng.
- **Kết quả mong đợi:**
  - Mỗi request chỉ trả về đúng 5 bản ghi nhân sự thay vì toàn bộ danh sách.
  - Thời gian phản hồi mạng < 50ms.
  - Phân trang, chuyển trang và badge hiển thị mượt mà, không bị lag giật.
- **Tiêu chí PASS/FAIL:**
  - *PASS:* Phân trang Server-side hoạt động chính xác; giao diện cập nhật tương ứng.

---

### 7. QUY CHUẨN DỪNG KIỂM THỬ KHẨN CẤP (TEST HALT TRIGGERS)

Người thực thi kiểm định phải **DỪNG NGAY LẬP TỨC** toàn bộ quá trình kiểm thử nếu xảy ra bất kỳ điều kiện nào sau đây:

1. **Dữ liệu nhân sự bị biến động bất thường:** Số lượng bản ghi nhân sự của 12 nhân viên chính thức bị sụt giảm hoặc sai lệch trường thông tin CCCD/Họ tên.
2. **PostgreSQL mất kết nối hoặc sập dịch vụ:** Lỗi `Connection refused` hoặc container `hrbot-postgres-1` thoát đột ngột (Exited code 1).
3. **Nginx không thể khởi động lại cấu hình:** Lỗi cú pháp trong file cấu hình dẫn đến mã lỗi `502 Bad Gateway` toàn hệ thống.
4. **Phát hiện rò rỉ thông tin xác thực mới:** Bất kỳ chuỗi khóa bảo mật hoặc mật khẩu nào bị in ra console log không che dấu trong quá trình chạy test.

Khi kích hoạt Dừng khẩn cấp, kỹ sư kiểm thử phải thông báo ngay cho Quản trị viên và thực hiện kích hoạt theo tài liệu **Kế hoạch Rollback (`SYSTEM_REMEDIATION_ROLLBACK_PLAN.md`)**.

---
*Ma trận này là căn cứ kỹ thuật bắt buộc để ký biên bản nghiệm thu cho từng đợt sửa lỗi SOTRANS Hub.*
