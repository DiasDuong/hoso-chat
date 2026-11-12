# SOTRANS HUB — BÁO CÁO LOẠI BỎ QUYỀN TRUY CẬP GENERAL AI ĐỐI VỚI NGƯỜI DÙNG CHƯA ĐĂNG NHẬP

**Mã công việc:** `AUTH-PUBLIC-GENERAL-AI-REMOVAL-01`  
**Dự án:** `D:\hoso-chat`  
**Môi trường:** Production SOTRANS Hub  
**Ngày thực hiện:** 30/10/2026  
**Trạng thái:** ✅ **HOÀN THÀNH TOÀN DIỆN (12/12 KIỂM THỬ ĐẠT 100%)**

---

## I. MỤC TIÊU VÀ NGUYÊN TẮC BẢO MẬT

Theo yêu cầu kiểm soát an ninh thông tin và bảo vệ tài nguyên tính toán AI nội bộ của Tập đoàn SOTRANS, hệ thống SOTRANS Hub đã tiến hành:
1. **Loại bỏ hoàn toàn khả năng sử dụng chatbot General AI đối với khách truy cập chưa đăng nhập.**
2. **Khóa 100% các endpoint API của General AI ở tầng máy chủ**, bắt buộc phải có JSON Web Token (JWT) hợp lệ từ phiên đăng nhập đang hoạt động; mọi request không có token hoặc token sai/hết hạn đều bị từ chối ngay lập tức với mã lỗi **HTTP 401 Unauthorized**.
3. **Thay thế giao diện chat công khai bằng Cổng Đăng nhập Doanh nghiệp & Giới thiệu Nền tảng (Public Auth Landing View)**, không để lộ khung chat trống, ô nhập văn bản, nút gửi tin nhắn hay câu hỏi gợi ý.
4. **Bảo toàn 100% chức năng General AI cho người dùng đã đăng nhập**: Chat thông thường, lưu trữ hội thoại, phân tích tài liệu/ảnh, trích xuất dữ liệu, ReAct Agent, Web Research và Personal AI Agents.
5. **Bảo toàn toàn vẹn dữ liệu cơ sở dữ liệu**: Không xóa bất kỳ hội thoại (`ai_conversations`), tin nhắn (`ai_messages`), tệp đính kèm (`ai_attachments`) hay hồ sơ nhân sự nào.

---

## II. ĐỐI CHIẾU HÌNH ẢNH GIAO DIỆN (E2E EVIDENCE)

### 1. Giao diện Người chưa đăng nhập (Public Auth Portal)
*Khách truy cập vào hệ thống sẽ thấy Cổng Đăng nhập Doanh nghiệp chuyên nghiệp; toàn bộ khung chat, ô gõ nội dung, nút gửi và thẻ General AI trên sidebar đều bị ẩn.*

