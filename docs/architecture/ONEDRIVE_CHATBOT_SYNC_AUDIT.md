# BÁO CÁO KIỂM TOÁN HỆ THỐNG KẾT NỐI ONEDRIVE & ĐỒNG BỘ DỮ LIỆU CHATBOT (RAG / QDRANT)

**Mã Kiểm toán:** `ONEDRIVE-RAG-SYNC-AUDIT-01`  
**Dự án:** SOTRANS Hub — Logistics AI Platform (`D:\hoso-chat`)  
**Hệ thống:** SOTRANS Hub — General AI / Personal AI Agents / Qdrant RAG  
**Nguồn dữ liệu:** Microsoft OneDrive (Graph API v1.0)  
**Phạm vi:** READ-ONLY AUDIT — BẢO TOÀN NGUYÊN TRẠNG MÃ NGUỒN VÀ DỮ LIỆU PRODUCTION  
**Ngày thực hiện:** 31/10/2026  
**Chuyên gia kiểm toán:** Senior AI Platform & Data Infrastructure Engineer

---

## I. TỔNG QUAN KẾT QUẢ KIỂM TOÁN VÀ KẾT LUẬN CỐT LÕI

Qua quá trình rà soát toàn diện mã nguồn, cơ sở dữ liệu thực tế (`hrbot`), chỉ mục Qdrant và các luồng xử lý dữ liệu, nhóm kiểm toán xác định **9 câu trả lời mấu chốt** cho các câu hỏi của Hội đồng Quản trị & Kỹ thuật:

