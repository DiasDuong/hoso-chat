# BÁO CÁO NGHIỆM THU AN TOÀN BẢO MẬT & GUARDRAILS
## GENERALAI × BI × WRENAI FORK
**Mã tài liệu:** `DOC-BI-SEC-05`  
**Phiên bản:** 2.0.0 (Đã đối soát module và tham số an ninh thực tế)  
**Trạng thái:** ACCEPTED / COMPLIANT  
**Ngày cập nhật:** 18/11/2026  
**Commit Baseline:** `dbed29a187b09a7b8eac09b6b65c10ae408053c1` (`main`)

---

## 1. MÔ HÌNH AN NINH & ĐỐI TƯỢNG KIỂM TOÁN

Phân hệ BI xử lý thông tin nhân sự và số liệu kinh doanh nội bộ, áp dụng mô hình phòng thủ theo chiều sâu (Defense-in-Depth) tại 6 tầng:
1. **Xác thực & Phân quyền (Authentication & RBAC):** JWT Token, kiểm tra trạng thái tài khoản `ACTIVE`, phân định vai trò `ADMIN`, `HR`, `USER`.
2. **Cô lập Đa Khách thuê & IDOR:** Ràng buộc `tenant_id` (`STL`, `VTX`, `SWC`), ngăn chặn truy cập chéo tài nguyên file và bảng tính.
3. **Rào chắn Truy vấn CSDL (Read-Only Enforcement):** Phân tích cú pháp AST, cấm tuyệt đối câu lệnh ghi, cấu hình `SET TRANSACTION READ ONLY` trên CSDL.
4. **Bảo vệ Dữ liệu Nhạy cảm (PII & Context Sanitization):** Tự động che số CCCD, SĐT, tài khoản cá nhân, đảm bảo không gửi bản ghi chi tiết thô vào prompt LLM.
5. **Kiểm soát Tệp Tải lên & Chống Injection:** Kiểm tra Magic Byte, giới hạn tỷ lệ nén ZIP, lọc mã độc công thức bảng tính (CSV/Formula Injection).
6. **Bảo vệ Luồng Xuất Báo cáo (HMAC Signatures):** Ký số báo cáo bằng thuật toán HMAC-SHA256, thời hạn 1 giờ, so sánh thời gian bất biến (Constant-Time Verification).

---

## 2. KẾT QUẢ KIỂM TOÁN CHI TIẾT THEO TỪNG TẦNG BẢO MẬT

### 2.1. Xác thực & Phân quyền (JWT & RBAC)
- **Module thực thi:** `auth-service/middleware/auth.js` (`verifyToken`), `auth-service/services/wrenBiService.js` (`scopeFor`).
- **Cơ chế:** Kiểm tra JWT ký bằng `JWT_SECRET`. Yêu cầu trạng thái người dùng phải là `ACTIVE`.
- **Phân định vai trò:**
  - `ADMIN`: Có quyền truy cập toàn diện, xem số liệu của các công ty thuộc tập đoàn (`ALL` hoặc từng đơn vị).
  - `HR`: Chỉ được truy vấn dữ liệu thuộc phạm vi đơn vị mình được gán (`STL`, `VTX`, hoặc `SWC`). Thao tác truy vấn sang đơn vị khác bị từ chối ngay với mã lỗi `403 Forbidden` (`WREN_FORBIDDEN`).
  - `USER` / `EMPLOYEE`: Bị chặn hoàn toàn khỏi phân hệ Internal System BI (Dashboard Contract Test D02 PASS); chỉ được phép phân tích các tệp bảng tính do chính mình tải lên.

### 2.2. Cô lập Đa Khách thuê & Chống IDOR (Dataset Security)
- **Module thực thi:** `auth-service/services/biDatasetRegistry.js` (`canUserAccessDataset`), `auth-service/services/biFileSecurityService.js`.
- **Bằng chứng kiểm thử:** Bộ `tests/test_task01_dataset_security.js` (13/13 PASS).
- **Kết quả đối soát:**
  - Người dùng truy cập file của người khác mà không có quyền chia sẻ: BỊ CHẶN (SEC-02).
  - Người dùng truy cập file thuộc tenant khác: BỊ CHẶN (SEC-03).
  - Dataset hết hạn (quá 7 ngày): BỊ CHẶN truy vấn, kể cả với chính chủ sở hữu (SEC-04).
  - Quyền chỉ xem (View-only) cố tình gọi API thực thi truy vấn: BỊ CHẶN (SEC-09).

### 2.3. Rào chắn Thực thi Truy vấn SQL (Read-Only Guardrails)
- **Module thực thi:**
  - Phía Gateway/Auth: `auth-service/services/biQueryValidator.js` (`validateQueryPlan`).
  - Phía WrenAI Sidecar: `integrations/wrenai/upstream/runtime/wren/policy.py` (`validate_planned_sql`), `integrations/wrenai/upstream/runtime/wren/read_only.py`, `integrations/wrenai/bridge/query_service.py`.
