# SOTRANS HUB — BÁO CÁO KIỂM TOÁN NGUYÊN NHÂN GỐC RỄ (ROOT CAUSE AUDIT)
## SỰ CỐ KẾT NỐI ONEDRIVE THÀNH CÔNG NHƯNG AGENT KHÔNG NHẬN DIỆN FILE

**Dự án:** SOTRANS Hub (`D:\hoso-chat`)  
**Tài khoản kiểm toán:** `hr_stl` (User ID: `9a2e8590-c1a2-41c6-abb2-b802cb8060c6`, Công ty: `STL`)  
**Personal AI Agent đích:** `Excel-Data-Pro` (Agent ID: `cbb7053e-c388-4072-a87f-1e49b6facf07`, Role: `VIEWER`)  
**Tệp dữ liệu kiểm toán:** `Pricing Vendor.xlsx` (Item ID: `D629852830F61364!sca0f4d8aec374469aa91d2e80e71581e`)  
**Thời điểm kiểm toán:** 03/11/2026 — 09:55:00 (GMT+7)  
**Chế độ thực thi:** STRICT READ-ONLY AUDIT (Không sửa mã nguồn, không migration, không ghi database)  

---

## 1. TỔNG QUAN HIỆN TƯỢNG VÀ NGUYÊN NHÂN CỐT LÕI

### 1.1. Diễn biến thực tế của người dùng
1. Người dùng `hr_stl` mở modal **Quản lý Dữ liệu Microsoft OneDrive**.
2. Tài khoản Microsoft hiển thị `Đã liên kết` (`d629852830f61364`).
3. Mở File Picker, chọn file `Pricing Vendor.xlsx` và bấm **Xác nhận liên kết ngay**.
4. Hệ thống hiển thị Alert: `✅ Đã liên kết thành công 1 tệp từ OneDrive! Tệp: Pricing Vendor.xlsx. AI đã lập chỉ mục toàn bộ workbook và sẵn sàng đối soát khi bạn đặt câu hỏi.`
5. Modal đóng lại, danh sách nguồn trong Quản lý OneDrive hiển thị **Số tệp đang theo dõi: 0** hoặc danh sách trống.
6. Trở lại khung chat với Agent `Excel-Data-Pro`, hỏi giá cước tuyến đường (VD: Thái Hà đến Lô B2 KCN WHA Nghệ An).
7. Chatbot trả lời: *"Hiện tại KHÔNG có tệp dữ liệu nào đang được kết nối với Agent (hoặc tệp đã bị gỡ khỏi Agent)..."*

---

### 1.2. Bản đồ lỗi và 4 mắt xích đứt gãy kỹ thuật (The 4 Disconnects)

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                             SƠ ĐỒ TRUY VẾT 4 MẮT XÍCH ĐỨT GÃY                                    │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘

 [1. Giao diện File Picker]
      populateOneDrivePickerAgentSelect()
      Gọi GET /api/agents (Chỉ trả về Agent DO USER TẠO, KHÔNG CÓ Agent được chia sẻ cbb7053e...)
      ==> Dropdown thiếu Agent đích, bị ép chọn mặc định: value = 'excel-data-pro'
                                 │
                                 ▼
 [2. Lưu trữ Nguồn Dữ liệu]
      POST /api/onedrive/sources/import { agentId: 'excel-data-pro' }
      Tải file từ Graph API, bóc tách 8 sheets, xuất bản Snapshot v4 (416b42ae...)
      Lưu vào user_onedrive_sources:
      owner_user_id = hr_stl | agent_id = 'excel-data-pro' (CHUỖI LITERAL, KHÔNG PHẢI UUID AGENT ĐÍCH)
                                 │
                                 ▼
 [3. Truy vấn Danh sách File trên UI]
      renderOneDriveSourcesList() -> GET /api/onedrive/sources?agent_id=cbb7053e-c388-4072-a87f-...
      oneDriveSourceService.getConnectedSourcesForAgent({ ownerUserId: hr_stl, agentId: cbb7053e... })
      Kiểm tra user_agents: cbb7053e... do emp_stl tạo (bỏ qua agent_shares) ==> isExcelAgent = FALSE
      Truy vấn SQL: WHERE s.owner_user_id = hr_stl AND s.agent_id = 'cbb7053e...'
      Nhưng trong DB: s.agent_id = 'excel-data-pro'
      ==> KẾT QUẢ: 0 BẢN GHI ==> UI HIỂN THỊ "0 TỆP THEO DÕI"
                                 │
                                 ▼
 [4. Truy vấn Chatbot & Prompt Injection]
      User hr_stl gửi tin nhắn chat trong conversation của Agent cbb7053e...
      ensureAgentSourcesFreshness() gọi lại getConnectedSourcesForAgent()
      ==> KẾT QUẢ VẪN LÀ 0 BẢN GHI
      routes/agents.js kích hoạt FALLBACK PROMPT (Line 1881):
      "[HƯỚNG DẪN BẮT BUỘC KHI KHÔNG CÓ TỆP DỮ LIỆU ĐƯỢC KẾT NỐI]..."
      ==> CHATBOT TRẢ LỜI: "KHÔNG CÓ TỆP DỮ LIỆU NÀO ĐƯỢC KẾT NỐI"