| STT | Câu hỏi kiểm toán | Kết quả xác minh thực tế từ hệ thống |
| :---: | :--- | :--- |
| **1** | **Lấy danh sách file khi kết nối OneDrive bằng cách nào?** | Gọi Microsoft Graph API endpoint `/v1.0/me/drive/root/children` hoặc `/v1.0/me/drive/items/{folderId}/children` với phân trang `$top=20`, lọc theo phần mở rộng cho phép (`.xlsx, .xls, .csv, .docx, .pdf`) và dung lượng tối đa 20MB. |
| **2** | **Thêm file mới vào OneDrive, SOTRANS Hub có tự động phát hiện không?** | **HOÀN TOÀN KHÔNG.** Hệ thống **không có background worker polling** và bảng `onedrive_graph_subscriptions` có **0 bản ghi** (không có Webhook subscription). File mới chỉ được phát hiện khi người dùng mở File Picker bấm nhập hoặc dán liên kết chia sẻ vào chat. |
| **3** | **File sửa đổi nội dung, hệ thống có nhận diện phiên bản mới không?** | **CÓ, NHƯNG CHỈ TẠI THỜI ĐIỂM QUERY HOẶC BẤM NÚT.** Hệ thống áp dụng cơ chế *Query-Time Freshness Guard*: khi người dùng gửi câu hỏi, hệ thống gọi Graph API so sánh `cTag`, `eTag`, `lastModifiedDateTime`. Nếu khác, tự động kích hoạt tải và tăng phiên bản `v(N+1)`. |
| **4** | **File mới/cập nhật được tải, trích xuất, chia nhỏ và đưa vào RAG thế nào?** | File được tải qua stream (giới hạn 20MB), lưu tại `auth-service/data/uploads/src_{sourceId}_v{ver}_{uuid}_{name}`, sau đó phân tích qua `Universal Data Understanding Engine` (SheetJS / pdf-parse / mammoth) tạo thành cấu trúc JSON `data_profile` và chuỗi `prompt_context`. **KHÔNG chia nhỏ thành các text chunk RAG.** |
| **5** | **Embeddings có được tạo lại và cập nhật vào Qdrant không?** | **KHÔNG HỀ TỒN TẠI.** Đây là phát hiện kiến trúc quan trọng nhất: **OneDrive hoàn toàn không sinh embedding vector và không lưu vào Qdrant.** Qdrant collection `hr_docs` chỉ dùng riêng cho văn bản Quy chế/Chính sách pháp quy nội bộ (`/api/documents`). Dữ liệu OneDrive được nạp trực tiếp dưới dạng bảng tính cấu trúc JSON vào ngữ cảnh mô hình ngôn ngữ (LLM Context Window). |
| **6** | **Chatbot dùng dữ liệu OneDrive mới nhất hay dữ liệu cũ từ trước?** | - **Personal AI Agents (`routes/agents.js`):** Kiểm tra độ mới trước khi trả lời. Nếu Microsoft Graph đã commit tệp, hệ thống nạp snapshot mới nhất. Nếu Microsoft đang giữ trong cache RAM (Excel Online trễ 10–30s) hoặc phiên hết hạn, hệ thống dùng snapshot đã lưu gần nhất trong PostgreSQL.<br>- **General AI (`routes/general_ai.js`):** **HOÀN TOÀN KHÔNG KẾT NỐI ONEDRIVE.** |
| **7** | **Khi hỏi thông tin trong file OneDrive, hệ thống truy xuất tài liệu/phiên bản nào?** | Hệ thống truy xuất snapshot có trạng thái `PUBLISHED` gắn với `user_onedrive_sources.active_snapshot_id`. Với file Excel, `dataEngine.js` thực hiện tra cứu chính xác theo dòng/cột. |
| **8** | **Khi OneDrive bị ngắt kết nối, hệ thống có tiếp tục truy xuất dữ liệu cũ không?** | **CÓ (LỖI NGHIÊM TRỌNG P0).** Hàm `oneDriveService.disconnectOAuth` chỉ xóa token trong `user_oauth_tokens`, nhưng **không cập nhật** `user_onedrive_sources` sang `DISCONNECTED`. Chatbot chuyển sang chế độ "Ngoại tuyến" và **vẫn tiếp tục dùng dữ liệu cũ trong snapshot để trả lời**. |
| **9** | **Khi file bị xóa, đổi tên, di chuyển trên OneDrive, SOTRANS Hub xử lý thế nào?** | - **Đổi tên:** Giữ nguyên `item_id`, cập nhật tên mới vào bản ghi nguồn, không nhân đôi.<br>- **Di chuyển:** Cùng ổ đĩa thì `item_id` giữ nguyên; sang ổ khác báo lỗi 404.<br>- **Bị xóa (LỖI P0):** Graph API trả về 404, hệ thống đánh dấu `sync_status = 'FAILED'` nhưng **vẫn giữ nguyên `active_snapshot_id`**. Chatbot tiếp tục trả lời từ dữ liệu của file đã xóa. |

---

## II. KIẾN TRÚC KẾT NỐI ONEDRIVE HIỆN TẠI

### 1. Phân loại Tài khoản và Dịch vụ Microsoft
- **Loại tài khoản kết nối thực tế:** Microsoft OneDrive Cá nhân (Personal Microsoft Account).
  - Dữ liệu thực tế tại bảng `public.user_oauth_tokens` ghi nhận `account_id = 'd629852830f61364'` của tài khoản cá nhân `duongminhduc196873@gmail.com`.
  - Cấu hình `tenantId`: Mặc định là `common` (hoặc `consumers`). Hệ thống **chưa hỗ trợ SharePoint Document Library** cấp doanh nghiệp (Tenant-wide SharePoint Sites).
- **Cơ chế xác định danh tính:**
  - Định danh qua cặp `(user_id, provider = 'microsoft')` trong cơ sở dữ liệu `hrbot`.
  - Mỗi người dùng SOTRANS Hub chỉ liên kết tối đa 1 tài khoản Microsoft tại một thời điểm (`ON CONFLICT (user_id, provider) DO UPDATE`).

### 2. Quản lý Token & Mã hóa An toàn
- **Lưu trữ Token:** Bảng `public.user_oauth_tokens` với các trường:
  - `encrypted_access_token`
  - `encrypted_refresh_token`
  - `token_expires_at`
  - `scope`
