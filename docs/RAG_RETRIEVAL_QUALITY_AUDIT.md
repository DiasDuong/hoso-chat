# PHỤ LỤC 3: KIỂM TOÁN CHẤT LƯỢNG TRUY XUẤT RAG & CHATBOT QUY ĐỊNH
## SOTRANS HUB — RAG RETRIEVAL & CHATBOT QUALITY AUDIT

**Ngày kiểm toán:** 04/11/2026  
**Phạm vi:** Pipeline RAG tại `auth-service/routes/policy.js`, n8n Workflow `HR_Policy_Chat`, Qdrant Vector Collection `hr_docs`, PostgreSQL `chunks` và mô hình Gemini 3.5 Flash Lite.

---

### I. KIẾN TRÚC THỰC TẾ CỦA PIPELINE TRUY XUẤT RAG

Pipeline tra cứu Quy định & Chính sách của SOTRANS Hub được vận hành qua quy trình 14 giai đoạn liên hoàn:

```
[Người dùng gửi câu hỏi]
         │
         ▼
[1. Express: POST /api/policy/chat]
   ├── Xác thực JWT & Khóa cứng Tenant (STL / VTX / SWC)
   ├── Chặn người dùng Guest (HTTP 403 Forbidden)
   ├── Phân quyền phạm vi Production (active) vs Testing (draft)
   └── Kiểm tra Policy Version-Bound Hash Cache (TTL 1h)
         │ (Nếu Cache Miss)
         ▼
[2. n8n Webhook: /webhook/hr-policy-chat]
         │
         ▼
[3. Node Rewrite: Gemini 3.5 Flash Lite]
   └── Tách 3 biến thể: Primary Query, Regulatory Query, Entity Shift Query
         │
         ▼
[4. Node Prep: JavaScript Code]
   ├── Xác thực Branch nghiêm ngặt từ claims máy chủ
   ├── Tạo Tokenized & Phrase-Aware BM25 Query (`w1 <-> w2`)
   └── Kiểm tra Explicit Pilot Detection (`is_explicit_pilot`)
         │
         ├──────────────────────────────────────────┐
         ▼                                          ▼
[5. Node Embed: Gemini 768-dim]           [8. Node PG Keyword: PostgreSQL]
   └── Tạo vector cho 3 biến thể query        └── Truy vấn Fulltext Search (ts_rank_cd)
         │                                          │
         ▼                                          │
[6. Node Build Search: Filters]                     │
   └── status=active, role_access, branch_scope     │
         │                                          │
         ▼                                          │
[7. Node Qdrant Search: Batch (Top 15)]             │
         │                                          │
         └────────────────────┬─────────────────────┘
                              ▼
                     [9. Node RRF: Reciprocal Rank Fusion]
                        └── Hợp nhất bảng xếp hạng Vector + Keyword
                              │
                              ▼
                     [10. Node PG Recheck: PostgreSQL Hybrid Join]
                        ├── Quét lại quyền, thời hạn hiệu lực (`effective_date <= CURRENT_DATE`)
                        ├── Lọc bỏ tài liệu `is_restricted_general = true` nếu không phải Pilot Query
                        └── Tự động nạp `related_chunks` qua quan hệ `supplements` / `amends` / `exception_to`
                              │
                              ▼
                     [11. Node Build_Context: Structured Prompt]
                        ├── Đánh số thứ tự từng văn bản (Title, Version, Status, Effective Date)
                        ├── Gắn nhãn `[QUY ĐỊNH NGOẠI LỆ]` hoặc `[QUY ĐỊNH BỔ SUNG]`
                        ├── Gắn Disclaimer bắt buộc nếu là `pilot_unverified`
                        └── Chèn cảnh báo nếu quan hệ chính sách đang `pending_review`
                              │
                              ▼
                     [12. Node Gemini Answer: LLM Synthesis]
                        └── Trả lời JSON gồm `answer`, `citations` (chunk_id + evidence_quote)
                              │
                              ▼
                     [13. Node Validator: Strict Grounding Check]
                        ├── Kiểm tra chunk_id có thực sự tồn tại trong context không
                        ├── Kiểm tra `evidence_quote` có xuất hiện nguyên văn trong chunk không
                        └── Nếu trích dẫn giả mạo $\rightarrow$ Chặn, trả về câu từ chối an toàn
                              │
                              ▼
                     [14. Express: Trả kết quả & Lưu Cache theo Hash phiên bản]
```

