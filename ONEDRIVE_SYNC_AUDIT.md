# KIỂM TOÁN HỆ THỐNG ĐỒNG BỘ DỮ LIỆU ONEDRIVE & REAL-TIME REFRESH
**Dự án:** SOTRANS AI Workspace (`D:\hoso-chat`)  
**Tác nhân bị ảnh hưởng:** Personal AI Agents / `Excel-Data-Pro`  
**Tệp dữ liệu kiểm toán:** `testdulieu.xlsx`, `Pricing Vendor.xlsx`  
**Thời điểm thực hiện:** 26/10/2026  
**Trạng thái kiểm toán:** HOÀN THÀNH — ĐÃ XÁC ĐỊNH & KIỂM CHỨNG TOÀN BỘ NGUYÊN NHÂN GỐC

---

## 1. SƠ ĐỒ KIẾN TRÚC TOÀN BỘ PIPELINE ĐỒNG BỘ DỮ LIỆU

Dữ liệu di chuyển từ tài khoản Microsoft OneDrive của người dùng tới câu trả lời của Personal AI Agent thông qua 7 tầng sau:

```
[1. Microsoft OneDrive / Excel Online]
         │ (Tự động lưu / Flush session ngầm từ 10-30s)
         ▼
[2. Microsoft Graph API & CDN Edge Cache]
         │ GET /me/drive/items/{id} hoặc /shares/{token}/driveItem
         │ GET /content (Follow HTTP 302 chuyển hướng tới CDN Storage download)
         ▼
[3. Auth Service - oneDriveService & oneDriveSourceService]
         │ HTTP Fetch with 'Cache-Control: no-cache, no-store, must-revalidate'
         │ Concurrency Mutex Lock theo sourceId (Deduplicate)
         │ Tính toán SHA-256 Content Hash của luồng nhị phân vừa tải
         │ So sánh Content Hash với Active Snapshot gần nhất
         │ Smart Flush Polling (Backoff 2.5s) nếu phát hiện hash chưa đổi
         ▼
[4. Universal Data Understanding Engine]
         │ parseUniversalFile: SheetJS parsing, lọc header, nhận diện kiểu cột
         │ formatUniversalPromptContext: Cấu trúc hóa prompt metadata
         │ Tính toán tổng dòng hợp lệ (validUnits / totalUnits)
         ▼
[5. PostgreSQL Registry & Immutable Snapshots]
         │ public.user_onedrive_sources (Metadata, active_version, content_hash)
         │ public.onedrive_source_snapshots (Lưu trữ profile JSON, manifest, disk_path)
         │ public.onedrive_sync_jobs (Audit trail lịch sử đồng bộ)
         ▼
[6. Platform-Level Query-Time Freshness Guard]
         │ routes/agents.js & ensureAgentSourcesFreshness:
         │ Đối soát độ mới trước mọi câu hỏi của người dùng
         │ Cung cấp dữ liệu trực tiếp vào activeSpreadsheets & activeFiles
         │ Triệt tiêu hoàn toàn lỗi đảo thứ tự ưu tiên (Priority Inversion)
         ▼
[7. Dynamic Data Retrieval & AI Reasoning]
         │ dataEngine.js & universalDataEngine.js:
         │ Tìm kiếm chính xác trên bảng tính theo Tuyến, Chi phí, Loại cont, Đơn/Ghép
         │ Zero Hallucination: Không bao giờ trả về dòng đã xóa
```

---

## 2. BẢN ĐỒ LƯU TRỮ VÀ VỊ TRÍ ĐỌC DỮ LIỆU

Trong toàn bộ vòng đời, dữ liệu tệp bảng tính được quản lý và đọc tại các vị trí xác định:

| Tầng lưu trữ | Công nghệ | Dữ liệu được lưu | Cách đọc dữ liệu |
| :--- | :--- | :--- | :--- |
| **Bản gốc (Upstream)** | Microsoft OneDrive | File `.xlsx` người dùng chỉnh sửa | Gọi Microsoft Graph API tải trực tuyến khi có yêu cầu đồng bộ hoặc khi Freshness Guard phát hiện lệch cTag/eTag. |
| **Bản chụp nhị phân (Disk Snapshot)** | File System (`/uploads`) | File gốc `.xlsx` từng phiên bản | Được lưu tại `src_{sourceId}_v{ver}_{uuid}_{filename}` làm căn cứ đối soát nhị phân an toàn. |
| **Hồ sơ cấu trúc (Data Profile)** | PostgreSQL (`onedrive_source_snapshots`) | JSON trích xuất: `sheetNames`, `columns`, `validDataRows`, toàn bộ các dòng `rows` dữ liệu đã chuẩn hóa | Agent đọc trực tiếp từ `active_snapshot` của nguồn kết nối. Agent **không** sử dụng vector embedding Qdrant cho bảng tính Excel; Qdrant chỉ dùng riêng cho văn bản chính sách (`/api/documents`). |
| **Chỉ mục bộ nhớ đệm (Query Context)** | Runtime Memory | Cấu trúc `activeFiles` và `activeSpreadsheets` được nạp vào ngữ cảnh Agent | Nạp động tại mỗi lượt hội thoại bởi `ensureAgentSourcesFreshness()`. |