- **Chuẩn mã hóa:** Sử dụng thuật toán chuẩn **AES-256-GCM** (tại `auth-service/services/tokenEncryption.js`):
  - Khóa mã hóa 256-bit lấy từ `OAUTH_TOKEN_ENCRYPTION_KEY` (hoặc băm SHA-256 từ `JWT_SECRET + salt`).
  - Mỗi token được mã hóa với IV ngẫu nhiên 12 bytes (`crypto.randomBytes(12)`) và lưu kèm Auth Tag xác thực toàn vẹn: `ivHex:tagHex:encryptedHex`.
  - Không bao giờ lưu token thô dưới dạng plain-text trong database.
- **Cơ chế Tự động Làm mới (Token Refresh):**
  - Hàm `getUserValidAccessToken(userId)` tại `oneDriveService.js` (dòng 230–280).
  - Hệ thống kiểm tra trước thời hạn hết hạn **5 phút** (`expiresAt - now > 5 * 60 * 1000`). Nếu sắp hết hạn hoặc đã hết hạn, tự động gọi Microsoft OAuth Token endpoint với `grant_type: 'refresh_token'`, giải mã refresh token trong RAM, nhận access token mới, mã hóa lại và cập nhật vào PostgreSQL.

### 3. Microsoft Graph API Permissions (Scopes)
Cấu hình yêu cầu quyền tối thiểu (Least Privilege):
- `offline_access`: Cho phép nhận Refresh Token để duy trì kết nối nền.
- `User.Read`: Đọc thông tin hồ sơ cơ bản (Email, Tên hiển thị) để gắn nhãn tài khoản.
- `Files.Read`: Đọc các tệp cá nhân và tệp được chia sẻ cho người dùng.
- **Không yêu cầu:** `Files.ReadWrite`, `Files.Read.All` (không có quyền ghi, không có quyền quản trị toàn tenant).

### 4. Vị trí thực thi Connector
- 100% các cuộc gọi Microsoft Graph API, xác thực OAuth, tải file và phân tích nội dung được thực thi tại **Backend (Node.js Service trong Docker)**.
- Frontend (`chat/index.html`) chỉ đóng vai trò giao diện hiển thị danh sách (File Picker Modal) và nhận sự kiện qua `BroadcastChannel('ms_oauth_channel')`. Không có API token nào bị lộ ra ngoài trình duyệt của người dùng.

---

## III. SƠ ĐỒ ĐỐI CHIẾU LUỒNG DỮ LIỆU: KỲ VỌNG VS THỰC TẾ

```
[KIẾN TRÚC KỲ VỌNG TRONG ĐẶT HÀNG]
Microsoft OneDrive ──> Graph API ──> Download ──> Text Chunking ──> Embedding (bge-m3) ──> Qdrant Vector DB ──> RAG Retrieval ──> Chatbot

                                                       VS

[KIẾN TRÚC THỰC TẾ TRONG CODEBASE]
Microsoft OneDrive
       │
       ▼ (Graph API v1.0 GET /content - Stream Limit 20MB)
Auth Service (oneDriveService.js)
       │
       ▼ (Lưu file nhị phân vào đĩa: /uploads/src_{id}_v{ver}_{uuid}_{name})
Universal Data Understanding Engine (universalDataEngine.js)
       │
       ├── Excel / CSV (.xlsx, .xls, .csv) ──> SheetJS (dataEngine.js) ──> Cấu trúc JSON (Worksheets, Headers, Data Rows)
       ├── Word (.docx)                    ──> Mammoth                  ──> Trích xuất Text/Markdown
       └── PDF (.pdf)                      ──> pdf-parse                ──> Trích xuất Text/Trang
       │
       ▼ (Tạo Snapshot bất biến v1, v2, v3... - Gắn SHA-256 Content Hash)
PostgreSQL Registry (user_onedrive_sources & onedrive_source_snapshots)
       │
       ▼ (Query-Time Freshness Guard đối soát cTag/eTag trước mỗi lượt hỏi)
Personal AI Agents (routes/agents.js)
       │
       ├── dataEngine.searchStructuredSpreadsheet (Tra cứu chính xác số liệu bảng tính theo dòng/cột)
       └── Format Universal Prompt Context (Đưa dữ liệu vào Context Window của LLM)
       │
       ▼
Google Gemini LLM Answer + Cảnh báo độ mới nguồn dữ liệu (Freshness Note)
```

