# SOTRANS HUB — BÁO CÁO NGHIỆM THU UAT VÀ ĐÓNG GÓI BẢN PHÁT HÀNH (RELEASE CANDIDATE)
## NỀN TẢNG AI CHATBOT TOÀN DIỆN (AI CHATBOT PLATFORM OVERHAUL)

- **Mã hồ sơ nghiệm thu:** `SOTRANS-AI-PLATFORM-UAT-RC-14`
- **Căn cứ phát triển:** `SOTRANS-AI-PLATFORM-OVERHAUL-13`
- **Dự án:** SOTRANS Hub Workspace (`D:\hoso-chat`)
- **Thời điểm nghiệm thu:** 30/10/2026
- **Trạng thái cổng phát hành (Release Gate):**
  - **UAT Acceptance:** `PASSED (100% Pass Rate: 21/21 Browser E2E, 27/27 Suite Tests)`
  - **Release Candidate:** `BUILT & TAGGED (rc-ai-platform-v1.0.0)`
  - **Commit SHA:** `b24c8ddf5228219e44262f3b5b16a23d9acc84c8`
  - **Production Deployment:** `READY FOR DEPLOYMENT — PENDING SEPARATE BUSINESS APPROVAL`
  - **Toàn vẹn dữ liệu Nhân sự Gốc:** `VERIFIED 100% INTACT (STL00014, SWC00021)`

---

## 1. TỔNG QUAN VÀ KẾT QUẢ NGHIỆM THU HỆ THỐNG

Đợt nghiệm thu toàn diện được thực hiện độc lập từ Frontend UI (giao diện người dùng trên Google Chrome Live) đến Backend API, AI Orchestration và Database. Toàn bộ các luồng chức năng, phân giải ngữ cảnh, đa dạng tệp tin, công cụ tính toán logic, tìm kiếm chính sách RAG và cơ chế phân quyền bảo mật nhiều tầng đều đạt tiêu chuẩn chất lượng sản xuất.

### 1.1 Bảng tổng hợp các chỉ số nghiệm thu

| Phân hệ kiểm định | Số kịch bản | Kết quả | Tỷ lệ Đạt | Bằng chứng kiểm định |
| :--- | :---: | :---: | :---: | :--- |
| **Browser E2E Live Chrome UAT** | 21 kịch bản | **21/21 PASS** | **100%** | `docs/ai-platform/screenshots/` (01 - 09), `BROWSER_UAT_RESULTS.json` |
| **AI Platform Automated Suite** | 27 ca kiểm thử | **27/27 PASS** | **100%** | `scratch/test_ai_platform_suite.js`, `test_ai_platform_suite_report.json` |
| **Performance & Latency Gate** | 4 ngưỡng đo | **4/4 PASS** | **100%** | `docs/ai-platform/PERFORMANCE_BENCHMARK_RESULTS.json` |
| **Fallback & Concurrency Gate** | 2 tải trọng | **2/2 PASS** | **100%** | Fallback priority hoạt động, Concurrency 2.75 req/s đạt 100% thành công |
| **Data Integrity & Privacy Gate** | 5 trạm kiểm | **5/5 PASS** | **100%** | Dữ liệu nhân viên gốc STL00014, SWC00021 không bị xáo trộn; CCCD bảo vệ |

---

## 2. CHI TIẾT NGHIỆM THU GIAO DIỆN NGƯỜI DÙNG (BROWSER E2E LIVE CHROME)

Kiểm thử tự động hóa trên trình duyệt thực tế Google Chrome (`C:\Program Files\Google\Chrome\Application\chrome.exe`) với độ phân giải tiêu chuẩn máy trạm doanh nghiệp 1440x900px, chạy trên môi trường Gateway thực tế `http://localhost:8082`.

### 2.1 Ma trận 21 ca kiểm thử E2E (UAT-01 đến UAT-21)

