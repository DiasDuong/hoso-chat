# SOTRANS HUB — CONVERSATION & REFERENCE RESOLUTION ENGINE
## TÀI LIỆU KỸ THUẬT QUẢN LÝ HỘI THOẠI & PHÂN GIẢI NGỮ CẢNH ĐA LƯỢT

**Mã phân hệ:** `AI-CONV-ENGINE-01`  
**Dự án:** SOTRANS Hub AI Chatbot Platform (`D:\hoso-chat`)  
**Tình trạng:** Production-Grade Implemented & Verified

---

## 1. TỔNG QUAN KIẾN TRÚC HỘI THOẠI

Hệ thống hội thoại SOTRANS Hub được thiết kế theo mô hình **Stateful Multi-Turn Conversation Architecture** với hai lớp lưu trữ đồng bộ:
1. **Lớp giao dịch thời gian thực (Hot Storage - PostgreSQL):**
   - `ai_conversations`: Quản lý danh tính phiên, quyền sở hữu `user_id`, liên kết `agent_id`, tiêu đề và trạng thái `ACTIVE / ARCHIVED / DELETED`.
   - `ai_messages`: Lưu trữ từng lượt trao đổi (`role`: `user` / `assistant` / `system`), nội dung định dạng UTF-8 NFC, siêu dữ liệu `metadata` (chứa mảng tệp đính kèm, versioning, token usage).
   - `ai_attachments`: Lưu trữ tệp đính kèm, đường dẫn vật lý an toàn, MIME type, kích thước và bảng thông số cấu trúc `manifest`.
2. **Lớp nhật ký kiểm toán bất biến (Audit Storage - NocoDB `chat_log`):**
   - Ghi nhận độc lập mọi lượt hỏi/đáp với đầy đủ thông tin: `conversationId`, `userId`, `username`, `companyId`, `agentId`, `role`, `content`, `metadata` và thời gian chuẩn `timestamp`. Phục vụ giám sát tuân thủ nội bộ và đối soát bảo mật.

---

## 2. VÒNG ĐỜI TRUYỀN PHÁT SSE (STREAMING LIFECYCLE)

Để mang lại trải nghiệm tương tác liền mạch, API hội thoại hỗ trợ cả hai giao thức:
- **RESTful JSON chuẩn:** Phù hợp với các yêu cầu tự động hoặc client không hỗ trợ streaming.
- **Server-Sent Events (SSE):** Truyền phát từng token theo thời gian thực qua chuẩn MIME `text/event-stream; charset=utf-8`.

### Các pha sự kiện SSE:
1. `type: "start"`: Khởi tạo luồng, gửi `conversation_id`, `agent_id`, `model` được chọn và danh sách tệp đính kèm `files`.
2. `type: "step"` (Dành cho Agent ReAct Loop): Phát tín hiệu trạng thái suy luận (`thinking`), gọi công cụ (`executing_tool`), hoàn tất công cụ (`tool_finished`), hoặc ngắt vòng lặp (`loop_broken`).
3. `type: "chunk"`: Truyền tải từng đoạn văn bản câu trả lời khi mô hình sinh dữ liệu.
4. `type: "artifact"`: Phát tín hiệu khi công cụ tạo thành công tệp đầu ra (ví dụ: file Excel báo cáo kèm đường dẫn tải về).
5. `type: "done"`: Kết thúc phiên sinh, gửi kèm câu trả lời hoàn chỉnh `reply`, `message_id`, thông tin phiên bản `active_version` và `versions`.
6. `type: "error"`: Xử lý và truyền tải thông báo lỗi nếu có gián đoạn dịch vụ hoặc vi phạm an toàn.

### Kiểm soát đóng kết nối (Abort Controller & Clean-up):
Khi client ngắt kết nối trước khi hoàn tất (ví dụ: người dùng đóng tab hoặc bấm Hủy), backend kích hoạt `AbortController.signal` để dừng ngay lập tức kết nối tới Gemini API, đồng thời lưu trữ phần văn bản đã sinh dở vào DB với cờ `metadata.aborted = true` nhằm bảo toàn dữ liệu.

---

## 3. CƠ CHẾ PHÂN GIẢI THAM CHIẾU TỰ NHIÊN (CONVERSATION REFERENCE RESOLVER)

Một trong những hạn chế lớn nhất của chatbot thông thường là mất ngữ cảnh khi người dùng sử dụng các đại từ thay thế hoặc cụm từ tham chiếu mơ hồ. SOTRANS Hub tích hợp module chuyên dụng `conversationReferenceResolver.js` tại `auth-service/services/conversationReferenceResolver.js`.