- **Ràng buộc:**
  - Chỉ cho phép các câu lệnh bắt đầu bằng `SELECT`. Cấm tuyệt đối: `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `TRUNCATE`, `CREATE`, `RENAME`, `GRANT`, `EXEC`.
  - Cấm chuỗi lệnh phân cách bằng dấu chấm phẩy (`;`).
  - Whitelist danh sách bảng được phép truy vấn trong WrenAI: `public.documents`, `public.hr_intake_batches`, `public.hr_employee_staging`.
  - Kết nối cơ sở dữ liệu của WrenAI bắt buộc chạy dưới giao dịch: `SET TRANSACTION READ ONLY`.

### 2.4. Che giấu Thông tin Cá nhân & Ngữ cảnh An toàn (PII Sanitization)
- **Module thực thi:** `auth-service/services/biPrivacy.js`.
- **Cơ chế:**
  - `sanitizeBiData`: Quét và che giấu các trường định danh cá nhân nhạy cảm trước khi trả về client:
    - Căn cước công dân (12 chữ số): Định dạng `079******234`.
    - Số điện thoại (10 chữ số): Định dạng `09******89`.
    - Mật khẩu, token, API key: Che toàn bộ (`[REDACTED]`).
  - `buildSafeInsightContext`: Khi tạo prompt tóm tắt cho mô hình AI, **tuyệt đối không gửi các dòng dữ liệu cá nhân chi tiết**, mà chỉ gửi các chỉ số tổng hợp an toàn (`kpi_summary`, `period_comparison`, `top_categories`).

### 2.5. Bảo vệ Tệp Tải lên & Chống Injection (File Security)
- **Module thực thi:** `auth-service/services/biFileSecurityService.js`.
- **Ràng buộc tham số thực tế:**
  - Dung lượng file tối đa: **25 MB** (`MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024`).
  - Bảo vệ chống ZIP Bomb: Giới hạn dung lượng giải nén tối đa 100 MB (`MAX_UNCOMPRESSED_ZIP_BYTES`), tỷ lệ nén tối đa 25:1 (`MAX_ZIP_RATIO`).
  - Xác thực Magic Byte: Kiểm tra khớp chữ ký tệp tin (tránh việc đổi đuôi file `.exe` thành `.xlsx`).
  - Chống Formula Injection: Hàm `sanitizeFormulaInjection` tự động thêm tiền tố dấu nháy đơn (`'`) vào các ô dữ liệu bắt đầu bằng `=`, `+`, `-`, `@` nhằm triệt tiêu nguy cơ thực thi mã ngoài dự kiến khi người dùng mở file xuất trên Excel.
  - Vòng đời lưu trữ tạm thời: **7 ngày** (`DEFAULT_RETENTION_DAYS = 7`).

### 2.6. Bảo vệ Luồng Xuất Báo cáo (HMAC Signed Export Tokens)
- **Module thực thi:** `auth-service/services/biExportToken.js`, `auth-service/routes/bi_exports.js`.
- **Cơ chế:**
  - Khi một dashboard được tạo, server ký số toàn bộ nội dung qua hàm `signReport(payload, user)`.
  - Token gồm 2 phần: `<body_base64url>.<signature_base64url>` với chữ ký `HMAC_SHA256(body, JWT_SECRET)`.
  - Thời hạn hiệu lực: **1 giờ (3.600.000 ms)** kể từ thời điểm sinh báo cáo.
  - Xác minh thời gian bất biến: Sử dụng hàm `crypto.timingSafeEqual` để so sánh chữ ký nhận được với chữ ký kỳ vọng, loại bỏ hoàn toàn rủi ro tấn công phân tích thời gian (Timing Attacks).
  - Chống sửa đổi (Tamper-proof): Token gắn chặt với mã băm SHA-256 (`digest`) của payload. Thử nghiệm sửa đổi tiêu đề hoặc số liệu của dashboard khiến digest không khớp và bị từ chối ngay lập tức với mã `403 Forbidden` (Đã xác minh trong `test_bi_release_browser.js`).

### 2.7. Quản lý Bí mật & Khuyến nghị Xoay vòng Khóa (Secrets Audit)
- **Hiện trạng:**
  - Toàn bộ bí mật của môi trường Staging đã được tham số hóa thành biến môi trường thông qua file `D:\hoso-chat-staging\.env` (file này nằm trong `.gitignore` và không bị Git theo dõi).
  - Môi trường phát triển cục bộ (`docker-compose.yml`) sử dụng các giá trị fallback tiện lợi cho dev.
- **Khuyến nghị bắt buộc cho Production:**
  - Tạo mới các khóa bí mật độc lập cho môi trường Production: `JWT_SECRET` (tối thiểu 32 ký tự ngẫu nhiên entropy cao), `POSTGRES_PASSWORD`, và `WRENAI_API_KEY`.
  - Tuyệt đối không dùng chung bí mật giữa môi trường Dev/Staging và Production.

---

## 3. KẾT LUẬN AN TOÀN BẢO MẬT

Hệ thống tuân thủ đầy đủ các chuẩn an ninh xác thực JWT, RBAC đa tenant, bảo vệ IDOR, che giấu PII, kiểm soát tệp tải lên, và rào chắn SQL Read-Only. Trong phạm vi kiểm thử tự động 211 kịch bản và kiểm toán an toàn mã nguồn, **không phát hiện lỗ hổng bảo mật nghiêm trọng (Critical / High vulnerabilities) cản trở nghiệm thu kỹ thuật.**