```

---

## 2. TRUY VẾT CHI TIẾT THEO TỪNG GIAI ĐOẠN

### Giai đoạn A: OAuth & Kết nối Microsoft Graph
- **Tài khoản Microsoft liên kết:** `account_id = 'd629852830f61364'`, Provider: `microsoft`.
- **Chủ sở hữu token:** `user_id = '9a2e8590-c1a2-41c6-abb2-b802cb8060c6'` (`hr_stl`).
- **Thời hạn token:** `token_expires_at = 2026-11-03 10:46:04+07` (Hợp lệ, còn hiệu lực).
- **Quyền Graph API:** `Files.Read.All`, `offline_access`.
- **Kiểm chứng:** Tải tệp `Pricing Vendor.xlsx` (Item ID `D629852830F61364!sca0f4d8aec374469aa91d2e80e71581e`, 51.031 bytes) trực tiếp từ Microsoft Graph thành công 100%.

### Giai đoạn B: Giao diện File Picker & API Import
- **File Metadata từ Graph:**
  - File Name: `Pricing Vendor.xlsx`
  - Item ID: `D629852830F61364!sca0f4d8aec374469aa91d2e80e71581e`
  - File Size: `51.031 bytes`
  - MIME Type: `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
- **Lỗ hổng tại `populateOneDrivePickerAgentSelect()` (`chat/index.html` line 15886-15920):**
  - Hàm gọi `GET /api/agents`.
  - Backend `routes/agents.js` (line 94) chỉ trả về Agent do người dùng tự tạo: `WHERE a.user_id = $1 AND a.status = 'active'`.
  - Agent `cbb7053e-c388-4072-a87f-1e49b6facf07` (`Excel-Data-Pro`) do `emp_stl` tạo và chia sẻ qua bảng `agent_shares`. Do đó, `/api/agents` KHÔNG trả về Agent này.
  - Vòng lặp gán option chỉ có duy nhất: `<option value="excel-data-pro">Excel-Data-Pro (Mặc định)</option>`.
  - Khi người dùng bấm lưu, form gửi payload:
    ```json
    {
      "items": [{ "itemId": "D629852830F61364!sca0f4d8aec374469aa91d2e80e71581e" }],
      "agentId": "excel-data-pro",
      "conversationId": "ccf0ed50-5f21-4182-9ca5-d8b1d518d6d8"
    }
    ```

### Giai đoạn C: Lưu trữ Nguồn Dữ liệu (Source Persistence)
- Bản ghi nguồn được tạo/cập nhật thành công trong `user_onedrive_sources`:
  - `id`: `b0112ae9-6035-4af3-b82d-47d1fa21608f`
  - `owner_user_id`: `9a2e8590-c1a2-41c6-abb2-b802cb8060c6` (`hr_stl`)
  - `company_id`: `STL`
  - `agent_id`: `'excel-data-pro'` (Sai lệch so với Agent `cbb7053e...` người dùng đang mở)
  - `item_id`: `D629852830F61364!sca0f4d8aec374469aa91d2e80e71581e`
  - `sync_status`: `'SYNCED'`
  - `is_watched`: `TRUE`
  - `active_version`: `4` (Tăng từ 1 lên 4 do người dùng bấm thử lại 4 lần khi thấy UI hiển thị 0 file)
  - `active_snapshot_id`: `416b42ae-8001-454a-ab9a-57265c206178`

