# BÁO CÁO KIỂM TOÁN TOÀN DIỆN HỆ THỐNG SOTRANS HUB
**Mã văn bản:** `SYSTEM_AUDIT_REPORT_20261028`  
**Ngày thực hiện:** 28/10/2026  
**Chế độ thực hiện:** STRICTLY READ-ONLY AUDIT (Không sửa mã nguồn, không sửa dữ liệu, không đổi cấu hình, không restart dịch vụ)  
**Đơn vị kiểm toán:** Senior Business Analyst, Senior Backend Engineer, Database Architect & Security Auditor  
**Phạm vi hệ thống:** Toàn bộ dự án SOTRANS Hub tại `D:\hoso-chat` và các dịch vụ hạ tầng liên quan (Docker, PostgreSQL, Nginx, n8n, Qdrant, NocoDB, Google Sheets, OneDrive)  

---

## MỤC LỤC
1. [Phần A — Tóm tắt điều hành (Executive Summary)](#phần-a--tóm-tắt-điều-hành-executive-summary)
   - 1.1. Bối cảnh và mục tiêu kiểm toán
   - 1.2. Phương pháp luận & Nguyên tắc bảo vệ dữ liệu
   - 1.3. Đánh giá tổng quan hiện trạng hệ thống
   - 1.4. Ma trận thống kê phát hiện kiểm toán
2. [Phần B — Bảng danh mục lỗi & phát hiện kiểm toán chi tiết (12 Modules)](#phần-b--bảng-danh-mục-lỗi--phát-hiện-kiểm-toán-chi-tiết)
   - Module A: Kiến trúc hệ thống, Docker, Nginx, Cổng dịch vụ & Mạng
   - Module B: Bảo mật, Xác thực JWT, Phân quyền RBAC & Quản lý Secret
   - Module C: Cơ sở dữ liệu, Schema, Khóa ngoại, Ràng buộc & Dữ liệu mồ côi
   - Module D: Quản lý hồ sơ nhân viên, Vòng đời nhân sự & 4 Nhân viên yêu cầu xóa vĩnh viễn
   - Module E: Tiếp nhận dữ liệu (Intake), Staging, File Excel/CSV, Universal Data Engine
   - Module F: Tệp tin, Tài liệu đính kèm, Staging Retention & Preview/Download
   - Module G: AI, Chatbot Nhân sự, General AI Router, Orchestrator & Gemini Quota
   - Module H: Vector Database (Qdrant), Chunks, Embeddings & RAG Pipeline
   - Module I: Tích hợp bên ngoài (n8n, NocoDB, Microsoft Graph / OneDrive, Google Sheets)
   - Module J: Frontend, Giao diện Chat, Admin Console & Markdown Rendering
   - Module K: Hiệu năng, Connection Pooling & Khả năng mở rộng (Scalability)
   - Module L: Logging, Giám sát, Audit Trail, Backup & Phục hồi sau thảm họa (Disaster Recovery)
3. [Phần C — Bản đồ phụ thuộc và ma trận phạm vi tác động (Dependency Map & Impact Matrix)](#phần-c--bản-đồ-phụ-thuộc-và-ma-trận-phạm-vi-tác-động)
4. [Phần D — Danh sách kiểm thử chi tiết (Test Suites Execution Summary)](#phần-d--danh-sách-kiểm-thử-chi-tiết)
5. [Phần E — Kế hoạch khắc phục theo lộ trình (5 Giai đoạn đề xuất)](#phần-e--kế-hoạch-khắc-phục-theo-lộ-trình)
6. [Phần F — Các quyết định cần người dùng phê duyệt](#phần-f--các-quyết-định-cần-người-dùng-phê-duyệt)

---

## PHẦN A — TÓM TẮT ĐIỀU HÀNH (EXECUTIVE SUMMARY)

### 1.1. Bối cảnh và mục tiêu kiểm toán
Hệ thống SOTRANS Hub (`D:\hoso-chat`) đóng vai trò là nền tảng quản trị hồ sơ nhân sự, chính sách nội bộ và trợ lý AI thông minh cho các công ty thành viên trong hệ sinh thái SOTRANS (STL, VTX, SWC). Đợt kiểm toán toàn diện này được kích hoạt nhằm rà soát độc lập, sâu rộng mọi tầng kỹ thuật: từ hạ tầng mạng, bảo mật container, cơ chế xác thực JWT, phân quyền RBAC, tính toàn vẹn dữ liệu PostgreSQL, luồng tiếp nhận hồ sơ (Intake Staging), cơ sở dữ liệu vector (Qdrant), mô hình ngôn ngữ lớn (Gemini API), đến giao diện người dùng (Frontend Web).

### 1.2. Phương pháp luận & Nguyên tắc bảo vệ dữ liệu
- **Chế độ kiểm toán thuần túy chỉ đọc (Strict Read-Only Mode):** 100% các kết luận dựa trên bằng chứng kiểm tra mã nguồn tĩnh, truy vấn trạng thái cơ sở dữ liệu có kiểm soát, giám sát nhật ký vận hành (logs) và chạy các bộ kiểm thử tự động không làm thay đổi dữ liệu thật (non-destructive tests có teardown sạch).
- **Phân loại trạng thái phát hiện:**
  - `CONFIRMED`: Lỗi hoặc điểm yếu đã được xác nhận trực tiếp từ mã nguồn hoặc cấu trúc cấu hình.
  - `REPRODUCED`: Lỗi đã được kích hoạt và tái hiện thực tế thông qua lệnh kiểm thử thực tế.
  - `SUSPECTED`: Vấn đề có dấu hiệu bất thường nhưng phụ thuộc vào điều kiện ngoại vi hoặc tải cao.
  - `NOT VERIFIED`: Chức năng chưa thể xác minh đầy đủ do thiếu môi trường kết nối trực tiếp.
  - `PASS`: Tính năng đã được kiểm chứng bằng thực nghiệm tự động và đạt tiêu chuẩn sản xuất.

### 1.3. Đánh giá tổng quan hiện trạng hệ thống
- **Điểm mạnh cốt lõi:**
  1. *Phân quyền RBAC nhân sự (Section F Remediation):* Cơ chế bảo vệ hồ sơ xóa mềm và thôi việc hoạt động rất nghiêm ngặt. Chuyên viên Nhân sự (HR) bị chặn hoàn toàn (HTTP 403) khi cố xóa, khôi phục hoặc tự ý kích hoạt lại nhân viên bị ADMIN cho nghỉ việc.
  2. *Động cơ bóc tách dữ liệu thông minh (Universal Data Engine):* Hỗ trợ xuất sắc bóc tách đa định dạng (Excel đa sheet, CSV, DOCX, PDF văn bản thuần), chuẩn hóa địa danh logistics, loại bỏ dấu tiếng Việt, phòng chống tấn công Prompt Injection và đối soát mâu thuẫn dữ liệu giữa nhiều tệp đính kèm.
  3. *Qdrant RAG & Đồng bộ tự động:* Vector DB Qdrant quản trị 100 vector chunk chính sách với cosine distance (size 768), có tiến trình đối soát định kỳ (`qdrantSyncService.js`) mỗi 60 phút và tự động xóa vector khi tài liệu bị xóa.
  4. *Chính sách Staging Retention 7 ngày:* Vừa được triển khai thành công, tự động dọn dẹp các tệp tạm > 7 ngày trên ổ đĩa vật lý mà vẫn bảo vệ các hồ sơ đang trong hàng đợi phê duyệt.
- **Điểm yếu & Rủi ro trọng yếu cần khắc phục:**
  1. *[P0 - Critical] Lộ khóa bảo mật Google Service Account RSA Private Key:* Khóa riêng tư RSA của Google Service Account đang bị hardcode trực tiếp dạng plaintext trong mã nguồn `auth-service/services/syncWorker.js`.
  2. *[P1 - High] Lỗi điều hướng Nginx `/chat/files/` & Basic Auth Popup:* Cấu hình Nginx chặn tên file có phần mở rộng (như `.pdf`) gây lỗi 404, đồng thời bắt buộc xác thực Basic Auth qua `.htpasswd` khiến người dùng đã đăng nhập JWT bị chặn 401 khi xem tệp đính kèm trong chat.
  3. *[P1 - High] Lộ khóa JWT_SECRET và GEMINI_API_KEY trong `docker-compose.yml`:* Thông tin xác thực cốt lõi được cấu hình trực tiếp dạng plaintext trong compose file thay vì nạp từ tệp môi trường được bảo vệ.
  4. *[P2 - Medium] Cổng nội bộ (n8n, NocoDB, Auth) lắng nghe trên `0.0.0.0`:* Cho phép các máy trong mạng LAN truy cập trực tiếp n8n (5679) và NocoDB (8081) mà không đi qua Nginx Gateway.
  5. *[P2 - Medium] Giới hạn Token Gemini Free Tier (250,000 tokens):* Khi người dùng tải nhiều tệp lớn cùng lúc hoặc chạy kiểm thử dồn dập, tài khoản Gemini miễn phí bị cạn quota, buộc hệ thống phải kích hoạt cơ chế fallback sang `gemini-3.5-flash-lite`, làm tăng độ trễ phản hồi.
  6. *[P2 - Medium] 4 nhân sự yêu cầu xóa vĩnh viễn vẫn đang ACTIVE trong DB:* Chưa được thực hiện Hard-Delete theo yêu cầu trước đó do chờ phê duyệt phương án an toàn.

### 1.4. Ma trận thống kê phát hiện kiểm toán

| Phân hệ (Module) | P0 (Critical) | P1 (High) | P2 (Medium) | P3 (Low) | P4 (Improvement) | PASS | Tổng mục |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **A. Kiến trúc & Mạng Nginx** | 0 | 1 | 1 | 1 | 0 | 0 | 3 |
| **B. Bảo mật, RBAC & Secrets** | 1 | 1 | 2 | 0 | 0 | 1 | 5 |
| **C. Cơ sở dữ liệu & Schema** | 0 | 0 | 1 | 1 | 0 | 1 | 3 |
| **D. Vòng đời nhân sự & 4 Nhân viên** | 0 | 0 | 1 | 0 | 0 | 0 | 1 |
| **E. Tiếp nhận Staging & Data Engine** | 0 | 0 | 1 | 0 | 0 | 2 | 3 |
| **F. Quản lý Tệp tin & Đường dẫn** | 0 | 0 | 1 | 0 | 0 | 0 | 1 |
| **G. AI Chatbot & Quota Management** | 0 | 0 | 1 | 0 | 0 | 0 | 1 |
| **H. Qdrant Vector & RAG Pipeline** | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| **I. Tích hợp bên ngoài (n8n, NocoDB)** | 0 | 0 | 1 | 0 | 0 | 0 | 1 |
| **J. Frontend & Markdown UX** | 0 | 0 | 0 | 1 | 0 | 1 | 2 |
| **K. Hiệu năng & Scalability** | 0 | 0 | 0 | 1 | 0 | 0 | 1 |
| **L. Logging, Audit Trail & DR Backup** | 0 | 0 | 1 | 0 | 0 | 0 | 1 |
| **TỔNG CỘNG** | **1** | **2** | **9** | **4** | **0** | **6** | **22** |

---

## PHẦN B — BẢNG DANH MỤC LỖI & PHÁT HIỆN KIỂM TOÁN CHI TIẾT

### Module A: Kiến trúc hệ thống, Docker, Nginx, Cổng dịch vụ & Mạng

#### [AUD-001] [P1 — High] [REPRODUCED] Nginx `/chat/files/` xung đột Regex và chặn Basic Auth
- **Vị trí phát hiện:** `nginx/default.conf:27-44`, `chat/index.html:8013, 8237`
- **Bằng chứng thực tế:**
  - Kiểm tra Nginx location:
    ```nginx
    location ~ "^/chat/files/([A-Za-z0-9-]{8,64})$" {
      auth_basic "Ho so nhan su";
      auth_basic_user_file /etc/nginx/.htpasswd;
      alias /usr/share/nginx/chat-files/$1;
      dav_methods PUT DELETE;
      ...
    }
    ```
  - Lệnh kiểm chứng 1: `curl.exe -I http://127.0.0.1:8082/chat/files/test.pdf` trả về `HTTP/1.1 404 Not Found` vì regex không chứa dấu chấm (`.`), Nginx chuyển tiếp request vào `location /chat/ { root /usr/share/nginx; }`, tìm kiếm tại `/usr/share/nginx/chat/files/test.pdf` (không tồn tại).
  - Lệnh kiểm chứng 2: `curl.exe -I http://127.0.0.1:8082/chat/files/1470de38-0bd0-4ca8-9032-9f48bb1ef87b` trả về `HTTP/1.1 401 Unauthorized` kèm header `WWW-Authenticate: Basic realm="Ho so nhan su"`.
- **Nguyên nhân gốc rễ:** Cấu hình WebDAV cũ dùng file `.htpasswd` từ giai đoạn trước khi xây dựng dịch vụ xác thực JWT. Người dùng hiện đại đăng nhập bằng Bearer JWT nên trình duyệt không có Basic Auth Header, dẫn đến popup đòi tài khoản hoặc bị chặn 401/404.
- **Phạm vi tác động:** Người dùng trong chat bấm tải hoặc xem trước các tài liệu đính kèm bị lỗi không mở được tệp.
- **Đề xuất khắc phục:** Sửa `location /chat/files/` trong `nginx/default.conf`: tắt `auth_basic off;`, mở rộng regex cho phép các ký tự mở rộng file hợp lệ `[A-Za-z0-9._-]{1,128}`, ánh xạ alias trực tiếp vào thư mục `/usr/share/nginx/chat-files/`, hoặc proxy qua `hr-auth:3000/api/conversations/files/` để kiểm tra quyền truy cập JWT.

#### [AUD-007] [P2 — Medium] [CONFIRMED] Cổng dịch vụ nội bộ (n8n, NocoDB, Auth) lắng nghe mở trên `0.0.0.0`
- **Vị trí phát hiện:** `docker-compose.yml:42, 70, 83, 107`
- **Bằng chứng thực tế:**
  - `n8n: ports: - "5679:5678"` (không có tiền tố `127.0.0.1:`)
  - `nocodb: ports: - "8081:8080"` (không có tiền tố `127.0.0.1:`)
  - `auth: ports: - "3000:3000"` (không có tiền tố `127.0.0.1:`)
  - `curl.exe -I http://127.0.0.1:3000/api/health` trả về HTTP 200 trực tiếp mà không cần đi qua cổng Nginx 8082.
- **Nguyên nhân gốc rễ:** Thiếu ràng buộc IP cục bộ (`127.0.0.1:port:port`) trong cấu hình dịch vụ docker-compose.
- **Phạm vi tác động:** Nếu máy chủ tham gia mạng LAN hoặc có IP công cộng, bất kỳ ai trên mạng đều có thể kết nối thẳng vào giao diện n8n workflow editor hoặc NocoDB mà không bị Nginx kiểm soát.
- **Đề xuất khắc phục:** Thay đổi cấu hình cổng trong `docker-compose.yml` thành `"127.0.0.1:5679:5678"`, `"127.0.0.1:8081:8080"`, `"127.0.0.1:3000:3000"`.

#### [AUD-008] [P3 — Low] [CONFIRMED] Location `/chat/history` WebDAV không còn sử dụng nhưng vẫn mở xác thực Basic Auth
- **Vị trí phát hiện:** `nginx/default.conf:47-58`
- **Bằng chứng thực tế:**
  ```nginx
  location = /chat/history {
    auth_basic "Ho so nhan su";
    auth_basic_user_file /etc/nginx/.htpasswd;
    alias /usr/share/nginx/chat-files/_history_$remote_user.json;
    dav_methods PUT;
    ...
  }
  ```
- **Nguyên nhân gốc rễ:** Tàn dư cấu hình lưu lịch sử chat vào file JSON phẳng trên đĩa từ phiên bản đầu. Hiện tại toàn bộ lịch sử trò chuyện được lưu trong bảng PostgreSQL `ai_conversations` và `ai_messages`.
- **Phạm vi tác động:** Không ảnh hưởng nghiệp vụ chính nhưng làm rối cấu hình Nginx và tiềm ẩn nguy cơ bảo mật nếu file `.htpasswd` bị lộ.
- **Đề xuất khắc phục:** Gỡ bỏ block `location = /chat/history` khỏi `nginx/default.conf`.

---

### Module B: Bảo mật, Xác thực JWT, Phân quyền RBAC & Quản lý Secret

#### [AUD-006] [P0 — Critical] [CONFIRMED] Lộ khóa RSA Private Key của Google Service Account trong mã nguồn
- **Vị trí phát hiện:** `auth-service/services/syncWorker.js:7-27`
- **Bằng chứng thực tế:**
  ```javascript
  const GOOGLE_SA = {
    client_email: 'n8n-sheets-bot@n8n-sheets-510207.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC0lkpn48v2kzpA\n...'
  };
  ```
  Khóa riêng tư RSA đầy đủ (~1,700 ký tự) được gán cứng vào biến hằng số trong code JavaScript.
- **Nguyên nhân gốc rễ:** Lập trình viên đưa trực tiếp thông tin xác thực để kiểm thử đồng bộ Google Sheets mà không tách ra biến môi trường hoặc vault.
- **Phạm vi tác động:** Nếu mã nguồn bị rò rỉ hoặc chia sẻ, kẻ tấn công có toàn quyền mạo danh Service Account này để đọc, ghi hoặc thao túng các tài liệu trên Google Cloud Project `n8n-sheets-510207`.
- **Đề xuất khắc phục:**
  1. Thu hồi (Revoke) ngay lập tức Key ID hiện tại trên Google Cloud Console IAM.
  2. Tạo cặp khóa mới và lưu vào file cấu hình bảo mật hoặc biến môi trường `GOOGLE_SHEETS_PRIVATE_KEY` trong `.env`.
  3. Cập nhật `syncWorker.js` để đọc khóa qua `process.env.GOOGLE_SHEETS_PRIVATE_KEY`.

#### [AUD-002] [P1 — High] [CONFIRMED] Khóa bí mật JWT_SECRET và GEMINI_API_KEY đặt cố định trong `docker-compose.yml`
- **Vị trí phát hiện:** `docker-compose.yml:92, 94`
- **Bằng chứng thực tế:**
  ```yaml
  JWT_SECRET: [REDACTED]
  GEMINI_API_KEY: [REDACTED]
  ```
- **Nguyên nhân gốc rễ:** Cấu hình trực tiếp biến môi trường nhạy cảm trong file compose thay vì sử dụng cơ chế nội suy từ file `.env` được bảo mật bằng quyền đọc hạn chế.
- **Phạm vi tác động:** Rủi ro lộ API Key Gemini và JWT Secret (cho phép giả mạo token người dùng) nếu repo Git được commit hoặc gửi cho bên thứ ba.
- **Đề xuất khắc phục:** Thay bằng `${JWT_SECRET}` và `${GEMINI_API_KEY}`, lưu giá trị thật trong tệp `.env` riêng biệt có phân quyền NTFS/Linux nghiêm ngặt và thêm `.env` vào `.gitignore`.

#### [AUD-009] [P2 — Medium] [CONFIRMED] Cấu hình CORS mở (`*`) và rò rỉ header `X-Powered-By: Express`
- **Vị trí phát hiện:** `auth-service/server.js:24`, HTTP response headers
- **Bằng chứng thực tế:**
  - `app.use(cors());` -> trả về header `Access-Control-Allow-Origin: *` trên mọi API bao gồm cả API nhạy cảm.
  - Header phản hồi HTTP chứa `X-Powered-By: Express`.
- **Nguyên nhân gốc rễ:** Sử dụng middleware mặc định mà không thiết lập whitelist domain và chưa gọi `app.disable('x-powered-by')`.
- **Phạm vi tác động:** Giúp kẻ tấn công thu thập thông tin về công nghệ backend và tạo điều kiện cho các kịch bản Cross-Site Request mạo danh nếu cookie/token bị khai thác.
- **Đề xuất khắc phục:** Cấu hình CORS với danh sách origin được phép (chỉ định miền nội bộ SOTRANS và localhost), đồng thời thêm `app.disable('x-powered-by')`.

#### [AUD-010] [P2 — Medium] [CONFIRMED] Tuyến Proxy Nginx `/webhook/` chuyển tiếp trực tiếp vào n8n không có xác thực
- **Vị trí phát hiện:** `nginx/default.conf:83-93`
- **Bằng chứng thực tế:** Nginx chặn đích danh 2 webhook chatbot (`/webhook/hoso-chat` và `/webhook/hr-policy-chat`), nhưng các webhook khác được proxy tự do vào n8n:
  ```nginx
  location /webhook/ {
    auth_basic off;
    proxy_pass http://n8n:5678/webhook/;
    ...
  }
  ```
- **Nguyên nhân gốc rễ:** Nhằm phục vụ webhook cho trang quản trị n8n (`hr-admin-api`, `hr-upload-api`), nhưng không có tiền tố bảo mật hoặc token handshake.
- **Phạm vi tác động:** Bất kỳ ai biết tên webhook trên n8n đều có thể gửi HTTP request kích hoạt luồng xử lý hoặc làm quá tải n8n instance.
- **Đề xuất khắc phục:** Đặt header `X-Webhook-Secret` hoặc giới hạn các URL webhook cụ thể thay vì mở tiền tố `/webhook/` rộng rãi.

#### [AUD-011] [PASS] Phân quyền vòng đời nhân sự (RBAC Soft-delete, Resign, Reactivate)
- **Vị trí kiểm tra:** `auth-service/routes/employees.js:1902-2300`
- **Kết quả kiểm toán:** Hoạt động chuẩn mực 100% (25/25 kịch bản PASS). Chuyên viên Nhân sự (HR) gọi API xóa hoặc khôi phục trực tiếp bị trả về HTTP 403 Forbidden. Trạng thái nghỉ việc do ADMIN chỉ định không thể bị HR đảo ngược. Toàn bộ các lần cố gắng thao tác trái phép đều được ghi nhận vào `auth_audit_logs`.

---

### Module C: Cơ sở dữ liệu, Schema, Khóa ngoại, Ràng buộc & Dữ liệu mồ côi

#### [AUD-012] [P2 — Medium] [CONFIRMED] Dư thừa dữ liệu giữa hai bảng `employees` và `hr_employee_profiles` (Thiếu ràng buộc FK)
- **Vị trí phát hiện:** Cơ sở dữ liệu PostgreSQL `hrbot`
- **Bằng chứng thực tế:**
  - Bảng `employees`: Khóa chính UUID (`id`), chứa `employee_code`, `employee_name`, `company_id`, `department`, `position`, `email`, `status` (16 bản ghi).
  - Bảng `hr_employee_profiles`: Khóa chính Serial Integer (`id`), chứa `employee_id`, `full_name`, `citizen_id`, `company_id`, `status` (16 bản ghi).
  - Không có ràng buộc khóa ngoại (Foreign Key) chính thức giữa `employees.employee_code` và `hr_employee_profiles.employee_id`.
- **Nguyên nhân gốc rễ:** Bảng `employees` phục vụ dịch vụ xác thực và phân quyền tài khoản (auth), còn `hr_employee_profiles` phục vụ 53 trường dữ liệu chuyên sâu của NocoDB/Nhân sự.
- **Phạm vi tác động:** Tiềm ẩn rủi ro mâu thuẫn dữ liệu (data drift) nếu một transaction cập nhật một bảng mà quên cập nhật bảng còn lại.
- **Đề xuất khắc phục:** Thiết lập trigger cập nhật đồng bộ hai chiều hoặc bổ sung ràng buộc khóa ngoại `FOREIGN KEY (employee_id) REFERENCES employees(employee_code) ON UPDATE CASCADE`.

#### [AUD-013] [P3 — Low] [CONFIRMED] Tồn tại các bảng sao lưu cũ (Backup/Archive) trong public schema
- **Vị trí phát hiện:** PostgreSQL `hrbot`, schema `public`
- **Bằng chứng thực tế:** Bảng `chat_log_backup_20261018` (1,691 dòng) và `chat_log_archive_legacy` (395 dòng) vẫn nằm trực tiếp trong public schema hoạt động.
- **Nguyên nhân gốc rễ:** Sao lưu thủ công trước các đợt migration trước đây mà chưa chuyển sang schema `archive` hoặc tệp `.sql.gz`.
- **Phạm vi tác động:** Chiếm dụng dung lượng và làm nhiễu danh sách bảng khi kiểm toán hoặc bảo trì tự động.
- **Đề xuất khắc phục:** Tạo schema `archive` và di chuyển 2 bảng này: `ALTER TABLE public.chat_log_backup_20261018 SET SCHEMA archive;`.

#### [AUD-014] [PASS] Đánh chỉ mục Index trên các cột tìm kiếm và trạng thái
- **Vị trí kiểm tra:** `pg_indexes`
- **Kết quả kiểm toán:** Các cột quan trọng đều có index tối ưu: `idx_hr_employee_profiles_status`, `idx_hr_employee_profiles_emp_id`, `idx_employees_status`, `idx_employees_company_id`, `idx_staging_status`, `idx_audit_logs_action`.

---

### Module D: Quản lý hồ sơ nhân viên, Vòng đời nhân sự & 4 Nhân viên yêu cầu xóa vĩnh viễn

#### [AUD-015] [P2 — Medium] [CONFIRMED] 4 Nhân viên yêu cầu xóa vĩnh viễn (Hard Delete) vẫn đang tồn tại với trạng thái ACTIVE
- **Vị trí phát hiện:** PostgreSQL bảng `employees` và `hr_employee_profiles`
- **Bằng chứng thực tế:**
  Truy vấn SQL thực tế:
  ```sql
  SELECT id, employee_code, employee_name, company_id, status 
  FROM employees 
  WHERE employee_code IN ('079204001284', '079205001589', '062095000277', '080087002353');
  ```
  Kết quả trả về 4 dòng với `status = 'ACTIVE'`:
  1. `466418f7-c618-4646-a89b-7d5957670d7e` | `062095000277` | NGÔ ĐẶNG TUẤN UYÊN | SWC | ACTIVE
  2. `aa5b866b-dcec-4226-8381-23aa491d2f8e` | `079204001284` | PHAN DƯƠNG THANH BÌNH | SWC | ACTIVE
  3. `f27d66e7-fa9c-4818-b253-0049b2144f06` | `079205001589` | NGUYỄN TRẦN THIỆN NHÂN | SWC | ACTIVE
  4. `4d10e36a-20c3-476a-9b97-9d981bb6d11b` | `080087002353` | LÊ THÀNH NHÂN | SWC | ACTIVE
- **Nguyên nhân gốc rễ:** Tuân thủ nguyên tắc bảo vệ dữ liệu ở lượt tương tác trước (chờ xác nhận và lập quy trình xóa sạch liên kết đa bảng để tránh lỗi khóa ngoại).
- **Phạm vi tác động:** 4 hồ sơ này vẫn xuất hiện khi tìm kiếm nhân viên thuộc Sowatco (SWC) trên Chatbot và Trang quản trị.
- **Đề xuất khắc phục:** Thực hiện xóa vĩnh viễn (Hard-delete) theo kế hoạch có rollback tại Đợt 2, xóa sạch các bản ghi liên quan trong `hr_sync_tasks`, `hr_employee_staging`, `hr_employee_profiles` và `employees`.

---

### Module E: Tiếp nhận dữ liệu (Intake), Staging, File Excel/CSV, Universal Data Engine

#### [AUD-016] [PASS] Động cơ bóc tách Universal Data Understanding Engine
- **Vị trí kiểm tra:** `auth-service/services/universalDataEngine.js`, `dataEngine.js`
- **Kết quả kiểm toán:** Đạt 100% trong bài kiểm tra đối soát sâu (12/12 test case). Bóc tách chuẩn xác tọa độ ô Excel, phân biệt các sheet đa tab, chuẩn hóa tiền tệ, chống Prompt Injection và nhận diện chính xác 8 cụm địa danh logistics cốt lõi (Cát Lái, Dĩ An, Tân Bình, Hải Phòng, Hà Nội, Đồng Nai, Quảng Ngãi, Bắc Giang).

#### [AUD-017] [P2 — Medium] [CONFIRMED] Cảnh báo thiếu native binding `@napi-rs/canvas` trên môi trường Host Windows
- **Vị trí phát hiện:** `auth-service/node_modules/@napi-rs/canvas`
- **Bằng chứng thực tế:** Khi chạy kịch bản kiểm thử trên Node.js môi trường máy Host Windows xuất hiện cảnh báo:
  `Warning: Cannot load "@napi-rs/canvas" package: "Error: Failed to load native binding".`
  `Warning: Cannot polyfill ImageData, rendering may be broken.`
- **Nguyên nhân gốc rễ:** Module `@napi-rs/canvas` được biên dịch dạng native binary cho Linux container (Alpine/glibc) hoặc thiếu file binary Windows tương ứng trong thư mục `node_modules`.
- **Phạm vi tác động:** Hệ thống tự động fallback sang cơ chế xử lý text thuần túy `pdf-parse`. Tuy nhiên các file scan PDF thuần hình ảnh sẽ không thể render canvas để OCR nếu chạy ngoài container. Trong Docker Alpine, service hoạt động ổn định.
- **Đề xuất khắc phục:** Cài đặt gói native binding tương thích `@napi-rs/canvas-win32-x64-msvc` cho môi trường phát triển máy Host Windows nếu cần kiểm thử OCR trực tiếp trên Host.

#### [AUD-018] [PASS] Chính sách lưu trữ và dọn dẹp Staging Retention (7 Ngày)
- **Vị trí kiểm tra:** `auth-service/services/retentionService.js`, `auth-service/routes/audit.js`
- **Kết quả kiểm toán:** Kiểm thử 8/8 kịch bản PASS. Tệp tạm > 7 ngày được quét và dọn sạch tự động mỗi 24 giờ; các tệp đang gắn liền với hồ sơ chờ duyệt (`pending_review`) được bảo vệ 100% không bị xóa nhầm.

---

### Module F: Tệp tin, Tài liệu đính kèm, Staging Retention & Preview/Download

#### [AUD-019] [P2 — Medium] [CONFIRMED] Đường dẫn lưu trữ tuyệt đối không đồng nhất giữa Host Windows và Docker Linux
- **Vị trí phát hiện:** Bảng `user_onedrive_sources.storage_path`, `onedrive_source_snapshots.storage_path`
- **Bằng chứng thực tế:**
  Cột `storage_path` lưu các chuỗi đường dẫn tuyệt đối của máy chủ Windows:
  `'D:\hoso-chat\auth-service\data\uploads\src_c9eaf28e...Pricing_Vendor.xlsx'`.
  Trong khi container `hr-auth` là Linux Alpine có thư mục làm việc là `/app`.
- **Nguyên nhân gốc rễ:** Code chạy thử nghiệm trực tiếp trên máy Host đã ghi đường dẫn Windows vào database. Mặc dù `oneDriveSourceService.js` đã có hàm `resolveStoragePath()` để chuyển đổi chuỗi linh hoạt khi chạy trong container, việc lưu đường dẫn tuyệt đối của OS vào DB vi phạm tính độc lập môi trường (12-Factor App).
- **Phạm vi tác động:** Nếu di chuyển database sang cụm máy chủ Linux hoặc Kubernetes khác, các đường dẫn này sẽ không tìm thấy nếu không đi qua hàm chuyển đổi `resolveStoragePath`.
- **Đề xuất khắc phục:** Chuẩn hóa toàn bộ cột `storage_path` sang đường dẫn tương đối (ví dụ: `uploads/src_c9eaf28e...Pricing_Vendor.xlsx`) kết hợp với biến gốc `UPLOADS_DIR`.

---

### Module G: AI, Chatbot Nhân sự, General AI Router, Orchestrator & Gemini Quota

#### [AUD-003] [P2 — Medium] [CONFIRMED] Giới hạn Token Free Tier của Gemini API (250,000 tokens) gây Fallback Model
- **Vị trí phát hiện:** `auth-service/services/agentOrchestrator.js`, container logs `hr-auth`
- **Bằng chứng thực tế:**
  Log hệ thống ghi nhận sự kiện:
  `[AgentOrchestrator] Model "gemini-3.1-flash-lite" thất bại (You exceeded your current quota... limit: 250000). Đã tự động Fallback thành công sang model dự phòng "gemini-3.5-flash-lite".`
- **Nguyên nhân gốc rễ:** Khóa `GEMINI_API_KEY` hiện tại đang dùng gói Free Tier của Google AI Studio với mức trần input token là 250k token/phút hoặc token/ngày tùy theo gói quota. Khi người dùng tải file tài liệu lớn nhiều trang hoặc thực hiện nhiều truy vấn liên tục, hạn mức bị vượt ngưỡng.
- **Phạm vi tác động:** Dù cơ chế Retry và Fallback model giúp hệ thống không bị gián đoạn, thời gian phản hồi cho người dùng bị kéo dài (thêm 8 - 15 giây). Nếu model fallback cũng cạn quota, chatbot sẽ báo lỗi không thể tạo nội dung.
- **Đề xuất khắc phục:**
  1. Cấu hình gắn billing/Pay-as-you-go cho Gemini API Key dự án chính thức.
  2. Bổ sung pool nhiều API Key luân phiên (Key Rotation) trong `agentOrchestrator.js`.
  3. Cắt tỉa ngữ cảnh (Context Truncation) và cache token cho các tài liệu tra cứu lặp lại.

---

### Module H: Vector Database (Qdrant), Chunks, Embeddings & RAG Pipeline

#### [AUD-020] [PASS] Trạng thái vận hành Qdrant Collection `hr_docs` và RAG Pipeline
- **Vị trí kiểm tra:** `http://127.0.0.1:6333/collections/hr_docs`, `qdrantSyncService.js`
- **Kết quả kiểm toán:**
  - Collection `hr_docs` ở trạng thái `green`, 100 điểm vector, kích thước 768 vector (Cosine distance).
  - Đầy đủ payload schema index: `doc_version_id`, `status`, `role_access`, `branch_scope`, `effective_int`, `expiry_int`, `topics`.
  - Tiến trình đồng bộ đối soát tự động hoạt động định kỳ mỗi 60 phút, bảo đảm không bị lệch dữ liệu giữa Postgres `documents` và Qdrant vectors.

---

### Module I: Tích hợp bên ngoài (n8n, NocoDB, Microsoft Graph / OneDrive, Google Sheets)

#### [AUD-021] [P2 — Medium] [CONFIRMED] Microservice SQLite `nocodb_helper.js` (Cổng 8084) không hoạt động
- **Vị trí phát hiện:** `auth-service/services/nocodb_helper.js`, `docker-compose.yml`
- **Bằng chứng thực tế:**
  - `nocodb_helper.js` mở server HTTP cổng 8084 và kết nối trực tiếp SQLite `/usr/app/data/noco.db`.
  - Lệnh `curl.exe -s http://127.0.0.1:8084/health` không kết nối được (Connection refused).
  - File compose không mount `nocodb_data` vào service `auth`.
  - Thực tế trong `syncWorker.js`, hệ thống đã chuyển sang cập nhật trực tiếp vào PostgreSQL:
    ```javascript
    // NocoDB connects directly to PostgreSQL as the System of Record
    await syncToNocoDB(payload);
    ```
- **Nguyên nhân gốc rễ:** File `services/nocodb_helper.js` là giải pháp tạm thời trong giai đoạn cũ trước khi NocoDB được cấu hình kết nối trực tiếp vào cơ sở dữ liệu PostgreSQL. Hiện file này đã trở thành mã nguồn thừa (dead code).
- **Phạm vi tác động:** Gây hiểu nhầm về mặt kiến trúc cho các kỹ sư mới và tạo nguy cơ bảo mật nếu ai đó cố kích hoạt lại service này.
- **Đề xuất khắc phục:** Lưu trữ (archive) hoặc gỡ bỏ `nocodb_helper.js` và cập nhật tài liệu kiến trúc xác nhận NocoDB đồng bộ 100% qua Postgres metadata.

---

### Module J: Frontend, Giao diện Chat, Admin Console & Markdown Rendering

#### [AUD-022] [PASS] Khắc phục triệt để lỗi đánh số thứ tự Markdown danh sách
- **Vị trí kiểm tra:** `chat/index.html:1500-1560`, `chat/hr-admin.html:2670-2720`
- **Kết quả kiểm toán:** Kiểm thử 7/7 kịch bản PASS. Danh sách thứ tự có khoảng trống giữa các mục, danh sách phụ thụt đầu dòng (sub-bullets), danh sách ký tự hoa (A, B, C) và danh sách bị ngắt bởi đoạn văn đều được render đúng thứ tự số học tự nhiên (1, 2, 3, 4, 5...) thay vì bị reset về 1.

#### [AUD-005] [P3 — Low] [CONFIRMED] Giao diện Quản trị tải toàn bộ hồ sơ nhân sự về Client-side để phân trang
- **Vị trí phát hiện:** `chat/hr-admin.html:5250-5350`
- **Bằng chứng thực tế:** Hàm `loadEmployees()` gọi `GET /api/employees?status=ALL`, tải toàn bộ mảng dữ liệu nhân sự về biến `allEmployees` trong bộ nhớ JavaScript trình duyệt, sau đó mới thực hiện cắt trang qua `renderEmployeesWithPagination()`.
- **Nguyên nhân gốc rễ:** Thiết kế ban đầu phục vụ tập dữ liệu nhỏ gọn (< 100 nhân viên).
- **Phạm vi tác động:** Với quy mô hiện tại (16 nhân viên), tốc độ phản hồi cực nhanh (< 50ms). Tuy nhiên khi hệ thống mở rộng lên hàng nghìn nhân sự trên toàn hệ sinh thái SOTRANS, điều này sẽ gây tiêu tốn băng thông và làm chậm giao diện người dùng.
- **Đề xuất khắc phục:** Nâng cấp API `GET /api/employees` hỗ trợ phân trang Server-side (`?page=1&limit=20&search=...`) khi quy mô nhân sự vượt quá 200 hồ sơ.

---

### Module K: Hiệu năng, Tải đồng thời, Pagination, Connection Pooling & Scalability

#### [AUD-023] [P3 — Low] [CONFIRMED] Cấu hình Connection Pool PostgreSQL sử dụng tham số mặc định
- **Vị trí phát hiện:** `auth-service/db.js`
- **Bằng chứng thực tế:** Khởi tạo `new Pool({ host, port, user, password, database })` không cấu hình rõ ràng các tham số `max`, `idleTimeoutMillis`, `connectionTimeoutMillis`.
- **Nguyên nhân gốc rễ:** Sử dụng cấu hình ngầm định của thư viện `pg` (mặc định max = 10 kết nối).
- **Phạm vi tác động:** Nếu có nhiều người dùng đồng thời cùng truy vấn chatbot hoặc chạy các batch OCR/Intake lớn, hàng đợi connection pool có thể bị nghẽn dẫn đến `timeout` kết nối.
- **Đề xuất khắc phục:** Bổ sung cấu hình rõ ràng trong `db.js`: `max: 25`, `idleTimeoutMillis: 30000`, `connectionTimeoutMillis: 5000`.

---

### Module L: Logging, Giám sát, Audit Trail, Backup & Phục hồi sau thảm họa (Disaster Recovery)

#### [AUD-024] [P2 — Medium] [CONFIRMED] Thiếu tiến trình tự động sao lưu định kỳ PostgreSQL (Daily pg_dump Cron)
- **Vị trí phát hiện:** Hạ tầng Docker máy chủ
- **Bằng chứng thực tế:** Dữ liệu PostgreSQL hiện chỉ được lưu trên Docker Volume `hrbot_pg_data`. Chưa có cron job hoặc script định kỳ chạy lệnh `pg_dump` để xuất bản sao lưu ra thư mục bên ngoài máy chủ hoặc đẩy lên Cloud Storage.
- **Nguyên nhân gốc rễ:** Chưa thiết lập chính sách sao lưu tự động mức hệ điều hành.
- **Phạm vi tác động:** Rủi ro mất mát dữ liệu nghiêm trọng nếu phân vùng ổ đĩa Docker bị lỗi vật lý hoặc volume bị hỏng không thể phục hồi.
- **Đề xuất khắc phục:** Tạo script tự động sao lưu `scripts/backup_database.bat` hoặc cron container, tự động nén bản dump hàng ngày vào 02:00 sáng và giữ lại bản lưu trong 30 ngày gần nhất.

---

## PHẦN C — BẢN ĐỒ PHỤ THUỘC VÀ MA TRẬN PHẠM VI TÁC ĐỘNG

### 1. Bản đồ luồng dữ liệu & Các thành phần liên kết

```
[NGƯỜI DÙNG TRÌNH DUYỆT] 
      │
      ▼ (Port 8082 - Public Gateway)
[NGINX REVERSE PROXY]
      │
      ├─── /chat/ ──────────────► [Tệp giao diện tĩnh Frontend: index.html, hr-admin.html]
      ├─── /chat/files/ ────────► [Thư mục tệp tin đính kèm: /chat-files/] (ĐANG LỖI AUD-001)
      ├─── /api/auth, /api/hoso ─► [HR-AUTH SERVICE (Node.js 20 on Port 3000)]
      │                                 │
      │                                 ├──► [POSTGRESQL 16 (Port 5432)] (SoR)
      │                                 │      ├── employees & hr_employee_profiles
      │                                 │      ├── hr_employee_staging
      │                                 │      ├── auth_audit_logs & audit_logs
      │                                 │      └── documents & chunks
      │                                 │
      │                                 ├──► [QDRANT VECTOR DB (Port 6333)]
      │                                 │      └── hr_docs (Embeddings 768-dim)
      │                                 │
      │                                 ├──► [GOOGLE GEMINI API (Cloud LLM)]
      │                                 │      └── gemini-3.1-flash-lite / 3.5-flash-lite
      │                                 │
      │                                 ├──► [GOOGLE SHEETS API v4] (SyncWorker)
      │                                 │
      │                                 └──► [MICROSOFT GRAPH API] (OneDrive Sources)
      │
      └─── /webhook/ ───────────► [N8N AUTOMATION ENGINE (Port 5679)]
                                        │
                                        └──► [NOCODB UI (Port 8081)]
```

### 2. Ma trận phạm vi tác động chéo (Cross-Impact Matrix)

| Hành động dự kiến | Thành phần tác động trực tiếp | Rủi ro tác động dây chuyền | Mức độ kiểm soát |
| :--- | :--- | :--- | :--- |
| **Sửa routing Nginx `/chat/files/`** | `nginx/default.conf` | Không ảnh hưởng đến dữ liệu; chỉ mở khóa xem tệp cho người dùng chat. | An toàn tuyệt đối (Hotfix Nginx reload) |
| **Thu hồi & Xoay Service Account Key** | `syncWorker.js`, `.env` | Nếu key mới chưa kích hoạt quyền trên Google Sheets, task đồng bộ sheet sẽ bị pending. | Cần kiểm thử dry-run đồng bộ sheet trước khi release |
| **Đổi mật khẩu JWT & Postgres** | `docker-compose.yml`, `.env` | Các phiên đăng nhập hiện tại của người dùng sẽ hết hạn (cần login lại). | Thông báo trước cho người dùng |
| **Hard-delete 4 nhân viên Sowatco** | `employees`, `hr_employee_profiles` | Cần xóa đồng bộ trong `hr_sync_tasks` và `hr_employee_staging` để không bị foreign key constraint. | Có script backup trước khi thực thi |
| **Đóng cổng Docker về 127.0.0.1** | `docker-compose.yml` | Chặn kết nối trực tiếp từ máy ngoài mạng LAN vào n8n/NocoDB; người dùng phải truy cập qua Nginx Gateway. | Đúng chuẩn bảo mật nội bộ |

---

## PHẦN D — DANH SÁCH KIỂM THỬ CHI TIẾT (TEST SUITES SUMMARY)

Tất cả các bộ kiểm thử đã được chạy và đối soát trực tiếp trong môi trường dự án. Kết quả thực tế như sau:

| STT | Tên bộ kiểm thử | Phạm vi kiểm tra | Số test cases | Kết quả | Ghi chú bằng chứng |
| :---: | :--- | :--- | :---: | :---: | :--- |
| 1 | `test_hr_governance_rbac_security.js` | Phân quyền xóa mềm, thôi việc, khôi phục giữa HR và ADMIN, chống bypass qua Intake/Chatbot | 25/25 | **PASS (100%)** | Ghi nhận đầy đủ 403 Forbidden và Audit Log |
| 2 | `verify_section_f_remediation.js` | Đối chiếu quy tắc Phần F, kiểm tra n8n workflow chặn hồ sơ [ĐÃ XÓA], lọc mặc định ACTIVE | 14/14 | **PASS (100%)** | Xác nhận status DELETED và job_grade chuẩn hóa |
| 3 | `test_staging_retention_7days.js` | Chính sách dọn tệp tạm Staging > 7 ngày và bảo vệ tệp pending review | 8/8 | **PASS (100%)** | Xóa sạch tệp quá hạn, bảo toàn hồ sơ đang duyệt |
| 4 | `test_markdown_numbering.js` | Đánh số danh sách Markdown CommonMark và các trường hợp ngắt dòng trong Chat & Admin | 7/7 | **PASS (100%)** | Khắc phục hoàn toàn lỗi đánh số lặp lại số 1 |
| 5 | `final_go_nogo_automated_verification.js` | Đối chiếu Ground Truth, phân định 5 trạng thái Universal Data Engine, chống giả mạo IDOR | 12/12 | **PASS (100%)** | Kết luận tự động: [GO] |
| 6 | `production_readiness_audit_v2_1.js` | 4 trụ cột sẵn sàng sản xuất: Ground Truth sâu, Bóc tách PDF/CSV, Chống IDOR đa công ty, Quota | 13/13 | **PASS (100%)** | Pass rate: 100%, Final Decision: [GO] |
| 7 | `rag_policy_regression_suite.js` | Truy xuất Qdrant, phân quyền tài liệu theo phòng ban và thời hạn hiệu lực | 10/10 | **PASS (100%)** | Đảm bảo tính nhất quán của RAG pipeline |
| 8 | `universal_agent_acceptance_gate.js` | Cổng chấp thuận Agent trí tuệ nhân tạo, đối chiếu bảng giá logistics đa sheet | 15/15 | **PASS (100%)** | Xác minh độ chính xác nghiệp vụ logistics |

---

## PHẦN E — KẾ HOẠCH KHẮC PHỤC THEO LỘ TRÌNH (5 GIAI ĐOẠN ĐỀ XUẤT)

> [!IMPORTANT]
> Toàn bộ các hạng mục dưới đây chỉ là **KẾ HOẠCH ĐỀ XUẤT CHỜ PHÊ DUYỆT**. Tuyệt đối chưa có bất kỳ dòng mã nguồn nào bị thay đổi hay dữ liệu nào bị ghi đè trong đợt kiểm toán này.

### Đợt 1: Khắc phục khẩn cấp An ninh, Bảo mật Secret và Routing Tệp tin (P0, P1)
- **Mục tiêu:** Vá ngay các lỗ hổng lộ lọt khóa và khôi phục tính năng xem/tải tài liệu đính kèm cho người dùng chat.
- **Hành động cụ thể:**
  1. *Xoay khóa Google Service Account (AUD-006):* Thu hồi private key cũ, tạo key mới và đưa vào `.env`, cập nhật `syncWorker.js` đọc qua biến môi trường.
  2. *Bảo mật Secrets trong Docker (AUD-002):* Đưa `JWT_SECRET`, `GEMINI_API_KEY`, `POSTGRES_PASSWORD` ra khỏi `docker-compose.yml`, chuyển vào `.env`.
  3. *Sửa Routing Nginx `/chat/files/` (AUD-001):* Loại bỏ `auth_basic` khỏi `/chat/files/`, sửa regex chấp nhận tên tệp có đuôi mở rộng (`.pdf`, `.xlsx`, `.png`...), bảo đảm người dùng mở tệp không bị lỗi 401/404.
  4. *Đóng cổng Docker về IP nội bộ (AUD-007):* Ràng buộc cổng n8n (5679) và NocoDB (8081) về `127.0.0.1`.

### Đợt 2: Xử lý dữ liệu nhân sự & Chuẩn hóa toàn vẹn Database (P2)
- **Mục tiêu:** Hoàn tất xóa vĩnh viễn 4 nhân sự theo yêu cầu và bảo toàn tính nhất quán dữ liệu giữa hai bảng nhân sự.
- **Hành động cụ thể:**
  1. *Hard-Delete 4 nhân sự Sowatco (AUD-015):* Thực thi script xóa vĩnh viễn an toàn có backup cho: Phan Dương Thanh Bình (`079204001284`), Nguyễn Trần Thiện Nhân (`079205001589`), Ngô Đặng Tuấn Uyên (`062095000277`), Lê Thành Nhân (`080087002353`).
  2. *Chuẩn hóa Dual Schema (AUD-012):* Tạo ràng buộc FK hoặc trigger đồng bộ hai chiều giữa `employees` và `hr_employee_profiles`.
  3. *Dọn dẹp bảng sao lưu cũ (AUD-013):* Chuyển các bảng `chat_log_backup_*` vào schema riêng `archive`.

### Đợt 3: Tối ưu AI Token Quota, Rate Limit & Fallback Model (P2)
- **Mục tiêu:** Ngăn chặn hiện tượng cạn quota token đầu vào của Gemini API và giảm độ trễ phản hồi của Chatbot.
- **Hành động cụ thể:**
  1. *Gắn Billing hoặc cấu hình Pool Key (AUD-003):* Thiết lập cơ chế xoay vòng nhiều API key cho Gemini hoặc nâng cấp gói hạn mức.
  2. *Cắt tỉa ngữ cảnh thông minh:* Giới hạn kích thước chunk tài liệu gửi kèm trong prompt ngữ cảnh để tiết kiệm input tokens.
  3. *Thêm bộ nhớ đệm Cache Token:* Lưu kết quả xử lý các tài liệu PDF/Excel lớn đã phân tích để tránh gửi lại toàn bộ tệp vào Gemini nhiều lần.

### Đợt 4: Hoàn thiện tích hợp, Dọn dẹp mã nguồn thừa & Tối ưu Mạng (P2, P3)
- **Mục tiêu:** Tinh gọn mã nguồn, loại bỏ dead code và chuẩn hóa đường dẫn tệp tin.
- **Hành động cụ thể:**
  1. *Loại bỏ dead code `nocodb_helper.js` (AUD-021):* Đóng và gỡ bỏ microservice cổng 8084 không còn dùng.
  2. *Chuẩn hóa đường dẫn lưu trữ OneDrive (AUD-019):* Chuyển đổi các đường dẫn tuyệt đối dạng Windows trong DB thành đường dẫn tương đối.
  3. *Gỡ bỏ block WebDAV `/chat/history` cũ trong Nginx (AUD-008).*

### Đợt 5: Hiệu năng, Connection Pooling & Kế hoạch Sao lưu tự động (P3, P4)
- **Mục tiêu:** Nâng cao khả năng mở rộng (Scalability) và thiết lập cơ chế khôi phục sau thảm họa (Disaster Recovery).
- **Hành động cụ thể:**
  1. *Tối ưu Connection Pool PostgreSQL (AUD-023):* Thiết lập `max: 25`, timeout hợp lý trong `db.js`.
  2. *Phân trang Server-side cho Admin Console (AUD-005):* Bổ sung tham số phân trang API cho bảng nhân sự.
  3. *Triển khai tự động sao lưu Database hàng ngày (AUD-024):* Cài đặt script `pg_dump` nén tự động định kỳ vào 02:00 sáng.

---

## PHẦN F — CÁC QUYẾT ĐỊNH CẦN NGƯỜI DÙNG PHÊ DUYỆT

Để đảm bảo tuân thủ nghiêm ngặt quy trình phê duyệt trước khi can thiệp hệ thống, kính trình Người dùng xem xét và cho ý kiến chỉ đạo đối với 5 quyết định trọng yếu sau:

1. **Quyết định 1 (Bảo mật Khóa & Secrets):**
   - *Đề xuất:* Cho phép thu hồi Google Service Account RSA Private Key hiện tại, sinh key mới và chuyển toàn bộ Secrets (`JWT_SECRET`, `GEMINI_API_KEY`) từ `docker-compose.yml` vào tệp `.env` bảo mật.
   - *Lựa chọn:* **[ĐỒNG Ý]** / [TẠM HOÃN]

2. **Quyết định 2 (Sửa Routing Tệp tin Nginx):**
   - *Đề xuất:* Cho phép sửa cấu hình `nginx/default.conf` để tắt Basic Auth trên `/chat/files/` và cho phép mở tệp đính kèm có đuôi mở rộng (`.pdf`, `.xlsx`...).
   - *Lựa chọn:* **[ĐỒNG Ý (Khuyến nghị)]** / [GIỮ NGUYÊN]

3. **Quyết định 3 (Xóa vĩnh viễn 4 hồ sơ nhân sự Sowatco):**
   - *Đề xuất:* Cho phép chạy script xóa cứng (Hard-delete) sạch sẽ 4 nhân sự (Phan Dương Thanh Bình, Nguyễn Trần Thiện Nhân, Ngô Đặng Tuấn Uyên, Lê Thành Nhân) khỏi `employees`, `hr_employee_profiles`, `hr_employee_staging` và `hr_sync_tasks` sau khi đã tạo bản backup riêng.
   - *Lựa chọn:* **[ĐỒNG Ý XÓA VĨNH VIỄN]** / [GIỮ TRẠNG THÁI ACTIVE]

4. **Quyết định 4 (Đóng cổng Docker nội bộ về `127.0.0.1`):**
   - *Đề xuất:* Cấu hình các cổng dịch vụ n8n (5679) và NocoDB (8081) chỉ lắng nghe trên localhost để ngăn chặn truy cập trực tiếp từ mạng ngoài mà không qua Nginx Gateway.
   - *Lựa chọn:* **[ĐỒNG Ý]** / [ĐỂ MỞ CHO MẠNG LAN]

5. **Quyết định 5 (Nâng cấp & Quản lý Gemini API Quota):**
   - *Đề xuất:* Cho phép bổ sung cơ chế xoay vòng nhiều API Key trong `agentOrchestrator.js` hoặc hỗ trợ cung cấp API Key trả phí (Pay-as-you-go) để chấm dứt tình trạng cạn quota 250k token khi chat file lớn.
   - *Lựa chọn:* **[ĐỒNG Ý BỔ SUNG KEY ROTATION]** / [DUY TRÌ FREE TIER HIỆN TẠI]

---

*Báo cáo được lập hoàn tất và lưu trữ tại:* `D:\hoso-chat\SYSTEM_AUDIT_REPORT_20261028.md`  
*Trạng thái kết luận:*  
**FULL SYSTEM AUDIT COMPLETED — FINDINGS DOCUMENTED — WAITING FOR APPROVAL**  
**CHƯA SỬA CODE — CHƯA GHI DỮ LIỆU NGHIỆP VỤ — CHƯA XÓA TỆP — CHƯA THAY ĐỔI CẤU HÌNH — CHƯA RESTART/REBUILD/REDEPLOY DỊCH VỤ.**
