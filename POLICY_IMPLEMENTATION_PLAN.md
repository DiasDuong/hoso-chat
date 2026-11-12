# SOTRANS HUB — KẾ HOẠCH TRIỂN KHAI NHANH (CHECKPOINT 0)
## FAST-TRACK IMPLEMENTATION PLAN — POLICY & REGULATORY GOVERNANCE V2

> **Dự án:** SOTRANS Hub — Logistics AI Platform  
> **Workspace:** `D:\hoso-chat`  
> **Nhánh thực thi:** `feat/policy-conflict-engine-v2`  
> **Môi trường triển khai:** Staging biệt lập  
> **Phương châm:** FAST-TRACK — CHECKPOINT KIỂM SOÁT — BẢO VỆ TUYỆT ĐỐI PRODUCTION

---

## 1. NGUYÊN TẮC THỰC THI NHANH (FAST-TRACK RULES)

1. **Tái sử dụng tối đa:** Không viết lại những gì đã chạy ổn định. Chỉ sửa chữa khuyết tật và bổ sung các hàm thiếu hụt theo đúng Ma trận Khoảng trống `POLICY_GAP_MATRIX.md`.
2. **Kiểm thử tự động song hành:** Mỗi Checkpoint hoàn thành phải có script kiểm thử tự động tương ứng với dữ liệu test có tiền tố `test_run_id` và mã kiểm thử duy nhất.
3. **Chuyển giao tuần tự tự động:** Khi một Checkpoint đạt 100% tiêu chí nghiệm thu và đảm bảo an toàn dữ liệu, hệ thống tự động bước sang Checkpoint tiếp theo mà không cần chờ lệnh phê duyệt lặp lại cho các bước nội bộ.
4. **Điểm dừng bắt buộc (Stop-the-line Triggers):** Dừng ngay lập tức nếu phát hiện nguy cơ ảnh hưởng Production, nghi ngờ rò rỉ mạng Staging sang Production, hoặc thất bại bài test an toàn dữ liệu.

---

## 2. KẾ HOẠCH CHI TIẾT 6 CHECKPOINTS

```
[CHECKPOINT 0] Preflight & Baseline Audit ──► [POLICY_BASELINE_AUDIT.md, GAP_MATRIX, PLANS]
       │
       ▼
[CHECKPOINT 1] Document Lifecycle & Governance ──► [State Machine + DAG Cycle Detection]
       │                                            Report: CHECKPOINT_1_REPORT.md
       ▼
[CHECKPOINT 2] Conflict Engine V2 ───────────────► [9-Class Engine + Golden Dataset Test]
       │                                            Report: CHECKPOINT_2_REPORT.md + GOLDEN_DATASET
       ▼
[CHECKPOINT 3] Reliable Processing & Publication ──► [Zero-Chunk Gate + Durable Multi-instance Lease]
       │                                            Report: CHECKPOINT_3_REPORT.md + DATA_CONSISTENCY
       ▼
[CHECKPOINT 4] Advanced RAG & Policy Assistant ───► [Validity Filtering + Precise Citations]
       │                                            Report: CHECKPOINT_4_REPORT.md + RAG_EVALUATION
       ▼
[CHECKPOINT 5] Integration & Final Acceptance ────► [Full 8-Domain Regression + Release Readiness]
                                                    Report: FINAL_ACCEPTANCE_REPORT.md
```

---

### CHECKPOINT 1 — DOCUMENT LIFECYCLE & GOVERNANCE (GIAI ĐOẠN 1)
* **Mục tiêu:** Hoàn thiện Domain 1 và Domain 2.
* **Hành động cụ thể:**
  1. Xây dựng hàm `validateStateTransition(currentStatus, targetStatus, role)` tập trung trong `documents.js`.
  2. Xây dựng thuật toán kiểm tra chu trình đồ thị quan hệ văn bản (DAG Cycle Detection) ngăn chặn vòng lặp phụ thuộc và quan hệ mâu thuẫn đồng thời.
  3. Đảm bảo các trường ghi chú nghiệp vụ và căn cứ pháp lý là tùy chọn (`optional`).
* **Sản phẩm bàn giao:** `CHECKPOINT_1_REPORT.md`.

---