### Giai đoạn D: Liên kết Agent–Source (Agent Association Mismatch)
- **Agent Owner:** `emp_stl` (`f2b6606e-3125-409c-b5f9-d3ed82282c26`).
- **Người thao tác:** `hr_stl` (`9a2e8590-c1a2-41c6-abb2-b802cb8060c6`).
- **Quyền của `hr_stl`:** `VIEWER` (theo `agent_shares` id `14558529-c957-4aa7-a5b7-4e0e6e461c77`).
- **Sự cố đứt gãy quan hệ:**
  1. Nếu `routes/onedrive.js` nhận UUID của Custom Agent (`cbb7053e...`), line 276-286 sẽ trả về **HTTP 403 Forbidden** vì chỉ kiểm tra `WHERE id = $1 AND (user_id = $2 OR status = 'public')` mà không kiểm tra `agent_shares`.
  2. Vì Frontend fallback gửi `'excel-data-pro'`, source được lưu với `agent_id = 'excel-data-pro'`. Nhưng phiên làm việc chat lại đang chạy với `agent_id = 'cbb7053e-c388-4072-a87f-1e49b6facf07'`.

### Giai đoạn E: Lập chỉ mục & Snapshot (Indexing & Parsing)
- **Tình trạng Indexing:** Đã hoàn thành 100% trong PostgreSQL.
- **Snapshot ID:** `416b42ae-8001-454a-ab9a-57265c206178` (Version 4, xuất bản lúc `09:46:56+07`).
- **Số sheets:** 8 sheets.
- **Sheet `Miền Bắc`:** Đã bóc tách 14 dòng thô, 12 dòng dữ liệu hợp lệ.
  - **Dòng 11 (STT 12):** Tuyến `Thái Hà` ➔ `Lô B2 KCN WHA Nghệ An` | Loại cont: `Cont 20' (đi đơn)` | Cost: **9.500.000 VNĐ**.
  - **Dòng 12 (STT 13):** Tuyến `Nghi Sơn` ➔ `Lô B2 KCN WHA Nghệ An` | Loại cont: `Cont 20' (đi đơn)` | Cost: **9.500.000 VNĐ**.
- **Xác thực Data Engine:** Chạy trực tiếp `dataEngine.searchSpreadsheetRecords(snapshot.data_profile, { query: 'giá dịch vụ đi từ Thái Hà đến Lô B2' })` trả về đúng 1 kết quả (STT 12) với giá 9.500.000 VNĐ.

### Giai đoạn F: Truy xuất Chatbot (Chat Retrieval & Fallback Injection)
- Khi `hr_stl` gửi câu hỏi, hàm `ensureAgentSourcesFreshness` (`auth-service/services/oneDriveSourceService.js` line 831) gọi:
  ```javascript
  const connectedSources = await getConnectedSourcesForAgent({
    ownerUserId: userId,      // hr_stl
    agentId: agent.id,        // cbb7053e-c388-4072-a87f-1e49b6facf07
    conversationId
  });
  ```
- Bên trong `getConnectedSourcesForAgent` (line 183-195):
  ```javascript
  const agRes = await db.query(
    `SELECT id::text FROM public.user_agents
     WHERE (user_id = $1 OR status = 'public') 
       AND (name ILIKE '%excel%' OR agent_type = 'DATA_ANALYST')`,
    [ownerUserId]
  );
  ```
  Truy vấn này chỉ tìm trong các Agent do `hr_stl` sở hữu (`user_id = hr_stl`). Vì `cbb7053e...` thuộc `emp_stl`, kết quả trả về rỗng (`[]`).
  `isExcelAgent` bị tính là `FALSE`!
- Do `isExcelAgent = FALSE`, mệnh đề WHERE của SQL (line 219-222) trở thành:
  ```sql
  WHERE s.owner_user_id = hr_stl
    AND (s.agent_id = 'cbb7053e-c388-4072-a87f-1e49b6facf07' OR s.agent_id IS NULL)
  ```
  Nhưng source record của `hr_stl` lại lưu `s.agent_id = 'excel-data-pro'`.
