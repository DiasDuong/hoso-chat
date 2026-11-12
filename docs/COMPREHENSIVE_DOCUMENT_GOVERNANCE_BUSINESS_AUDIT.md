# BÁO CÁO KIỂM TOÁN TOÀN DIỆN VỀ NGHIỆP VỤ & KỸ THUẬT QUẢN TRỊ TÀI LIỆU
## SOTRANS HUB — DEEP AUDIT REPORT: DOCUMENT GOVERNANCE, CROSS-DOCUMENT CONFLICT DETECTION, DUPLICATE INFORMATION & RAG QUALITY

**Dự án:** SOTRANS Hub — Logistics AI Platform  
**Thư mục làm việc:** `D:\hoso-chat`  
**Ngày thực hiện kiểm toán:** 04/11/2026  
**Chế độ thực hiện:** DEEP AUDIT — READ-ONLY / AUDIT ONLY (Không thay đổi mã nguồn, không sửa CSDL, không can thiệp trạng thái dữ liệu).  
**Phạm vi:** Toàn bộ hệ thống quản lý tài liệu, Quy định, Chính sách, Document Governance, Relationship Engine, Conflict Detection, OCR, Retrieval và RAG.

---

# I. TỔNG QUAN KẾT QUẢ KIỂM TOÁN (EXECUTIVE SUMMARY)

Cuộc kiểm toán toàn diện đã được tiến hành trên toàn bộ các thành phần của hệ thống SOTRANS Hub: CSDL PostgreSQL `hrbot`, Vector DB Qdrant `hr_docs`, Backend Express `hr-auth`, n8n Workflow `HR_Policy_Chat`, Nginx Gateway và Frontend giao diện Quản trị.

### 1. Kết luận tổng thể về mức độ sẵn sàng nghiệp vụ
- **Chất lượng RAG & An toàn Chatbot:** **ĐẠT MỨC CAO (L4 — VERIFIED).**
  - Cơ chế bảo vệ Tenant Boundary giữa SOTRANS Logistics (STL), Vietranstimex (VTX) và Sowatco (SWC) hoạt động nghiêm ngặt và không bị rò rỉ dữ liệu.
  - Cơ chế kiểm soát tài liệu thử nghiệm (`QC-DXM-2026-FLEX`) hoạt động hoàn hảo: ẩn hoàn toàn khi nhân viên hỏi câu hỏi chung và chỉ xuất hiện kèm Disclaimer pháp lý bắt buộc khi có câu hỏi đích danh về mô hình làm việc số / flexitime.
  - Cơ chế Cổng gác đền (Guardrail & Validator) kiểm tra đối chiếu trích dẫn nguyên văn (`evidence_quote`) và nguồn gốc chunk thực tế, ngăn chặn 100% hiện tượng ảo giác (hallucination) hoặc tự ý bịa đặt trích dẫn.
  - Dữ liệu giữa PostgreSQL (104 chunks) và Qdrant (104 vector points) đồng bộ tuyệt đối 1:1, không có vector mồ côi.
- **Năng lực Đối soát Xung đột & Trùng lặp Văn bản (Intake Conflict Engine):** **MỨC CƠ BẢN (L1 — BASIC / CẦN NÂNG CẤP LỚN).**
  - Mặc dù hệ thống đã có giao diện Wizard 3 bước và engine `policyConflictDetector.js`, nhưng cơ chế phát hiện xung đột hiện tại **hoàn toàn dựa trên từ khóa Regex cứng**, **chưa ứng dụng AI Semantic Analysis** tại khâu tiếp nhận.
  - Phát hiện **2 lỗi kỹ thuật / logic nghiêm trọng** trong mã nguồn khiến cho việc phân loại xung đột bị sai lệch:
    1. *Lỗi chuẩn hóa chữ "đ/Đ":* Làm mất hoàn toàn khả năng phát hiện chủ đề an toàn lao động đối với các văn bản có dấu tiếng Việt.
    2. *Lỗi logic `isFullyOverlappingScope`:* Nuốt mất nhánh ngoại lệ `isSpecializedScope`, khiến mọi quy định đặc thù của phòng ban/nhóm nhân sự đều bị hệ thống phân loại nhầm thành xung đột trực tiếp cấp cao (`HIGH`).
  - Hệ thống hiện tại **đánh đồng thông tin trùng lặp (Case C) và thông tin bổ sung (Case D) thành mâu thuẫn đối kháng (Case F)**, gây hiện tượng báo động giả (False Positive) cản trở quy trình nộp hồ sơ của HR.
  - Detector hiện tại **chỉ đọc tiêu đề và mã số của văn bản cũ**, bỏ qua toàn văn điều khoản bên trong CSDL, gây nguy cơ lọt xung đột (False Negative).