### Bảng phân giải tham chiếu chuẩn hóa:

| Cụm từ người dùng | Loại tham chiếu (`Resolution Type`) | Hành vi điều phối & Công cụ mục tiêu |
| :--- | :--- | :--- |
| *"file vừa gửi"*, *"tệp trước"* | `LATEST_FILE` | Tự động liên kết với tệp cuối cùng trong `ai_attachments` của hội thoại, nạp manifest và cấu trúc dữ liệu. |
| *"file thứ hai"*, *"file 2"* | `SECOND_FILE` | Trích xuất chính xác tệp ở chỉ số thứ 2 (`files[1]`) trong danh sách đính kèm. |
| *"tệp [Tên_file.xlsx]"* | `EXPLICIT_NAME_MATCH` | So khớp mềm không dấu (`removeAccents`) với danh sách tên tệp của phiên. |
| *"bảng trên"*, *"sheet trên"* | `PREVIOUS_TABLE` | Điều phối tới `SPREADSHEET_DATA_ENGINE`, trích xuất bảng số liệu tại lượt trả lời gần nhất của trợ lý. |
| *"kết quả vừa rồi"*, *"so với trước"* | `PREVIOUS_RESULT_COMPARISON` | Trích xuất kết quả tính toán trước đó, cung cấp hướng dẫn so sánh đối chiếu cho AI. |
| *"chỉ sửa mục số 3"*, *"hồ sơ 2, 4 và 6"* | `SPECIFIC_ITEMS` | Trích xuất mảng chỉ số `[3]` hoặc `[2, 4, 6]`, thiết lập chỉ thị bắt buộc: **chỉ chỉnh sửa các mục được chỉ định, giữ nguyên các mục còn lại**. |
| *"tiếp tục phần còn lại"*, *"làm tiếp"* | `CONTINUATION` | Phân tích phần nội dung chưa hoàn tất từ lượt trước, tiếp tục triển khai mà không lặp lại đoạn mở đầu. |
| *"quay lại phương án ban đầu"* | `INITIAL_PROPOSAL` | Trích xuất nội dung phương án tại lượt trả lời đầu tiên (`initialAssistantTurn`) để khôi phục định hướng. |
| *"xuất kết quả này ra excel"* | `EXPORT_REQUEST` | Kích hoạt công cụ `export_excel_report` để sinh file `.xlsx` cho người dùng tải về. |

---

## 4. BẢO VỆ RANH GIỚI NGƯỜI DÙNG & CÁCH LY PHIÊN (TENANT & USER ISOLATION)

Module giải quyết tham chiếu áp dụng nguyên tắc **Fail-Closed & Zero-Trust Isolation**:
1. **Kiểm tra quyền sở hữu hội thoại:**
   - Trước khi nạp bất kỳ lượt tin nhắn hay tệp đính kèm nào từ `ai_messages` hoặc `ai_attachments`, hệ thống đối soát `ai_conversations.user_id` với `req.user.user_id` đã được giải mã từ token JWT máy chủ.
   - Nếu `user_id` không trùng khớp (và không phải phiên khách ẩn danh), hệ thống trả về `{ forbidden: true }` và hủy nạp ngữ cảnh.
2. **Khách ẩn danh (Anonymous Guest Mode):**
   - Không được phép nạp ngữ cảnh từ cơ sở dữ liệu.
   - Không được phép tải lên file đính kèm.
   - Toàn bộ lịch sử hội thoại chỉ tồn tại trên bộ nhớ đệm client (`inMemoryHistory`) trong một phiên trình duyệt.

---

## 5. QUẢN TRỊ CỬA SỔ NGỮ CẢNH (CONTEXT WINDOW DYNAMICS)

Nhằm tối ưu hóa hiệu năng và tránh tràn token khi trò chuyện kéo dài:
- Hệ thống trích xuất **14 lượt tin nhắn gần nhất** theo thứ tự thời gian (`ASC`) làm ngữ cảnh đàm thoại trực tiếp gửi cho LLM.
- Các tệp đính kèm lớn (PDF, DOCX) được phân đoạn (`sections`) và chỉ trích xuất các phân đoạn chứa từ khóa liên quan (`top-k chunking`).
- Bảng tính Excel lớn (> 50,000 ô) được tóm tắt qua cấu trúc `dataProfile` (tên sheet, danh sách cột, mẫu 5 dòng đầu) thay vì nhồi toàn bộ dữ liệu thô vào prompt, đồng thời trao quyền cho AI dùng công cụ `search_spreadsheet_data` và `calculate_spreadsheet_metrics` để tra cứu theo nhu cầu.
