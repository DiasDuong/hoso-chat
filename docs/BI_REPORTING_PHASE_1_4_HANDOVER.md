# SOTRANS HUB — BI REPORTING SYSTEM
## TÀI LIỆU BÀN GIAO KỸ THUẬT & HƯỚNG DẪN VẬN HÀNH (PHASE 1.4)
**Ngày lập tài liệu:** 14/11/2026  
**Phiên bản hệ thống:** BI Reporting v1.4 (Enterprise Edition)  
**Workspace:** `D:\hoso-chat`  
**Trạng thái kiểm thử:** **148 / 148 PASS (100%)**

---

## 1. TỔNG QUAN KIẾN TRÚC BI REPORTING

Hệ thống Báo Cáo Quản Trị (BI Reporting) của **SOTRANS Hub** được thiết kế theo kiến trúc **General AI Grounding**. Thay vì xây dựng một trang Dashboard độc lập hoặc tạo một chatbot riêng biệt, toàn bộ năng lực báo cáo số liệu được nhúng trực tiếp vào giao diện **General AI** hiện có của tập đoàn.

```
+-----------------------------------------------------------------------------------+
|                            NGƯỜI DÙNG (ADMIN / HR)                                |
|                 Giao diện Duy Nhất: chat/index.html (General AI)                  |
+-----------------------------------------------------------------------------------+
                                          |
                                          v  (HTTP POST /api/general/chat)
+-----------------------------------------------------------------------------------+
|               BI INTENT ROUTER & GUARD (biReportingHelper.js)                     |
|  - Quét & phân loại Intent: BI_QUERY, AMBIGUOUS_BI_QUERY, NORMAL_CHAT            |
|  - Trích xuất thời gian tiếng Việt (Asia/Ho_Chi_Minh: Hôm nay, Tuần này, Tháng...) |
|  - Kiểm soát RBAC & Tenant Isolation (ADMIN: STL/VTX/SWC/ALL; HR: company_id)     |
|  - Chống Prompt Injection & Vô hiệu hóa Arbitrary SQL                              |
+-----------------------------------------------------------------------------------+
       |                                                           |
       | (Nếu là Chat thường / RAG quy định)                       | (Nếu là Câu hỏi BI hợp lệ)
       v                                                           v
+-------------------------------+         +-----------------------------------------+
|     GEMINI AI PIPELINE        |         |       ANALYTICS ENGINE FOUNDATION       |
|  - Xử lý ngôn ngữ tự nhiên   |         |           (analyticsEngine.js)          |
|  - Tra cứu tài liệu RAG       |         |  - Thực thi 17 KPI cố định              |
|  - Thời tiết, tỷ giá, tính toán|        |  - Read-Only Transaction (timeout 3000ms)|
+-------------------------------+         |  - Parameterized SQL (Chống Injection)  |
                                          +-----------------------------------------+
                                                                   |
                                                                   v
+-----------------------------------------------------------------------------------+
|                    BÁO CÁO KẾT XUẤT ĐA TẦNG (Dual Rendering)                      |
|  1. Bảng Markdown Chuẩn: Tương thích văn bản thuần, thiết bị di động, email      |
|  2. Fenced Code Block ```bi-report: Chứa dữ liệu JSON an toàn XSS                |
|  3. Frontend Visual Widget: Render trực tiếp thành Corporate KPI Cards & Charts   |
+-----------------------------------------------------------------------------------+
```

---

## 2. DANH SÁCH MODULE VÀ NHIỆM VỤ

| Tên Module / File | Đường Dẫn Tuyệt Đối | Nhiệm Vụ Kỹ Thuật |
|:---|:---|:---|
| **Analytics Engine** | `auth-service/services/analyticsEngine.js` | Thực thi truy vấn 17 KPI bằng SQL cố định, kiểm soát tenant isolation, quản lý giao dịch read-only và trả về cấu trúc JSON chuẩn hóa. |
| **Reporting API** | `auth-service/routes/analytics.js` | Endpoint RESTful `/api/analytics/kpis` và `/api/analytics/catalog` phục vụ tích hợp microservice độc lập. |
| **BI Reporting Helper** | `auth-service/services/biReportingHelper.js` | Nhận diện intent BI, phân tích thời gian tiếng Việt, cầu nối backend-to-engine, định dạng Markdown bảng tổng hợp và payload UI chống XSS. |
| **General AI Chat Route** | `auth-service/routes/general_ai.js` | Định tuyến câu hỏi người dùng, lưu vết lịch sử hội thoại (`ai_conversations`, `ai_messages`, `chat_log`) và phát luồng SSE streaming. |
| **Client UI & Widget** | `chat/index.html` | Hiển thị bong bóng hội thoại, render Corporate KPI Cards, thanh tiến độ, bảng dữ liệu và biểu đồ SVG responsive. |
| **Server Bootstrapper** | `auth-service/server.js` | Đăng ký route `/api/analytics` và bảo vệ toàn bộ server API. |

---

## 3. DANH MỤC 17 KPI VÀ TRẠNG THÁI DỮ LIỆU

Single Source of Truth: `KPI_CATALOG` trong `analyticsEngine.js`.

| STT | Mã KPI | Tên Nghiệp Vụ | Phân Loại | Bảng CSDL Nguồn | Ghi Chú Kỹ Thuật |
|:---:|:---|:---|:---:|:---|:---|
| **1** | `DOC_TOTAL` | Tổng số Văn bản Quy định | **READY** | `public.documents` | Đếm tổng văn bản và số lượng văn bản đang hiệu lực (`active`). |
| **2** | `DOC_BY_EFFECTIVE_DATE` | Văn bản Quy định Theo Ngày Hiệu lực | **READY** | `public.documents` | Phân nhóm theo tháng hiệu lực (`effective_date`). |
| **3** | `DOC_BY_TYPE` | Cơ cấu Loại hình & Chuyên mục Văn bản | **READY** | `public.documents` | Đếm theo loại hình (`doc_type`) và chuyên mục (`category`). |
| **4** | `DOC_STATUS` | Cơ cấu Trạng thái Vòng đời Văn bản | **READY** | `public.documents` | Tỷ lệ và số lượng các trạng thái (`active`, `expired`, `draft`). |
| **5** | `INTAKE_UPLOADS` | Tổng số Lô & Tệp Tiếp nhận Hồ sơ | **READY** | `public.hr_intake_batches` | Đếm tổng số lô (`batches`), tổng số tệp (`files`) và TB tệp/lô. |
| **6** | `INTAKE_BY_USER` | Khối lượng Tiếp nhận Theo Cán bộ HR | **READY** | `public.hr_intake_batches` | Thống kê số lô và số tệp tải lên theo từng tài khoản cán bộ. |
| **7** | `INTAKE_TRENDS` | Xu hướng Tiếp nhận Hồ sơ Theo Chu kỳ | **READY** | `public.hr_intake_batches` | Biến động số lượng lô và tệp hồ sơ theo từng tháng. |
| **8** | `INTAKE_SUCCESS` | Phân bổ Trạng thái Lô & Tỷ lệ Chuyển đổi Staging | **CONDITIONAL** | `hr_intake_batches`, `hr_employee_staging` | Dùng CTE tránh trùng lặp; phân định rõ chuyển đổi staging cùng/khác đơn vị. |
| **9** | `INTAKE_FAILURE` | Tỷ lệ Tiếp nhận & Trích xuất Thất bại | **BLOCKED** | `public.hr_intake_batches` | Pipeline chưa ghi nhận chi tiết lỗi vào CSDL; trả `DATA_UNAVAILABLE`. |
| **10** | `INTAKE_DURATION` | Thời gian Xử lý Hồ sơ Trung bình | **BLOCKED** | `public.hr_intake_batches` | Cột `completed_at` chưa được pipeline cập nhật; trả `DATA_UNAVAILABLE`. |
| **11** | `DUPLICATE_RATE` | Tỷ lệ Hồ sơ Nghi ngờ Trùng lặp CCCD | **READY** | `public.hr_employee_staging` | Đếm hồ sơ gắn cờ nghi trùng CCCD trên tổng hồ sơ staging. |
| **12** | `POLICY_CONFLICT` | Tình trạng Xung đột Văn bản Quy định | **BLOCKED** | `public.document_relationships` | Xung đột đang tính động trong code, chưa lưu CSDL; trả `DATA_UNAVAILABLE`. |
| **13** | `APPROVAL_QUEUE` | Tồn đọng Phê duyệt & Hoạt động Duyệt/Từ chối | **READY** | `public.hr_employee_staging` | Tách bạch: Tồn đọng hiện tại, Duyệt trong kỳ, Từ chối trong kỳ. |
| **14** | `OCR_QUALITY` | Điểm Chất lượng Số hóa Văn bản | **CONDITIONAL** | `public.documents` | Thống kê mẫu số rõ ràng (`measured_docs`/`total_docs`). Sub-metric hồ sơ nhân sự: DATA_UNAVAILABLE. |
| **15** | `DATA_INTEGRITY` | Hồ sơ Thiếu hoặc Không chắc chắn | **READY** | `public.hr_employee_staging` | Tỷ lệ hồ sơ thiếu trường dữ liệu hoặc trường nghi vấn. |
| **16** | `ACTIVE_USERS` | Tài khoản Hoạt động & Tần suất Phiên | **READY** | `public.auth_audit_logs`, `public.users` | Tổng người dùng đăng nhập và tổng số phiên làm việc. |
| **17** | `RAG_ANSWERABLE` | Tỷ lệ Đáp ứng của RAG Quy định | **CONDITIONAL** | `public.chat_log` | Tỷ lệ câu hỏi RAG trả lời được & độ tương đồng vector. Sub-metric độ trễ (latency): DATA_UNAVAILABLE. |

---

## 4. HƯỚNG DẪN DÀNH CHO QUẢN TRỊ VIÊN (ADMIN)

1. **Phạm vi thẩm quyền:** Quản trị viên cấp cao có quyền xem số liệu của từng công ty thành viên hoặc toàn tập đoàn:
   * `STL`: SOTRANS Logistics
   * `VTX`: Vietranstimex
   * `SWC`: Sowatco
   * `ALL`: Toàn Tập Đoàn SOTRANS
2. **Quy tắc truy vấn:**
   * ADMIN **phải chỉ định rõ công ty hoặc phạm vi toàn tập đoàn** trong câu hỏi.
   * *Ví dụ:* `"Báo cáo tiếp nhận hồ sơ của STL tháng này"` hoặc `"Tổng số văn bản của toàn tập đoàn"`.
3. **Cơ chế hỏi lại (Clarification):**
   * Nếu ADMIN hỏi chung chung (ví dụ: *"Báo cáo hồ sơ tiếp nhận"*), hệ thống **tuyệt đối không tự ý fallback về ALL**. Chatbot sẽ lịch sự hỏi lại để ADMIN chọn đơn vị: `STL`, `VTX`, `SWC` hoặc `ALL`.

---

## 5. HƯỚNG DẪN DÀNH CHO CÁN BỘ NHÂN SỰ (HR)

1. **Phạm vi thẩm quyền:** Cán bộ Nhân sự chỉ được xem số liệu thuộc đơn vị của mình (dựa trên trường `company_id` gắn trong tài khoản đăng nhập).
2. **Quy tắc truy vấn tự động:**
   * Cán bộ HR không cần gõ tên công ty. Câu hỏi: `"Báo cáo hồ sơ tháng này"` sẽ tự động hiển thị số liệu của công ty trực thuộc.
3. **Cưỡng chế an toàn (Zero Data Leakage):**
   * Nếu cán bộ HR của `STL` cố tình hỏi: *"Cho tôi xem hồ sơ của Vietranstimex"*, hệ thống tự động cưỡng chế kết quả về `STL` và đính kèm ghi chú:  
     `Lưu ý: Tài khoản của bạn thuộc đơn vị STL. Hệ thống cung cấp báo cáo theo đúng phạm vi thẩm quyền được cấp.`

---

## 6. VÍ DỤ CÂU HỎI TIẾNG VIỆT MẪU

* **Văn bản quy định:**
  * *"Tổng số văn bản quy định của STL hiện tại"*
  * *"Thống kê văn bản theo ngày hiệu lực của VTX"*
  * *"Cơ cấu loại hình văn bản của toàn tập đoàn"*
  * *"Tỷ lệ văn bản còn hiệu lực của SWC"*
* **Hồ sơ nhân sự & Tiếp nhận:**
  * *"Báo cáo tiếp nhận hồ sơ của STL trong tháng này"*
  * *"Ai tải lên nhiều hồ sơ nhất của Vietranstimex"*
  * *"Xu hướng tiếp nhận hồ sơ theo từng tháng của SWC"*
  * *"Tỷ lệ chuyển đổi hồ sơ sang staging của STL"*
  * *"Tỷ lệ trùng lặp hồ sơ căn cước của toàn tập đoàn"*
  * *"Báo cáo số lượng hồ sơ đang chờ duyệt của STL"*
* **Hệ thống & AI:**
  * *"Chất lượng nhận dạng OCR văn bản của STL"*
  * *"Số lượng người dùng hoạt động của toàn tập đoàn tuần qua"*
  * *"Tỷ lệ chatbot trả lời được quy định của toàn tập đoàn"*
  * *"Báo cáo tổng quan tình hình hệ thống của STL"*

---

## 7. CÁC TÌNH HUỐNG LÀM RÕ PHẠM VI & THỜI GIAN

1. **Thiếu phạm vi đơn vị (Đối với ADMIN):**
   * *Người dùng:* "Cho tôi xem tình hình văn bản quy định"
   * *Chatbot phản hồi:* "Để cung cấp số liệu chính xác, bạn muốn xem báo cáo của đơn vị nào: **SOTRANS Logistics (STL)**, **Vietranstimex (VTX)**, **Sowatco (SWC)**, hay **Toàn tập đoàn (ALL)**?"
2. **Không nêu thời gian:**
   * Hệ thống không đoán bừa khoảng 30 ngày. Báo cáo được tính theo mốc **Lũy kế toàn thời gian** hoặc trạng thái hiện hành của hệ thống (`startDate = null, endDate = null`).
3. **Khoảng ngày cụ thể:**
   * Cú pháp: `"từ 01/10/2026 đến 31/10/2026"`. Hệ thống tự động chuyển đổi sang định dạng ISO `YYYY-MM-DD` theo múi giờ `Asia/Ho_Chi_Minh` và áp dụng cận trên độc quyền (`endExclusiveDate = 2026-11-01`).

---

## 8. CÁCH BẬT / TẮT FEATURE FLAG THEO MÔI TRƯỜNG

Tính năng BI Reporting được bảo vệ bằng biến môi trường `BI_REPORTING_ENABLED`:

* **Bật tính năng (Môi trường Dev / Test):**
  ```bash
  BI_REPORTING_ENABLED=true
  ```
* **Tắt tính năng (Emergency Kill Switch):**
  ```bash
  BI_REPORTING_ENABLED=false
  ```
  Khi bị tắt, mọi truy vấn BI từ General AI hoặc API sẽ nhận được phản hồi lịch sự:  
  `Dịch vụ BI Reporting hiện đang tạm thời bị vô hiệu hóa (BI_REPORTING_ENABLED is false).`  
  Toàn bộ các tính năng chat, RAG, tra cứu thời tiết, tỷ giá... vẫn tiếp tục hoạt động 100% bình thường.

---

## 9. API VÀ RESPONSE CONTRACT

### Endpoint: `POST /api/analytics/kpis`
* **Headers:** `Authorization: Bearer <JWT_TOKEN>`, `Content-Type: application/json`
* **Request Body:**
  ```json
  {
    "kpiCodes": ["DOC_TOTAL", "INTAKE_UPLOADS"],
    "options": {
      "companyId": "STL",
      "startDate": "2026-11-01",
      "endDate": "2026-11-14"
    }
  }
  ```
* **Standard Response Payload:**
  ```json
  {
    "success": true,
    "timestamp": "2026-11-14T09:30:00.000Z",
    "total_kpis": 2,
    "data": [
      {
        "kpi": "DOC_TOTAL",
        "status": "AVAILABLE",
        "scope": { "company_id": "STL", "branch": "sotrans_logistics" },
        "period": { "start": "2026-11-01", "end_exclusive": "2026-11-15", "timezone": "Asia/Ho_Chi_Minh" },
        "data": { "total_documents": 70, "active_count": 50, "expired_count": 15, "draft_count": 5 },
        "warnings": [],
        "metadata": { "classification": "READY", "source_tables": ["public.documents"], "generated_at": "..." }
      }
    ]
  }
  ```

---

## 10. NGUYÊN TẮC BẢO MẬT & TENANT ISOLATION

1. **Phân quyền nghiêm ngặt (Strict RBAC):** Chỉ `ADMIN` và `HR` có quyền truy vấn số liệu BI. Vai trò `EMPLOYEE`, `USER`, `Guest` (chưa đăng nhập) và tài khoản `INACTIVE`/`LOCKED` bị từ chối tuyệt đối ngay tại tầng middleware.
2. **Không sử dụng Text-to-SQL:** Không bao giờ chuyển giao câu hỏi cho Gemini để tự viết câu lệnh SQL. CSDL PostgreSQL chỉ nhận các câu lệnh SQL cố định đã được tham số hóa (`$1`, `$2`, `$3`).
3. **Giao dịch Chỉ Đọc (Read-Only Transaction):**
   ```sql
   BEGIN READ ONLY;
   SET LOCAL statement_timeout = 3000;
   SET LOCAL TIME ZONE 'Asia/Ho_Chi_Minh';
   -- Thực thi SQL tham số hóa
   COMMIT;
   ```
4. **Cô lập Đơn vị Văn bản:** Bảng `documents` sử dụng trường mảng `branches` với toán tử overlap `@> ARRAY['sotrans_logistics', 'all']::text[]` để bảo đảm các văn bản dùng chung toàn tập đoàn (`all`) luôn hiển thị đầy đủ cho các công ty thành viên.

---

## 11. HƯỚNG DẪN CHẠY BỘ KIỂM THỬ (TEST EXECUTION)

Hệ thống sở hữu 4 bộ kiểm thử tự động độc lập không phụ thuộc vào kết nối CSDL bên ngoài:

```bash
# 1. Kiểm thử Foundation Analytics Engine (Phase 1.1 - 30 scenarios)
node tests/test_analytics_engine_foundation.js