- **Kết quả:** Truy vấn trả về **0 nguồn** (`[]`).
- Tại `routes/agents.js` (line 1879-1886), vì `activeFiles.length === 0`, hệ thống tiêm chỉ thị:
  ```
  [HƯỚNG DẪN BẮT BUỘC KHI KHÔNG CÓ TỆP DỮ LIỆU ĐƯỢC KẾT NỐI]:
  - Hiện tại KHÔNG có tệp dữ liệu nào đang được kết nối với Agent (hoặc tệp đã bị gỡ khỏi Agent).
  - TUYỆT ĐỐI KHÔNG tự ý bịa số liệu, giá cước, nhà cung cấp hoặc tuyến đường.
  - Hãy thông báo rõ ràng cho người dùng rằng tệp dữ liệu hiện chưa được kết nối...
  ```
- **Kết quả cuối cùng:** Chatbot trả lời người dùng rằng không có file dữ liệu báo giá nào được kết nối.

---

## 3. BẢNG ĐỐI CHIẾU 6 LỚP TRẠNG THÁI HIỆN TẠI

| Lớp trạng thái | Giá trị hiển thị / Kết quả | Nguyên nhân kỹ thuật dẫn đến sai lệch |
|---|---|---|
| **1. OneDrive UI (Modal & Count)** | `Số tệp đang theo dõi: 0`<br>Danh sách trống | `renderOneDriveSourcesList` gọi `/api/onedrive/sources?agent_id=cbb7053e...`. Backend trả về `[]` vì `agent_id` trong DB lưu `'excel-data-pro'`. |
| **2. Header Badge UI** | `OneDrive [Đã nối]` (Màu xanh) | `updateOneDriveHeaderUI` chỉ kiểm tra cờ OAuth token (`oneDriveConnectionCache.connected`), không kiểm tra xem Agent có tệp đang theo dõi hay không. |
| **3. Source Database (`user_onedrive_sources`)** | **1 bản ghi hợp lệ** (`b0112ae9...`), `sync_status = 'SYNCED'` | Tệp đã được lưu thành công, nhưng bị lưu lệch cột `agent_id = 'excel-data-pro'` thay vì ID custom agent. |
| **4. Agent Association** | **Bị đứt gãy (Mismatch)** | Cột `agent_id` kiểu VARCHAR(255) chỉ lưu được 1 giá trị; UI gửi `'excel-data-pro'` do dropdown `/api/agents` không có custom agent được chia sẻ. |
| **5. Indexing & Snapshot** | **Snapshot v4 (`416b42ae...`)**, `status = 'PUBLISHED'` | Tệp 51.031 bytes đã parse thành công 8 sheets, 12 dòng `Miền Bắc`, có đầy đủ 2 dòng STT 12 & 13 (Cost 9.500.000 VNĐ). |
| **6. Chat Retrieval (Data Engine & Prompt)** | **0 nguồn được nạp**, LLM nhận fallback prompt | `getConnectedSourcesForAgent` lọc cứng `owner_user_id` và tính sai `isExcelAgent = false`, không truyền snapshot vào Data Engine. |

---

## 4. KIỂM TRA CHỐNG TRÙNG LẶP (DUPLICATION AUDIT)

1. **Trùng lặp Source Record:**
   - Trong `user_onedrive_sources`, người dùng `hr_stl` chỉ có **1 source record duy nhất** (`b0112ae9-6035-4af3-b82d-47d1fa21608f`). Cơ chế deduplication theo `(owner_user_id, item_id)` của `registerOrUpdateSource` đã hoạt động tốt, không tạo ra nhiều dòng rác.
2. **Trùng lặp Snapshot:**
   - Do mỗi lần người dùng bấm xác nhận nhưng thấy UI vẫn báo 0 file, người dùng đã bấm lặp lại 4 lần.
   - Bảng `onedrive_source_snapshots` đã tạo ra 4 snapshot (v1, v2, v3, v4). Snapshot v4 hiện là `active_snapshot_id`.
3. **Trùng lặp Nguồn liên công ty:**
   - Cùng một file `Pricing Vendor.xlsx` (`D629852830F61364!sca0f4d8aec374469aa91d2e80e71581e`) hiện đang có:
     * 1 record của `emp_vtx` (VTX, snapshot v51).
     * 1 record của `hr_stl` (STL, snapshot v4).
     * 17 record cũ bị `DISCONNECTED` của `emp_stl` (STL).
   - Kiến trúc hiện tại chưa có bảng liên kết nhiều-nhiều (`agent_onedrive_source_associations`) nên mỗi user phải tự kéo 1 bản ghi riêng.