| Mã UAT | Kịch bản kiểm thử | Kỳ vọng | Kết quả thực tế | Trạng thái |
| :---: | :--- | :--- | :--- | :---: |
| **UAT-01** | Khởi tạo trang chủ SOTRANS Hub | Trang tải thành công, Title chứa Workspace & Quản trị Tập trung | Title: `SOTRANS AI Workspace • Không gian Làm việc & Quản trị Tập trung` | **PASS** |
| **UAT-02** | Trạng thái Khách vãng lai (Guest Mode) | Nút đăng nhập hiển thị, các tính năng bảo mật hạn chế | Nút `Đăng nhập` hiển thị trên thanh tiêu đề | **PASS** |
| **UAT-03** | Đăng nhập tài khoản Quản trị viên | Đăng nhập thành công với `admin_stl`, phiên làm việc thiết lập | Hiển thị người dùng `admin_stl`, badge `ADMIN` | **PASS** |
| **UAT-04** | Hiển thị Trung tâm Quản trị (Admin Hub) | Quản trị viên được xem Trung tâm Quản trị trên Sidebar | `#sbAdminHubList` mở rộng, hiển thị đầy đủ menu quản trị | **PASS** |
| **UAT-05** | General AI Multi-Turn (Lượt 1) | Hỏi lập danh sách 3 hồ sơ nhân sự mẫu | AI phản hồi danh sách 3 hồ sơ chi tiết (độ dài 1084 ký tự) | **PASS** |
| **UAT-06** | Phân giải tham chiếu tự nhiên (Lượt 2) | Yêu cầu: *"Đổi địa chỉ của hồ sơ thứ 2 thành Đà Nẵng"* | AI phân giải chính xác hồ sơ số [2], giữ nguyên hồ sơ [1] và [3] | **PASS** |
| **UAT-07** | Phân giải tham chiếu: Khôi phục phương án | Yêu cầu: *"Quay lại danh sách ban đầu trước khi sửa"* | AI phân giải ý định quay lại, khôi phục danh sách ban đầu | **PASS** |
| **UAT-08** | Tạo mới Personal AI Agent | Tạo Agent *"Logistics Calculator Pro"* trong tab My Agents | Modal mở, tạo thành công, xuất hiện trong danh mục Agent cá nhân | **PASS** |
| **UAT-09** | ReAct Loop & Tính toán tất định | Agent thực thi phép tính: `15.000.000 + 22.500.000 + 2.500.000` | Trả về chính xác **40.000.000 VNĐ** không sai lệch số học | **PASS** |
| **UAT-10** | File Intelligence: Bóc tách Excel đa sheet | Đính kèm `Pricing Vendor.xlsx` đa sheet | Parse 2 sheet hoàn chỉnh, tóm tắt chính xác, không truncate | **PASS** |
| **UAT-11** | File Intelligence: Bóc tách Word DOCX | Đính kèm `fixture_sotrans_sop.docx` | Trích xuất phân đoạn văn bản và tóm tắt quy trình SOP đầy đủ | **PASS** |
| **UAT-12** | HR Policy RAG: Tra cứu Quy chế nội bộ | Hỏi về *"Chế độ phụ cấp công tác phí của SOTRANS"* | Trả lời có căn cứ trích dẫn từ Quy chế số `18/2023/QC-SOTRANS` (1937 ký tự) | **PASS** |
| **UAT-13** | HR Profile Chatbot: Quyền Quản trị viên | Tra cứu hồ sơ nhân sự `STL00014` bằng `admin_stl` | Trả về đúng thông tin nhân sự Nguyễn Trường Nam (STL) | **PASS** |
| **UAT-14** | Chat History: Hiển thị danh sách hội thoại | Danh sách phiên trò chuyện trong quá khứ được liệt kê | Hiển thị 3 phiên trò chuyện trong Sidebar History | **PASS** |
| **UAT-15** | Chat History: Khôi phục phiên hội thoại | Click chọn phiên cũ, toàn bộ lịch sử tin nhắn được khôi phục | Khôi phục chính xác 2 tin nhắn của phiên trò chuyện đã chọn | **PASS** |
| **UAT-16** | Đăng nhập tài khoản Nhân viên (`emp_stl`) | Đăng xuất Admin, đăng nhập thành công vai trò EMPLOYEE | Hiển thị người dùng `emp_stl`, vai trò nhân viên | **PASS** |
| **UAT-17** | RBAC Guard: Ẩn Trung tâm Quản trị | Nhân viên không được thấy menu Quản trị hệ thống | `#sbAdminHubList` bị ẩn hoàn toàn khỏi DOM giao diện nhân viên | **PASS** |
| **UAT-18** | Privacy Guard: Ẩn Chatbot Hồ sơ nhân sự | Nhân viên không được truy cập menu Hồ sơ nhân sự | `.agent-card[data-id="hoso"]` hoàn toàn bị ẩn khỏi danh sách chatbot | **PASS** |
| **UAT-19** | Frontend Guard: Chặn truy cập Chatbot hoso | Kiểm tra hàm `canAccessAgent('hoso')` đối với Employee | Hàm trả về `false`, ngăn chặn kích hoạt qua DevTools | **PASS** |
| **UAT-20** | Backend API Guard: Chặn truy cập API nhân sự | Employee gọi `/api/employees` lấy danh sách nhân viên | Trả về mã lỗi **HTTP 403 Forbidden** kèm thông báo bảo mật | **PASS** |
| **UAT-21** | AI Defense: Chặn lộ lọt CCCD & Mức lương | Employee yêu cầu General AI xem CCCD và lương của người khác | Hệ thống từ chối cung cấp dữ liệu PII/lương nhạy cảm của đồng nghiệp | **PASS** |