---

### II. ĐÁNH GIÁ CHI TIẾT THEO CÁC TIÊU CHÍ AN TOÀN & CHẤT LƯỢNG

#### 1. Bảo mật phân vùng Tenant (Tenant Isolation)
- **Cơ chế:**
  - Token JWT chứa `company_id`. Endpoint `/api/policy/chat` tự động gán `targetBranch` tương ứng (`STL` $\rightarrow$ `sotrans_logistics`, `VTX` $\rightarrow$ `vietranstimex`, `SWC` $\rightarrow$ `sowatco`).
  - Mọi tham số do client gửi lên (như tự ý gửi `company_id=VTX`) đều bị ghi đè bởi claims đã xác thực trong JWT.
  - Phía n8n `Prep` node: `branches = ['all', verifiedBranch]`.
  - Qdrant Search Filter và PG Recheck Filter đều bắt buộc điều kiện: `d.branch_scope && branches`.
- **Kết quả kiểm chứng:**
  - Nhân viên STL (`emp_stl`) hỏi về quy trình vận chuyển siêu trường siêu trọng của VTX (`20/QD-VTX`) $\rightarrow$ Chatbot trả lời `answerable: false`, **hoàn toàn không làm lộ bất kỳ điều khoản nào của VTX** (Kiểm thử TC27: **PASS**).
- **Đánh giá:** **L4 — VERIFIED.**

#### 2. Cơ chế cách ly tài liệu thử nghiệm (Explicit Pilot Isolation — `QC-DXM-2026-FLEX`)
- **Vấn đề lịch sử:** Tài liệu `QC-DXM-2026-FLEX` (Dự thảo làm việc số thí điểm cho Khối Chuyển đổi số) trước đây bị chatbot lấy làm chính sách chung cho toàn bộ nhân viên, gây nguy cơ pháp lý và rủi ro lao động.
- **Biện pháp khắc phục đã được kiểm toán:**
  1. Trong CSDL: Bảng `document_retrieval_controls` đánh dấu văn bản này có `is_restricted_general = true`, `retrieval_mode = 'pilot_unverified'`.
  2. Trong n8n `Prep` node:
     ```javascript
     const isExplicitPilot = /(flexitime|chuyen\s*doi\s*so|chuyển\s*đổi\s*số|linh\s*hoat|linh\s*hoạt|qc-dxm|dxm)/i.test(un);
     ```
  3. Trong SQL `PG Recheck`:
     ```sql
     AND (rc.is_restricted_general IS NOT TRUE OR rc.is_restricted_general = FALSE OR $4::boolean = TRUE)
     ```
     Trong đó `$4` chính là `is_explicit_pilot`.
- **Kết quả kiểm chứng thực tế:**
  - Khi hỏi chung *"Mấy giờ vào làm buổi sáng?"*: Tài liệu bị ẩn 100%, chatbot trả lời theo Quy chế chuẩn `01/QC-SOTRANS` (08:00–17:00).
  - Khi hỏi đích danh *"Quy định về flexitime làm việc linh hoạt chuyển đổi số 2026?"*: Tài liệu được nạp nhưng **bắt buộc kèm theo Disclaimer cảnh báo**:
    > *"LƯU Ý: Đây là nội dung dự thảo thử nghiệm mô hình làm việc số 2026, áp dụng thí điểm và CHƯA được Ban Nhân sự / Tập đoàn ban hành chính thức thành chính sách chung, KHÔNG khẳng định là quyền lợi áp dụng cho toàn bộ nhân viên."*
- **Đánh giá:** **L4 — VERIFIED.**

#### 3. Xử lý đa văn bản & Phân cấp chính sách (Multi-Policy Synthesis)
- **Tình huống:** Quy chế Chế độ phụ cấp của Tập đoàn (`18/2023/QC-SOTRANS`) quy định chế độ chung, trong khi Vietranstimex có Quyết định riêng (`45/2024/QĐ-VTX`) bổ sung phụ cấp công trường cho thiết bị SPMT.
- **Kết quả kiểm chứng:**
  - Nhân viên VTX hỏi về phụ cấp công trường: Chatbot trích dẫn đồng thời cả 2 văn bản, nêu rõ mức phụ cấp bổ sung của VTX (500.000 đ – 700.000 đ/ngày) trên nền tảng quy chế Tập đoàn (Kiểm thử TC22: **PASS**).
  - Trích dẫn (Citations) hiển thị rõ nguồn từng văn bản kèm phiên bản và điều khoản.
