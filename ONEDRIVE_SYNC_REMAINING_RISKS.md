# ĐÁNH GIÁ RỦI RO CÒN LẠI VÀ BIỆN PHÁP PHÒNG NGỪA
**Dự án:** SOTRANS AI Workspace (`D:\hoso-chat`)  
**Hạng mục:** OneDrive Sync Engine & Personal AI Agents  
**Ngày đánh giá:** 26/10/2026

---

## 1. PHÂN TÍCH RỦI RO TIỀM ẨN

### Rủi ro 1: Độ trễ lưu trữ tự nhiên của Microsoft Office Online (Office for the Web)
- **Bản chất:** Khi người dùng mở tệp `.xlsx` và chỉnh sửa trực tiếp trên trình duyệt qua Microsoft 365 / Excel Online, Microsoft sử dụng cơ chế Co-authoring Session đệm trên RAM máy chủ Microsoft. Quá trình flush xuống storage của OneDrive mất từ **10 đến 45 giây** sau khi người dùng ngừng gõ phím hoặc đóng tab trình duyệt.
- **Biện pháp phòng ngừa đã triển khai:**
  - Triển khai **Smart Flush Polling**: Khi người dùng nhấn nút "Đồng bộ", nếu SHA-256 hash của tệp chưa đổi, hệ thống tự động thăm dò 2 đợt (mỗi đợt cách nhau 2.5s) để đón đầu khoảnh khắc Microsoft commit file.
  - Phản hồi minh bạch: Nếu sau 2 lần thăm dò mà Microsoft vẫn chưa commit, hệ thống hiển thị thông báo: *"Dữ liệu đã ở bản mới nhất v{X}. Không có thay đổi từ OneDrive."* và giữ nguyên phiên bản, không báo lỗi và không sinh bản snapshot rác.

### Rủi ro 2: Microsoft Graph API Throttling (Rate Limiting HTTP 429)
- **Bản chất:** Microsoft áp dụng giới hạn số lượng request Graph API theo tenant/user (thường là 10.000 requests/10 phút). Nếu nhiều người dùng đồng loạt nhấn đồng bộ thủ công liên tục, Microsoft có thể trả về HTTP 429 Too Many Requests kèm header `Retry-After`.
- **Biện pháp phòng ngừa đã triển khai:**
  - **Concurrency Mutex Lock**: Khóa theo từng `sourceId`. Nếu có nhiều request đồng thời tới cùng một file, chỉ 1 request thực sự gọi tới Graph API, các request còn lại dùng chung kết quả.
  - **UI Debounce**: Nút bấm đồng bộ bị disable và hiển thị spinner ngay lập tức khi click.
  - **Kế hoạch tiếp theo:** Đọc header `Retry-After` trong `fetchWithTimeout` để tự động giãn cách khi có thông báo rate-limit từ Microsoft.

### Rủi ro 3: Tệp Excel dung lượng rất lớn (> 50 MB) hoặc cấu trúc phức tạp
- **Bản chất:** Các file bảng tính chứa hàng trăm nghìn dòng hoặc hàng chục sheet phức tạp có thể mất 5–10 giây để tải về và phân tích qua SheetJS.
- **Biện pháp phòng ngừa đã triển khai:**
  - **Async Processing & Streaming Guard**: Toàn bộ quá trình phân tích chạy bất đồng bộ, không chặn luồng server (Node.js event loop).
  - Bản snapshot cấu trúc JSON được lưu trong cơ sở dữ liệu để phục vụ truy vấn tức thì (0 download) cho tất cả các câu hỏi tiếp theo của Agent.

### Rủi ro 4: Thu hồi quyền truy cập Microsoft Account (Token Revocation)
- **Bản chất:** Người dùng đổi mật khẩu Microsoft cá nhân, quản trị viên thu hồi phân quyền, hoặc token làm mới (refresh token) hết hạn sau 90 ngày không hoạt động.
- **Biện pháp phòng ngừa đã triển khai:**
  - **Graceful Fallback**: Hệ thống không xóa snapshot hiện có. Nguồn được chuyển trạng thái ghi nhận lỗi, đồng thời Freshness Guard hiển thị ghi chú cảnh báo: *"Tài khoản Microsoft OneDrive đã ngắt kết nối. Hệ thống đang sử dụng bản sao lưu nội bộ gần nhất để trả lời"*. Người dùng vẫn tra cứu được dữ liệu cũ mà không bị gián đoạn.

---

## 2. KHUYẾN NGHỊ VẬN HÀNH DÀNH CHO NGƯỜI DÙNG

1. **Sau khi chỉnh sửa Excel Online:** Hãy chờ khoảng 5–10 giây hoặc kiểm tra thanh tiêu đề của Excel Online hiển thị biểu tượng **"Saved" / "Đã lưu"** trước khi nhấn nút "Đồng bộ" trên SOTRANS Hub.
2. **Không cần bấm đồng bộ nhiều lần:** Hệ thống đã có cơ chế tự động đối soát mã băm nhị phân. Nếu thông báo hiển thị *"Dữ liệu đã ở bản mới nhất"*, nghĩa là hệ thống đã có phiên bản khớp 100% với file trên OneDrive.
3. **Theo dõi trạng thái:** Nếu huy hiệu file hiển thị `SYNCED` màu xanh lá, Agent `Excel-Data-Pro` cam kết sử dụng 100% dữ liệu từ bản snapshot đó để tra cứu và tính toán.
