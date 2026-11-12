# PHỤ LỤC 4: PHÂN TÍCH KHOẢNG CÁCH NGHIỆP VỤ QUẢN TRỊ TÀI LIỆU DOANH NGHIỆP
## SOTRANS HUB — BUSINESS REQUIREMENT GAP ANALYSIS

**Ngày kiểm toán:** 04/11/2026  
**Mục tiêu:** Rà soát toàn bộ 15 giai đoạn vòng đời tài liệu doanh nghiệp, đối chiếu thực trạng hệ thống với yêu cầu nghiệp vụ thực tế tại SOTRANS Group.

---

### I. ĐÁNH GIÁ 15 GIAI ĐOẠN VÒNG ĐỜI TÀI LIỆU

```
  [1. Tiếp nhận] ──► [2. Loại tài liệu] ──► [3. OCR/Trích xuất] ──► [4. Nhận diện Metadata]
         │
         ▼
  [5. Xác định Phạm vi] ──► [6. Phân loại Chủ đề] ──► [7. Chống trùng tệp] ──► [8. Đối soát Xung đột]
         │
         ▼
  [9. Thiết lập Quan hệ] ──► [10. Kiểm tra Hiệu lực] ──► [11. Chờ HR Xác nhận] ──► [12. Phê duyệt & RAG]
         │
         ▼
  [13. Theo dõi Thay thế] ──► [14. Thu hồi / Lưu trữ] ──► [15. Đồng bộ Dữ liệu Hệ thống]
```

---

#### Giai đoạn 1: Tiếp nhận tài liệu (Intake)
- **Đã có chức năng:** Có (Kéo thả, chọn tệp đơn lẻ hoặc hàng loạt).
- **Có thực sự hoạt động:** Hoạt động tốt qua modal Wizard 3 bước.
- **Đã đáp ứng nghiệp vụ:** Đạt yêu cầu giao diện tiếng Việt, trực quan, hỗ trợ chế độ Cơ bản và Nâng cao.
- **Ngoại lệ còn thiếu:** Chưa có cơ chế quét virus/malware tự động trước khi lưu tệp vào máy chủ.
- **Mức trưởng thành:** **L3 — FUNCTIONAL.**

#### Giai đoạn 2: Nhận diện hình thức văn bản
- **Đã có chức năng:** Có dropdown chọn: Chính sách nhân sự, Quy chế & Quy trình, Nội quy lao động, Sổ tay nhân viên, Cam kết pháp lý.
- **Có thực sự hoạt động:** Hoạt động tốt, lưu đúng vào trường `category`.
- **Đã đáp ứng nghiệp vụ:** Đáp ứng tốt, không dùng category làm điều kiện loại trừ đối soát chéo.
- **Ngoại lệ còn thiếu:** Chưa có AI tự động gợi ý phân loại dựa trên nội dung tệp tải lên (người dùng vẫn phải tự chọn thủ công).
- **Mức trưởng thành:** **L3 — FUNCTIONAL.**

#### Giai đoạn 3: OCR và trích xuất nội dung văn bản
- **Đã có chức năng:** Đọc được nội dung văn bản có sẵn dạng text từ `.pdf`, `.docx`, `.md`, `.txt`.
- **Có thực sự hoạt động:** Hoạt động tốt với các tệp có sẵn lớp văn bản (text layer).
- **Đã đáp ứng nghiệp vụ:** **CHƯA ĐÁP ỨNG** với các tệp scan thuần hình ảnh hoặc bản chụp từ máy photocopy (không có text layer).
- **Ngoại lệ còn thiếu:** Thiếu bộ xử lý OCR thị giác (Tesseract OCR hoặc Google Cloud Vision OCR) để nhận diện tệp scan.
- **Mức trưởng thành:** **L2 — PARTIAL.**

#### Giai đoạn 4: Nhận diện mã văn bản, tiêu đề, ngày ban hành, ngày hiệu lực
- **Đã có chức năng:** Tự động lấy tiêu đề từ tên tệp, tự sinh mã hiệu thông minh (`generateSmartDocCode`), mặc định ngày hiệu lực là ngày hiện tại.
- **Có thực sự hoạt động:** Hoạt động tốt, không còn chặn cứng người dùng khi thiếu mã hiệu chính xác.
- **Đã đáp ứng nghiệp vụ:** Tiết kiệm thời gian nhập liệu cho HR/Admin.
- **Ngoại lệ còn thiếu:** Chưa có AI tự động trích xuất ngày ký, người ký và nơi ban hành nằm ở phần cuối văn bản.
- **Mức trưởng thành:** **L3 — FUNCTIONAL.**

