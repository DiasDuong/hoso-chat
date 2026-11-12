# SỔ ĐĂNG KÝ VÀ QUẢN TRỊ LỖI HỆ THỐNG SOTRANS HUB
## SOTRANS HUB — MASTER DEFECT & BUG REGISTER (SBR-20261029)

> **Tài liệu:** Sổ đăng ký theo dõi lỗi và rủi ro kỹ thuật hệ thống SOTRANS Hub  
> **Phiên bản:** 1.0 (Audit & System Testing Baseline)  
> **Ngày lập:** 29/10/2026  
> **Chế độ:** CHỈ GHI NHẬN & PHÂN TÍCH — CHƯA THỰC HIỆN SỬA LỖI  
> **Quy chuẩn bảo mật:** Tuyệt đối không hiển thị plaintext khóa bí mật, private key, token hay mật khẩu trong tài liệu này.

---

### MỤC LỤC
1. [Bảng tổng hợp lỗi theo mức độ ưu tiên](#1-bảng-tổng-hợp-lỗi-theo-mức-độ-ưu-tiên)
2. [Chi tiết các lỗi Mức độ P0 (Critical / Blocker)](#2-chi-tiết-các-lỗi-mức-độ-p0-critical--blocker)
3. [Chi tiết các lỗi Mức độ P1 (High Priority)](#3-chi-tiết-các-lỗi-mức-độ-p1-high-priority)
4. [Chi tiết các lỗi Mức độ P2 (Medium Priority)](#4-chi-tiết-các-lỗi-mức-độ-p2-medium-priority)
5. [Chi tiết các lỗi Mức độ P3 (Low Priority / Optimization)](#5-chi-tiết-các-lỗi-mức-độ-p3-low-priority--optimization)

---

### 1. BẢNG TỔNG HỢP LỖI THEO MỨC ĐỘ ƯU TIÊN

```
+------------------------------------------------------------------------------------------------------------------------+
| MÃ LỖI  | MỨC ĐỘ | LĨNH VỰC ẢNH HƯỞNG        | TÊN LỖI & MÔ TẢ TÓM TẮT                               | MÃ AUDIT LIÊN KẾT |
+------------------------------------------------------------------------------------------------------------------------+
| BUG-001 | P0     | Domain 8: Integrations    | Lộ Google Service Account RSA Private Key trong code  | AUD-006           |
| BUG-002 | P1     | Domain 6: AI & Ops        | Lộ JWT_SECRET và GEMINI_API_KEY trong compose file    | AUD-002           |
| BUG-003 | P2     | Domain 6: AI Router       | Hạn ngạch Gemini Free Tier Token gây cạn kiệt 429     | AUD-003           |
| BUG-004 | P2     | Domain 4: HR Lifecycle    | 4 Hồ sơ yêu cầu xóa thật vẫn tồn tại ACTIVE trong CSDL| AUD-015           |
| BUG-005 | P2     | Domain 9: Database        | Thiếu ràng buộc Foreign Key cứng giữa 2 bảng nhân sự  | AUD-012           |
| BUG-006 | P2     | Domain 8: Integrations    | Đường dẫn tuyệt đối Windows trong bảng OneDrive sync  | AUD-010           |
| BUG-007 | P2     | Domain 9: Database        | Thiếu cơ chế sao lưu tự động định kỳ hàng ngày        | AUD-024           |
| BUG-008 | P2     | Domain 5: Intake & OCR    | Thiếu native binding @napi-rs/canvas trên Windows host| AUD-017           |
| BUG-009 | P3     | Domain 9: Database        | Tồn tại 2 bảng backup tàn dư trong schema public      | AUD-013           |
| BUG-010 | P3     | Domain 1: Frontend        | Phân trang Admin tải toàn bộ hồ sơ vào RAM trình duyệt| AUD-005           |
+------------------------------------------------------------------------------------------------------------------------+
```

---

### 2. CHI TIẾT CÁC LỖI MỨC ĐỘ P0 (CRITICAL / BLOCKER)

#### BUG-001: Rò rỉ Google Service Account RSA Private Key trong mã nguồn
- **Mã lỗi:** `BUG-001`
- **Mức độ ưu tiên:** **P0 (Khẩn cấp / Nguy cơ cao nhất)**
- **Lĩnh vực ảnh hưởng:** Lĩnh vực 8: Tích hợp bên ngoài (External Integrations) & An toàn thông tin.
- **Mã kiểm toán liên kết:** `AUD-006`
- **Vị trí phát hiện:** Tệp `auth-service/services/syncWorker.js`, dòng 7 đến dòng 27.
- **Mô tả hiện tượng:**
  Toàn bộ chuỗi khóa bí mật RSA Private Key (`-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----`) cùng địa chỉ email Service Account của Google Cloud Platform (`...@...iam.gserviceaccount.com`) đang bị gán cứng trực tiếp dưới dạng chuỗi hằng số (hardcoded constant string) trong mã nguồn ứng dụng.
- **Bằng chứng kiểm tra thực tế:**
  Kiểm tra cú pháp tại `syncWorker.js`:
  ```javascript
  const serviceAccount = {
    client_email: "sotrans-sheets-sync@...iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC...[REDACTED]...\n-----END PRIVATE KEY-----\n"
  };
  ```
  Khóa này cho phép quyền đọc/ghi toàn quyền tới Google Drive và Google Spreadsheets mà tài khoản service được chia sẻ. Nếu mã nguồn bị rò rỉ hoặc chia sẻ qua kho lưu trữ bên ngoài, toàn bộ dữ liệu bảng tính Google Sheets liên quan đến hồ sơ lương, nhân sự có thể bị truy cập trái phép.
- **Nguyên nhân gốc rễ (Root Cause):**
  Trong quá trình phát triển tính năng đồng bộ Google Sheets, lập trình viên đã đưa trực tiếp file chứng thực JSON vào mã nguồn để chạy thử nghiệm nhanh thay vì cấu hình đọc từ file chứng thực an toàn bên ngoài hoặc sử dụng biến môi trường mã hóa.
- **Tác động (Impact Analysis):**
  - Rủi ro rò rỉ dữ liệu bảng tính nội bộ ra bên ngoài.
  - Vi phạm nghiêm trọng tiêu chuẩn an toàn thông tin (OWASP Secret Management & ISO 27001).
- **Rủi ro khi sửa (Fix Risk & Blast Radius):**
  - *Mức độ rủi ro:* Trung bình.
  - *Vùng ảnh hưởng:* Module đồng bộ Google Sheets `syncWorker.js`. Nếu luân chuyển khóa không đúng, luồng đồng bộ hai chiều giữa Google Sheets và CSDL có thể bị gián đoạn tạm thời.
- **Điều kiện tiên quyết để sửa:**
  - Cần quyền truy cập Google Cloud Console của dự án để tạo cặp khóa mới (Key Rotation) và vô hiệu hóa/xóa khóa cũ.
  - Phê duyệt phương án lưu trữ khóa mới dạng file secret (ví dụ: `credentials/google_service_account.json` được loại trừ bởi `.gitignore`) hoặc biến môi trường `GOOGLE_SA_PRIVATE_KEY`.

---

### 3. CHI TIẾT CÁC LỖI MỨC ĐỘ P1 (HIGH PRIORITY)

#### BUG-002: Lộ `JWT_SECRET` và `GEMINI_API_KEY` dạng Plaintext trong `docker-compose.yml`
- **Mã lỗi:** `BUG-002`
- **Mức độ ưu tiên:** **P1 (Nghiêm trọng)**
- **Lĩnh vực ảnh hưởng:** Lĩnh vực 6: Chatbot AI & Lĩnh vực 10: Vận hành hạ tầng Docker.
- **Mã kiểm toán liên kết:** `AUD-002`
- **Vị trí phát hiện:** Tệp `docker-compose.yml`, dòng 92 và dòng 94 (dưới định nghĩa service `hr-auth`).
- **Mô tả hiện tượng:**
  Các chuỗi bí mật cốt lõi vận hành hệ thống xác thực người dùng (`JWT_SECRET`) và khóa truy cập dịch vụ trí tuệ nhân tạo (`GEMINI_API_KEY`) đang được ghi trực tiếp dưới dạng chuỗi văn bản thuần (plaintext) trong file cấu hình triển khai Docker Compose.
- **Bằng chứng kiểm tra thực tế:**
  Trích đoạn `docker-compose.yml`:
  ```yaml
  hr-auth:
    environment:
      - JWT_SECRET=sotrans_secret_jwt_key_...[REDACTED]
      - GEMINI_API_KEY=AIzaSy...[REDACTED]
  ```
  Bất kỳ ai có quyền đọc file cấu hình hoặc xem lịch sử commit Git đều có thể trích xuất `JWT_SECRET` để tự ký (forge) token quản trị viên giả mạo, hoặc trích xuất `GEMINI_API_KEY` để sử dụng miễn phí/làm cạn kiệt tài nguyên AI.
- **Nguyên nhân gốc rễ (Root Cause):**
  Quá trình thiết lập ban đầu chưa áp dụng quy trình nạp biến môi trường chuẩn qua file `.env` (chưa dùng cú pháp `${JWT_SECRET}` và `${GEMINI_API_KEY}`).
- **Tác động (Impact Analysis):**
  - Nguy cơ giả mạo chữ ký JWT, cho phép kẻ tấn công leo thang đặc quyền lên ADMIN.
  - Nguy cơ lạm dụng API Key của Gemini dẫn đến phát sinh chi phí hoặc khóa tài khoản Google AI.
- **Rủi ro khi sửa (Fix Risk & Blast Radius):**
  - *Mức độ rủi ro:* Thấp đến Trung bình.
  - *Vùng ảnh hưởng:* Toàn bộ phiên đăng nhập của người dùng hiện tại (nếu thay đổi giá trị `JWT_SECRET`, người dùng đang online sẽ bị đăng xuất và cần đăng nhập lại).
- **Điều kiện tiên quyết để sửa:**
  - Phê duyệt kế hoạch luân chuyển khóa bí mật (Secret Rotation).
  - Chuẩn bị file `.env` được bảo vệ quyền truy cập và cập nhật `docker-compose.yml` sử dụng biến nội suy.

---

### 4. CHI TIẾT CÁC LỖI MỨC ĐỘ P2 (MEDIUM PRIORITY)

#### BUG-003: Giới hạn hạn ngạch Gemini Free Tier gây nghẽn và lỗi HTTP 429
- **Mã lỗi:** `BUG-003`
- **Mức độ ưu tiên:** **P2 (Trung bình / Hiệu năng vận hành)**
- **Lĩnh vực ảnh hưởng:** Lĩnh vực 6: Chatbot, AI Router & Trải nghiệm người dùng.
- **Mã kiểm toán liên kết:** `AUD-003`
- **Vị trí phát hiện:** Module `aiRouter.js` và `geminiService.js`.
- **Mô tả hiện tượng:**
  Tài khoản Google AI Studio đang sử dụng gói Free Tier với hạn ngạch trần 250,000 input tokens/ngày và 15 RPM (Requests Per Minute). Khi người dùng tải lên các tệp tài liệu nội quy dài hoặc khi hệ thống chatbot nhân sự nhận nhiều câu hỏi liên tiếp, API của Google trả về mã lỗi HTTP 429 (Resource Exhausted / Quota Exceeded).
- **Nguyên nhân gốc rễ:**
  Chưa đăng ký gói cước trả phí theo dung lượng (Pay-as-you-go Tier) trên Google Cloud Console cho hệ thống AI của doanh nghiệp.
- **Tác động:**
  Chatbot bị gián đoạn phản hồi trong giờ cao điểm hoặc phải chuyển sang model rút gọn (`gemini-3.5-flash-lite`) với độ chính xác và khả năng hiểu ngữ cảnh văn bản dài kém hơn.
- **Rủi ro khi sửa:** Không có rủi ro kỹ thuật; chỉ phát sinh chi phí thanh toán API theo thực tế sử dụng.

#### BUG-004: 4 Hồ sơ nhân sự yêu cầu xóa hoàn toàn (Hard Delete) vẫn tồn tại ACTIVE
- **Mã lỗi:** `BUG-004`
- **Mức độ ưu tiên:** **P2 (Trung bình / Dữ liệu nghiệp vụ)**
- **Lĩnh vực ảnh hưởng:** Lĩnh vực 4: Nghiệp vụ Nhân sự & Vòng đời hồ sơ.
- **Mã kiểm toán liên kết:** `AUD-015`
- **Vị trí phát hiện:** Bảng `employees`, `hr_employee_profiles`, và `hr_employee_staging`.
- **Mô tả hiện tượng:**
  Đợt kiểm toán ngày 28/10 đã định danh 4 hồ sơ nhân viên thử nghiệm/cần xóa vĩnh viễn (Phan Dương Thanh Bình - CCCD `079204001284`, Nguyễn Trần Thiện Nhân - CCCD `079205001589`, Ngô Đặng Tuấn Uyên - CCCD `062095000277`, Lê Thành Nhân - CCCD `080087002353`). Hiện tại 4 hồ sơ này vẫn đang ở trạng thái `ACTIVE` trong cả 2 bảng chính và tồn tại 4 bản ghi tương ứng trong staging.
- **Nguyên nhân gốc rễ:**
  Hệ thống tuân thủ nguyên tắc an toàn dữ liệu: không tự ý thực hiện thao tác xóa cứng (DELETE) khi chưa có văn bản phê duyệt chính thức từ Chủ sở hữu dữ liệu (Data Owner/User).
- **Tác động:**
  Các hồ sơ này vẫn hiển thị trên giao diện quản trị nhân sự và chatbot vẫn có thể tra cứu ra thông tin, gây nhiễu dữ liệu báo cáo nhân sự thực tế của tập đoàn.
- **Rủi ro khi sửa:** Cần kiểm tra ràng buộc khóa ngoại và bản ghi audit log trước khi xóa để tránh lỗi `Foreign Key Violation` hoặc mất dấu vết kiểm toán.

#### BUG-005: Thiếu ràng buộc Foreign Key cứng giữa hai bảng nhân sự cốt lõi
- **Mã lỗi:** `BUG-005`
- **Mức độ ưu tiên:** **P2 (Trung bình / Toàn vẹn cơ sở dữ liệu)**
- **Lĩnh vực ảnh hưởng:** Lĩnh vực 9: PostgreSQL & Kiến trúc cơ sở dữ liệu.
- **Mã kiểm toán liên kết:** `AUD-012`
- **Vị trí phát hiện:** Schema bảng `employees` và `hr_employee_profiles`.
- **Mô tả hiện tượng:**
  Hệ thống duy trì hai bảng song song để quản lý nhân sự: `employees` (bảng thông tin cơ bản phục vụ chat) và `hr_employee_profiles` (bảng hồ sơ chi tiết phục vụ HR). Tuy nhiên, giữa trường `employees.employee_code` và `hr_employee_profiles.employee_id` không có ràng buộc khóa ngoại (`FOREIGN KEY CONSTRAINT`) ở cấp độ database engine.
- **Nguyên nhân gốc rễ:**
  Lịch sử phát triển chắp vá giữa hai giai đoạn: bảng `employees` từ phiên bản cũ và bảng `hr_employee_profiles` mới được bổ sung sau này nhưng chưa được thiết kế migration đồng bộ quan hệ khóa ngoại.
- **Tác động:**
  Tính toàn vẹn dữ liệu phụ thuộc 100% vào mã nguồn backend. Nếu có bất kỳ script bảo trì nào chạy độc lập hoặc thao tác SQL thủ công ngoài ứng dụng, nguy cơ phát sinh bản ghi mồ côi (Orphan Records) là rất lớn.
- **Rủi ro khi sửa:** Trước khi tạo khóa ngoại `ADD CONSTRAINT FOREIGN KEY`, bắt buộc phải đối soát làm sạch 100% dữ liệu để không bị lỗi vi phạm ràng buộc (hiện tại cả 2 bảng đã khớp 16/16 bản ghi).

#### BUG-006: Đường dẫn Windows tuyệt đối trong bảng `user_onedrive_sources.storage_path`
- **Mã lỗi:** `BUG-006`
- **Mức độ ưu tiên:** **P2 (Trung bình / Di động hạ tầng)**
- **Lĩnh vực ảnh hưởng:** Lĩnh vực 8: Tích hợp bên ngoài (OneDrive Sync).
- **Mã kiểm toán liên kết:** `AUD-010`
- **Vị trí phát hiện:** Bảng `user_onedrive_sources` trong PostgreSQL, trường `storage_path`.
- **Mô tả hiện tượng:**
  Trường `storage_path` đang lưu đường dẫn cứng dạng Windows: `D:\hoso-chat\staging\onedrive\...`. Khi chạy mã nguồn hoặc worker trong môi trường Docker Container (Linux container), các đường dẫn chứa dấu gạch chéo ngược `\` và ký tự ổ đĩa `D:` không tương thích với hệ thống file Linux POSIX.
- **Nguyên nhân gốc rễ:**
  Script đồng bộ ban đầu được viết và chạy trực tiếp trên máy host Windows thay vì sử dụng đường dẫn tương đối (Relative Path) hoặc mapping đường dẫn qua biến môi trường container.
- **Tác động:** Khó khăn khi di chuyển hạ tầng từ máy trạm Windows sang máy chủ Linux chuyên dụng (Ubuntu Server/Debian).

#### BUG-007: Thiếu cơ chế sao lưu cơ sở dữ liệu định kỳ tự động (`pg_dump`)
- **Mã lỗi:** `BUG-007`
- **Mức độ ưu tiên:** **P2 (Trung bình / An toàn dữ liệu & Khôi phục sau thảm họa)**
- **Lĩnh vực ảnh hưởng:** Lĩnh vực 9: PostgreSQL & Vận hành sao lưu.
- **Mã kiểm toán liên kết:** `AUD-024`
- **Vị trí phát hiện:** Hệ thống lập lịch tác vụ hệ điều hành Host và Container Postgres.
- **Mô tả hiện tượng:**
  Chưa có tác vụ định kỳ tự động (Cron job hoặc Windows Task Scheduler) thực hiện sao lưu toàn vẹn cơ sở dữ liệu (`pg_dump`) hàng ngày ra thư mục backup độc lập hoặc lưu trữ đám mây. Dữ liệu hiện chỉ nằm trong Docker Volume `hrbot_postgres_data`.
- **Tác động:**
  Nếu máy chủ gặp sự cố phần cứng, hỏng ổ cứng hoặc volume Docker bị xóa nhầm, hệ thống đối mặt với nguy cơ mất trắng dữ liệu nhân sự mà không có bản sao lưu gần nhất để khôi phục.

#### BUG-008: Thiếu native binding `@napi-rs/canvas` trên môi trường Host Windows
- **Mã lỗi:** `BUG-008`
- **Mức độ ưu tiên:** **P2 (Trung bình / Môi trường phát triển)**
- **Lĩnh vực ảnh hưởng:** Lĩnh vực 5: Tiếp nhận hồ sơ, OCR & Staging.
- **Mã kiểm toán liên kết:** `AUD-017`
- **Vị trí phát hiện:** Console log khi khởi động worker trích xuất OCR trên máy trạm Windows.
- **Mô tả hiện tượng:**
  Khi chạy script kiểm thử OCR ngoài container trên Windows, module in ra cảnh báo thiếu file binary biên dịch sẵn `@napi-rs/canvas`, buộc hệ thống phải hạ cấp xuống chế độ trích xuất văn bản thuần qua `pdf-parse`. Tuy nhiên bên trong Docker Linux container thì thư viện hoạt động đầy đủ.
- **Tác động:** Ảnh hưởng đến việc chạy kiểm thử offline hoặc test suite trực tiếp từ PowerShell của lập trình viên.

---

### 5. CHI TIẾT CÁC LỖI MỨC ĐỘ P3 (LOW PRIORITY / OPTIMIZATION)

#### BUG-009: Tồn tại 2 bảng sao lưu tàn dư trong schema `public` của PostgreSQL
- **Mã lỗi:** `BUG-009`
- **Mức độ ưu tiên:** **P3 (Thấp / Dọn dẹp schema)**
- **Lĩnh vực ảnh hưởng:** Lĩnh vực 9: PostgreSQL & Quản trị dữ liệu.
- **Mã kiểm toán liên kết:** `AUD-013`
- **Vị trí phát hiện:** Schema `public`, bảng `chat_log_backup_20261018` (1,691 rows) và bảng `chat_log_archive_legacy` (395 rows).
- **Mô tả hiện tượng:**
  Hai bảng sao lưu lịch sử chat từ các đợt bảo trì cũ vẫn nằm lẫn lộn trong schema chính `public`, gây nhiễu cho các công cụ trích xuất metadata và làm tăng dung lượng không cần thiết trong database production.
- **Giải pháp đề xuất:** Di chuyển vào schema lưu trữ riêng biệt (ví dụ `archive.chat_log_...`) hoặc kết xuất file SQL sao lưu nén rồi xóa bỏ khỏi schema `public`.

#### BUG-010: Giao diện Quản trị tải toàn bộ hồ sơ về RAM trình duyệt để phân trang
- **Mã lỗi:** `BUG-010`
- **Mức độ ưu tiên:** **P3 (Thấp / Tối ưu hóa hiệu năng)**
- **Lĩnh vực ảnh hưởng:** Lĩnh vực 1: Frontend & UI Performance.
- **Mã kiểm toán liên kết:** `AUD-005`
- **Vị trí phát hiện:** Tệp `chat/hr-admin.html`, hàm `loadEmployees()`.
- **Mô tả hiện tượng:**
  Frontend gọi API `GET /api/employees` để lấy toàn bộ 100% danh sách nhân sự về mảng biến JavaScript trên trình duyệt, sau đó mới dùng hàm `allEmployees.slice((page-1)*limit, page*limit)` để cắt trang hiển thị. Hiện tại quy mô 16 nhân viên thì hoạt động nhanh, nhưng khi hệ thống tăng lên hàng nghìn nhân sự, việc tải toàn bộ payload lớn sẽ làm đơ trình duyệt và tốn băng thông mạng.
- **Giải pháp đề xuất:** Nâng cấp API `GET /api/employees?page=1&limit=10` phía backend để hỗ trợ phân trang Server-side.

---
*Sổ đăng ký lỗi này phản ánh chính xác hiện trạng hệ thống đã được kiểm chứng và làm cơ sở cho Kế hoạch Khắc phục (`SYSTEM_REMEDIATION_PLAN.md`).*