> [!IMPORTANT]
> **KẾT LUẬN VỀ RAG & QDRANT:**  
> Hệ thống SOTRANS Hub **KHÔNG sử dụng RAG Vector / Qdrant cho OneDrive**. Toàn bộ dữ liệu OneDrive được quản lý bằng cơ chế **Structured Snapshot Engine** lưu trong PostgreSQL. Đây là nguyên nhân khiến mọi câu hỏi liên quan đến chunking vector, bge-m3 embedding và Qdrant collection đối với OneDrive đều không khớp với thiết kế hiện hữu của hệ thống.

---

## IV. ĐIỀU TRA BA VẤN ĐỀ VẬN HÀNH ĐÃ PHÁT SINH

### VẤN ĐỀ 1: File mới cập nhật trên OneDrive nhưng chatbot không tìm thấy số liệu mới

#### 1. Bằng chứng mã nguồn
- `auth-service/services/oneDriveSourceService.js` (dòng 230–280, hàm `checkSourceFreshness`).
- `auth-service/services/oneDriveSourceService.js` (dòng 400–460, hàm `syncSourceVersion`).
- `auth-service/services/oneDriveService.js` (dòng 65–85, hàm `fetchWithTimeout`).

#### 2. Nguyên nhân gốc (Root Cause)
Có **3 mắt xích** dẫn đến hiện tượng này:
1. **Độ trễ commit của Microsoft Office Online (Office for the Web):**  
   Khi người dùng chỉnh sửa file Excel/Word trực tiếp trên trình duyệt, Microsoft lưu tạm trên RAM phiên làm việc (Co-authoring Session Cache). Quá trình flush dữ liệu xuống bộ lưu trữ vật lý của OneDrive mất từ **10 đến 45 giây**. Nếu người dùng vừa gõ xong và lập tức quay sang hỏi Chatbot, Microsoft Graph API vẫn trả về `cTag` và `eTag` của phiên bản cũ. Hệ thống kiểm tra thấy `meta.cTag === source.ctag` nên kết luận file "vẫn mới" và không đồng bộ.
2. **Microsoft Graph CDN Caching:**  
   Trước ngày 26/10, các lệnh gọi Graph API thiếu header `Cache-Control: no-cache, no-store`. Các CDN Edge Proxies của Microsoft trả về phản hồi 304 Not Modified hoặc nội dung cũ. (Đã được bổ sung `Cache-Control` trong đợt vá trước).
3. **Người dùng hỏi trên General AI thay vì Personal AI Agent:**  
   Người dùng mở kênh **General AI 3.1** để hỏi dữ liệu OneDrive. Do General AI hoàn toàn không có module liên kết OneDrive nên không thể đọc được file.

---

### VẤN ĐỀ 2: OneDrive hiển thị "Connected" nhưng danh sách file trong File Picker bị trống

#### 1. Bằng chứng mã nguồn
- `auth-service/routes/onedrive.js` (dòng 48–145, endpoint `GET /api/onedrive/files`).
- `auth-service/services/oneDriveService.js` (dòng 420–510, hàm `listDriveItems`).
- `chat/index.html` (dòng 532500–535000, hàm `renderOneDrivePickerItems`).