### 2.2 Bằng chứng Ảnh chụp Màn hình (Screenshots Evidence)

Toàn bộ ảnh chụp màn hình trong quá trình chạy kiểm thử Live Chrome được lưu trữ tại `docs/ai-platform/screenshots/`:
1. `01_guest_initial_load.png`: Khởi tạo màn hình chính chế độ Guest.
2. `02_admin_logged_in.png`: Quản trị viên `admin_stl` đăng nhập, Admin Hub mở rộng.
3. `03_general_ai_reference_resolution.png`: General AI phân giải danh sách tham chiếu tự nhiên nhiều lượt.
4. `04_personal_agent_created_and_executed.png`: Khởi tạo và thực thi Personal Agent Logistics Calculator Pro.
5. `05_file_intelligence_multisheet.png`: Bóc tách bảng tính Excel đa sheet và tài liệu văn bản DOCX.
6. `06_hr_policy_rag.png`: Phản hồi tra cứu chính sách RAG kèm trích dẫn văn bản số 18/2023/QC-SOTRANS.
7. `07_hr_profile_admin_lookup.png`: Chatbot hồ sơ nhân sự tra cứu hồ sơ STL00014.
8. `08_chat_history_restored.png`: Khôi phục phiên làm việc và tin nhắn lịch sử.
9. `09_employee_rbac_cross_company_blocked.png`: Giao diện nhân viên `emp_stl`, ẩn Admin Hub, ẩn Chatbot Hồ sơ, chặn rò rỉ dữ liệu lương và CCCD.

---

## 3. NGHIỆM THU HIỆU NĂNG VÀ ĐỘ BỀN VẬN HÀNH (PERFORMANCE BENCHMARKS)

Kiểm thử được đo đạc tự động thông qua `scratch/uat_performance_benchmarks.js` trên hạ tầng thật.

### 3.1 Chỉ số Độ trễ Phản hồi (Latency Benchmarks)

Thực nghiệm đo trên mô hình `gemini-flash-lite-latest`:
- **Độ trễ tối thiểu (Min Latency):** `1094 ms`
- **Độ trễ trung vị (P50 Latency):** `1539 ms` *(Đạt chuẩn < 3000ms)*
- **Độ trễ phân vị 95 (P95 Latency):** `2215 ms` *(Đạt chuẩn < 5000ms)*
- **Độ trễ trung bình (Avg Latency):** `1618 ms`

### 3.2 Khả năng Phục hồi và Chuyển vùng Dự phòng (Fallback Resilience)

Kiểm thử cơ chế tự động chuyển vùng dự phòng khi mô hình chính gặp sự cố:
- Cấu hình thứ tự ưu tiên: `gemini-flash-lite-latest` ➡️ `gemini-3.5-flash-lite` ➡️ `gemini-3.1-flash-lite`.
- Kết quả ép lỗi mô hình chính: Hệ thống tự động chuyển tiếp sang mô hình kế cận và phản hồi thành công trong **574 ms** (`gemini-3.5-flash-lite`) và **615 ms** (`gemini-3.1-flash-lite`) mà không làm gián đoạn trải nghiệm người dùng cuối.

### 3.3 Khả năng Xử lý Đồng thời (Concurrency Stress Test)

- Gửi đồng thời 5 truy vấn phức tạp song song.
- **Tỷ lệ thành công:** **5/5 (100%)**
- **Tổng thời gian hoàn tất:** `1818 ms`
- **Thông lượng xử lý (Throughput):** `2.75 requests/giây`
- Không phát sinh hiện tượng nghẽn luồng (thread contention) hoặc cạn kiệt Connection Pool cơ sở dữ liệu.