---

## 3. NGUYÊN NHÂN GỐC ĐÃ ĐƯỢC XÁC MINH BẰNG DỮ LIỆU THỰC TẾ

### Nguyên nhân 1: Tăng phiên bản giả tạo và báo "SYNCED" khi tệp chưa đổi trên máy chủ OneDrive
- **Bằng chứng kiểm toán:** Kiểm tra bảng `onedrive_sync_jobs` và `onedrive_source_snapshots` của tệp `testdulieu.xlsx` (ID: `b58446c8-440d-4d69-af87-f0dd867f2cae`) cho thấy trong vòng **12 giây**, hệ thống đã tạo liên tiếp các phiên bản v6, v7, v8 với cùng một eTag `{F82143A3-4629-40B2-A3BA-031C26AAADE3},14` và cùng 14 dòng dữ liệu. Đến lần bấm thứ 4 (v9), eTag mới nhảy sang `,15` với 13 dòng.
- **Cơ chế lỗi:** Khi người dùng vừa chỉnh sửa trên Excel Online (Office for the Web), Microsoft chỉ lưu tạm trên bộ nhớ đệm phiên làm việc (Session cache) và cần 10–30 giây để flush xuống storage của OneDrive. Code cũ không đối soát mã băm nhị phân, cứ mỗi lần người dùng bấm nút "Đồng bộ" là lập tức tăng `active_version` (v6 -> v7 -> v8), tạo snapshot trùng lặp và báo thành công. Người dùng hỏi Chatbot thấy vẫn ra kết quả cũ nên bấm liên tục 4–5 lần cho đến khi OneDrive thực sự flush.

### Nguyên nhân 2: Thiếu HTTP Cache-Control trong các lệnh gọi Microsoft Graph API
- **Bằng chứng kiểm toán:** Trong `oneDriveService.js`, các hàm `downloadDriveItem`, `resolveAndDownloadSharedItem`, `fetchWithTimeout` chỉ truyền `Authorization` và `Accept`.
- **Cơ chế lỗi:** Microsoft Graph API và các CDN Edge Proxies (`1drv.ms`, SharePoint Edge CDN) tự động trả về phản hồi cached 304 hoặc nội dung cached của URL tải xuống nếu request không chỉ định rõ `Cache-Control: no-cache, no-store, must-revalidate` và `Pragma: no-cache`.

### Nguyên nhân 3: Đảo lộn thứ tự ưu tiên (Priority Inversion) giữa `ai_attachments` và OneDrive Snapshot
- **Bằng chứng kiểm toán:** Trong `routes/agents.js` (dòng 808–864), khi hội thoại đã có lịch sử đính kèm một file cùng tên (`testdulieu.xlsx` hoặc `Pricing Vendor.xlsx`), hệ thống đọc danh sách file từ bảng `ai_attachments` trước và nạp đường dẫn lưu trữ cục bộ cũ của attachment đó vào `activeSpreadsheets`, đồng thời ghi đè lên snapshot mới nhất từ OneDrive!
- **Hậu quả:** Dù OneDrive đã đồng bộ phiên bản mới, Agent vẫn ưu tiên nạp file đính kèm cũ từ hội thoại trước đó.

### Nguyên nhân 4: Giao diện người dùng thiếu Debounce và Alert hiển thị sai phiên bản (`vundefined`)
- **Bằng chứng kiểm toán:** Trong `chat/index.html` (hàm `syncOneDriveSource`), nút "Đồng bộ" không bị disable khi đang chạy, cho phép người dùng click 3–4 lần liên tiếp tạo ra các job song song. Đồng thời dòng thông báo `alert('...v' + data.active_version)` bị hiển thị `vundefined` do backend trả về trường `version` thay vì `active_version`.

### Nguyên nhân 5: Rò rỉ quyền hạn (Tenant Boundary Leak) khi xử lý lỗi đồng bộ
- **Bằng chứng kiểm toán:** Trong khối `catch (syncErr)` của `oneDriveSourceService.syncSourceVersion`, câu lệnh `UPDATE public.user_onedrive_sources SET sync_status = 'FAILED' WHERE id = $1` không kiểm tra `owner_user_id`. Khi một user không có quyền gọi đồng bộ, hệ thống đánh dấu nguồn của chủ sở hữu hợp pháp sang trạng thái `FAILED`.