#### 2. Nguyên nhân gốc (Root Cause)
Trạng thái "Connected" và khả năng đọc file là **2 tầng logic hoàn toàn tách biệt**:
- **Trạng thái "Connected":** Chỉ phản ánh rằng bảng `public.user_oauth_tokens` đang có 1 dòng ghi nhận token của người dùng (kiểm tra qua `GET /api/auth/microsoft/status`).
- **Danh sách file bị trống (`odPickerItems.length === 0`):**
  1. **Tệp nằm trong thư mục con:** Hàm `listDriveItems` mặc định gọi `/me/drive/root/children`. Nếu toàn bộ file của người dùng nằm trong các thư mục (như `Documents`, `Báo cáo`, `Kho vận`), thư mục gốc `root` chỉ có các folder mà không có file lẻ. Nếu người dùng không click mở folder con, danh sách file hiển thị trống.
  2. **Tệp được người khác chia sẻ ("Shared with me"):** Endpoint `/me/drive/root/children` **chỉ đọc tệp do chính user đó sở hữu trong My Files**. Nếu tệp do đồng nghiệp chia sẻ qua link hoặc qua thư mục dùng chung, Graph API của My Drive trả về danh sách rỗng. Để thấy tệp chia sẻ, Microsoft Graph bắt buộc phải dùng endpoint `/me/drive/sharedWithMe` (chưa được cài đặt).
  3. **Bộ lọc phần mở rộng (Extension Filter):** File Picker kiểm tra `SUPPORTED_EXTENSIONS = ['.xlsx', '.xls', '.csv', '.docx', '.pdf']`. Nếu trong thư mục chỉ chứa file định dạng khác (`.zip`, `.jpg`, `.rar`, `.pptx`), danh sách không có file hợp lệ nào để chọn.

---

### VẤN ĐỀ 3: Ngắt kết nối OneDrive nhưng chatbot vẫn tiếp tục trả lời dữ liệu cũ

#### 1. Bằng chứng mã nguồn
- `auth-service/services/oneDriveService.js` (dòng 345–355, hàm `disconnectOAuth`).
- `auth-service/services/oneDriveSourceService.js` (dòng 155–215, hàm `getConnectedSourcesForAgent`).
- `auth-service/services/oneDriveSourceService.js` (dòng 540–580, hàm `ensureAgentSourcesFreshness`).

#### 2. Bằng chứng kiểm tra thực tế
Kiểm tra mã nguồn hàm `disconnectOAuth`:
```javascript
async function disconnectOAuth(userId) {
  await db.query(
    `DELETE FROM public.user_oauth_tokens WHERE user_id = $1 AND provider = 'microsoft'`,
    [userId]
  );
  return { success: true };
}
```
Và câu lệnh truy vấn trong `getConnectedSourcesForAgent`:
```sql
SELECT s.*, snp.data_profile, snp.prompt_context
FROM public.user_onedrive_sources s
LEFT JOIN public.onedrive_source_snapshots snp ON s.active_snapshot_id = snp.id
WHERE s.owner_user_id = $1 AND s.sync_status != 'DISCONNECTED'
```

#### 3. Nguyên nhân gốc (Root Cause)
1. **Thiếu cập nhật trạng thái nguồn:** Khi người dùng bấm "Ngắt kết nối Microsoft", hệ thống chỉ xóa dòng token trong bảng `user_oauth_tokens`. Bảng `user_onedrive_sources` **vẫn giữ nguyên trạng thái `sync_status = 'SYNCED'`** và `active_snapshot_id` vẫn trỏ tới bản snapshot đã lưu.
2. **Cơ chế Fallback ngoại tuyến tự động kích hoạt:** Khi người dùng gửi tin nhắn tiếp theo, `ensureAgentSourcesFreshness` cố gắng lấy access token nhưng thất bại. Thay vì từ chối truy xuất, hệ thống kích hoạt nhánh:
   ```text
   isOffline = true;
   freshnessNotes.push('⚠️ [CẢNH BÁO ONEDRIVE NGOẠI TUYẾN]: Hệ thống đang sử dụng bản sao lưu nội bộ...');
   ```
   Hệ thống nạp toàn bộ snapshot cũ từ PostgreSQL vào `activeFiles` và `activeSpreadsheets`, cho phép AI tiếp tục trả lời dựa trên file đã ngắt kết nối.
