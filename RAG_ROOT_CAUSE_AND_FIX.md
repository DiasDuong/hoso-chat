# NGUYÊN NHÂN GỐC VÀ GIẢI PHÁP KHẮC PHỤC TRIỆT ĐỂ (ROOT CAUSE & FIX)
**Dự án:** SOTRANS AI Workspace — `D:\hoso-chat`  
**Tài liệu tham chiếu:** `RAG_ANSWER_BUG_AUDIT.md`

---

## 1. NGUYÊN NHÂN GỐC (ROOT CAUSES IDENTIFIED)

### 1.1 Nguyên nhân gốc 1: Thiếu quy tắc phân định nhóm nhân viên & ca làm việc trong Prompt System Instructions (`Build_Context`)
- **Vị trí:** Node `Build_Context` trong n8n workflow `HR_Policy_Chat` (id `wbGnHNQ7oGkpQFEW`) và `HR_Policy_QA` (id `btcmLiJpb11xZ5BY`).
- **Phân tích:**
  - Prompt cũ chỉ yêu cầu: *"CÓ BẰNG CHỨNG TRỰC TIẾP... NHIỀU TÀI LIỆU HOẶC NHIỀU PHIÊN BẢN (v1 vs v2)"*.
  - Prompt hoàn toàn không có chỉ dẫn hướng dẫn LLM phân định giữa **Khung thời giờ chuẩn chung toàn tập đoàn** (áp dụng mặc định cho toàn bộ nhân viên) và **Ca làm việc đặc thù theo văn bản riêng** (chỉ áp dụng cho nhân sự được phân ca tại đơn vị tương ứng).
  - Kết quả: Khi LLM nhận được cả 2 đoạn văn bản (1 đoạn ghi 12:00-13:00, 1 đoạn ghi 12:30-13:30), nó tổng hợp cơ học cả 2 đoạn vào câu trả lời cho cả hai câu hỏi A và B mà không giải thích điều kiện áp dụng hay lý do có 2 mốc thời gian khác nhau.

### 1.2 Nguyên nhân gốc 2: Mất ngữ cảnh hội thoại đa lượt (Multi-turn Context Loss)
- **Vị trí:**
  - Giao diện chat: `chat/index.html` gọi `fetch('/api/policy/chat')` chỉ gửi `{ message: text }`, không truyền `conversation_id`.
  - Backend router: `auth-service/routes/policy.js` không nhận hoặc không lấy lịch sử tin nhắn từ bảng `ai_messages`.
  - Node `Rewrite` trong n8n: Chỉ nhận câu hỏi hiện tại mà không có các lượt trao đổi trước đó.
- **Phân tích:** Khi người dùng hỏi nối tiếp (ví dụ: *"Thế còn khối văn phòng thì sao?"* hoặc câu hỏi thu hẹp phạm vi), hệ thống coi đây là câu hỏi độc lập, không thể hiểu được ý định tiếp nối từ chủ đề trước đó.

### 1.3 Nguyên nhân gốc 3: Lỗi Typo trong tiêu đề văn bản tại PostgreSQL và Qdrant
- **Vị trí:** Bản ghi văn bản v3 (`298d5728-7a73-4faf-ade8-b819991bdb64`).
- **Phân tích:** Tiêu đề lưu trong DB và Qdrant là `'Quy dinh Thoi gian Lam viec   Khong Van phong (Ca 09h30)'` (chữ **`Khong`** thay vì **`Khoi`**, kèm nhiều dấu cách thừa).
- **Hệ quả:** Tìm kiếm từ khóa (TSV / Keyword Search) với cụm `"khối văn phòng"` bị giảm điểm khớp trên tiêu đề tài liệu.

### 1.4 Nguyên nhân gốc 4: Thiếu bộ nhớ đệm ràng buộc phiên bản văn bản (Version-Bound Policy Cache)
- Hệ thống tra cứu quy định chưa có tầng cache thông minh. Các câu hỏi lặp lại của người dùng luôn phải gọi lại toàn bộ pipeline LLM (tốn 4-8 giây và chi phí token).
- Đồng thời, nếu áp dụng cache thông thường, khi quản trị viên cập nhật hoặc thu hồi văn bản, cache cũ sẽ trả dữ liệu sai. Cần có cơ chế cache ràng buộc mã băm phiên bản (`active_doc_version_hash`) để tự động vô hiệu hóa tức thời.

---

## 2. CÁC BIỆN PHÁP KHẮC PHỤC ĐÃ TRIỂN KHAI (IMPLEMENTED FIXES)