#### Giai đoạn 5: Xác định phạm vi áp dụng (Scope Specification)
- **Đã có chức năng:** Phân định 3 tầng phạm vi (Toàn tập đoàn, Toàn công ty, Phạm vi hẹp phòng ban/khối/địa bàn). Khóa cứng Tenant Boundary cho Admin STL/VTX/SWC.
- **Có thực sự hoạt động:** Hoạt động chính xác cả ở frontend và backend.
- **Đã đáp ứng nghiệp vụ:** Đáp ứng đầy đủ quy tắc không tự ý mở rộng phạm vi, phân định rõ ràng giữa các đơn vị thành viên.
- **Mức trưởng thành:** **L4 — VERIFIED.**

#### Giai đoạn 6: Phân loại nội dung và chủ đề (Topic Classification)
- **Đã có chức năng:** Hàm `extractCoreTopics` phân loại 5 nhóm chủ đề: `thoi_gio_lam_viec`, `phu_cap_cong_tac_phi`, `an_toan_lao_dong`, `ky_luat_lao_dong`, `che_do_nghi_phep`.
- **Có thực sự hoạt động:** Hoạt động được với từ khóa khớp regex, **nhưng bị lỗi không nhận diện chữ "đ"** dẫn đến mất chủ đề an toàn lao động.
- **Đã đáp ứng nghiệp vụ:** **CHƯA ĐÁP ỨNG.** Quá hẹp, bỏ sót mọi chủ đề khác của doanh nghiệp (bảo hiểm, đào tạo, mua sắm, bảo mật...).
- **Ngoại lệ còn thiếu:** Cần chuyển sang mô hình phân loại chủ đề linh hoạt bằng AI Embedding hoặc LLM Zero-shot Classification.
- **Mức trưởng thành:** **L1 — BASIC.**

#### Giai đoạn 7: Phát hiện tài liệu trùng lặp (Duplicate Detection)
- **Đã có chức năng:** Tính mã băm SHA-256 chống trùng tệp nhị phân; kiểm tra `doc_code` chống trùng số hiệu văn bản.
- **Có thực sự hoạt động:** Hoạt động hoàn hảo, chặn tức thì tệp trùng (HTTP 409).
- **Đã đáp ứng nghiệp vụ:** Đạt yêu cầu cao về bảo toàn kho dữ liệu.
- **Ngoại lệ còn thiếu:** Chưa phát hiện được 2 tệp scan có cùng nội dung chữ nhưng mã băm ảnh khác nhau.
- **Mức trưởng thành:** **L3 — FUNCTIONAL.**

#### Giai đoạn 8: Phát hiện thông tin trùng lặp hoặc mâu thuẫn (Conflict Detection)
- **Đã có chức năng:** Engine `detectPolicyConflicts` đối soát phạm vi, ngày hiệu lực và chủ đề.
- **Có thực sự hoạt động:** Có chạy tại Bước 3 của Wizard và API `/api/documents/detect-conflicts`.
- **Đã đáp ứng nghiệp vụ:** **CHƯA ĐÁP ỨNG.**
  - Chỉ đọc tiêu đề văn bản cũ, không đọc toàn văn.
  - Đánh đồng thông tin trùng lặp và thông tin bổ sung thành xung đột trực tiếp `HIGH`.
  - Lỗi logic `isFullyOverlappingScope` làm hỏng phân loại ngoại lệ phòng ban.
  - Không bóc tách được số liệu thực tế (VND, Ngày, Giờ).
- **Mức trưởng thành:** **L1 — BASIC.**

#### Giai đoạn 9: Xác định quan hệ với tài liệu hiện có (Relationship Engine)
- **Đã có chức năng:** Chuẩn hóa 7 loại quan hệ: `independent`, `supersedes`, `amends`, `supplements`, `exception_to`, `clarifies`, `applies_with`. Có bảng `document_relationships` lưu lịch sử và người duyệt. Có cơ chế chặn mâu thuẫn ngược chiều.
- **Có thực sự hoạt động:** Hoạt động tốt tại UI Quản lý quan hệ và Modal Upload.
- **Đã đáp ứng nghiệp vụ:** Phản ánh đúng bản chất quan hệ văn bản pháp lý.
- **Ngoại lệ còn thiếu:** Chưa có liên kết quan hệ ở cấp điều khoản cụ thể (`clause_id`).
- **Mức trưởng thành:** **L3 — FUNCTIONAL.**