### CHECKPOINT 2 — CONFLICT ENGINE V2 & GOLDEN DATASET (GIAI ĐOẠN 2)
* **Mục tiêu:** Nâng cấp Domain 3 và xây dựng bộ kiểm thử chuẩn mực.
* **Hành động cụ thể:**
  1. Bổ sung các nhãn phân loại chuẩn hóa vào `policyConflictDetector.js`:
     * `EXACT_DUPLICATE` (Layer 1: SHA-256)
     * `IDENTIFIER_DUPLICATE` (Layer 2: Mã hiệu trùng nhưng nội dung khác)
     * `CONTENT_OVERLAP` (Layer 3: Shingles > 85% nhưng không có mâu thuẫn pháp quy)
     * `COMPLEMENTARY` (Bổ sung, song song tồn tại)
     * `AMENDMENT` (Sửa đổi điều khoản)
     * `SUPERSESSION` (Thay thế toàn diện)
     * `POTENTIAL_CONFLICT` (Cần người dùng xác nhận)
     * `CONFIRMED_CONFLICT` (Xung đột trực diện đối kháng)
     * `UNKNOWN` (Fail-closed khi trích xuất OCR không đủ căn cứ)
  2. Tích hợp Shadow Mode ghi log bất đồng bộ ra tệp JSON Lines độc lập (`shadow_conflict_audit.jsonl`).
  3. Xây dựng và thực thi bộ dữ liệu kiểm chuẩn Golden Dataset (tối thiểu 30 ca kiểm chuẩn đa chiều).
* **Sản phẩm bàn giao:** `CHECKPOINT_2_REPORT.md` và `POLICY_CONFLICT_GOLDEN_DATASET_REPORT.md`.

---

### CHECKPOINT 3 — RELIABLE PROCESSING & PUBLICATION (GIAI ĐOẠN 3)
* **Mục tiêu:** Hoàn thiện Domain 4 và Domain 5.
* **Hành động cụ thể:**
  1. Khắc phục phát hiện **F-01**: Tối ưu hóa hàm `reconcileGenerationsAndVectors()` đảm bảo đếm chính xác số lượng chunk rác bị xóa và không để lại vector mồ côi trong Qdrant.
  2. Khắc phục phát hiện **F-02**: Kiểm chứng thực tế cơ chế phân tán `document_retry_leases` thông qua kịch bản kiểm thử đa tiến trình (multi-instance simulation test).
  3. Khắc phục phát hiện **F-04**: Thắt chặt chốt chặn Zero-Chunk Gate tại cả 2 ngõ `approve` và `activate`.
* **Sản phẩm bàn giao:** `CHECKPOINT_3_REPORT.md` và `POLICY_DATA_CONSISTENCY_REPORT.md`.

---

### CHECKPOINT 4 — ADVANCED RAG & POLICY ASSISTANT (GIAI ĐOẠN 4)
* **Mục tiêu:** Hoàn thiện Domain 7.
* **Hành động cụ thể:**
  1. Cập nhật bộ lọc truy vấn vector: Chỉ truy xuất các văn bản `active` và có `effective_date <= CURRENT_DATE` đối với các câu hỏi tra cứu chính sách hiện hành.
  2. Bổ sung trích dẫn điều, khoản rõ ràng trong câu trả lời từ dữ liệu ngữ cảnh.
  3. Khi không tìm thấy thông tin hoặc căn cứ mâu thuẫn, trợ lý phải trả về cảnh báo rõ ràng, không được tự bịa đặt nội dung chính sách.
* **Sản phẩm bàn giao:** `CHECKPOINT_4_REPORT.md` và `POLICY_RAG_EVALUATION_REPORT.md`.

---

### CHECKPOINT 5 — INTEGRATION & FINAL ACCEPTANCE (GIAI ĐOẠN 5)
* **Mục tiêu:** Chạy kiểm thử hồi quy toàn diện trên toàn bộ 8 phạm vi chức năng, bảo đảm chất lượng tổng thể và lập báo cáo nghiệm thu phát hành.
* **Hành động cụ thể:**
  1. Chạy bộ kiểm thử hồi quy tự động (Full Regression Suite).
  2. Kiểm tra lại phân quyền RBAC và cách ly dữ liệu giữa các đơn vị (STL / VTX / SWC).
  3. Lập hồ sơ hoàn thành và hướng dẫn Rollback khi cần thiết.
* **Sản phẩm bàn giao:**
  * `POLICY_FINAL_ACCEPTANCE_REPORT.md`
  * `POLICY_RELEASE_READINESS.md`
  * `POLICY_KNOWN_ISSUES.md`
  * `POLICY_ROLLBACK_RUNBOOK.md`