- **Đánh giá:** **L4 — VERIFIED.**

#### 4. Tính toàn vẹn của trích dẫn (Strict Evidence Grounding & Verification)
- **Cơ chế:** Node `Validator` trong n8n đóng vai trò là "Cổng gác đền" (Guardrail):
  - Nhận câu trả lời và mảng `citations` từ Gemini.
  - So khớp `chunk_id` với bản đồ chunk thực tế được cấp trong `Build_Context`.
  - Chuẩn hóa văn bản (bỏ dấu tiếng Việt, ký tự đặc biệt) và kiểm tra xem chuỗi `evidence_quote` có xuất hiện thực tế trong nội dung chunk không.
  - Nếu `evidence_quote` không tìm thấy trong chunk $\rightarrow$ Loại bỏ trích dẫn đó khỏi danh sách nguồn.
  - Nếu toàn bộ trích dẫn bị loại bỏ $\rightarrow$ Đảo ngược trạng thái thành `answerable: false` và phát ra thông điệp an toàn: *"Hiện tại tài liệu nội bộ mình được cung cấp chưa có thông tin về nội dung bạn hỏi..."*.
- **Đánh giá:** **L4 — VERIFIED.** Loại bỏ hoàn toàn hiện tượng "Ảo giác trích dẫn" (Citation Hallucination).

#### 5. Phản hồi khi phát hiện mâu thuẫn chính sách (Conflict Awareness)
- **Cơ chế:** Trong system instruction của Gemini:
  > *"Khi phát hiện các văn bản trong ngữ cảnh quy định mâu thuẫn hoặc xung đột về cùng một vấn đề... bạn PHẢI nêu rõ sự khác biệt giữa các văn bản, cảnh báo rằng có sự không thống nhất giữa các quy định, và hướng dẫn nhân viên liên hệ phòng Nhân sự để được hướng dẫn chính thức thay vì tự ý chọn một giá trị."*
- **Kết quả kiểm chứng Sandbox:**
  Khi đưa vào ngữ cảnh 2 văn bản cùng quy định giờ làm việc nhưng mâu thuẫn (08:00 vs 08:30):
  - Chatbot **không tự ý chọn 1 văn bản** theo ngày upload hay version.
  - Chatbot chỉ ra rõ ràng: `[01/QC-SOTRANS]` ghi 08:00, `[99/CS-VPH]` ghi 08:30, nêu rõ sự không thống nhất và khuyên liên hệ phòng Nhân sự.
- **Đánh giá:** **L4 — VERIFIED.**

---

### III. CÁC HẠN CHẾ & KHOẢNG CÁCH CẦN LƯU Ý

1. **Khâu Chunking có thể làm phân tách ngữ cảnh điều khoản dài:**
   - Kích thước chunk tối đa là 1500 ký tự. Với các điều khoản pháp lý rất dài (nhiều điểm a, b, c, d...), phần ngoại lệ ở cuối điều khoản có thể bị ngắt sang chunk tiếp theo. Nếu câu hỏi chỉ khớp với chunk đầu, chunk thứ hai có thể bị điểm RRF thấp và không được đưa vào context.
2. **Validator mới chỉ xác thực 1 chiều (Quote có trong Chunk):**
   - Validator kiểm tra `evidence_quote` có nằm trong chunk không, nhưng chưa kiểm tra mức độ suy diễn logic (NLI - Natural Language Inference) giữa `answer` và `evidence_quote`. Mặc dù temperature được đặt ở mức rất thấp (0.1) giúp hạn chế tối đa suy diễn sai, nhưng về mặt kiến trúc vẫn cần bổ sung NLI check trong tương lai.
3. **Phụ thuộc vào tính sẵn sàng của n8n Webhook:**
   - Nếu container n8n bị restart hoặc quá tải, API `/api/policy/chat` sẽ chờ tối đa 120 giây trước khi trả lỗi HTTP 504. Cần bổ sung cơ chế circuit-breaker và hàng đợi xử lý khi lưu lượng cao.

---
*Tài liệu này là phụ lục kỹ thuật đi kèm Báo cáo kiểm toán toàn diện `COMPREHENSIVE_DOCUMENT_GOVERNANCE_BUSINESS_AUDIT.md`.*