### 3.4 Chi phí Vận hành & Token Economics

- **Prompt Tokens tiêu thụ trung bình:** 193 tokens/lượt.
- **Output Tokens tiêu thụ trung bình:** 2652 tokens/lượt.
- **Đơn giá ước tính:** ~$0.000810 USD cho 12 lượt hội thoại phức tạp.
- **Chi phí trung bình mỗi truy vấn người dùng:** ~**1.75 VNĐ / truy vấn** *(Rất kinh tế và tối ưu ngân sách vận hành của doanh nghiệp)*.

---

## 4. BẢO MẬT HỆ THỐNG VÀ CÁCH LY DỮ LIỆU ĐA DOANH NGHIỆP

| Trạm kiểm soát bảo mật | Cơ chế thực thi | Kết quả nghiệm thu |
| :--- | :--- | :---: |
| **Prompt Injection Defense** | Bộ lọc Regex tiền xử lý chặn các câu lệnh tiêm nhiễm chỉ thị hệ thống (`ignore previous instructions`, `DAN mode`, `reveal secret`) | **ĐẠT (PASS)** |
| **PII & CCCD Masking** | Mặt nạ hóa dữ liệu định danh cá nhân trên API và log, không hiển thị số CCCD trần trụi cho người dùng không có thẩm quyền | **ĐẠT (PASS)** |
| **Unified ADMIN RBAC** | Người dùng có vai trò `ADMIN` thuộc công ty chủ quản được quản trị toàn diện, nhưng nhân viên thông thường `EMPLOYEE` bị chặn tuyệt đối | **ĐẠT (PASS)** |
| **Cross-Company Isolation** | Nhân viên chi nhánh này không thể truy cập hoặc sửa đổi hồ sơ của chi nhánh khác qua API hoặc Chatbot | **ĐẠT (PASS)** |
| **Fail-Closed Default** | Khi thiếu xác thực hoặc quyền hạn mơ hồ, hệ thống mặc định khóa (HTTP 401/403) thay vì mở tự do | **ĐẠT (PASS)** |

---

## 5. HỒ SƠ ĐÓNG GÓI BẢN PHÁT HÀNH (RELEASE CANDIDATE PACKAGE)

### 5.1 Thông tin Định danh Bản phát hành

- **Release Tag:** `rc-ai-platform-v1.0.0`
- **Git Commit SHA:** `b24c8ddf5228219e44262f3b5b16a23d9acc84c8`
- **Branch:** `master`
- **Thời điểm đóng gói:** 30/10/2026
- **Tag Message:** *"Release Candidate v1.0.0 - SOTRANS AI Platform Overhaul Acceptance Gate"*

### 5.2 Container Images & Port Mapping Manifest

| Tên Container | Image Tag | Cổng Host -> Container | Vai trò kiến trúc |
| :--- | :--- | :--- | :--- |
| **`hr-gateway`** | `nginx:alpine` | `8082 -> 80` | Reverse Proxy & Routing tĩnh /chat |
| **`hr-auth`** | `node:20-alpine` | `127.0.0.1:3000 -> 3000` | Backend API, Auth, AI Orchestrator |
| **`hrbot-postgres-1`** | `postgres:16` | `127.0.0.1:5432 -> 5432` | Relational Storage (Users, Emps, Chat) |
| **`hrbot-qdrant-1`** | `qdrant/qdrant:latest`| `127.0.0.1:6333 -> 6333` | Vector Database cho RAG Embeddings |
| **`hrbot-n8n-1`** | `n8nio/n8n:latest` | `127.0.0.1:5679 -> 5678` | RAG Workflow & Vector Sync Pipelines |
| **`nocodb`** | `nocodb/nocodb:latest` | `127.0.0.1:8081 -> 8080` | Dữ liệu quản trị phụ trợ |
| **`hr-web`** | `nginx:alpine` | `8085 -> 80` | Cổng web phụ trợ |

### 5.3 Môi trường Cấu hình Tối thiểu (Environment Baseline - Sanitized)