# 2. Kiểm thử Reporting API & Security (Phase 1.2 - 30 scenarios)
node tests/test_analytics_api.js

# 3. Kiểm thử General AI Integration (Phase 1.3 - 35 scenarios)
node tests/test_general_ai_bi_integration.js

# 4. Kiểm thử End-to-End Verification (Phase 1.4 - 53 scenarios)
node tests/test_phase_1_4_e2e_verification.js
```
* **Tổng số test toàn hệ thống:** **148 / 148 PASS (0 FAIL)**.

---

## 12. CƠ CHẾ XỬ LÝ LỖI & PHỤC HỒI

* **Quá thời gian chờ (Query Timeout):** Giới hạn tối đa 3000ms mỗi truy vấn. Nếu vượt quá, giao dịch tự động ROLLBACK và trả về trạng thái `DATA_UNAVAILABLE` kèm thông báo lỗi thân thiện, không làm treo server.
* **Lỗi CSDL cục bộ:** Một KPI gặp lỗi không làm gián đoạn các KPI khác trong cùng một báo cáo.
* **Sự cố phía Gemini API:** Nếu Gemini gặp sự cố mạng hoặc hết hạn mức, General AI vẫn trả về đầy đủ bảng biểu và thẻ chỉ số KPI được định dạng từ dữ liệu thực tế trích xuất thành công.

---

## 13. ĐIỀU KIỆN TIÊN QUYẾT TRƯỚC KHI BẬT PRODUCTION

Trước khi kích hoạt cờ `BI_REPORTING_ENABLED=true` trên máy chủ Production, bắt buộc phải hoàn thành các bước sau:
1. **Tạo tài khoản CSDL Read-Only riêng biệt:**
   * Tạo user PostgreSQL `hrbot_readonly` chỉ có quyền `SELECT` trên các bảng nghiệp vụ liên quan.
   * Tuyệt đối không cho phép quyền `INSERT`, `UPDATE`, `DELETE`, `DROP` hoặc `ALTER`.
2. **Kiểm thử trên CSDL Staging thực tế:**
   * Chạy kiểm tra đối soát số liệu thực tế với các cán bộ quản lý STL, VTX, SWC trên môi trường Staging/Test DB.
3. **Phê duyệt chính thức:**
   * Có sự chấp thuận bằng văn bản của DevOps / Quản trị hệ thống CSDL SOTRANS.

---

## 14. SAO LƯU VÀ QUY TRÌNH ROLLBACK

Toàn bộ các file chương trình trước khi thay đổi đều được lưu trữ an toàn tại:
`D:\SOTRANS_BACKUPS\20261114_PHASE_1_4\`

* **Danh sách file sao lưu:**
  * `D:\SOTRANS_BACKUPS\20261114_PHASE_1_4\biReportingHelper.js.bak`
  * `D:\SOTRANS_BACKUPS\20261114_PHASE_1_4\general_ai.js.bak`
  * `D:\SOTRANS_BACKUPS\20261114_PHASE_1_4\index.html.bak`
* **Quy trình Rollback khẩn cấp:**
  Nếu phát sinh sự cố, sao chép đè các file `.bak` trở lại thư mục dự án tương ứng và khởi động lại dịch vụ backend.

---

## 15. CÁC TÍNH NĂNG CHƯA KHẢ DỤNG (KNOWN LIMITATIONS)

1. **3 KPI BLOCKED:**
   * `INTAKE_FAILURE`: Đang chờ pipeline Intake ghi nhận chi tiết log lỗi Gateway vào PostgreSQL.
   * `INTAKE_DURATION`: Đang chờ cập nhật mốc thời gian hoàn tất trích xuất (`completed_at`).
   * `POLICY_CONFLICT`: Đang chờ lưu kết quả xung đột văn bản thành bảng dữ liệu quan hệ trong PostgreSQL.
2. **Sub-metrics tạm thời chưa có:**
   * Điểm tin cậy OCR hồ sơ nhân sự (cần bổ sung cột định lượng trong `hr_employee_staging`).
   * Độ trễ phản hồi của RAG (cần bổ sung cột `latency_ms` trong `chat_log`).

---

## 16. ĐỊNH HƯỚNG PHÁT TRIỂN WRENAI POC TRONG GIAI ĐOẠN SAU

Sau khi Phase 1.4 được nghiệm thu hoàn tất, hệ thống có thể mở rộng thử nghiệm **WrenAI POC**:
* Xây dựng Semantic Modeling Layer độc lập bên cạnh Analytics Engine.
* Cho phép người dùng đặt những câu hỏi phân tích kinh doanh tự do (Ad-hoc BI queries) ngoài 17 KPI cố định mà vẫn bảo toàn an toàn CSDL thông qua Semantic Guardrails.
* WrenAI POC sẽ được thực hiện trên môi trường sandbox riêng, tách biệt hoàn toàn với Production Hub.
