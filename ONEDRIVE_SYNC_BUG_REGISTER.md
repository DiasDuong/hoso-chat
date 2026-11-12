# SỔ TAY GHI NHẬN & QUẢN LÝ LỖI (BUG REGISTER)
**Dự án:** SOTRANS AI Workspace (`D:\hoso-chat`)  
**Hạng mục:** Đồng bộ OneDrive & Kiểm soát độ mới dữ liệu Agent  
**Cập nhật lần cuối:** 26/10/2026

---

## BẢNG TỔNG HỢP LỖI ĐÃ PHÁT HIỆN VÀ KHẮC PHỤC

| Mã lỗi | Mức độ | Mô tả lỗi | Nguyên nhân gốc | Giải pháp khắc phục | Trạng thái |
| :---: | :---: | :--- | :--- | :--- | :---: |
| **BUG-01** | **CRITICAL** | Phải bấm "Đồng bộ" 4–5 lần mới thấy dữ liệu mới; mỗi lần bấm đều tăng số phiên bản dù nội dung chưa đổi | Excel Online đệm sửa đổi trong bộ nhớ 10–30s trước khi commit vào OneDrive storage. Hệ thống không kiểm tra mã băm nhị phân nên liên tục tạo bản v6, v7, v8 rác. | Bổ sung SHA-256 `content_hash` trong PostgreSQL và cơ chế Smart Flush Polling (thăm dò 2 lần, mỗi lần cách nhau 2.5s) khi bấm ép buộc đồng bộ. | **RESOLVED** |
| **BUG-02** | **HIGH** | Agent vẫn trả về câu trả lời từ file đính kèm cũ dù OneDrive đã nạp bản mới (Priority Inversion) | `routes/agents.js` duyệt qua `ai_attachments` của hội thoại trước và nạp đường dẫn lưu trữ cũ, vô tình ghi đè lên danh sách `activeFiles` của OneDrive. | Đổi thứ tự: Nạp OneDrive Freshness trước, đồng thời loại trừ bất kỳ file `ai_attachments` nào trùng tên với nguồn OneDrive đang hoạt động. | **RESOLVED** |
| **BUG-03** | **HIGH** | Outbound request gọi Microsoft Graph API nhận dữ liệu cached từ CDN / Edge Proxies | Các request qua `fetchWithTimeout` trong `oneDriveService.js` thiếu headers chỉ thị chống cache. | Thêm `Cache-Control: no-cache, no-store, must-revalidate` và `Pragma: no-cache` trong mọi request outbound tới Graph API. | **RESOLVED** |
| **BUG-04** | **MEDIUM** | Nút bấm Đồng bộ trên Modal không debounce, tạo ra nhiều job đồng bộ song song, thông báo hiển thị `vundefined` | Không vô hiệu hóa nút khi gửi fetch request; code frontend đọc `data.active_version` trong khi API cũ trả về `data.version`. | Thêm disabled + spinner xoay trên nút, cập nhật API trả về cả `version` và `active_version`, dùng Toast thông báo thay cho Alert. | **RESOLVED** |
| **BUG-05** | **MEDIUM** | Người dùng trái phép gọi đồng bộ có thể biến trạng thái tệp của người dùng khác thành `FAILED` (Tenant Leak) | Khối `catch (syncErr)` của `oneDriveSourceService` chạy câu lệnh `UPDATE user_onedrive_sources SET sync_status='FAILED' WHERE id=$1` thiếu điều kiện `owner_user_id`. | Kiểm tra `statusCode !== 404` và bổ sung `WHERE id = $1 AND owner_user_id = $2` trong lệnh cập nhật trạng thái lỗi. | **RESOLVED** |
| **BUG-06** | **LOW** | Modal quản lý OneDrive thiếu badge phân biệt các trạng thái `FAILED`, `STALE`, `DISCONNECTED` | Frontend chỉ có logic màu sắc cho `SYNCED` và `SYNCING`, các trạng thái khác hiển thị màu vàng mặc định. | Cập nhật hàm `renderOneDriveSourcesList` với đầy đủ dải màu: Xanh lá (`SYNCED`), Xanh dương (`SYNCING`), Cam (`STALE`), Đỏ (`FAILED`), Xám (`DISCONNECTED`). | **RESOLVED** |