### 2.1 Cải tiến Prompt System Instructions trong n8n (`Build_Context`)
Đã nâng cấp chỉ dẫn hệ thống trong node `Build_Context` với các quy tắc nghiệp vụ rõ ràng:
1. **Phân định rõ ràng nhóm nhân viên / khối đối tượng (Employee Group Clarity):**
   - Khi câu hỏi hỏi về một khối cụ thể (*Khối văn phòng, Khối hiện trường, Lái xe, Ca kíp...*):
     - Trả lời trọng tâm cho khối đối tượng đó.
     - Nêu rõ: Khung giờ chuẩn toàn tập đoàn (08:00 - 17:00, nghỉ trưa 12:00 - 13:00) áp dụng mặc định cho nhân viên khối văn phòng; còn ca đặc thù (09:30 - 18:30, nghỉ trưa 12:30 - 13:30 theo HR-TG-002) chỉ áp dụng cho nhân viên được xếp vào ca làm việc này tại đơn vị tương ứng.
     - Nêu rõ điều kiện áp dụng để người dùng biết mình thuộc ca nào thì áp dụng khung giờ đó.
   - Khi câu hỏi chung chung (*"Thời gian nghỉ trưa như thế nào?"*):
     - Nêu khung chuẩn chung toàn tập đoàn trước (12:00 - 13:00).
     - Nêu các ca làm việc đặc thù (12:30 - 13:30) như trường hợp ngoại lệ theo ca.
2. **Quy định chung vs Quy định đặc thù đơn vị thành viên:**
   - Quy chế toàn tập đoàn (GLOBAL-POLICY) thiết lập khung tiêu chuẩn chung.
   - Quy định của đơn vị thành viên / văn bản ca riêng chỉ áp dụng cho nhân viên thuộc đơn vị/ca đó.
   - Nếu không rõ ca làm việc của người hỏi, khuyến nghị liên hệ Trưởng bộ phận hoặc phòng Nhân sự để xác nhận chính thức.

### 2.2 Nâng cấp Node `Rewrite` hỗ trợ lịch sử hội thoại
- Trong n8n workflow, node `Rewrite` được cập nhật để đọc `history` từ webhook body.
- Bổ sung quy tắc:
  > *"XỬ LÝ CÂU HỎI NỐI TIẾP (FOLLOW-UP): Nếu câu hỏi mới là câu hỏi tiếp nối làm rõ, thu hẹp phạm vi, hoặc thay đổi đối tượng áp dụng (ví dụ: 'thế còn khối văn phòng?', 'vậy ca đêm thì sao?', 'còn lái xe?'): BẮT BUỘC phải kết hợp chủ đề của câu hỏi trước với đối tượng mới để tạo thành một câu truy vấn tìm kiếm HOÀN CHỈNH, ĐỘC LẬP."*

### 2.3 Cập nhật `chat/index.html` và `auth-service/routes/policy.js`
1. **`chat/index.html`:**
   - Cập nhật cả 2 vị trí gửi request tra cứu quy định (dòng 7843 và dòng 8375) để truyền `conversation_id: targetConvId`.
2. **`auth-service/routes/policy.js`:**
   - Tiếp nhận `conversation_id` và truy vấn 6 tin nhắn gần nhất từ bảng `ai_messages` nếu người dùng không truyền trực tiếp mảng `history`.
   - Xây dựng tầng **Policy Response Cache** lưu trữ phản hồi theo khóa:
     $$\text{CacheKey} = \text{SHA256}(\text{normalizedQuery} \parallel \text{historyKey} \parallel \text{company} \parallel \text{role} \parallel \text{scope} \parallel \text{docHash})$$
   - Mã băm phiên bản tài liệu (`docHash`) được tính toán động từ PostgreSQL:
     ```sql
     SELECT md5(COALESCE(string_agg(
       concat_ws(':', doc_version_id::text, version::text, status::text, file_sha256, title),
       ',' ORDER BY doc_version_id
     ), '')) as doc_hash
     FROM documents WHERE status = 'active'
     ```
   - Khi có bất kỳ thay đổi nào trong bảng `documents` (ban hành bản mới, sửa tiêu đề, thu hồi bản cũ), `docHash` lập tức thay đổi $\rightarrow$ Tự động vô hiệu hóa toàn bộ cache cũ mà không cần can thiệp thủ công!

### 2.4 Sửa lỗi Typo tiêu đề văn bản trong PostgreSQL & Qdrant
- Cập nhật tiêu đề văn bản `298d5728-7a73-4faf-ade8-b819991bdb64` thành:
  `Quy định Thời gian Làm việc - Khối Văn phòng (Ca 09h30)`
- Đồng bộ payload của 5 points tương ứng trong Qdrant collection `hr_docs`.