3. **Tồn lưu trong bảng `ai_attachments`:** Nếu trong phiên hội thoại trước đó tệp từng được đính kèm, câu lệnh tải lịch sử trong `routes/agents.js` có thể nạp lại nếu không được đánh dấu nguồn gốc chính xác.

---

## V. MA TRẬN ĐÁNH GIÁ 18 KỊCH BẢN KIỂM TOÁN (OD-01 ĐẾN OD-18)

| Mã ID | Kịch bản kiểm toán | Trạng thái thực tế | Đánh giá & Bằng chứng xác minh | Phân loại |
| :---: | :--- | :---: | :--- | :---: |
| **OD-01** | Kết nối OneDrive hợp lệ | **ĐẠT (PASS)** | Lưu `user_oauth_tokens` an toàn, xác định đúng email và Account ID qua Microsoft Graph `/me`. | `Verified` |
| **OD-02** | Liệt kê file và phân trang | **ĐẠT (PASS)** | `listDriveItems` xử lý phân trang `$skiptoken`, giới hạn `$top=20`, duyệt cây thư mục an toàn. | `Verified` |
| **OD-03** | Phát hiện file mới trên OneDrive | **LỖI (DEFECT)** | Không có Webhook ngầm (`onedrive_graph_subscriptions` = 0). File mới không tự động vào hệ thống nếu user không chủ động thao tác. | **P1** |
| **OD-04** | Phát hiện file sửa đổi nội dung | **ĐẠT (PASS)** | `checkSourceFreshness` đối soát `cTag`, `eTag`, `lastModifiedDateTime` tại Query-Time và Manual Sync. | `Verified` |
| **OD-05** | File không đổi - Chống nhân đôi | **ĐẠT (PASS)** | Tính mã băm SHA-256 nhị phân. Nếu hash trùng `activeContentHash`, giữ nguyên phiên bản, không sinh snapshot rác. | `Verified` |
| **OD-06** | File đổi tên trên OneDrive | **ĐẠT (PASS)** | Phân giải theo `item_id` bất biến của Microsoft Graph. Tên mới được ghi đè vào bản ghi nguồn hiện tại. | `Verified` |
| **OD-07** | File di chuyển thư mục | **ĐẠT (PASS)** | Trong cùng Drive cá nhân, `item_id` không đổi; `downloadDriveItem` tự động phân giải lại đường dẫn mới. | `Verified` |
| **OD-08** | File bị xóa trên OneDrive | **LỖI (DEFECT)** | Graph trả về HTTP 404, hệ thống set `sync_status = 'FAILED'` nhưng bảo toàn snapshot cũ; Chatbot vẫn trả lời từ file đã xóa. | **P0** |
| **OD-09** | Download thất bại - Ghi log lỗi | **ĐẠT (PASS)** | Ghi nhận lỗi vào `onedrive_sync_jobs` với trạng thái `FAILED` kèm thông điệp chi tiết; hỗ trợ retry. | `Verified` |
| **OD-10** | Tạo RAG Embeddings (bge-m3) | **LỆCH KIẾN TRÚC** | Hệ thống **không dùng embedding** cho OneDrive. Dữ liệu trích xuất cấu trúc trực tiếp qua SheetJS. | `Arch` |
| **OD-11** | Cập nhật Vector vào Qdrant | **LỆCH KIẾN TRÚC** | Qdrant `hr_docs` chỉ phục vụ văn bản pháp quy nội bộ, hoàn toàn không lưu trữ vector của OneDrive. | `Arch` |
| **OD-12** | Truy vấn nội dung file mới nạp | **ĐẠT (PASS)** | Nạp thành công snapshot v1 vào ngữ cảnh Personal AI Agent; `dataEngine` truy vấn chính xác bảng tính. | `Verified` |
| **OD-13** | Truy vấn nội dung file đã sửa đổi | **ĐẠT (PASS)** | Khi Graph đã commit eTag mới, hệ thống tự động tải v(N+1) trước khi trả lời; không dùng dữ liệu cũ. | `Verified` |
| **OD-14** | Ngắt kết nối OneDrive (Disconnect) | **LỖI (DEFECT)** | `disconnectOAuth` không đổi trạng thái nguồn; chatbot chuyển sang chế độ ngoại tuyến và vẫn dùng snapshot cũ. | **P0** |
| **OD-15** | Token hết hạn tự động làm mới | **ĐẠT (PASS)** | `getUserValidAccessToken` tự động gọi refresh token trước 5 phút hết hạn; mã hóa lại AES-256-GCM. | `Verified` |
| **OD-16** | Phân quyền & Cách ly dữ liệu | **ĐẠT (PASS)** | Lọc nghiêm ngặt theo `owner_user_id` tại cấp database SQL; không có tình trạng user này đọc file của user khác. | `Verified` |
| **OD-17** | Connected nhưng listing lỗi | **ĐẠT (PASS)** | Phân biệt rõ lỗi token (401), lỗi thư mục (404) và trạng thái kết nối; không báo file đã sync nếu chưa tải. | `Verified` |
| **OD-18** | Concurrency Lock & Idempotency | **ĐẠT (PASS)** | In-memory Mutex Map theo `sourceId` và `idempotency_key` ngăn chặn hoàn toàn tình trạng chạy đồng thời sinh tệp trùng. | `Verified` |

