# DANH SÁCH SỬA ĐỔI KỸ THUẬT VÀ RATIONALE
**Dự án:** SOTRANS AI Workspace (`D:\hoso-chat`)  
**Mục tiêu:** Khắc phục triệt để lỗi không nhất quán đồng bộ OneDrive và dữ liệu bị chậm cập nhật  
**Ngày thực hiện:** 26/10/2026

---

## 1. TỔNG HỢP CÁC FILE ĐÃ ĐƯỢC CHỈNH SỬA

| File | Module | Bản sao lưu (Backup) | Mục đích sửa đổi |
| :--- | :--- | :--- | :--- |
| `auth-service/services/oneDriveService.js` | Graph API Service | `.bak_20261026_audit_sync` | Bổ sung HTTP headers `Cache-Control: no-cache, no-store, must-revalidate` và `Pragma: no-cache` trong tất cả các request gọi Microsoft Graph API. |
| `auth-service/services/oneDriveSourceService.js` | Source Sync Engine | `.bak_20261026_audit_sync` | Triển khai đối soát mã băm nhị phân SHA-256 (`content_hash`), Smart Flush Polling khi phát hiện chưa commit, ngăn chặn tăng version giả tạo, bảo vệ phân quyền lỗi tenant. |
| `auth-service/routes/agents.js` | Chat Freshness Hook | `.bak_20261026_audit_sync` | Khắc phục lỗi đảo thứ tự ưu tiên: Nạp dữ liệu OneDrive Freshness trước, ngăn chặn `ai_attachments` cũ đè lên dữ liệu sống. |
| `auth-service/routes/onedrive.js` | OneDrive REST API | `.bak_20261026_audit_sync` | Cập nhật phản hồi API đồng bộ trả về đầy đủ `isNewVersion`, `active_version`, `status`, `valid_units` và cung cấp `contentHash` trong danh sách nguồn. |
| `chat/index.html` | Frontend UI / Modal | `.bak_20261026_audit_sync` | Bổ sung Debounce + Spinner trên nút bấm Đồng bộ, hiển thị Toast thông báo trạng thái chính xác (bản mới vs không đổi), render đầy đủ badge FAILED / STALE. |
| Database Schema (PostgreSQL) | Cơ sở dữ liệu | N/A (Không phá hủy) | Thêm các cột `content_hash`, `last_successful_sync_at`, `sync_started_at` vào bảng `public.user_onedrive_sources` và cột `content_hash` vào bảng `public.onedrive_source_snapshots`. |

---

## 2. CHI TIẾT CÁC THAY ĐỔI THEO TỪNG FILE

### 2.1. `auth-service/services/oneDriveService.js`
- **Thay đổi:** Thêm các headers chống cache vào hàm `fetchWithTimeout`:
  ```javascript
  const defaultHeaders = {
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache'
  };
  ```
- **Lý do:** Đảm bảo Microsoft Edge Proxy và CDN không bao giờ trả về HTTP 304 Not Modified hoặc nội dung cũ khi người dùng vừa chỉnh sửa tệp trên OneDrive.

### 2.2. `auth-service/services/oneDriveSourceService.js`
- **Thay đổi 1 (SHA-256 Content Hash & Smart Flush Polling):**
  - Khi tải tệp nhị phân về, tính toán `downloadedHash = crypto.createHash('sha256').update(dl.buffer).digest('hex')`.
  - Nếu `downloadedHash === activeContentHash` và người dùng bấm Đồng bộ (`force === true`): hệ thống tự động thăm dò tối đa 2 lần với backoff 2.5 giây để chờ máy chủ Office 365 flush dữ liệu từ session in-memory xuống storage.
  - Nếu sau các đợt thăm dò nội dung vẫn không đổi: hệ thống **không** tăng phiên bản giả tạo, **không** tạo snapshot rác, cập nhật trạng thái `SYNCED` và trả về `{ isNewVersion: false, version: currentVersion }`.
  - Nếu nội dung khác biệt: tiến hành phân tích qua Universal Engine, lưu Snapshot mới với `content_hash`, tăng phiên bản và trả về `{ isNewVersion: true, version: nextVersion }`.
- **Thay đổi 2 (Bảo vệ Tenant Isolation):**
  - Trong khối bắt lỗi `catch (syncErr)` của `syncSourceVersion`, chỉ cập nhật `sync_status = 'FAILED'` khi người dùng thực sự sở hữu tệp (`owner_user_id = $3`) và mã lỗi không phải là 404/403. Ngăn ngừa việc một người dùng lạ có thể làm hỏng trạng thái tệp của người dùng khác.
- **Thay đổi 3 (Đồng bộ hóa thuộc tính File):**
  - Bổ sung cả `name` lẫn `fileName` trong `activeFiles.push` để đảm bảo tương thích hoàn hảo giữa các module tìm kiếm dữ liệu.

### 2.3. `auth-service/routes/agents.js`
- **Thay đổi:**
  - Nạp toàn bộ danh sách `oneDriveFreshness.activeFiles` và `oneDriveFreshness.activeSpreadsheets` vào ngữ cảnh Agent **trước tiên**.
  - Kiểm tra danh sách tệp đính kèm trong `ai_attachments`: Nếu tên file đính kèm trùng với tên của một nguồn OneDrive đang active, hệ thống tự động bỏ qua attachment cũ đó, tuyệt đối không cho phép ghi đè lên dữ liệu OneDrive mới.

### 2.4. `auth-service/routes/onedrive.js`
- **Thay đổi:**
  - Endpoint `POST /sources/:id/sync`: Chuẩn hóa phản hồi JSON trả về đầy đủ các trường `success`, `message`, `version`, `active_version`, `isNewVersion`, `fileName`, `size`, `status`, `valid_units`.
  - Endpoint `GET /sources`: Trả về bổ sung các trường `contentHash`, `lastSuccessfulSyncAt`, `syncStartedAt` cho giao diện người dùng.

### 2.5. `chat/index.html`
- **Thay đổi:**
  - Cập nhật hàm `syncOneDriveSource(sourceId, btnEl)`: Vô hiệu hóa nút bấm ngay lập tức khi click, hiển thị biểu tượng xoay (spinner) và nhãn "Đang đồng bộ...", chống hiện tượng double-click hoặc spam click.
  - Sử dụng cơ chế `showAppToast` để hiển thị thông báo toast màu xanh (khi có bản mới) hoặc màu xanh dương/info (khi dữ liệu đã là mới nhất), loại bỏ hàm `alert()` gây chặn giao diện.
  - Cập nhật hàm `renderOneDriveSourcesList`: Hỗ trợ hiển thị đầy đủ các badge màu sắc tương ứng với trạng thái: `SYNCED` (xanh lá), `SYNCING` (xanh dương), `STALE` (cam), `FAILED` (đỏ), `DISCONNECTED` (xám).

---

## 3. CAM KẾT KHÔNG PHÁ VỠ HỆ THỐNG CŨ (NON-BREAKING ASSURANCE)

1. **Cơ chế xác thực & Phân quyền:** Giữ nguyên 100% token JWT, luồng Microsoft OAuth 2.0, Microsoft Graph App Registration.
2. **Cấu trúc bảng tính & Universal Engine:** Giữ nguyên thuật toán trích xuất SheetJS, bộ nhận diện địa danh (`removeAccents`, `matchLocationAliases`, `ALIAS_GROUPS`), không làm sai lệch logic tìm kiếm chi phí hoặc đơn vị vận chuyển.
3. **Không xóa dữ liệu:** Không xóa bất kỳ bản ghi bảng tính, bảng lịch sử, vector database hay tài khoản người dùng nào.