![Public Landing Screen](file:///C:/Users/Admin/.gemini/antigravity/brain/8075309c-9094-41f0-a8ba-aaed531952d1/screenshots/auth_gai_01_public_landing.png)

### 2. Giao diện Sau khi Đăng nhập Thành công
*Đăng nhập thành công sẽ mở khóa đầy đủ không gian làm việc General AI, nạp danh sách bot được phân quyền trên sidebar, cho phép trò chuyện và nhận phản hồi tức thì từ AI.*

![Authenticated General AI View](file:///C:/Users/Admin/.gemini/antigravity/brain/8075309c-9094-41f0-a8ba-aaed531952d1/screenshots/auth_gai_06_login_success.png)

### 3. Phản hồi Tin nhắn Trực tiếp trong Phiên Đăng nhập
*General AI phản hồi nhanh chóng, hỗ trợ đầy đủ Markdown, phân tích dữ liệu và trích xuất nguồn.*

![General AI Message Success](file:///C:/Users/Admin/.gemini/antigravity/brain/8075309c-9094-41f0-a8ba-aaed531952d1/screenshots/auth_gai_07_message_success.png)

### 4. Thu hồi Quyền Ngay lập tức khi Đăng xuất (Logout)
*Ngay khi nhấn "Đăng xuất", token bị hủy hoàn toàn khỏi bộ nhớ, giao diện chat đóng lập tức và chuyển hướng an toàn về `#login`.*

![Post Logout State](file:///C:/Users/Admin/.gemini/antigravity/brain/8075309c-9094-41f0-a8ba-aaed531952d1/screenshots/auth_gai_08_logout.png)

---

## III. CHI TIẾT CÁC THAY ĐỔI ĐÃ THỰC HIỆN

### 1. Phía Giao diện Người dùng (Frontend — `chat/index.html`)

- **Loại bỏ hiển thị General AI đối với khách:**
  - Cập nhật hàm `getAllowedAgentIds()`: Khi `!isAuthenticated()`, trả về mảng rỗng `[]`.
  - Cập nhật hàm `canAccessAgent(agentId)`: Trả về `false` đối với mọi chatbot khi chưa xác thực.
  - Cập nhật hàm `renderAgentList()`: Khi chưa đăng nhập, sidebar không hiển thị nút General AI mà thay bằng thẻ hướng dẫn bảo mật: *"Yêu cầu đăng nhập — Đăng nhập để sử dụng General AI và các Trợ lý AI"*.
  - Huy hiệu bot trên sidebar chuyển thành `0 BOT` khi chưa đăng nhập.
- **Xây dựng Cổng Đăng nhập Công khai (`#publicAuthView`):**
  - Bổ sung cấu trúc HTML và CSS đáp ứng tiêu chuẩn Enterprise SaaS Dashboard.
  - Bao gồm: Giới thiệu 3 trụ cột AI của SOTRANS Hub, thông báo bảo mật và Form đăng nhập trực tiếp tích hợp Single-Sign-On (SSO).
  - Ẩn hoàn toàn khung chat (`#chatViewWrap`), thanh công cụ gửi file, gợi ý câu hỏi và các nút tiện ích header (`btnCopyChat`, `btnExportChatWrap`, `btnNewChatTop`, `btnActiveDocs`).
- **Bảo vệ Định tuyến (Route Protection):**
  - Trong `resolveInitialWorkspaceState()`, `switchWorkspaceMode()` và `handleBrowserNavigationRoute()`:
    - Nếu người dùng chưa xác thực truy cập URL General AI (e.g. `#chat/general`, `#chat/policy`, `#admin/...`), hệ thống ghi nhận URL dự định vào `window.pendingRedirectHash` và tự động điều hướng an toàn về `#login`.
    - Sau khi đăng nhập thành công, hệ thống tự động đưa người dùng trở lại đúng màn hình đã yêu cầu trước đó mà không gây vòng lặp redirect.
- **Bảo vệ Thao tác Gửi tin nhắn (`sendMessage()`):**
  - Nếu phát hiện người dùng chưa đăng nhập, lập tức chặn gửi, kích hoạt `#publicAuthView` và mở form đăng nhập.

### 2. Phía Máy chủ & API Bảo mật (Backend — `auth-service/routes/general_ai.js`)

- **Áp dụng Middleware `verifyToken` trên toàn bộ Router `/api/general`:**
  - Thay thế middleware tuỳ chọn `resolveOptionalUser` bằng `router.use(verifyToken)`.
  - Mọi request đến `/api/general/chat`, `/api/general/attachments/:id`, `/api/general/conversations/:id/attachments` đều bắt buộc phải có Authorization Bearer token hợp lệ và tài khoản ở trạng thái `ACTIVE`.
- **Chặn đứng luồng Khách vãng lai (Guest Mode Elimination):**
  - Loại bỏ hoàn toàn khối mã ephemeral guest chat (vốn cho phép khách gửi prompt in-memory mà không cần token).
  - Bổ sung cơ chế phòng vệ chiều sâu (Defense-in-Depth): Trả về `HTTP 401 Unauthorized` ngay lập tức nếu thiếu `req.user.user_id`.
- **Bảo vệ Kết nối Luồng Streaming / SSE:**
  - Endpoint `/api/general/chat?stream=true` kiểm tra token trước khi thiết lập header `text/event-stream`. Nếu không có token, máy chủ trả về `HTTP 401` dạng JSON và từ chối bắt tay kết nối (Handshake Rejected).

---

## IV. BẢNG TỔNG HỢP KẾT QUẢ 12 KIỂM THỬ BẮT BUỘC

| Mã Kiểm Thử | Kịch Bản Kiểm Thử | Kỳ Vọng | Kết Quả Thực Tế | Trạng Thái |
|:---:|---|---|---|:---:|
| **AUTH-GAI-01** | Truy cập trang công khai chưa đăng nhập | Không hiển thị General AI, hiển thị Public Auth View | `chatViewWrap: false`, `chatInput: false`, `publicAuthView: true` | ✅ **PASS** |
| **AUTH-GAI-02** | Truy cập trực tiếp URL `#chat/general` khi chưa đăng nhập | Tự động chuyển hướng an toàn về `#login` | Hash chuyển thành `#login`, General AI bị chặn | ✅ **PASS** |
| **AUTH-GAI-03** | Gọi API `POST /api/general/chat` không có token | Trả về HTTP 401 Unauthorized | HTTP 401 (`Chưa đăng nhập. Vui lòng cung cấp token hợp lệ.`) | ✅ **PASS** |
| **AUTH-GAI-04** | Gọi Chat API với token sai chữ ký | Trả về HTTP 401 Unauthorized | HTTP 401 (`Token không hợp lệ hoặc đã bị thay đổi.`) | ✅ **PASS** |
| **AUTH-GAI-05** | Truy cập SSE Stream không xác thực | Từ chối Handshake, trả về HTTP 401 | HTTP 401 (`application/json; charset=utf-8`) | ✅ **PASS** |
| **AUTH-GAI-06** | Đăng nhập tài khoản hợp lệ trên giao diện | Mở khóa General AI, hiển thị bot trên sidebar | Đăng nhập thành công, mở khóa chat, `activeAgent: "general"` | ✅ **PASS** |
| **AUTH-GAI-07** | Gửi tin nhắn sau khi đăng nhập | Nhận câu trả lời hoàn chỉnh từ AI | Gửi thành công, nhận phản hồi từ Gemini Engine | ✅ **PASS** |
| **AUTH-GAI-08** | Đăng xuất khi đang trong phòng chat | Hủy token, ẩn chat view, chặn gọi API tiếp theo | Token bị xóa, màn hình Public Auth hiển thị, API trả về 401 | ✅ **PASS** |
| **AUTH-GAI-09** | Gọi API khi Token đã hết hạn | Trả về HTTP 401 yêu cầu đăng nhập lại | HTTP 401 (`Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.`) | ✅ **PASS** |
| **AUTH-GAI-10** | Truy cập My Agents (Personal AI Agents) sau đăng nhập | Hoạt động bình thường theo quyền | Workspace My Agents mở bình thường | ✅ **PASS** |
| **AUTH-GAI-11** | Đăng nhập bằng tài khoản Quản trị viên (ADMIN) & HR | Giữ nguyên đầy đủ quyền hạn quản trị | ADMIN & HR truy cập đủ 3 bot + Trung tâm Quản trị | ✅ **PASS** |
| **AUTH-GAI-12** | Truy cập các trang và API công khai hợp lệ khác | Hoạt động ổn định, không bị chặn nhầm | `/api/auth/login`: 200/400, `/api/health`: 200, `/hr.css`: 200 | ✅ **PASS** |

---

## V. XÁC NHẬN BẢO TOÀN DỮ LIỆU & TÍNH TOÀN VẸN CƠ SỞ DỮ LIỆU

Hệ thống đã thực hiện kiểm tra đối soát trực tiếp trên cơ sở dữ liệu Production `hrbot`:

| Bảng Cơ Sở Dữ Liệu | Số Lượng Bản Ghi | Trạng Thái Bảo Toàn |
|---|:---:|:---:|
| `ai_conversations` (Hội thoại AI) | **313** bản ghi | ✅ Giữ nguyên vẹn 100% |
| `ai_messages` (Tin nhắn AI) | **2,283** bản ghi | ✅ Giữ nguyên vẹn 100% |
| `ai_attachments` (Tệp đính kèm chat) | **17** bản ghi | ✅ Giữ nguyên vẹn 100% |
| `employees` (Danh sách nhân viên) | **5** bản ghi | ✅ Giữ nguyên vẹn 100% |
| `hr_employee_profiles` (Hồ sơ nhân sự OCR) | **5** bản ghi | ✅ Giữ nguyên vẹn 100% |
| `users` (Tài khoản người dùng) | **14** tài khoản | ✅ Giữ nguyên vẹn 100% |

---

## VI. DANH SÁCH TỆP THAY ĐỔI & THÔNG TIN DEPLOYMENT

1. **`auth-service/routes/general_ai.js`:**
   - Thay thế `resolveOptionalUser` bằng `router.use(verifyToken)`.
   - Bổ sung kiểm tra `!req.user || !req.user.user_id` trả về HTTP 401.
   - Loại bỏ khối ephemeral guest chat.
2. **`chat/index.html`:**
   - Thêm CSS và container HTML cho `#publicAuthView`.
   - Cập nhật logic `getAllowedAgentIds()`, `canAccessAgent()`, `renderAgentList()`, `updateUserUI()`.
   - Bổ sung cơ chế bảo vệ chuyển hướng URL và xử lý form đăng nhập trực tiếp.
3. **Container Services:**
   - `hr-auth`: Đã khởi động lại sạch, nạp cấu hình bảo mật mới.
   - `hr-gateway`: Đã reload Nginx configuration, phục vụ tài sản tĩnh không lưu cache phiên cũ.
4. **Git Commit Hash:** `b24c8dd`

**Kết luận:** Quyền truy cập General AI đối với người dùng chưa đăng nhập đã được loại bỏ hoàn toàn, triệt để cả ở tầng Frontend và Backend API. Toàn bộ tính năng General AI và dữ liệu hội thoại của người dùng đã đăng nhập được bảo toàn nguyên vẹn và vận hành an toàn.