#### Giai đoạn 10: Kiểm tra hiệu lực và tính hợp lệ thời gian
- **Đã có chức năng:** Quản lý ngày ban hành (`issue_date`), ngày bắt đầu hiệu lực (`effective_date`), ngày hết hiệu lực (`expiry_date`).
- **Có thực sự hoạt động:** Nếu `effective_date > today`, văn bản tự động chuyển trạng thái `scheduled`. Có cronjob `autoActivateDueDocuments` tự kích hoạt khi đến hạn.
- **Đã đáp ứng nghiệp vụ:** Đúng chuẩn nghiệp vụ quản lý văn bản quy phạm nội bộ.
- **Mức trưởng thành:** **L4 — VERIFIED.**

#### Giai đoạn 11: Chờ HR/Admin xác nhận (Human-in-the-Loop)
- **Đã có chức năng:** Trạng thái `pending_approval`, cảnh báo xung đột hiển thị bằng chứng trích đoạn để HR/Admin xem xét trước khi ra quyết định.
- **Có thực sự hoạt động:** Đúng nguyên tắc: AI chỉ đề xuất, con người bấm phê duyệt.
- **Đã đáp ứng nghiệp vụ:** Đảm bảo tính kiểm soát con người, không tự động đưa văn bản vào sản xuất.
- **Mức trưởng thành:** **L4 — VERIFIED.**

#### Giai đoạn 12: Phê duyệt và đưa vào RAG (Approval & RAG Ingestion)
- **Đã có chức năng:** Endpoint `POST /api/documents/:id/approve` yêu cầu quyền `document.approve`, kiểm tra Separation of Duties (chống tự phê duyệt), tự động chuyển văn bản cũ sang `superseded` và kích hoạt đồng bộ tức thời sang Qdrant (`syncDocumentToQdrant`).
- **Có thực sự hoạt động:** Hoạt động chính xác và an toàn.
- **Đã đáp ứng nghiệp vụ:** Đáp ứng đầy đủ quy tắc quản trị doanh nghiệp.
- **Mức trưởng thành:** **L4 — VERIFIED.**

#### Giai đoạn 13: Theo dõi thay thế, sửa đổi, bổ sung và lịch sử phiên bản
- **Đã có chức năng:** Quản lý `document_family_id`, tự động tăng version `v1` $\rightarrow$ `v2`, bảng `doc_audit_log` ghi nhận đầy đủ người thao tác, thời gian, hành động.
- **Có thực sự hoạt động:** Hoạt động tốt và có thể tra cứu lịch sử trong CSDL.
- **Đã đáp ứng nghiệp vụ:** Đạt yêu cầu kiểm toán và truy vết thay đổi.
- **Mức trưởng thành:** **L4 — VERIFIED.**

#### Giai đoạn 14: Thu hồi, xóa hoặc lưu trữ tài liệu (Revocation / Archive)
- **Đã có chức năng:** Chuyển trạng thái `revoked`, `archived`, hoặc xóa mềm vào `trash` (lưu 30 ngày trước khi xóa vĩnh viễn).
- **Có thực sự hoạt động:** Khi thu hồi hoặc lưu trữ, vector chunks trong Qdrant được cập nhật ngay lập tức sang trạng thái tương ứng để loại khỏi phạm vi tra cứu RAG của nhân viên.
- **Đã đáp ứng nghiệp vụ:** Bảo đảm tài liệu hết hiệu lực không bị chatbot trả lời nhầm.
- **Mức trưởng thành:** **L4 — VERIFIED.**

#### Giai đoạn 15: Đồng bộ dữ liệu hệ thống (PostgreSQL ↔ Qdrant ↔ n8n)
- **Đã có chức năng:** Dịch vụ `qdrantSyncService.js` đồng bộ tức thời mọi thay đổi metadata, status, scope sang Qdrant.
- **Có thực sự hoạt động:** Kiểm toán thực tế ghi nhận: **104 chunks trong PostgreSQL khớp chính xác 104 vector points trong Qdrant**, không có vector mồ côi (0 orphans), tỷ lệ đồng bộ 100%.
- **Đã đáp ứng nghiệp vụ:** Đạt độ tin cậy dữ liệu cấp doanh nghiệp.
- **Mức trưởng thành:** **L4 — VERIFIED.**

---

### II. MA TRẬN MỨC ĐỘ TRƯỞNG THÀNH TỔNG THỂ (L0 - L4)