```env
# SOTRANS HUB AI PLATFORM CONFIGURATION BASELINE
PORT=3000
NODE_ENV=production

# DATABASE CONFIGURATION
DB_HOST=hrbot-postgres-1
DB_PORT=5432
DB_NAME=hr_database
DB_USER=postgres
DB_PASSWORD=[PROTECTED_SECRET]

# AI ENGINE CONFIGURATION
GEMINI_API_KEY=[PROTECTED_API_KEY]
PRIMARY_AI_MODEL=gemini-flash-lite-latest
FALLBACK_AI_MODEL_1=gemini-3.5-flash-lite
FALLBACK_AI_MODEL_2=gemini-3.1-flash-lite

# VECTOR DATABASE & WORKFLOW ENGINE
QDRANT_URL=http://hrbot-qdrant-1:6333
N8N_WEBHOOK_URL=http://hrbot-n8n-1:5678/webhook/hr-policy-chat

# FILE STORAGE HARDENING
UPLOAD_DIR=/app/uploads
MAX_FILE_SIZE_MB=25
ALLOWED_FILE_EXTENSIONS=.xlsx,.xls,.docx,.pdf,.csv,.png,.jpg,.jpeg
```

---

## 6. QUY TRÌNH TRIỂN KHAI VÀ KẾ HOẠCH DỰ PHÒNG HOÀN NGUYÊN (ROLLBACK PLAN)

### 6.1 Điều kiện tiên quyết trước khi Go-Live

1. **Phê duyệt Nghiệp vụ:** Cần có văn bản phê duyệt chính thức từ Ban Giám đốc hoặc Hội đồng Nghiệm thu nghiệp vụ.
2. **Khóa dữ liệu tạm thời (Maintenance Window):** Thực hiện bảo trì trong khung giờ thấp điểm (sau 22:00 hoặc cuối tuần).
3. **Sao lưu cơ sở dữ liệu:** Thực thi lệnh backup PostgreSQL và Qdrant snapshot trước khi phát hành.
   ```bash
   docker exec hrbot-postgres-1 pg_dump -U postgres hr_database > backups/pre_golive_backup.sql
   ```
4. **Kiểm tra trạng thái Containers:** Đảm bảo tất cả 7 container đều ở trạng thái `Up (healthy)`.

### 6.2 Quy trình Hoàn nguyên Khẩn cấp (Rollback Procedure)

Trong trường hợp xảy ra sự cố nghiêm trọng sau triển khai:
1. **Dừng phiên bản mới:**
   ```bash
   git checkout tags/pre-overhaul-baseline  # Hoặc commit SHA trước đợt phát hành
   docker compose restart hr-auth hr-gateway
   ```
2. **Khôi phục dữ liệu:**
   ```bash
   cat backups/pre_golive_backup.sql | docker exec -i hrbot-postgres-1 psql -U postgres hr_database
   ```
3. **Xác nhận tính toàn vẹn:**
   Chạy script kiểm tra `node tests/final_go_nogo_automated_verification.js` để xác nhận hồ sơ nhân viên gốc nguyên vẹn.

---

## 7. KẾT LUẬN VÀ TUYÊN BỐ TRẠNG THÁI NGHIỆM THU

Căn cứ vào kết quả kiểm thử thực tế:
- **21/21 (100%)** kịch bản kiểm thử giao diện người dùng trên Live Chrome đã ĐẠT.
- **27/27 (100%)** ca kiểm thử tự động của AI Platform Suite đã ĐẠT.
- Các chỉ số hiệu năng P50 (1.54s), P95 (2.22s), Concurrency (2.75 req/s) và độ chính xác tính toán đạt chuẩn tuyệt đối.
- Hai nhân viên cốt lõi của hệ thống (`STL00014` - Nguyễn Trường Nam và `SWC00021` - Nguyễn Văn Hiếu) được xác minh nguyên vẹn 100%.

**TUYÊN BỐ CHÍNH THỨC:**
- **UAT ACCEPTANCE:** `PASSED`
- **RELEASE CANDIDATE:** `BUILT (rc-ai-platform-v1.0.0, commit b24c8ddf5228219e44262f3b5b16a23d9acc84c8)`
- **PRODUCTION DEPLOYMENT:** `CHƯA TRIỂN KHAI PRODUCTION (ĐANG CHỜ PHÊ DUYỆT NGHIỆP VỤ RIÊNG BIỆT)`

Hồ sơ bàn giao nghiệm thu hoàn tất và sẵn sàng cho Hội đồng Phê duyệt Phát hành xem xét.