---

## VI. BẢNG TỔNG HỢP LỖI PHÁT HIỆN & PHÂN LOẠI MỨC ĐỘ

| Mã lỗi | Mức độ | Tên lỗi | Mô tả chi tiết | Vị trí mã nguồn |
| :---: | :---: | :--- | :--- | :--- |
| **BUG-OD-01** | **P0** | **Rò rỉ dữ liệu sau khi ngắt kết nối Account** | Hàm `disconnectOAuth` chỉ xóa dòng token trong `user_oauth_tokens`. Bảng `user_onedrive_sources` vẫn giữ `sync_status = 'SYNCED'`. Chatbot tự động chuyển sang chế độ offline và tiếp tục trả lời từ dữ liệu cũ. | `auth-service/services/oneDriveService.js` (dòng 345–352) |
| **BUG-OD-02** | **P0** | **Không vô hiệu hóa snapshot khi file bị xóa trên OneDrive** | Khi file bị xóa trên OneDrive, Microsoft Graph trả về HTTP 404. Hệ thống chỉ set `sync_status = 'FAILED'` mà không set `DISCONNECTED` hoặc hủy `active_snapshot_id`. Chatbot vẫn đọc snapshot cũ để trả lời. | `auth-service/services/oneDriveSourceService.js` (dòng 650–658) |
| **BUG-OD-03** | **P1** | **Thiếu cơ chế đồng bộ nền tự động (Background Polling / Webhook)** | Bảng `onedrive_graph_subscriptions` trống rỗng. Hệ thống hoàn toàn phụ thuộc vào việc người dùng gửi tin nhắn (Query-Time) hoặc bấm nút thủ công. Tệp mới thêm vào OneDrive không bao giờ tự xuất hiện trong kho tri thức nếu không import. | `auth-service/routes/onedrive.js` & `sql/04_onedrive_source_registry.sql` |
| **BUG-OD-04** | **P1** | **File Picker không hỗ trợ thư mục "Shared with me"** | Endpoint `listDriveItems` chỉ gọi `/me/drive/root/children`, không gọi `/me/drive/sharedWithMe`. Người dùng được chia sẻ file từ tài khoản khác sẽ thấy danh sách file trống. | `auth-service/services/oneDriveService.js` (dòng 420–460) |
| **BUG-OD-05** | **P2** | **General AI không có liên kết OneDrive** | Kênh General AI 3.1 hoàn toàn không tích hợp `ensureAgentSourcesFreshness`. Người dùng hỏi dữ liệu OneDrive trên General AI sẽ luôn nhận được câu trả lời không tìm thấy tệp. | `auth-service/routes/general_ai.js` |

