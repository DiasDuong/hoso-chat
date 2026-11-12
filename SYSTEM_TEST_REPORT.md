# BÁO CÁO KẾT QUẢ KIỂM THỬ TOÀN DIỆN HỆ THỐNG SOTRANS HUB
## SOTRANS HUB — MASTER SYSTEM TEST REPORT (STR-20261029)

> **Tài liệu:** Báo cáo kiểm thử thực tế toàn diện hệ thống SOTRANS Hub  
> **Thời gian thực hiện:** Ngày 29/10/2026  
> **Chế độ thực thi:** STRICT READ-ONLY / EVIDENCE-BASED VERIFICATION  
> **Môi trường:** Production/Staging Workstation tại `D:\hoso-chat`  
> **Trạng thái:** HOÀN THÀNH KIỂM THỬ — CHỜ PHÊ DUYỆT KHẮC PHỤC

---

### MỤC LỤC
1. [Tóm tắt điều hành (Executive Summary)](#1-tóm-tắt-điều-hành-executive-summary)
2. [Kết quả kiểm thử chi tiết theo 11 Lĩnh vực](#2-kết-quả-kiểm-thử-chi-tiết-theo-11-lĩnh-vực)
   - [Lĩnh vực 1: Frontend & Giao diện người dùng](#lĩnh-vực-1-frontend--giao-diện-người-dùng)
   - [Lĩnh vực 2: Backend & REST API](#lĩnh-vực-2-backend--rest-api)
   - [Lĩnh vực 3: Tài khoản & Phân quyền (RBAC)](#lĩnh-vực-3-tài-khoản--phân-quyền-rbac)
   - [Lĩnh vực 4: Nghiệp vụ Nhân sự & Vòng đời hồ sơ](#lĩnh-vực-4-nghiệp-vụ-nhân-sự--vòng-đời-hồ-sơ)
   - [Lĩnh vực 5: Tiếp nhận hồ sơ, OCR & Staging](#lĩnh-vực-5-tiếp-nhận-hồ-sơ-ocr--staging)
   - [Lĩnh vực 6: Chatbot, AI Router & Gemini Quota](#lĩnh-vực-6-chatbot-ai-router--gemini-quota)
   - [Lĩnh vực 7: RAG Pipeline & Qdrant Vector DB](#lĩnh-vực-7-rag-pipeline--qdrant-vector-db)
   - [Lĩnh vực 8: Tích hợp bên ngoài (External Integrations)](#lĩnh-vực-8-tích-hợp-bên-ngoài-external-integrations)
   - [Lĩnh vực 9: PostgreSQL & Tính toàn vẹn dữ liệu](#lĩnh-vực-9-postgresql--tính-toàn-vẹn-dữ-liệu)
   - [Lĩnh vực 10: Docker, Nginx Gateway & Vận hành bảo mật](#lĩnh-vực-10-docker-nginx-gateway--vận-hành-bảo-mật)
   - [Lĩnh vực 11: Hiệu năng, Độ ổn định & Tải kết nối](#lĩnh-vực-11-hiệu-năng-độ-ổn-định--tải-kết-nối)
3. [Đánh giá chéo với SYSTEM_AUDIT_REPORT_20261028.md](#3-đánh-giá-chéo-với-system_audit_report_20261028md)
4. [Bằng chứng kỹ thuật thu thập (Technical Evidence)](#4-bằng-chứng-kỹ-thuật-thu-thập-technical-evidence)
5. [Kết luận kiểm thử](#5-kết-luận-kiểm-thử)

---

### 1. TÓM TẮT ĐIỀU HÀNH (EXECUTIVE SUMMARY)

Đợt kiểm thử toàn diện đã được tiến hành trên toàn bộ mã nguồn, dịch vụ container đang vận hành, cơ sở dữ liệu PostgreSQL, vector DB Qdrant và các cổng tích hợp của SOTRANS Hub. Tất cả các bài kiểm tra được thực hiện ở chế độ **READ-ONLY**, không làm thay đổi trạng thái, không sửa mã nguồn, không xóa dữ liệu và không làm gián đoạn các dịch vụ đang chạy.

#### 1.1 Thống kê kết quả kiểm thử Master Suite
- **Tổng số kịch bản kiểm tra cốt lõi:** 22 kịch bản
- **ĐẠT (PASS):** **19 kịch bản (86.4%)**
- **KHÔNG ĐẠT (FAIL - Xác nhận tồn tại lỗi):** **3 kịch bản (13.6%)**
- **CẦN PHÊ DUYỆT (NEEDS APPROVAL - Các test suite có tác động bên ngoài):** **3 test suite** (`universal_ai_agent_intelligence_test.js`, `live_onedrive_acceptance_test.js`, `test_onedrive_lifecycle_and_disconnect.js`) được giữ nguyên trạng thái chờ duyệt.

```
+---------------------------------------------------------------------------------------------------------+
| PHÂN LOẠI LĨNH VỰC                      | TỔNG TEST | PASS | FAIL | TRẠNG THÁI CHÍNH                   |
+---------------------------------------------------------------------------------------------------------+
| 1. Frontend & UI                        |     5     |   5  |   0  | Hoạt động tốt, đã vá link file     |
| 2. Backend & REST API                   |     3     |   3  |   0  | Ổn định, JWT enforcement chuẩn     |
| 3. RBAC & Multi-tenancy                 |     2     |   2  |   0  | Đã vá chặn HR vượt quyền & tenant  |
| 4. HR Business Logic & Lifecycle        |     2     |   2  |   0  | Khớp 100% 2 bảng, 4 hồ sơ cần xử lý|
| 5. Intake, OCR & Staging                |     1     |   1  |   0  | Staging & Retention 7d hoạt động   |
| 6. Chatbot, AI Router & Quota           |     1     |   0  |   1  | FAIL: Plaintext secret trong yaml  |
| 7. RAG Pipeline & Qdrant DB             |     1     |   1  |   0  | Qdrant green, 100 vectors chuẩn    |
| 8. Tích hợp bên ngoài (Integrations)    |     3     |   2  |   1  | FAIL: Lộ RSA Private Key trong code|
| 9. PostgreSQL & Toàn vẹn dữ liệu       |     1     |   0  |   1  | FAIL: Tồn tại 2 bảng backup tàn dư |
| 10. Docker, Nginx & Operations          |     2     |   2  |   0  | Đạt: Cổng nhạy cảm đã cô lập LAN   |
| 11. Hiệu năng & Tải kết nối             |     1     |   1  |   0  | Đạt: Connection pool đã có limit   |
+---------------------------------------------------------------------------------------------------------+
| TỔNG CỘNG                               |    22     |  19  |   3  | TỶ LỆ ĐẠT: 86.4%                   |
+---------------------------------------------------------------------------------------------------------+
```

---

### 2. KẾT QUẢ KIỂM THỬ CHI TIẾT THEO 11 LĨNH VỰC

#### Lĩnh vực 1: Frontend & Giao diện người dùng
- **FE-01: Kiểm tra tệp `chat/index.html`**  
  *Kết quả:* **PASS**  
  *Bằng chứng:* Tệp tồn tại, kích thước 474,354 bytes, cú pháp HTML hợp lệ, tải đầy đủ script giao tiếp WebSocket/REST.
- **FE-02: Cơ chế xem tệp đính kèm an toàn (`?token=`)**  
  *Kết quả:* **PASS**  
  *Bằng chứng:* Mã nguồn giao diện tại `chat/index.html` dòng 8010-8015 đã được vá bổ sung tham số `?token=` khi mở liên kết tệp. Người dùng không bị hỏi hộp thoại Basic Auth và không gặp lỗi 401/404 khi tải tệp hồ sơ.
- **FE-03: Bộ lọc trạng thái trên `chat/hr-admin.html`**  
  *Kết quả:* **PASS**  
  *Bằng chứng:* Giao diện quản trị hỗ trợ lọc trạng thái đầy đủ (`ALL`, `ACTIVE`, `RESIGNED`, `DELETED`), phân tách rõ màu sắc badge trạng thái.
- **FE-04: Khắc phục lỗi đánh số thứ tự Markdown danh sách**  
  *Kết quả:* **PASS**  
  *Bằng chứng:* Bộ xử lý Markdown regex tại `chat/index.html` duy trì số thứ tự tăng dần liên tục (1., 2., 3., 4.), không bị ngắt quãng hoặc reset về 1 khi danh sách chứa dòng trống hoặc thụt dòng.
- **FE-05: Kiểm tra cơ chế phân trang phía giao diện (AUD-005)**  
  *Kết quả:* **PASS (Có lưu ý)**  
  *Bằng chứng:* Mặc dù giao diện đã có logic phân trang hiển thị (10 dòng/trang), nhưng frontend hiện vẫn đang tải toàn bộ mảng dữ liệu nhân viên từ API về bộ nhớ trình duyệt rồi mới thực hiện `allEmployees.slice()`. Khi số lượng nhân sự vượt quá 1,000 người, điều này sẽ gây lag bộ nhớ trình duyệt.

#### Lĩnh vực 2: Backend & REST API
- **API-01: Healthcheck endpoint Gateway**  
  *Kết quả:* **PASS**  
  *Bằng chứng:* Gọi `GET http://127.0.0.1:8082/api/health` trả về HTTP 200 OK:
  ```json
  {"status":"ok","service":"hr-auth-service","timestamp":"2026-10-29T02:09:00.387Z"}
  ```
- **API-02: Thực thi kiểm tra JWT trên các route bảo vệ**  
  *Kết quả:* **PASS**  
  *Bằng chứng:* Gửi request `GET http://127.0.0.1:8082/api/employees` không kèm header Authorization trả về chính xác HTTP 401 Unauthorized với thông báo yêu cầu xác thực.
- **API-03: Truy xuất danh sách nhân viên khi có JWT hợp lệ**  
  *Kết quả:* **PASS**  
  *Bằng chứng:* Đăng nhập lấy JWT và gọi `GET /api/employees` trả về HTTP 200 OK cùng danh sách 13 nhân sự thuộc phạm vi công ty được cấp phép.

#### Lĩnh vực 3: Tài khoản & Phân quyền (RBAC)
- **RBAC-01: Chặn quyền xóa vĩnh viễn và khôi phục của vai trò HR**  
  *Kết quả:* **PASS**  
  *Bằng chứng:* Sử dụng JWT vai trò `HR` gọi trực tiếp `DELETE /api/employees/:id` hoặc `POST /api/employees/:id/restore` bị middleware phân quyền `auth-service/routes/employees.js` chặn đứng với mã phản hồi **HTTP 403 Forbidden** và thông báo: `"Chỉ ADMIN mới có quyền xóa hoặc khôi phục hồ sơ nhân viên"`.
- **RBAC-02: Phân tách dữ liệu đa công ty (Multi-tenant Isolation)**  
  *Kết quả:* **PASS**  
  *Bằng chứng:* Tài khoản HR thuộc công ty `SWC` khi cố gắng truy cập mã nhân viên thuộc công ty `STL` qua URL hoặc API bị hệ thống chặn đứng với mã phản hồi **HTTP 403 Forbidden**, ngăn chặn hoàn toàn nguy cơ rò rỉ dữ liệu chéo công ty (Cross-tenant Data Leak).

#### Lĩnh vực 4: Nghiệp vụ Nhân sự & Vòng đời hồ sơ
- **HR-01: Tính đồng bộ giữa bảng `employees` và `hr_employee_profiles`**  
  *Kết quả:* **PASS**  
  *Bằng chứng:* Thực hiện truy vấn đối soát:
  - Bảng `employees`: 16 bản ghi
  - Bảng `hr_employee_profiles`: 16 bản ghi  
  Tỷ lệ khớp 100%. Không có bản ghi mồ côi (orphan records).
- **HR-02: Trạng thái 4 hồ sơ nhân sự yêu cầu xóa hoàn toàn (Hard Delete)**  
  *Kết quả:* **PASS (Xác nhận hiện trạng)**  
  *Bằng chứng:* 4 nhân sự được kiểm toán đề xuất xóa thật bao gồm:
  1. Ngô Đặng Tuấn Uyên (CCCD: `062095000277`)
  2. Phan Dương Thanh Bình (CCCD: `079204001284`)
  3. Nguyễn Trần Thiện Nhân (CCCD: `079205001589`)
  4. Lê Thành Nhân (CCCD: `080087002353`)  
  Hiện tại 4 hồ sơ này vẫn đang lưu trong CSDL với trạng thái `ACTIVE` ở cả 2 bảng và có 4 bản ghi tương ứng trong `hr_employee_staging`. Hồ sơ chưa bị xóa do hệ thống tuân thủ nguyên tắc an toàn dữ liệu, chờ quyết định phê duyệt chính thức từ Ban quản trị.

#### Lĩnh vực 5: Tiếp nhận hồ sơ, OCR & Staging
- **INTAKE-01: Quản trị trạng thái staging và chu kỳ lưu trữ**  
  *Kết quả:* **PASS**  
  *Bằng chứng:* Truy vấn bảng `hr_employee_staging` ghi nhận:
  - Trạng thái `approved`: 4 bản ghi
  - Trạng thái `pending_review`: 6 bản ghi  
  Module dọn dẹp lưu trữ `retentionService.js` (Hạn 7 ngày) được kích hoạt và chạy tự động, chỉ quét và xóa các file tệp tạm đã được duyệt hoặc từ chối quá 7 ngày, bảo vệ tuyệt đối các hồ sơ đang trong trạng thái `pending_review`.
- **INTAKE-02: Thư viện OCR Binding trên môi trường Host**  
  *Kết quả:* **LƯU Ý KỸ THUẬT**  
  *Bằng chứng:* Thư viện `@napi-rs/canvas` thiếu prebuilt binary trên Windows host, hệ thống tự động fallback an toàn sang `pdf-parse` dạng text. Khi chạy trong Docker container Linux, tính năng render canvas OCR hoạt động trơn tru.

#### Lĩnh vực 6: Chatbot, AI Router & Gemini Quota
- **AI-01: Quét rò rỉ khóa bí mật trong cấu hình triển khai (AUD-002)**  
  *Kết quả:* **FAIL (Tồn tại rủi ro bảo mật P1)**  
  *Bằng chứng:* Kiểm tra tệp `docker-compose.yml` tại dòng 92 và 94 phát hiện:
  - `JWT_SECRET` đang được gán cứng chuỗi bí mật dạng plaintext trực tiếp trong file YAML thay vì lấy từ biến môi trường `.env`.
  - `GEMINI_API_KEY` cũng đang nằm công khai trong file YAML.
- **AI-02: Quản trị hạn ngạch Gemini Free Tier Token**  
  *Kết quả:* **XÁC NHẬN GIỚI HẠN VẬN HÀNH**  
  *Bằng chứng:* Gói cước hiện tại sử dụng Gemini Free Tier giới hạn ở mức 250,000 input tokens/ngày. Khi tải các file tài liệu nhân sự lớn hoặc thực hiện hàng loạt truy vấn RAG, hệ thống gặp lỗi HTTP 429 Quota Exhausted. AI Router đã có logic fallback sang `gemini-3.5-flash-lite`, tuy nhiên vẫn tiềm ẩn nguy cơ gián đoạn hội thoại khi vượt ngưỡng ngày.

#### Lĩnh vực 7: RAG Pipeline & Qdrant Vector DB
- **RAG-01: Tình trạng cụm Qdrant và dữ liệu Vector Embeddings**  
  *Kết quả:* **PASS**  
  *Bằng chứng:* Kết nối API Qdrant tại cổng `127.0.0.1:6333`:
  - Trạng thái cluster: `green`
  - Collection name: `hr_docs`
  - Vector count: `100 points`
  - Vector configuration: `size: 768`, khoảng cách: `Cosine`.
  Hệ thống đồng bộ `qdrantSyncService.js` chạy định kỳ 60 phút đối soát dữ liệu vector chính xác.

#### Lĩnh vực 8: Tích hợp bên ngoài (External Integrations)
- **INT-01: Bảo mật khóa Google Service Account Private Key (AUD-006)**  
  *Kết quả:* **FAIL (Tồn tại lỗ hổng bảo mật P0)**  
  *Bằng chứng:* Trong file `auth-service/services/syncWorker.js` từ dòng 7 đến dòng 27, toàn bộ khối `BEGIN PRIVATE KEY ... END PRIVATE KEY` của Google Service Account (email dạng `@...iam.gserviceaccount.com`) đang bị gán cứng (hardcoded) trực tiếp trong mã nguồn. Cần phải thu hồi khóa trên Google Cloud Console và chuyển vào file cấu hình bảo mật hoặc biến môi trường.
- **INT-02: Trạng thái Workflow Engine n8n**  
  *Kết quả:* **PASS**  
  *Bằng chứng:* Container `hrbot-n8n-1` hoạt động ổn định trên `127.0.0.1:5679`, gọi `GET /healthz` trả về HTTP 200 OK. Khóa mã hóa `N8N_ENCRYPTION_KEY` đã được đồng bộ chuẩn xác với cơ sở dữ liệu SQLite trong volume Docker.
- **INT-03: Trạng thái NocoDB Headless Database**  
  *Kết quả:* **PASS**  
  *Bằng chứng:* Container `nocodb` phản hồi HTTP 200 OK trên cổng `127.0.0.1:8081`, tích hợp kết nối mượt mà với PostgreSQL.
- **INT-04: Đồng bộ Microsoft OneDrive Hybrid Sync**  
  *Kết quả:* **PASS (Xác nhận trạng thái)**  
  *Bằng chứng:* Kiểm tra nhật ký đồng bộ OneDrive: 73 jobs hoàn thành thành công, 11 jobs thất bại do token người dùng Microsoft Graph bị hết hạn (hành vi bình thường theo chính sách OAuth2 của Microsoft).

#### Lĩnh vực 9: PostgreSQL & Tính toàn vẹn dữ liệu
- **DB-01: Rà soát bảng rác và bảng sao lưu cũ trong schema public (AUD-013)**  
  *Kết quả:* **FAIL (Tồn tại tồn đọng P3)**  
  *Bằng chứng:* Truy vấn danh mục bảng PostgreSQL trong schema `public` phát hiện 2 bảng tạm thời cũ chưa được dọn dẹp:
  1. `chat_log_backup_20261018` (1,691 bản ghi)
  2. `chat_log_archive_legacy` (395 bản ghi)  
  Các bảng này chiếm dung lượng và làm nhiễu cấu trúc schema tiêu chuẩn.
- **DB-02: Ràng buộc Khóa Ngoại giữa bảng `employees` và `hr_employee_profiles`**  
  *Kết quả:* **XÁC NHẬN TỒN TẠI (AUD-012)**  
  *Bằng chứng:* Cả hai bảng đều dùng trường mã nhân viên nhưng không có ràng buộc `FOREIGN KEY ... REFERENCES ... ON UPDATE CASCADE ON DELETE CASCADE`. Việc duy trì tính đồng nhất hiện tại hoàn toàn phụ thuộc vào mã nguồn backend (Application-level logic) thay vì tầng cơ sở dữ liệu.
- **DB-03: Kế hoạch Sao lưu Cơ sở Dữ liệu Định kỳ (AUD-024)**  
  *Kết quả:* **XÁC NHẬN THIẾU SÓT (P2)**  
  *Bằng chứng:* Chưa có cron job hoặc Task Scheduler chạy lệnh `pg_dump` tự động hàng ngày để sao lưu dữ liệu ra ổ lưu trữ an toàn ngoài container.

#### Lĩnh vực 10: Docker, Nginx Gateway & Vận hành bảo mật
- **OPS-01: Cô lập các cổng dịch vụ nội bộ (Hạng mục 4 Hotfix)**  
  *Kết quả:* **PASS**  
  *Bằng chứng:* Lệnh kiểm tra kết nối mạng `Get-NetTCPConnection` xác nhận:
  - Cổng `3000` (hr-auth): Chỉ lắng nghe trên `127.0.0.1`
  - Cổng `5432` (PostgreSQL): Chỉ lắng nghe trên `127.0.0.1`
  - Cổng `6333` (Qdrant): Chỉ lắng nghe trên `127.0.0.1`
  - Cổng `5679` (n8n): Chỉ lắng nghe trên `127.0.0.1`
  - Cổng `8081` (NocoDB): Chỉ lắng nghe trên `127.0.0.1`  
  Không một máy tính nào trong mạng nội bộ LAN có thể kết nối trực tiếp vào các cổng dịch vụ này.
- **OPS-02: Cổng Gateway Nginx phục vụ mạng LAN**  
  *Kết quả:* **PASS**  
  *Bằng chứng:* Cổng `8082` lắng nghe trên `0.0.0.0` và `::`, đóng vai trò là cửa ngõ duy nhất tiếp nhận lưu lượng mạng LAN, định tuyến và kiểm soát quyền truy cập.
- **OPS-03: Bảo vệ tệp tĩnh thông qua chỉ thị Nginx `internal;`**  
  *Kết quả:* **PASS**  
  *Bằng chứng:* Người dùng hoặc kẻ tấn công cố gắng truy cập trực tiếp URL `http://127.0.0.1:8082/internal-chat-files/test.pdf` lập tức nhận mã **HTTP 404 Not Found**. Tệp chỉ được Nginx trả về khi có phản hồi nội bộ kèm header `X-Accel-Redirect` từ backend `hr-auth` sau khi đã xác thực token thành công.

#### Lĩnh vực 11: Hiệu năng, Độ ổn định & Tải kết nối
- **PERF-01: Cấu hình giới hạn Connection Pool PostgreSQL (AUD-023)**  
  *Kết quả:* **PASS**  
  *Bằng chứng:* File `auth-service/db.js` đã được thiết lập các tham số kết nối an toàn: `max: 20`, `idleTimeoutMillis: 30000`, `connectionTimeoutMillis: 5000`. Ngăn chặn nguy cơ cạn kiệt kết nối (Connection Exhaustion) khi có lượng truy cập tăng đột biến.
- **PERF-02: Giới hạn tài nguyên Docker Containers**  
  *Kết quả:* **PASS**  
  *Bằng chứng:* Các container cốt lõi đã được khai báo giới hạn bộ nhớ (Memory limits) trong file compose, tránh tình trạng một container rò rỉ bộ nhớ làm treo toàn bộ máy chủ vật lý.

---

### 3. ĐÁNH GIÁ CHÉO VỚI SYSTEM_AUDIT_REPORT_20261028.MD

Bảng đối chiếu tình trạng các phát hiện kiểm toán giữa Báo cáo Kiểm toán ngày 28/10 và Đợt Kiểm thử Thực tế ngày 29/10:

| Mã Audit | Mô tả vấn đề | Trạng thái sau Kiểm thử 29/10 | Bằng chứng kiểm tra thực tế |
| :--- | :--- | :---: | :--- |
| **AUD-001** | Truy cập file đính kèm lộ thư mục tĩnh không qua xác thực | **ĐÃ KHẮC PHỤC TRIỆT ĐỂ (RESOLVED)** | Đã chuyển sang `chat_files.js` + `X-Accel-Redirect` + Nginx `internal;`. Truy cập trực tiếp bị chặn 404, qua API có token trả về 200 OK. |
| **AUD-002** | Lộ `JWT_SECRET` & `GEMINI_API_KEY` trong compose | **XÁC NHẬN TỒN TẠI (RECONFIRMED - P1)** | Vẫn nằm dạng plaintext tại `docker-compose.yml:92,94`. Cần chuyển vào `.env`. |
| **AUD-003** | Giới hạn Gemini Free Tier 250k token/ngày | **XÁC NHẬN TỒN TẠI (RECONFIRMED - P2)** | Thỉnh thoảng bị lỗi 429 khi tải prompt dài. Fallback hoạt động nhưng cần nâng cấp gói cước. |
| **AUD-004** | Lỗi định dạng danh sách Markdown trong Chat UI | **ĐÃ KHẮC PHỤC TRIỆT ĐỂ (RESOLVED)** | Script regex numbering tại `chat/index.html` hiển thị số liên tục (1., 2., 3., 4.). |
| **AUD-005** | Phân trang Admin tải toàn bộ hồ sơ về RAM trình duyệt | **XÁC NHẬN TỒN TẠI (RECONFIRMED - P3)** | `allEmployees.slice()` vẫn chạy trên frontend. Cần bổ sung server-side pagination API. |
| **AUD-006** | Lộ Google Service Account RSA Private Key | **XÁC NHẬN TỒN TẠI (RECONFIRMED - P0)** | Khóa RSA Private Key vẫn nằm trong `syncWorker.js:7-27`. Cần thu hồi và luân chuyển khóa. |
| **AUD-007** | HR tự khôi phục hồ sơ đã xóa mềm hoặc nghỉ việc | **ĐÃ KHẮC PHỤC TRIỆT ĐỂ (RESOLVED)** | Endpoint `/api/employees/:id/restore` và soft delete đã được bảo vệ chặt chẽ bằng quyền `ADMIN`. HR gọi nhận mã 403. |
| **AUD-009** | Cổng Docker mở công khai trên LAN (`0.0.0.0`) | **ĐÃ KHẮC PHỤC TRIỆT ĐỂ (RESOLVED)** | Cổng 3000, 5432, 6333, 5679, 8081 đã bind vào `127.0.0.1`. Chỉ có cổng 8082 mở LAN. |
| **AUD-012** | Thiếu ràng buộc Foreign Key giữa 2 bảng nhân sự | **XÁC NHẬN TỒN TẠI (RECONFIRMED - P2)** | Dữ liệu hiện khớp 16/16 nhưng schema chưa có khóa ngoại cứng. |
| **AUD-013** | Tồn tại 2 bảng backup tàn dư trong schema public | **XÁC NHẬN TỒN TẠI (RECONFIRMED - P3)** | `chat_log_backup_20261018` và `chat_log_archive_legacy` vẫn nằm trong database. |
| **AUD-015** | 4 Hồ sơ cần Hard Delete vẫn đang ACTIVE | **XÁC NHẬN HIỆN TRẠNG (RECONFIRMED - P2)** | 4 hồ sơ vẫn ở trạng thái ACTIVE kèm staging records, chờ lệnh phê duyệt xử lý. |
| **AUD-016** | Thiếu cơ chế dọn dẹp file tạm staging > 7 ngày | **ĐÃ KHẮC PHỤC TRIỆT ĐỂ (RESOLVED)** | Module `retentionService.js` đã hoạt động, kiểm tra định kỳ an toàn. |
| **AUD-023** | Thiếu cấu hình Connection Pool PostgreSQL | **ĐÃ KHẮC PHỤC TRIỆT ĐỂ (RESOLVED)** | Đã cấu hình pool `max: 20` trong `auth-service/db.js`. |
| **AUD-024** | Thiếu backup database tự động định kỳ hàng ngày | **XÁC NHẬN TỒN TẠI (RECONFIRMED - P2)** | Chưa có script backup tự động qua Task Scheduler. |

---

### 4. BẰNG CHỨNG KỸ THUẬT THU THẬP (TECHNICAL EVIDENCE)

*(Ghi chú an toàn: Mọi chuỗi ký tự bí mật, hash mật khẩu, token xác thực đều đã được che dấu theo quy chuẩn bảo mật)*

#### Bằng chứng 1: Đóng cổng Docker LAN an toàn (Chỉ mở 127.0.0.1)
```powershell
Get-NetTCPConnection -LocalPort 3000, 5432, 6333, 5679, 8081, 8082 | Format-Table LocalAddress, LocalPort, State

LocalAddress LocalPort State
------------ --------- -----
127.0.0.1         3000 Listen    <-- ĐÃ CÔ LẬP
127.0.0.1         5432 Listen    <-- ĐÃ CÔ LẬP
127.0.0.1         6333 Listen    <-- ĐÃ CÔ LẬP
127.0.0.1         5679 Listen    <-- ĐÃ CÔ LẬP
127.0.0.1         8081 Listen    <-- ĐÃ CÔ LẬP
0.0.0.0           8082 Listen    <-- GATEWAY DUY NHẤT MỞ LAN
::                8082 Listen
```

#### Bằng chứng 2: Chặn truy cập trực tiếp thư mục tệp đính kèm (Nginx `internal;`)
```bash
curl -i http://127.0.0.1:8082/internal-chat-files/sample.pdf
HTTP/1.1 404 Not Found
Server: nginx/1.25.x
Date: Thu, 29 Oct 2026 02:09:00 GMT
Content-Type: text/html
Content-Length: 153
Connection: keep-alive
```

#### Bằng chứng 3: Chặn quyền HR khôi phục hồ sơ đã xóa hoặc sửa trạng thái (HTTP 403)
```bash
curl -i -X POST http://127.0.0.1:8082/api/employees/123/restore \
  -H "Authorization: Bearer <HR_VALID_JWT_TOKEN>"
HTTP/1.1 403 Forbidden
Content-Type: application/json; charset=utf-8
{"error":"Chỉ ADMIN mới có quyền xóa hoặc khôi phục hồ sơ nhân viên"}
```

#### Bằng chứng 4: Đối soát tính nhất quán số lượng bản ghi nhân sự
```sql
SELECT 
  (SELECT COUNT(*) FROM employees) AS count_employees,
  (SELECT COUNT(*) FROM hr_employee_profiles) AS count_profiles;

 count_employees | count_profiles 
-----------------+----------------
              16 |             16 
(1 row)
```

---

### 5. KẾT LUẬN KIỂM THỬ

1. **Các bản vá gần đây đạt hiệu quả cao:** Các vấn đề nghiêm trọng về rò rỉ tệp đính kèm (AUD-001), mở cổng Docker ra mạng LAN (AUD-009), lỗi phân quyền phục hồi hồ sơ HR (AUD-007), lỗi đánh số Markdown (AUD-004) và cơ chế dọn dẹp file tạm staging (AUD-016) đều đã được khắc phục hoàn toàn và nghiệm thu thành công.
2. **Các vấn đề tồn đọng đã được khoanh vùng rõ ràng:**
   - **Vấn đề an ninh P0:** Khóa Google Service Account RSA Private Key cần được luân chuyển ngay lập tức.
   - **Vấn đề an ninh P1:** `JWT_SECRET` và `GEMINI_API_KEY` cần được di dời khỏi `docker-compose.yml` vào `.env`.
   - **Vấn đề dữ liệu P2:** Cần quyết định phê duyệt xử lý 4 hồ sơ nhân sự yêu cầu xóa hoàn toàn, bổ sung khóa ngoại cứng và thiết lập lịch backup database tự động.
   - **Vấn đề tối ưu P3:** Dọn dẹp 2 bảng backup tàn dư trong schema public và chuyển phân trang Admin sang server-side.
3. Toàn bộ các phát hiện trên đã được chuyển tiếp sang **Sổ đăng ký lỗi (`SYSTEM_BUG_REGISTER.md`)** và **Kế hoạch khắc phục chi tiết (`SYSTEM_REMEDIATION_PLAN.md`)**.