---

## 5. DANH SÁCH FILE, API VÀ HÀM CẦN KHẮC PHỤC

| Thành phần | Vị trí File | Hàm / Đoạn code | Lỗi kỹ thuật |
|---|---|---|---|
| **Frontend Dropdown** | `chat/index.html` | `populateOneDrivePickerAgentSelect()` (Line 15886-15920) | Chỉ gọi `/api/agents` (thiếu `/api/agents/shared-with-me`), dẫn đến thiếu option Agent được chia sẻ, ép chọn mặc định `'excel-data-pro'`. |
| **Frontend Badge** | `chat/index.html` | `updateOneDriveHeaderUI()` (Line 15130-15138) | Hiển thị `[Đã nối]` màu xanh ngay cả khi Agent không có tệp nào (`sources.length === 0`). |
| **Backend Import Check** | `auth-service/routes/onedrive.js` | `POST /sources/import` (Line 275-286) | Bỏ qua bảng `agent_shares`, chặn 403 nếu user là VIEWER/EDITOR của Agent dùng chung. |
| **Backend Agent Resolver** | `auth-service/services/oneDriveSourceService.js` | `getConnectedSourcesForAgent()` (Line 183-195) | Chỉ kiểm tra `user_agents` do caller tạo, không kiểm tra `agent_shares`, dẫn đến `isExcelAgent = false`. |
| **Backend Source Query** | `auth-service/services/oneDriveSourceService.js` | `getConnectedSourcesForAgent()` (Line 206-224) | Lọc cứng `WHERE s.owner_user_id = $1`, không hỗ trợ Shared Source từ Owner của Agent hoặc thành viên khác. |
| **Backend OAuth Disconnect** | `auth-service/services/oneDriveService.js` | `disconnectOAuth()` (Line 368) | Ghi đè `agent_id = NULL, active_snapshot_id = NULL` khi ngắt kết nối làm mất vĩnh viễn liên kết file. |

---

## 6. PHƯƠNG ÁN KHẮC PHỤC TRIỆT ĐỂ (HYBRID OPTION C)

### 6.1. Luồng xử lý 9 bước thống nhất
1. **Bước 1 (User Action):** Người dùng mở File Picker; frontend nạp đồng thời `/api/agents` và `/api/agents/shared-with-me`, chọn đúng Agent hiện tại.
2. **Bước 2 (API Authorization):** `POST /api/onedrive/sources/import` kiểm tra quyền: Nếu Agent được chia sẻ có role `VIEWER` hoặc `EDITOR`, cho phép liên kết.
3. **Bước 3 (Source Record & Deduplication):** Backend kiểm tra file đã có snapshot hợp lệ trong hệ thống chưa (dùng chung hash SHA-256 / item_id), lưu `user_onedrive_sources`.
4. **Bước 4 (Association Table):** Lưu vào bảng trung gian `agent_onedrive_source_associations (agent_id, source_id, added_by, scope)` thay vì ghi đè cột đơn `agent_id`.
5. **Bước 5 (Snapshot & Indexing):** Tải và bóc tách workbook, xuất bản snapshot trong transaction an toàn.
6. **Bước 6 (Confirmation Response):** API chỉ trả về `success: true` khi snapshot đã xuất bản VÀ association đã được ghi nhận.
7. **Bước 7 (UI Refresh):** Frontend làm mới danh sách từ backend theo đúng `agent_id`, hiển thị đúng số lượng tệp hoạt động.
8. **Bước 8 (Chat Context Retrieval):** `getConnectedSourcesForAgent` lấy cả nguồn cá nhân (Personal) và nguồn được cấp quyền (Shared/Association), nhận diện chính xác vai trò Excel Agent.
9. **Bước 9 (Data Engine Execution):** Snapshot data profile được nạp đầy đủ vào Data Engine; LLM gọi `search_spreadsheet_data` truy xuất chính xác từng dòng dữ liệu thực tế.

---

## 7. MA TRẬN 15 TEST CASES NGHIỆM THU