---

## VII. ĐỀ XUẤT KIẾN TRÚC VÀ KẾ HOẠCH CẢI TIẾN (KHI ĐƯỢC PHÊ DUYỆT)

### 1. Khắc phục triệt để lỗi Disconnect (BUG-OD-01 & BUG-OD-02)
- Khi gọi `disconnectOAuth(userId)`, thực hiện cập nhật toàn bộ nguồn của người dùng:
  ```sql
  UPDATE public.user_onedrive_sources 
  SET sync_status = 'DISCONNECTED', updated_at = NOW() 
  WHERE owner_user_id = $1;
  ```
- Khi `checkSourceFreshness` nhận phản hồi HTTP 404 (file đã bị xóa trên OneDrive), tự động chuyển nguồn sang trạng thái `'DELETED_UPSTREAM'` và ngắt liên kết `active_snapshot_id` để Chatbot từ chối trả lời dữ liệu của file đã xóa.

### 2. Bổ sung hỗ trợ tệp được chia sẻ (Shared with Me)
- Trong `listDriveItems`, nếu thư mục gốc rỗng hoặc người dùng chọn tab "Được chia sẻ với tôi", backend gọi endpoint:
  `GET https://graph.microsoft.com/v1.0/me/drive/sharedWithMe`
  Giúp người dùng chọn được các file bảng tính do đối tác hoặc phòng ban khác chia sẻ.

### 3. Định tuyến minh bạch giữa General AI và Personal AI Agents
- Nếu người dùng hỏi dữ liệu về file OneDrive trên General AI, hệ thống kiểm tra và hiển thị gợi ý thông minh:  
  *"Tệp này hiện đang được quản lý bởi Trợ lý Personal AI (Excel-Data-Pro). Vui lòng chuyển sang tab My Agents để tra cứu dữ liệu mới nhất."*

---

## VIII. DANH SÁCH TỆP DỰ KIẾN ĐIỀU CHỈNH KHI ĐƯỢC PHÊ DUYỆT

1. `auth-service/services/oneDriveService.js`:
   - Sửa hàm `disconnectOAuth` để cập nhật đồng bộ trạng thái ngắt kết nối vào `user_onedrive_sources`.
   - Bổ sung hàm `listSharedWithMeItems` hỗ trợ duyệt file được chia sẻ.
2. `auth-service/services/oneDriveSourceService.js`:
   - Xử lý mã lỗi HTTP 404 từ Microsoft Graph thành trạng thái `DELETED_ON_DRIVE`, tự động gỡ snapshot khỏi quyền truy xuất của Agent.
3. `auth-service/routes/onedrive.js`:
   - Thêm tham số `scope=shared` vào endpoint `GET /api/onedrive/files` phục vụ duyệt file chia sẻ.
4. `chat/index.html`:
   - Bổ sung tab chuyển đổi "Tệp của tôi" và "Được chia sẻ với tôi" trong OneDrive File Picker Modal.

---

> [!NOTE]
> **XÁC NHẬN NGUYÊN TẮC KIỂM TOÁN:**  
> Toàn bộ quá trình kiểm toán tuân thủ nghiêm ngặt nguyên tắc **READ-ONLY**. Không có bất kỳ thay đổi nào được thực hiện đối với mã nguồn, cơ sở dữ liệu production, Qdrant vectors hay cấu hình Docker. Báo cáo này được lưu tại `docs/architecture/ONEDRIVE_CHATBOT_SYNC_AUDIT.md` để chờ phê duyệt chính thức từ Quản trị viên.