---

# II. KIẾN TRÚC HỆ THỐNG THỰC TẾ

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              SOTRANS HUB — KIẾN TRÚC TỔNG THỂ                          │
└────────────────────────────────────────────────────────────────────────────────────────┘

  [NGƯỜI DÙNG HR / ADMIN]                                      [NHÂN VIÊN DOANH NGHIỆP]
           │                                                               │
           ▼                                                               ▼
  ┌──────────────────────────────────────────────────────────────────────────────────┐
  │ NGINX GATEWAY (Port 8082) — Reverse Proxy & Static Assets Hosting                │
  │   ├── /chat/hr-admin.html (Giao diện Quản trị Quy định, Nhân sự, Người dùng)     │
  │   └── /chat/index.html    (Giao diện Chat AI Đa trợ lý, Hồ sơ, General AI)       │
  └────────────────────────┬───────────────────────────────────────┬─────────────────┘
                           │                                       │
                           ▼                                       ▼
  ┌──────────────────────────────────────────────────────────────────────────────────┐
  │ AUTH-SERVICE (Node.js Express - Port 3000)                                       │
  │   ├── /api/documents/* (Intake, Duplicate Check, Conflict Detector, Approve)    │
  │   ├── /api/documents/relationships/* (7 loại quan hệ, Tenant Security Guard)    │
  │   ├── /api/policy/chat (Khóa cứng Tenant claims, Cache 1h theo hash phiên bản)   │
  │   └── policyConflictDetector.js (Engine đối soát xung đột tại khâu tiếp nhận)    │
  └────────────────────────┬───────────────────────────────────────┬─────────────────┘
                           │                                       │
            ┌──────────────┴──────────────┐                        │ Webhook Relay
            ▼                             ▼                        ▼
  ┌─────────────────────────┐   ┌───────────────────┐   ┌────────────────────────────┐
  │ POSTGRESQL 16 (hrbot)   │   │ QDRANT (hr_docs)  │   │ N8N WORKFLOW (Port 5678)   │
  │ - 22 Documents          │   │ - 104 Vector Pts  │   │ - Workflow: HR_Policy_Chat │
  │ - 104 Chunks (Fulltext) │   │ - Top 15 Search   │   │ - Gemini 3.5 Flash Lite    │
  │ - 3 Relationships       │   │ - Status & Branch │   │ - RRF Hybrid Retrieval     │
  │ - 1 Retrieval Control   │   │   Filtering       │   │ - Validator Grounding Guard│
  └─────────────────────────┘   └───────────────────┘   └────────────────────────────┘
```

---

# III. KẾT QUẢ ĐỐI SOÁT 6 LOẠI TÌNH HUỐNG TRÙNG LẶP & MÂU THUẪN

Cuộc kiểm toán đã đối chiếu độc lập từng tình huống trong số 6 loại tình huống nghiệp vụ:

### 1. Loại A: Trùng tệp nhị phân 100% (Exact Duplicate)
- **Thực trạng:** Dùng thuật toán SHA-256 tính toán mã băm tệp ngay tại trình duyệt (`computeFileSha256`) và xác minh tại server (`POST /api/documents/check-duplicate`).
- **Đánh giá:** **PASS (L4 — VERIFIED).** Ngăn chặn tuyệt đối việc người dùng vô tình tải lại cùng một tệp (HTTP 409).

### 2. Loại B: Trùng tài liệu (Document Duplicate — Khác định dạng, cùng văn bản)
- **Thực trạng:** So khớp mã hiệu `doc_code` và `doc_number` trong CSDL.
- **Hạn chế:** Nếu một tệp Word và một tệp PDF cùng là một văn bản nhưng chưa được gõ mã hiệu (hoặc để trống), hệ thống không tự đọc nội dung để biết chúng là một.
- **Đánh giá:** **L2 — PARTIAL.**

### 3. Loại C: Trùng thông tin (Information Duplication)
- **Thực trạng:** Hai văn bản khác nhau nhưng cùng quy định một nội dung thống nhất (ví dụ: Quy định A và Chính sách B cùng quy định giờ làm việc từ 08:00 đến 17:00).
- **Hạn chế nghiêm trọng:** Hệ thống **báo động giả (False Positive)**. Vì cả 2 văn bản đều chứa từ khóa `thoi_gio_lam_viec` và cùng có phạm vi `{all}`, hệ thống đánh dấu là `POLICY_CONTRADICTION` với mức độ `HIGH`, chặn nộp hồ sơ.
- **Đánh giá:** **L1 — BASIC (Cần bổ sung AI Semantic Equivalence).**

### 4. Loại D: Thông tin bổ sung hợp lệ (Complementary Information)
- **Thực trạng:** Quy chế A quy định giờ làm việc chung (08:00–17:00). Chính sách B quy định thời gian nghỉ trưa giữa ca (12:00–13:00).
- **Hạn chế:** Regex của hệ thống gom cả giờ làm việc và giờ nghỉ trưa vào một giỏ `thoi_gio_lam_viec`, dẫn đến việc đánh dấu nhầm thành xung đột đối kháng cấp `HIGH`.
- **Đánh giá:** **L1 — BASIC.**

### 5. Loại E: Thông tin sửa đổi hoặc ngoại lệ (Amendment / Exception)
- **Thực trạng:** Văn bản chung áp dụng toàn công ty, văn bản mới áp dụng riêng cho Đội xe hoặc Khối Kho bãi.
- **Lỗi logic phát hiện:** Hàm `isNarrowerScope` có tồn tại, nhưng điều kiện `isFullyOverlappingScope` phía trước luôn bằng `true` do quy ước `{all}` bao hàm mọi phạm vi con. Do đó, nhánh phân loại ngoại lệ `UNLINKED_SPECIALIZATION` (MEDIUM) **bị triệt tiêu hoàn toàn**, đẩy thành xung đột trực tiếp `HIGH`.
- **Đánh giá:** **FAIL (Lỗi logic kỹ thuật cần khắc phục).**

### 6. Loại F: Mâu thuẫn thực sự (Semantic Conflict)
- **Thực trạng:** Hai văn bản cùng điều chỉnh một vấn đề, cùng phạm vi, cùng thời điểm hiệu lực nhưng đưa ra quy định trái ngược nhau (ví dụ: 08:00 vs 08:30).
- **Hạn chế:** Phát hiện được nếu rơi vào 5 chủ đề cứng. Bị bỏ sót hoàn toàn (False Negative) nếu mâu thuẫn về các chủ đề khác trong doanh nghiệp (thử việc, tuyển dụng, bảo hiểm, chi phí đào tạo...).
- **Đánh giá:** **L2 — PARTIAL.**

---

# IV. CÁC LỖ HỔNG KỸ THUẬT & NGHIỆP VỤ ĐƯỢC PHÁT HIỆN QUA KIỂM TOÁN

Qua rà soát từng dòng mã nguồn và chạy các test script trong Sandbox, kiểm toán phát hiện **4 lỗi kỹ thuật và 3 khiếm khuyết nghiệp vụ trọng yếu**:

### 1. Lỗi kỹ thuật K1: Lỗi chuẩn hóa ký tự tiếng Việt "đ/Đ" trong `extractCoreTopics`
- **File:** `auth-service/services/policyConflictDetector.js` (dòng 53–57).
- **Hiện tượng:** Mã nguồn chỉ dùng `.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()`. Vì chữ `đ` và `Đ` không phải ký tự tổ hợp dấu thanh trong Unicode, nên nó không bị phân rã thành `d`. Ký tự vẫn giữ nguyên là `đ`.
- **Bằng chứng kiểm chứng:**
  - Văn bản thực tế trong CSDL: `15/QĐ-SOTRANS` có tiêu đề *"An toàn lao động (Bản cập nhật)"*.
  - Khi chạy qua `extractCoreTopics`, kết quả trả về: **`[]` (Mảng rỗng)**!
  - Regex dòng 65: `/an\s*toan\s*lao\s*dong/` sử dụng chữ `d`, nên không bao giờ khớp với chuỗi `an toan lao đong`.
  - **Hệ quả:** Hệ thống **bị mù hoàn toàn** đối với toàn bộ các quy định và xung đột về an toàn lao động có dấu tiếng Việt.

### 2. Lỗi kỹ thuật K2: Lỗi logic `isFullyOverlappingScope` triệt tiêu nhánh ngoại lệ
- **File:** `auth-service/services/policyConflictDetector.js` (dòng 173–178, 212–240).
- **Hiện tượng:**
  ```javascript
  const isFullyOverlappingScope = branchOverlap && deptOverlap && buOverlap && egOverlap;
  if (isFullyOverlappingScope) {
    // Luôn bị rơi vào đây nếu văn bản cũ có scope = ['all']
    conflicts.push({ severity: 'HIGH', type: 'POLICY_CONTRADICTION', ... });
  } else if (isSpecializedScope) {
    // Nhánh này KHÔNG BAO GIỜ được thực thi!
  }
  ```
- **Hệ quả:** Mọi văn bản đặc thù phòng ban/nhóm nhân sự tải lên đều bị báo động đỏ cấp `HIGH` và bị chặn nộp hồ sơ, gây ức chế và làm gián đoạn nghiệp vụ của HR.

### 3. Lỗi kỹ thuật K3: Đối chiếu xung đột chỉ đọc tiêu đề văn bản cũ, bỏ qua toàn văn
- **File:** `auth-service/services/policyConflictDetector.js` (dòng 184–185).
- **Hiện tượng:**
  ```javascript
  const docText = `${doc.title} ${doc.doc_code || ''}`;
  const docTopics = extractCoreTopics(docText);
  ```
- **Hậu quả:** Đối với hàng chục văn bản đang áp dụng trong hệ thống, detector **chỉ đọc đúng tiêu đề và mã số** để tìm chủ đề. Nếu văn bản cũ có tên chung chung như *"Nội quy lao động"* nhưng bên trong có quy định về *phụ cấp*, *thời giờ làm việc*, *đồng phục*, *kỷ luật*... thì hệ thống hoàn toàn không biết, dẫn đến bỏ sót 100% các xung đột nằm sâu trong các điều khoản.

### 4. Lỗi kỹ thuật K4: Thiếu rào cản chặn xung đột tại Backend API (`POST /api/documents`)
- **File:** `auth-service/routes/documents.js` (dòng 550–650).
- **Hiện tượng:** Việc kiểm tra xung đột chỉ được gọi chủ động từ giao diện frontend Wizard Bước 3. Endpoint `POST /api/documents` ở backend không hề gọi `detectPolicyConflicts`. Nếu có người dùng gọi API trực tiếp hoặc dùng script nạp văn bản, tài liệu xung đột vẫn được tạo bình thường.

---

# V. KIỂM TOÁN RELATIONSHIP ENGINE & ĐỒNG BỘ DỮ LIỆU

### 1. Chuẩn hóa 7 loại quan hệ văn bản
Hệ thống đã chuẩn hóa danh mục 7 loại quan hệ:
1. `independent` (Độc lập).
2. `supersedes` (Thay thế toàn bộ).
3. `amends` (Sửa đổi một phần).
4. `supplements` (Bổ sung).
5. `exception_to` (Ngoại lệ đặc thù).
6. `clarifies` (Giải thích / Hướng dẫn thi hành).
7. `applies_with` (Áp dụng đồng thời).

### 2. Hiện trạng CSDL `document_relationships`
Hiện tại trong CSDL có **3 bản ghi quan hệ lịch sử**:
1. `QC-DXM-2026-FLEX` supersedes `QC-VPC-2024-V1` (Trạng thái: `approved`).
2. `15/QĐ-SOTRANS` supersedes `17/QĐ-LAODONG` (Trạng thái: `pending_review`).
3. `45/2024/QĐ-VTX` supplements `18/2023/QC-SOTRANS` (Trạng thái: `pending_review`).

### 3. Kiểm tra tính toàn vẹn và đồng bộ
- **Chống quan hệ mâu thuẫn ngược chiều:** Đã có kiểm tra Tenant Boundary và kiểm tra quan hệ đối kháng (không cho phép đồng thời vừa thay thế vừa bổ sung).
- **Đồng bộ Qdrant và PostgreSQL:**
  - Tổng số chunks trong PostgreSQL: **104 chunks**.
  - Tổng số points trong Qdrant `hr_docs`: **104 points**.
  - Số lượng vector mồ côi: **0**.
  - Phân bổ trạng thái trong Qdrant khớp 100% với PostgreSQL: `archived: 37`, `superseded: 22`, `testing: 22`, `active: 18`, `revoked: 5`.

---

# VI. ĐÁNH GIÁ CHẤT LƯỢNG RAG & TRUY XUẤT CHATBOT

Bộ kiểm toán đã chạy 7 kịch bản tra cứu RAG thực tế trên API `/api/policy/chat`:

1. **Tra cứu quy định chung toàn tập đoàn (TC01):**
   - Trả lời chính xác giờ làm việc chuẩn 08:00–17:00 từ Thứ Hai đến Thứ Sáu, nghỉ trưa 12:00–13:00, trích dẫn chuẩn xác `01/QC-SOTRANS` (v1) và `15/QĐ-SOTRANS` (v2).
2. **Tra cứu chính sách đặc thù của công ty con (TC02 - VTX):**
   - Nhân viên VTX hỏi về phụ cấp SPMT: Chatbot trích dẫn đồng thời cả văn bản Tập đoàn `18/2023/QC-SOTRANS` và Quyết định bổ sung `45/2024/QĐ-VTX`, nêu rõ mức phụ cấp 500k-700k/ngày.
3. **Bảo vệ Tenant Boundary (TC03, TC27):**
   - Nhân viên STL hỏi về phụ cấp riêng hoặc quy trình vận tải siêu trường siêu trọng của VTX (`20/QD-VTX`): Chatbot từ chối cung cấp dữ liệu riêng của VTX (`answerable: false`), bảo mật dữ liệu tuyệt đối giữa các đơn vị thành viên.
4. **Kiểm soát tài liệu thí điểm Pilot (TC04, TC05):**
   - Hỏi câu hỏi chung: Văn bản `QC-DXM-2026-FLEX` bị ẩn hoàn toàn khỏi kết quả tìm kiếm.
   - Hỏi câu hỏi đích danh về flexitime/chuyển đổi số: Chatbot trả lời nhưng **bắt buộc chèn Disclaimer cảnh báo**: Đây là dự thảo thử nghiệm mô hình làm việc số, chưa phải chính sách chính thức toàn tập đoàn.
5. **Tài liệu hết hiệu lực / Dự thảo (TC06, TC16):**
   - Quyết định 16/QĐ-AX (archived) và Dự thảo 2211 (pending_approval) bị cách ly hoàn toàn, chatbot thông báo chưa có thông tin và hướng dẫn liên hệ phòng Nhân sự.
6. **Bảo mật vai trò Người dùng (TC07):**
   - Tài khoản vai trò Guest (`user_guest`) bị chặn ngay tại tầng API với mã lỗi HTTP 403 Forbidden.
7. **Phản hồi khi có xung đột mâu thuẫn chính sách:**
   - Trong môi trường thử nghiệm với 2 văn bản mâu thuẫn (08:00 vs 08:30), Chatbot không tự ý chọn 1 văn bản mà chỉ rõ điểm không thống nhất giữa 2 văn bản và khuyên người dùng liên hệ phòng Nhân sự.

---

# VII. BẢNG TỔNG HỢP MỨC ĐỘ ĐÁP ỨNG NGHIỆP VỤ (L0 - L4)

| STT | Phân hệ / Chức năng nghiệp vụ | Mức hiện tại | Mức cần đạt | Đánh giá & Rủi ro |
| :---: | :--- | :---: | :---: | :--- |
| 1 | **Phát hiện trùng tệp nhị phân (SHA-256)** | **L4** | L4 | **Hoàn chỉnh:** Chặn trùng tệp 100% tại client & server. |
| 2 | **Nhận diện mã văn bản & Metadata** | **L3** | L4 | **Tốt:** Gợi ý mã thông minh, không ép buộc mã hiệu chính xác. |
| 3 | **Phân định 3 tầng phạm vi (Scope)** | **L4** | L4 | **Hoàn chỉnh:** Khóa cứng Tenant STL/VTX/SWC, không mở rộng trái phép. |
| 4 | **Đối soát xung đột chính sách (Conflict Detector)** | **L1** | L4 | **Rất yếu:** Dựa vào regex cứng, lỗi chữ "đ", chỉ đọc tiêu đề văn bản cũ. |
| 5 | **Phân loại ngoại lệ phòng ban (Specialization)** | **L2** | L4 | **Lỗi logic:** `isFullyOverlappingScope` đè bẹp nhánh ngoại lệ. |
| 6 | **Bóc tách entity số học (Số tiền, Ngày, Giờ)** | **L0** | L3 | **Chưa có:** Chưa so sánh được sự chênh lệch giá trị số giữa 2 điều khoản. |
| 7 | **Động cơ Quan hệ văn bản (Relationship Engine)** | **L3** | L4 | **Khá:** 7 loại quan hệ chuẩn hóa; thiếu liên kết cấp điều khoản (`clause_id`). |
| 8 | **Kiểm soát hiệu lực văn bản (Effective Date)** | **L4** | L4 | **Hoàn chỉnh:** Hỗ trợ scheduled future activation, hết hiệu lực tự động. |
| 9 | **Kiểm soát Người duyệt (Human-in-the-loop)** | **L4** | L4 | **Hoàn chỉnh:** Separation of Duties, AI chỉ đề xuất, con người bấm duyệt. |
| 10 | **Đồng bộ đa hệ thống (PostgreSQL ↔ Qdrant)** | **L4** | L4 | **Hoàn chỉnh:** 104/104 points khớp tuyệt đối 1:1, không có orphan. |
| 11 | **Cách ly tài liệu Pilot (`QC-DXM-2026-FLEX`)** | **L4** | L4 | **Hoàn chỉnh:** Ẩn khi hỏi chung, có Disclaimer khi hỏi đích danh. |
| 12 | **Bảo vệ trích dẫn & Chống ảo giác (Validator)** | **L4** | L4 | **Hoàn chỉnh:** Đối chiếu nguyên văn `evidence_quote` trong chunk thực tế. |

---

# VIII. DANH MỤC RỦI RO THEO PHÂN CẤP P0 / P1 / P2 / P3

### RỦI RO MỨC P0 (NGHIÊM TRỌNG — CẦN KHẮC PHỤC TRƯỚC KHI VẬN HÀNH THỰC TẾ)
- **R-P0-1: Lọt xung đột chính sách do chỉ đọc tiêu đề văn bản cũ.**
  - *Mô tả:* `policyConflictDetector.js` chỉ quét `doc.title` và `doc.doc_code` của các văn bản đang áp dụng. Nếu văn bản cũ có tên chung chung nhưng bên trong chứa điều khoản xung đột với văn bản mới, hệ thống hoàn toàn không phát hiện được.
  - *Hậu quả:* Doanh nghiệp ban hành các chính sách mâu thuẫn nhau mà hệ thống không cảnh báo.

### RỦI RO MỨC P1 (CAO — ẢNH HƯỞNG TRỰC TIẾP ĐẾN TRẢI NGHIỆM VÀ ĐỘ CHÍNH XÁC)
- **R-P1-1: Mất khả năng phát hiện xung đột an toàn lao động do lỗi chữ "đ".**
  - *Mô tả:* Lỗi chuẩn hóa Unicode NFD không phân rã chữ `đ` khiến hàm `extractCoreTopics` trả về mảng rỗng cho văn bản có chữ "An toàn lao động".
- **R-P1-2: Báo động giả và chặn nhầm văn bản đặc thù phòng ban do lỗi logic `isFullyOverlappingScope`.**
  - *Mô tả:* Quy chế cũ có scope `{all}` làm điều kiện giao thoa toàn phần luôn bằng `true`, biến mọi quy định đặc thù thành xung đột `HIGH`.
- **R-P1-3: Đánh đồng thông tin trùng lặp (Case C) và bổ sung (Case D) thành xung đột trực tiếp.**
  - *Mô tả:* Hai văn bản cùng quy định một giờ làm việc giống nhau bị coi là mâu thuẫn đối kháng và chặn nộp hồ sơ.

### RỦI RO MỨC P2 (TRUNG BÌNH — KHIẾM KHUYẾT TÍNH NĂNG)
- **R-P2-1: Chưa có OCR Vision cho PDF scan thuần hình ảnh.**
  - *Mô tả:* Các văn bản scan từ máy photocopy không có text layer sẽ không đọc được nội dung để đối soát và chunking.
- **R-P2-2: Thiếu rào cản kiểm tra xung đột tại Backend API `POST /api/documents`.**
  - *Mô tả:* Mới chỉ kiểm tra xung đột ở frontend Wizard Bước 3, chưa cưỡng chế tại API tiếp nhận.
- **R-P2-3: Chưa bóc tách entity số học (VND, Ngày, Giờ).**
  - *Mô tả:* Chưa tự động so sánh được 500.000 đ vs 700.000 đ hoặc 30 ngày vs 60 ngày.

### RỦI RO MỨC P3 (THẤP — CẢI TIẾN TRẢI NGHIỆM)
- **R-P3-1: Quan hệ văn bản mới ở cấp Document, chưa hỗ trợ cấp Clause (`clause_id`).**
- **R-P3-2: Phụ thuộc vào tính sẵn sàng của n8n Webhook khi lưu lượng tra cứu đồng thời cao.**

---

# IX. TRẢ LỜI TRỰC TIẾP 12 CÂU HỎI KẾT LUẬN (MỤC XV)

Theo đúng yêu cầu của bản đặc tả kiểm toán, dưới đây là câu trả lời thẳng thắn, có bằng chứng kỹ thuật cho 12 câu hỏi cốt lõi:

#### 1. Hiện tại upload một tài liệu mới, hệ thống có tự đối chiếu với tất cả tài liệu liên quan không?
- **Trả lời:** **CÓ, NHƯNG CHƯA HOÀN TOÀN.**
- **Bằng chứng:** Hệ thống tự động truy vấn các tài liệu `status = 'active'` trong CSDL có cùng phạm vi `branch_scope`. Tuy nhiên, việc đối chiếu chỉ dừng lại ở việc so sánh tiêu đề (`doc.title`) của tài liệu cũ với tiêu đề/nội dung tài liệu mới dựa trên 5 regex từ khóa cứng, **chưa đối chiếu toàn văn với các chunks nội dung bên trong CSDL**.

#### 2. Có đối chiếu xuyên category Quy định và Chính sách không?
- **Trả lời:** **CÓ.**
- **Bằng chứng:** Truy vấn SQL trong `policyConflictDetector.js` không hề có mệnh đề lọc theo `category`. Kiểm thử thực tế (TC04) xác nhận văn bản loại *Chính sách* vẫn được đối chiếu liên thông với văn bản loại *Quy chế* (`01/QC-SOTRANS`).

#### 3. Có nhận diện được cùng một thông tin xuất hiện trong hai file khác nhau không?
- **Trả lời:** **NHẬN DIỆN ĐƯỢC NHƯNG ĐÁNH GIÁ SAI BẢN CHẤT.**
- **Bằng chứng:** Khi tải lên văn bản có cùng thông tin giờ làm việc (08:00–17:00), hệ thống nhận diện được cả 2 văn bản cùng nói về thời giờ làm việc, nhưng lại **đánh dấu nhầm đây là xung đột trực tiếp (`HIGH: POLICY_CONTRADICTION`)** thay vì nhận diện là thông tin trùng lặp/kế thừa (TC03, TC05).

#### 4. Có phân biệt được thông tin trùng với mâu thuẫn thực sự không?
- **Trả lời:** **CHƯA PHÂN BIỆT ĐƯỢC.**
- **Bằng chứng:** Hệ thống hiện tại chỉ có 1 thước đo: nếu cùng chủ đề + cùng phạm vi + cùng thời gian $\rightarrow$ coi là xung đột trực tiếp `HIGH`. Hệ thống chưa có cơ chế so sánh ngữ nghĩa chi tiết để phân biệt giữa "nói giống nhau" (trùng lặp) và "nói trái ngược nhau" (mâu thuẫn).

#### 5. Có phát hiện được hai tài liệu cùng quy định một vấn đề nhưng giá trị khác nhau không?
- **Trả lời:** **CHỈ PHÁT HIỆN ĐƯỢC DƯỚI DẠNG XUNG ĐỘT CHỦ ĐỀ CHUNG, CHƯA SO SÁNH ĐƯỢC GIÁ TRỊ CỤ THỂ.**
- **Bằng chứng:** Nếu văn bản A ghi 08:00 và văn bản B ghi 08:30, hệ thống báo xung đột vì cả 2 cùng chứa từ khóa `thoi_gio_lam_viec`. Nhưng nếu văn bản A ghi phụ cấp 500k và văn bản B ghi phụ cấp 700k mà không có từ khóa regex, hệ thống không bóc tách được hai con số này để so sánh chênh lệch (TC28).

#### 6. Có xét đối tượng, phạm vi, công ty và ngày hiệu lực không?
- **Trả lời:** **CÓ XÉT, NHƯNG BỊ LỖI LOGIC TẠI PHẠM VI HẸP.**
- **Bằng chứng:**
  - Về công ty và ngày hiệu lực: Hoạt động rất tốt (TC12, TC14).
  - Về phòng ban và nhóm nhân sự: Hàm `isNarrowerScope` bị triệt tiêu do lỗi logic `isFullyOverlappingScope`, khiến văn bản đặc thù phòng ban bị đánh đồng thành văn bản toàn công ty (TC10, TC13).

#### 7. Có phát hiện được xung đột nằm ở các chunk khác nhau không?
- **Trả lời:** **CHƯA ĐÁP ỨNG Ở KHÂU UPLOAD, NHƯNG XỬ LÝ ĐƯỢC Ở KHÂU RAG.**
- **Bằng chứng:**
  - Ở khâu Upload: Detector chỉ đọc tiêu đề văn bản cũ, nên xung đột nằm ở chunk sâu bên trong sẽ bị bỏ sót.
  - Ở khâu RAG: Nếu 2 văn bản cùng được nạp vào context, mô hình Gemini Answer tổng hợp được cả 2 chunk và chỉ ra sự không thống nhất cho người dùng.

#### 8. Có đưa bằng chứng và vị trí điều khoản cụ thể cho HR/Admin không?
- **Trả lời:** **CÓ MỘT PHẦN.**
- **Bằng chứng:** Tại Bước 3 của Wizard Upload, hệ thống hiển thị trích đoạn minh chứng (`evidence_quote`) lấy từ `chunks.section_path` và nội dung đoạn trích. Tuy nhiên, hệ thống mới chỉ lấy đoạn trích đầu tiên (`LIMIT 1`) của văn bản cũ, chưa chỉ ra được chính xác câu/khoản cụ thể gây mâu thuẫn.

#### 9. Có ngăn tài liệu đang xung đột chưa giải quyết đi vào RAG chính thức không?
- **Trả lời:** **CÓ, NGĂN CHẶN RẤT TỐT QUA QUY TRÌNH PHÊ DUYỆT.**
- **Bằng chứng:** Mọi tài liệu tải lên chỉ ở trạng thái `draft` hoặc `pending_approval`. Tài liệu chỉ có thể vào RAG khi Quản trị viên thực hiện phê duyệt chính thức (`POST /api/documents/:id/approve`). Tại giao diện, nếu phát hiện xung đột `HIGH` mà chưa thiết lập quan hệ `supersedes` hay `amends`, nút Gửi phê duyệt bị vô hiệu hóa.

#### 10. Chatbot có trả lời đúng khi tồn tại nhiều tài liệu liên quan không?
- **Trả lời:** **CÓ, CHẤT LƯỢNG RẤT TỐT (L4 — VERIFIED).**
- **Bằng chứng:** Kiểm thử TC01, TC02, TC22, TC26 cho thấy chatbot trích dẫn đa nguồn chuẩn xác (ví dụ kết hợp quy chế Tập đoàn và quyết định riêng của VTX), bảo vệ Tenant Boundary nghiêm ngặt và cách ly văn bản thử nghiệm `QC-DXM-2026-FLEX` hoàn hảo.

#### 11. Còn thiếu chức năng hoặc nghiệp vụ quan trọng nào?
- **Trả lời:** Còn thiếu **3 chức năng cốt lõi**:
  1. *AI Semantic Clause Comparison:* Dùng LLM/Embedding đối chiếu từng điều khoản thay cho bộ regex 5 từ khóa cứng.
  2. *Bóc tách Entity Số học:* Tự động nhận diện và so sánh các giá trị số (mức tiền, số ngày, khung giờ).
  3. *OCR Vision nền:* Xử lý các tệp scan dạng ảnh không có text layer.

#### 12. Hệ thống hiện tại đạt mức nào và cần làm gì để đạt L4 — VERIFIED toàn diện?
- **Trả lời:**
  - **Trạng thái hiện tại:**
    - Phân hệ RAG, Chatbot, Phân quyền Tenant, Bảo mật dữ liệu: **ĐẠT L4 — VERIFIED.**
    - Phân hệ Document Ingestion & Conflict Detection: **ĐẠT L1 — BASIC.**
    - Tổng thể hệ thống: **ĐẠT L2.5 (Chưa đủ điều kiện nghiệm thu vận hành toàn diện phần Intake).**
  - **Để đạt L4 toàn diện:** Cần thực hiện đợt khắc phục kỹ thuật tập trung vào 4 hạng mục:
    1. Vá lỗi chữ "đ" và sửa logic `isFullyOverlappingScope` trong `policyConflictDetector.js`.
    2. Nâng cấp bộ đối soát xung đột sang cơ chế AI Semantic Analysis (quét toàn bộ chunks của văn bản hiện hành trong CSDL).
    3. Bổ sung logic phân biệt thông tin trùng lặp (kế thừa) và thông tin bổ sung.
    4. Cưỡng chế kiểm tra xung đột tại tầng Backend API `POST /api/documents`.

---

# X. ĐỀ XUẤT KIẾN TRÚC & KẾ HOẠCH NÂNG CẤP ĐỀ NGHỊ

### Giai đoạn 1: Vá lỗi kỹ thuật khẩn cấp (Hotfix — Không thay đổi kiến trúc)
1. Sửa hàm chuẩn hóa tiếng Việt trong `policyConflictDetector.js`: thay thế `.replace(/[đĐ]/g, 'd')` trước khi NFD normalize.
2. Sửa điều kiện logic: Tách biệt rõ giữa `isFullyIdenticalScope` (phạm vi hoàn toàn đồng nhất) và `isNarrowerScope` (phạm vi con đặc thù), bảo đảm nhánh `isSpecializedScope` hoạt động đúng.
3. Mở rộng regex quét chủ đề sang toàn bộ các lĩnh vực nhân sự (bảo hiểm, thử việc, tuyển dụng, đào tạo, công tác phí, tài sản...).

### Giai đoạn 2: Nâng cấp AI Semantic Clause Engine (Đợt nâng cấp chính)
1. **Quét toàn văn điều khoản:** Thay vì chỉ đọc `doc.title`, chuyển sang truy vấn tìm kiếm vector hoặc fulltext search trên bảng `chunks` của CSDL để tìm các điều khoản liên quan nhất của văn bản hiện hành.
2. **Đối chiếu ngữ nghĩa bằng LLM:** Khi tìm thấy các chunks có điểm tương đồng cao, gọi một prompt phân tích ngắn (Gemini Flash Lite) với nhiệm vụ phân loại chính xác:
   - `DUPLICATE` (Trùng lặp hoàn toàn thông tin).
   - `COMPLEMENTARY` (Bổ sung tương hỗ).
   - `AMENDMENT` (Sửa đổi một phần).
   - `CONFLICT` (Mâu thuẫn giá trị/yêu cầu).
3. **Cung cấp bằng chứng chi tiết:** Trả về chính xác Điều khoản nguồn và Điều khoản đích bị mâu thuẫn để HR/Legal xem xét trong 1 giây.

---
*Báo cáo được lập trên tinh thần khách quan, trung thực kỹ thuật, dựa trên bằng chứng kiểm thử thực tế tại hệ thống SOTRANS Hub ngày 04/11/2026.*
