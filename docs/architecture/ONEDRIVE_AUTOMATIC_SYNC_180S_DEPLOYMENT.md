# SOTRANS HUB — BÁO CÁO TRIỂN KHAI TỰ ĐỘNG ĐỒNG BỘ ONEDRIVE MỖI 3 PHÚT (180 GIÂY)

**Task ID:** `ONEDRIVE-AUTO-SYNC-180S-01`  
**Dự án:** `D:\hoso-chat`  
**Hệ thống:** SOTRANS Hub — AI Platform & Logistics Digital Workplace  
**Cơ sở dữ liệu:** PostgreSQL `hrbot`  
**Môi trường:** Production Docker Container `hr-auth` & `hr-gateway`  
**Tài liệu kiểm toán gốc:** [`docs/architecture/ONEDRIVE_CHATBOT_SYNC_AUDIT.md`](file:///d:/hoso-chat/docs/architecture/ONEDRIVE_CHATBOT_SYNC_AUDIT.md)  
**Ngày hoàn tất:** 31/10/2026  
**Commit Hash:** `b24c8ddf5228219e44262f3b5b16a23d9acc84c8`  

---

## I. TỔNG QUAN KIẾN TRÚC & MỤC TIÊU ĐẠT ĐƯỢC

### 1. Kiến trúc Trước vs Sau

```
[KIẾN TRÚC CŨ - BỊ ĐỘNG & THỦ CÔNG]
User upload link / chọn file -> Ingestion -> PostgreSQL (Snapshot) -> Chờ Query hoặc Bấm nút
- Người dùng bắt buộc phải bấm nút "Đồng bộ ngay" hoặc gửi câu hỏi để kích hoạt Freshness Guard.
- File xóa trên OneDrive -> Chatbot vẫn trả lời từ bản snapshot cũ (Lỗi P0).
- Ngắt kết nối OneDrive -> Chỉ xóa token, snapshot vẫn được retrieval (Lỗi P0).
- Không tự động phát hiện file mới thêm vào OneDrive.

                         ⬇ CHUYỂN ĐỔI TOÀN DIỆN ⬇

[KIẾN TRÚC MỚI - TỰ ĐỘNG NỀN MỖI 180 GIÂY (3 PHÚT)]
Microsoft OneDrive Graph API v1.0
   │
   ▼ (Mỗi 180 giây: Delta Query & Metadata Verification)
┌─────────────────────────────────────────────────────────────────────────────┐
│ Background Sync Worker (auth-service/services/oneDriveSyncWorker.js)        │
│ ├─ Distributed Advisory Lock: pg_try_advisory_lock(8492019)                │
│ ├─ Durable State Tracking: public.onedrive_sync_worker_states               │
│ ├─ Microsoft Graph Delta Query (@odata.deltaLink, @odata.nextLink)          │
│ ├─ Watched Folders Support: Tự động phát hiện & Ingestion file mới          │
│ ├─ P0 Remediation: Tự động đánh dấu DELETED_UPSTREAM & gỡ active snapshot   │
│ ├─ P0 Remediation: Disconnect OAuth chuyển DISCONNECTED & hủy retrieval     │
│ └─ Rate Limiting Resilience: HTTP 429 Retry-After & Exponential Backoff     │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼ (Universal Ingestion Pipeline)
┌─────────────────────────────────────────────────────────────────────────────┐
│ Ingestion & Version Engine                                                  │
│ ├─ SHA-256 Binary Hash check (chống tạo snapshot trùng)                    │
│ ├─ Universal Data Understanding Engine (SheetJS, pdf-parse, mammoth)       │
│ ├─ Verification Gate: Kiểm tra tính toàn vẹn cấu trúc dữ liệu              │
│ └─ Atomic Snapshot Publication: STAGING ➔ PUBLISHED (active_version = vN)   │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                   ┌───────────────────┴───────────────────┐
                   ▼                                       ▼
    ┌─────────────────────────────┐         ┌─────────────────────────────┐
    │     Personal AI Agents      │         │         General AI          │
    │  (routes/agents.js)         │         │  (routes/general_ai.js)     │
    │  - Truy xuất snapshot mới   │         │  - Tích hợp OneDrive với    │
    │  - Chặn DISCONNECTED /      │         │    người dùng đã xác thực   │
    │    DELETED_UPSTREAM         │         │  - Cách ly ACL nghiêm ngặt  │
    └─────────────────────────────┘         └─────────────────────────────┘
```

---

## II. CHI TIẾT CÁC THÀNH PHẦN TRIỂN KHAI

### 1. Background Sync Worker (`oneDriveSyncWorker.js`)
* **Chu kỳ vận hành:** 180.000 ms (180 giây = 3 phút), cấu hình qua biến môi trường `ONEDRIVE_AUTO_SYNC_INTERVAL_MS=180000` và `ONEDRIVE_AUTO_SYNC_ENABLED=true`.
* **Khóa phân tán (Distributed Locking):** Sử dụng PostgreSQL Advisory Lock `pg_try_advisory_lock(8492019)`. Trong cụm Docker container hoặc đa tiến trình, chỉ có duy nhất 1 worker instance sở hữu quyền thực thi một chu kỳ tại một thời điểm, tránh race condition.
* **Tự phục hồi sau sự cố (Crash Recovery):** Hàm `recoverStaleJobs()` quét và dọn dẹp các tác vụ bị kẹt ở trạng thái `RUNNING` quá 10 phút, tự động đánh dấu `FAILED` do timeout khi máy chủ hoặc container restart.
* **Lưu vết trạng thái bền vững:** Bảng `public.onedrive_sync_worker_states` lưu trữ `last_heartbeat`, `last_run_started_at`, `last_run_completed_at`, `last_run_status`, `total_runs`, `total_files_polled`, `total_files_updated`, `total_files_deleted`, `total_errors`.

### 2. Cơ chế Microsoft Graph Delta Query & Watched Folders
* **Delta Query:** Hàm `pollDriveDelta({ accessToken, driveId, folderId, deltaLink })` trong `oneDriveService.js`:
  * Phân trang qua `@odata.nextLink` và lưu trữ `@odata.deltaLink` mới nhất vào cột `user_onedrive_sources.delta_link`.
  * Xử lý lỗi `HTTP 410 Gone` (Delta token hết hạn): Đặt cờ `resyncRequired: true` và tự động quét lại từ đầu một cách an toàn.
  * Xử lý `HTTP 429` (Rate Limited): Đọc `Retry-After` header và cập nhật trạng thái `THROTTLED`.
* **Theo dõi thư mục (Watched Folders):**
  * Hỗ trợ đăng ký thư mục theo dõi với `source_type = 'FOLDER'`.
  * Khi xuất hiện file mới (Excel, Word, PDF) trong thư mục theo dõi, worker tự động phát hiện, tải về, trích xuất cấu trúc và xuất bản snapshot v1 gắn liền với thư mục cha (`parent_folder_id`).
  * Khi file bị xóa hoặc có đánh dấu `deleted` facet trong delta, hệ thống tự động gỡ bỏ quyền truy xuất ngay lập tức.

### 3. Khắc phục dứt điểm 2 lỗi P0 từ Audit

#### A. Lỗi P0-1: File bị xóa trên OneDrive upstream (`DELETED_UPSTREAM`)
* **Hiện tượng cũ:** Khi file bị xóa trên OneDrive, Graph API trả về 404 nhưng hệ thống vẫn giữ nguyên `active_snapshot_id`. Chatbot vẫn tiếp tục trả lời từ dữ liệu đã xóa ở chế độ ngoại tuyến.
* **Xử lý mới:**
  * Hàm `handleUpstreamDeletedSource(sourceId, ownerUserId)` lập tức:
    1. Cập nhật `sync_status = 'DELETED_UPSTREAM'`.
    2. Gỡ bỏ `active_snapshot_id = NULL`.
    3. Ghi nhận lỗi `last_error = 'Tệp đã bị xóa trên Microsoft OneDrive upstream'`.
    4. Xóa các bản ghi liên quan trong `ai_attachments` để loại bỏ hoàn toàn khỏi ngữ cảnh lịch sử chat.
  * Bộ lọc truy xuất tại `getConnectedSourcesForAgent` và `routes/general_ai.js` yêu cầu chặt chẽ: `s.sync_status = 'SYNCED' AND s.active_snapshot_id IS NOT NULL AND snp.status = 'PUBLISHED'`, loại bỏ 100% các file đã bị xóa upstream.

#### B. Lỗi P0-2: Ngắt kết nối Microsoft OneDrive (`DISCONNECTED`)
* **Hiện tượng cũ:** Bấm "Ngắt kết nối" chỉ xóa OAuth token trong `user_oauth_tokens`, các file trong `user_onedrive_sources` vẫn giữ trạng thái `SYNCED` và chatbot vẫn trả lời từ bản sao lưu nội bộ.
* **Xử lý mới:**
  * Hàm `disconnectOAuth(userId)` trong `oneDriveService.js`:
    1. Cập nhật toàn bộ file của người dùng sang `sync_status = 'DISCONNECTED'`, `active_snapshot_id = NULL`, `agent_id = NULL`.
    2. Hủy toàn bộ job đang chờ hoặc đang chạy (`status = 'CANCELLED'`).
    3. Xóa các bản ghi đính kèm trong `ai_attachments`.
    4. Xóa token khỏi `user_oauth_tokens`.
    5. Ngừng mọi chu kỳ polling đối với tài khoản đó. Chatbot lập tức từ chối truy xuất dữ liệu từ nguồn đã ngắt kết nối.

### 4. Tích hợp OneDrive cho General AI (Đã xác thực)
* Tại [`auth-service/routes/general_ai.js`](file:///d:/hoso-chat/auth-service/routes/general_ai.js):
  * Đối với người dùng đã đăng nhập, hệ thống tự động kiểm tra các nguồn OneDrive cá nhân có trạng thái `SYNCED` và snapshot `PUBLISHED`.
  * Nạp dữ liệu cấu trúc vào `systemInstruction` kèm ghi chú rõ ràng về tên file, phiên bản (vX) và thời điểm đồng bộ.
  * Bổ sung thông tin nguồn vào mảng `sources` trả về cho giao diện người dùng.
  * **Cách ly dữ liệu (ACL):** Lọc nghiêm ngặt theo `s.owner_user_id = req.user.user_id`. Người dùng không thể truy cập tài liệu OneDrive của người dùng khác. Khách vãng lai (chưa đăng nhập) nhận 0 nguồn OneDrive.

### 5. Giao diện Giám sát & Quản trị Tự động Đồng bộ (UI Telemetry)
* Tại Modal Quản lý OneDrive ([`chat/index.html`](file:///d:/hoso-chat/chat/index.html)):
  * Thẻ trạng thái **"Tự động đồng bộ OneDrive: ĐANG BẬT"** với chu kỳ 3 phút.
  * Hiển thị thời gian thực: *Kiểm tra gần nhất*, *Đồng bộ thành công*, *Kiểm tra tiếp theo*.
  * Số liệu thống kê: *Đang theo dõi*, *Cập nhật gần nhất*, *Đã xóa upstream*, *Lỗi*.
  * Nút hành động **"🔄 Đồng bộ ngay"** cho phép người dùng kích hoạt chu kỳ kiểm tra tức thời khi cần.

---

## III. THAY ĐỔI CƠ SỞ DỮ LIỆU (DATABASE SCHEMA MIGRATION)

Migration script: [`sql/05_onedrive_auto_sync_180s.sql`](file:///d:/hoso-chat/sql/05_onedrive_auto_sync_180s.sql)  
Rollback script: [`sql/rollback_05_onedrive_auto_sync_180s.sql`](file:///d:/hoso-chat/sql/rollback_05_onedrive_auto_sync_180s.sql)

### 1. Bảng `public.user_onedrive_sources` (Bổ sung cột)
* `source_type VARCHAR(50) NOT NULL DEFAULT 'FILE'`: Phân loại tệp (`FILE`) hoặc thư mục (`FOLDER`).
* `parent_folder_id VARCHAR(255)`: ID thư mục cha trên Microsoft Graph.
* `delta_link TEXT`: Lưu trữ `@odata.deltaLink` cho lần quét tiếp theo.
* `last_polled_at TIMESTAMPTZ`: Thời điểm worker kiểm tra gần nhất.
* `next_poll_at TIMESTAMPTZ`: Thời điểm worker dự kiến kiểm tra tiếp theo (+180s).
* `is_watched BOOLEAN NOT NULL DEFAULT TRUE`: Cờ bật/tắt theo dõi tự động.
* `poll_status VARCHAR(50) NOT NULL DEFAULT 'IDLE'`: Trạng thái (`IDLE`, `POLLING`, `DETECTED`, `DOWNLOADING`, `PROCESSING`, `THROTTLED`, `REVOKED`, `ERROR`).
* `poll_error_count INTEGER NOT NULL DEFAULT 0`: Đếm số lần lỗi liên tiếp.
* `retry_after_until TIMESTAMPTZ`: Thời điểm hết hạn Rate Limit theo HTTP 429.

### 2. Bảng `public.onedrive_sync_worker_states` (Tạo mới)
* Theo dõi nhịp tim (`last_heartbeat`), chu kỳ (`interval_ms = 180000`), thời gian thực thi (`last_run_duration_ms`), thống kê tổng hợp (`total_runs`, `total_files_polled`, `total_files_updated`, `total_files_deleted`, `total_errors`) và `stats JSONB`.

---

## IV. KẾT QUẢ KIỂM THỬ 24 KỊCH BẢN BẮT BUỘC (AUTO-01 ĐẾN AUTO-24)

File kiểm thử tự động: [`tests/test_onedrive_auto_sync_180s_suite.js`](file:///d:/hoso-chat/tests/test_onedrive_auto_sync_180s_suite.js)  
Kết quả: **24/24 PASS (100%)**

| STT | Mã Test | Nội dung kiểm thử | Kết quả | Bằng chứng xác minh |
|:---:|:---|:---|:---:|:---|
| 1 | **AUTO-01** | Worker chạy chu kỳ 180 giây | **PASS** | `intervalMs=180000` (180s), `autoSyncEnabled=true` |
| 2 | **AUTO-02** | Người dùng không mở chatbot (Worker vẫn chạy ngầm) | **PASS** | Worker chạy qua node scheduler, `duration=1070ms`, 3 connections |
| 3 | **AUTO-03** | Đăng ký & theo dõi Watched Folder | **PASS** | `source_type=FOLDER`, `is_watched=true`, delta tracking |
| 4 | **AUTO-04** | Sửa file giữ nguyên tên tạo version mới | **PASS** | Tự động tạo snapshot v2, `isNewVersion=true` |
| 5 | **AUTO-05** | File không đổi nội dung - Không tạo snapshot thừa | **PASS** | SHA-256 hash trùng khớp, `isNewVersion=false`, giữ nguyên v2 |
| 6 | **AUTO-06** | Đổi tên file trên OneDrive cập nhật metadata | **PASS** | Cập nhật `file_name` mới, bảo toàn nguyên vẹn `id` nguồn |
| 7 | **AUTO-07** | Di chuyển thư mục - Theo dõi theo Item ID | **PASS** | Microsoft Item ID được duy trì bất biến qua các thư mục |
| 8 | **AUTO-08** | File xóa trên OneDrive đánh dấu DELETED_UPSTREAM | **PASS** | `sync_status=DELETED_UPSTREAM`, `active_snapshot_id=null`, chặn retrieval |
| 9 | **AUTO-09** | Disconnect OneDrive chuyển DISCONNECTED | **PASS** | `sync_status=DISCONNECTED`, hủy toàn bộ quyền truy xuất |
| 10 | **AUTO-10** | Tự động kiểm tra hạn và refresh token | **PASS** | `getUserValidAccessToken` kiểm tra trước 5 phút và refresh an toàn |
| 11 | **AUTO-11** | Xử lý HTTP 429 Rate Limit theo Retry-After | **PASS** | Đọc `Retry-After`, đánh dấu `poll_status = 'THROTTLED'` |
| 12 | **AUTO-12** | Download timeout có kiểm soát & AbortController | **PASS** | Ngắt kết nối sau 30.000ms nếu Microsoft Graph phản hồi chậm |
| 13 | **AUTO-13** | Parse/Download thất bại - Không publish snapshot lỗi | **PASS** | Ingestion lỗi bị đánh dấu `FAILED`, bảo toàn snapshot active cũ |
| 14 | **AUTO-14** | Q&A sau khi cập nhật sử dụng version mới | **PASS** | Chatbot tải bản snapshot mới nhất v2 vào context prompt |
| 15 | **AUTO-15** | Trạng thái SYNCING khi tệp đang xử lý | **PASS** | Cảnh báo hệ thống đang cập nhật tệp, không trả lời giả mạo |
| 16 | **AUTO-16** | Chống xung đột đa worker qua Advisory Lock | **PASS** | Client 1 giữ lock -> Client 2 bị từ chối (`acq=false`) |
| 17 | **AUTO-17** | Restart worker dọn dẹp và khôi phục stale jobs | **PASS** | Các job bị treo quá 10 phút tự động chuyển sang `FAILED` |
| 18 | **AUTO-18** | Cách ly dữ liệu nghiêm ngặt giữa các tài khoản User | **PASS** | User B không thể truy xuất nguồn OneDrive của User A |
| 19 | **AUTO-19** | General AI tích hợp OneDrive cá nhân đã xác thực | **PASS** | Nạp dữ liệu cấu trúc vào context prompt kèm trích dẫn nguồn |
| 20 | **AUTO-20** | Personal AI Agent truy xuất snapshot mới nhất | **PASS** | Agent Excel-Data-Pro nạp chính xác `active_version` |
| 21 | **AUTO-21** | Kiểm tra định dạng và chữ ký tệp không hỗ trợ | **PASS** | Extension whitelist chặn `.exe`, magic bytes chặn fake zip |
| 22 | **AUTO-22** | Delta token HTTP 410 tự động resync từ đầu | **PASS** | Xóa `delta_link` cũ, kích hoạt quét lại từ đầu an toàn |
| 23 | **AUTO-23** | Xử lý khi OAuth token bị revoke từ Microsoft | **PASS** | Nhận diện `invalid_grant`, đánh dấu `REVOKED`, yêu cầu kết nối lại |
| 24 | **AUTO-24** | Kiểm soát phiên bản liên tiếp - Atomic Publication | **PASS** | Chỉ đánh dấu `PUBLISHED` khi các bước phân tích hoàn tất 100% |

---

## V. NHẬT KÝ VẬN HÀNH THỰC TẾ (PRODUCTION CONTAINER LOGS)

Trích xuất log thực tế từ container `hr-auth`:

```
🚀 HR Auth Service running on port 3000
⏱️ Qdrant Sync Service: Đã kích hoạt tiến trình tự động đối soát mỗi 60 phút.
[OneDriveWorker] 🚀 Khởi chạy Background Sync Worker (Chu kỳ: 180 giây)...
[QDRANT RECONCILE] Bắt đầu đối soát và đồng bộ 19 tài liệu...
[QDRANT RECONCILE] Hoàn tất đối soát: 19/19 tài liệu đã đồng bộ chuẩn xác.
[OneDriveWorker] ✅ Hoàn thành chu kỳ đồng bộ (1665ms): 3 kết nối, 2 tệp kiểm tra, 0 tệp mới, 0 cập nhật, 0 xóa, 0 lỗi.
```

Trích xuất telemetry từ API `GET /api/onedrive/sync-status`:

```json
{
  "success": true,
  "worker": {
    "autoSyncEnabled": true,
    "intervalMs": 180000,
    "intervalSeconds": 180,
    "workerInstanceId": "worker_1_6f62c8ae",
    "isCurrentlyRunning": false,
    "lastHeartbeat": "2026-10-31T11:45:04.694Z",
    "lastRunStartedAt": "2026-10-31T11:45:03.031Z",
    "lastRunCompletedAt": "2026-10-31T11:45:04.694Z",
    "lastRunStatus": "COMPLETED",
    "lastRunDurationMs": 1665,
    "totalRuns": 1,
    "totalFilesPolled": 2,
    "totalFilesUpdated": 0,
    "totalFilesDeleted": 0,
    "totalErrors": 0
  }
}
```

Kiểm tra Playwright UI trên trình duyệt:
* Đường dẫn ảnh chụp kiểm chứng: [`screenshots/onedrive_auto_sync_180s_modal.png`](file:///d:/hoso-chat/screenshots/onedrive_auto_sync_180s_modal.png)
* Kết quả: **0 console errors**, modal mở mượt mà, hiển thị nhịp polling chính xác đến từng giây.

---

## VI. DANH SÁCH FILE THAY ĐỔI & BẢNG MÃ NGUỒN LIÊN QUAN

1. [`auth-service/services/oneDriveSyncWorker.js`](file:///d:/hoso-chat/auth-service/services/oneDriveSyncWorker.js): Worker đồng bộ nền 180 giây, distributed lock, recovery.
2. [`auth-service/services/oneDriveService.js`](file:///d:/hoso-chat/auth-service/services/oneDriveService.js): Bổ sung `pollDriveDelta`, `checkItemExistsOrDeleted`, vá lỗi `disconnectOAuth`.
3. [`auth-service/services/oneDriveSourceService.js`](file:///d:/hoso-chat/auth-service/services/oneDriveSourceService.js): Bổ sung `handleUpstreamDeletedSource`, `registerWatchedFolder`, lọc nguồn sạch.
4. [`auth-service/server.js`](file:///d:/hoso-chat/auth-service/server.js): Khởi chạy `startSyncWorker()` lúc boot server.
5. [`auth-service/routes/onedrive.js`](file:///d:/hoso-chat/auth-service/routes/onedrive.js): Bổ sung `GET /sync-status`, `POST /folders/watch`, `POST /sync-all`.
6. [`auth-service/routes/general_ai.js`](file:///d:/hoso-chat/auth-service/routes/general_ai.js): Tích hợp OneDrive retrieval cho người dùng đã xác thực kèm ACL nghiêm ngặt.
7. [`chat/index.html`](file:///d:/hoso-chat/chat/index.html): Bổ sung thẻ Telemetry Auto-Sync 180s, thống kê trạng thái và nút đồng bộ thủ công.
8. [`sql/05_onedrive_auto_sync_180s.sql`](file:///d:/hoso-chat/sql/05_onedrive_auto_sync_180s.sql): DDL migration additive.
9. [`tests/test_onedrive_auto_sync_180s_suite.js`](file:///d:/hoso-chat/tests/test_onedrive_auto_sync_180s_suite.js): Bộ 24 test kiểm thử tự động.