| STT | Kịch bản kiểm thử | Dữ liệu đầu vào | Kết quả mong đợi |
|---|---|---|---|
| **TC-01** | Owner kết nối file và hỏi dữ liệu | `emp_stl` gắn `Pricing Vendor.xlsx` | Agent trả lời chính xác giá 9.500.000 VNĐ. |
| **TC-02** | Viewer được chia sẻ Agent hỏi dữ liệu | `hr_stl` hỏi trên Agent của `emp_stl` | Agent đọc được nguồn chung hoặc nguồn cá nhân do `hr_stl` gắn. |
| **TC-03** | Viewer truy cập nguồn ngoài phạm vi | `hr_stl` hỏi file của VTX chưa chia sẻ | Bị từ chối truy xuất (DENY BY DEFAULT). |
| **TC-04** | File chọn thành công nhưng parse lỗi | File hỏng định dạng Magic Bytes | Rollback transaction, thông báo lỗi cụ thể, không tạo snapshot ảo. |
| **TC-05** | Lưu source thành công nhưng association lỗi | Association trùng lặp hoặc lock timeout | Xử lý idempotent qua `ON CONFLICT DO NOTHING`. |
| **TC-06** | Source tồn tại nhưng active_snapshot_id NULL | Tệp mới khởi tạo chưa publish | Giao diện hiển thị `ĐANG LẬP CHỈ MỤC`, Chatbot không bị crash. |
| **TC-07** | Source DISCONNECTED | User ngắt kết nối OAuth | Chuyển sang chế độ Local Backup (Ngoại tuyến), có cảnh báo rõ ràng. |
| **TC-08** | OAuth token hết hạn | Token quá hạn 60 phút | Tự động refresh token qua refresh_token trong Microsoft Graph API. |
| **TC-09** | Người dùng kết nối lại OAuth | Bấm kết nối lại sau khi disconnect | Khôi phục trạng thái SYNCED, không nhân bản source record mới. |
| **TC-10** | Chọn cùng một file hai lần | Chọn lại file `Pricing Vendor.xlsx` | Tăng version snapshot, không tạo thêm bản ghi rác trong `user_onedrive_sources`. |
| **TC-11** | Thu hồi quyền Agent | Xóa quyền VIEWER của `hr_stl` | `hr_stl` mất quyền truy cập cả Agent và nguồn liên kết của Agent. |
| **TC-12** | Cross-company chưa phê duyệt | VTX share nguồn sang STL chưa có duyệt | Chặn truy cập (Status: `PENDING_APPROVAL`). |
| **TC-13** | Cross-company đã phê duyệt | Admin VTX xác nhận cấp quyền cho STL | Truy xuất bình thường cho đến khi hết hạn `expires_at`. |
| **TC-14** | Đồng bộ số lượng file UI và DB | Kiểm tra counter trên modal và DB | `odSourcesCount` bằng chính xác số bản ghi active trả về từ DB. |
| **TC-15** | Chatbot đối soát số liệu thực tế | Hỏi tuyến đường Thái Hà ➔ Nghệ An | Trả về đúng STT 12, Đơn giá: 9.500.000 VNĐ, Tên sheet: Miền Bắc. |

---

## 8. KẾ HOẠCH ROLLBACK VÀ AN TOÀN DỮ LIỆU

- **Nguyên tắc an toàn:** Không chạy bất kỳ lệnh `DROP TABLE`, `TRUNCATE` hoặc `DELETE`.
- **Bảo toàn dữ liệu hiện hữu:** 
  - Nguồn của `emp_vtx` (Snapshot v51) và nguồn của `hr_stl` (Snapshot v4) phải được giữ nguyên vẹn 100%.
  - 17 bản ghi `DISCONNECTED` cũ của `emp_stl` chỉ đánh dấu cờ `is_archived = TRUE`, không xóa vật lý.
- **Rollback Script:** Lưu sẵn bản sao lưu cấu trúc và dữ liệu trước khi thực thi Giai đoạn 1. Nếu có sự cố, khôi phục lại function gốc chỉ trong vòng 30 giây.

---

> [!IMPORTANT]
> **KẾT THÚC GIAI ĐOẠN AUDIT READ-ONLY:** Hệ thống hiện tại giữ nguyên hiện trạng. Toàn bộ nguyên nhân gốc rễ đã được chứng minh bằng log và dữ liệu thực nghiệm. Sẵn sàng triển khai mã nguồn và migration ngay khi nhận được lệnh phê duyệt.