| Giai đoạn vòng đời | Mức hiện tại | Mức mục tiêu | Khoảng cách & Tồn đọng chính |
| :--- | :---: | :---: | :--- |
| 1. Tiếp nhận tài liệu (Intake) | **L3** | L4 | Thiếu quét mã độc (Antivirus scan). |
| 2. Nhận diện hình thức văn bản | **L3** | L4 | Thiếu AI tự động gợi ý phân loại từ file. |
| 3. OCR & Trích xuất nội dung | **L2** | L4 | Chưa có OCR Vision xử lý file scan thuần ảnh. |
| 4. Nhận diện Metadata | **L3** | L4 | Chưa bóc tách ngày ký, thẩm quyền ban hành ở chân trang. |
| 5. Xác định phạm vi áp dụng | **L4** | L4 | **ĐÃ HOÀN THIỆN:** Khóa cứng 3 tầng phạm vi và Tenant Boundary. |
| 6. Phân loại nội dung & Chủ đề | **L1** | L3 | Lỗi chữ "đ" tiếng Việt, quá phụ thuộc vào 5 regex cứng. |
| 7. Chống trùng tệp (Duplicate) | **L3** | L4 | Đạt SHA-256; thiếu so sánh chữ đối với file scan khác hash. |
| 8. Đối soát xung đột (Conflict) | **L1** | L4 | **KHOẢNG CÁCH LỚN NHẤT:** Chỉ đọc tiêu đề văn bản cũ, lỗi `isFullyOverlappingScope`, thiếu so sánh số liệu thực tế. |
| 9. Thiết lập Quan hệ (Relationship) | **L3** | L4 | Đạt chuẩn 7 loại quan hệ; thiếu liên kết cấp điều khoản. |
| 10. Kiểm tra Hiệu lực | **L4** | L4 | **ĐÃ HOÀN THIỆN:** Scheduled activation, kiểm tra ngày tháng. |
| 11. Xác nhận Human-in-the-loop | **L4** | L4 | **ĐÃ HOÀN THIỆN:** AI chỉ gợi ý, con người phê duyệt. |
| 12. Phê duyệt & RAG Ingestion | **L4** | L4 | **ĐÃ HOÀN THIỆN:** Separation of Duties, cập nhật Qdrant tức thì. |
| 13. Theo dõi Lịch sử & Version | **L4** | L4 | **ĐÃ HOÀN THIỆN:** Document family, version increment, audit log. |
| 14. Thu hồi / Lưu trữ | **L4** | L4 | **ĐÃ HOÀN THIỆN:** Soft delete 30 ngày, cách ly khỏi RAG. |
| 15. Đồng bộ Dữ liệu Hệ thống | **L4** | L4 | **ĐÃ HOÀN THIỆN:** 104/104 points đồng bộ tuyệt đối 1:1. |

---

### III. CÁC QUYẾT ĐỊNH NGHIỆP VỤ CẦN XÁC NHẬN (NEEDS BUSINESS DECISION)

1. **Quyết định về Thông tin trùng lặp (Case C):**
   - *Vấn đề:* Khi Quy chế Tập đoàn và Chính sách Công ty con cùng nêu thông tin giống nhau (ví dụ cùng 08:00–17:00), hệ thống nên:
     - **Phương án A:** Coi là thông tin kế thừa/nhắc lại hợp lệ, chỉ hiển thị thông báo "Thông tin trùng khớp với Quy chế Tập đoàn" và cho phép ban hành bình thường.
     - **Phương án B:** Khuyến nghị hợp nhất, nhắc nhở công ty con không cần ban hành lại quy định trùng lặp nếu Tập đoàn đã có quy chế khung.
2. **Quyết định về Thông tin bổ sung (Case D):**
   - *Vấn đề:* Khi văn bản mới bổ sung giờ nghỉ trưa hoặc quy định phụ cấp cho vị trí mới chưa có trong quy chế cũ:
     - Hệ thống có được tự động gợi ý thiết lập quan hệ `supplements` (Bổ sung) hay bắt buộc HR phải tự chọn thủ công?
3. **Quyết định về Sửa đổi cấp điều khoản (Case E):**
   - *Vấn đề:* Doanh nghiệp có yêu cầu lưu vết chính xác đến từng Điều khoản (Ví dụ: *"Điều 5 sửa đổi Khoản 2 Điều 10 của Quy chế số 01"*) hay chỉ cần quản lý quan hệ sửa đổi ở cấp văn bản?
4. **Quyết định về Quy định vs Chính sách:**
   - *Vấn đề:* Theo phân cấp văn bản nội bộ SOTRANS:
     - Quy chế/Quy định có giá trị pháp lý cao hơn Chính sách hay ngang hàng?
     - Nếu có mâu thuẫn giữa Quy chế do Tổng Giám đốc ký và Chính sách do Giám đốc Khối ký, hệ thống có tự động xếp ưu tiên cho Quy chế của Tổng Giám đốc không?

---
*Tài liệu này là phụ lục kỹ thuật đi kèm Báo cáo kiểm toán toàn diện `COMPREHENSIVE_DOCUMENT_GOVERNANCE_BUSINESS_AUDIT.md`.*
