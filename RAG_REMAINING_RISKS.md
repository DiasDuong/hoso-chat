# ĐÁNH GIÁ RỦI RO CÒN LẠI & KHUYẾN NGHỊ VẬN HÀNH (REMAINING RISKS & RECOMMENDATIONS)
**Dự án:** SOTRANS AI Workspace — `D:\hoso-chat`  
**Ngày lập:** 26/10/2026

---

## 1. MA TRẬN ĐÁNH GIÁ RỦI RO (RISK ASSESSMENT MATRIX)

| Rủi ro tiềm ẩn | Mức độ | Khả năng | Biện pháp giảm thiểu hiện tại | Khuyến nghị dài hạn |
| :--- | :---: | :---: | :--- | :--- |
| **1. Trễ bộ nhớ đệm (Cache Hash Lag)** | Thấp | Rất thấp | `DOC_HASH_TTL_MS` đặt ở mức 5 giây. Thay đổi DB phản ánh sau tối đa 5s. | Khi tích hợp webhook CMS văn bản, có thể trigger trực tiếp `POST /api/policy/cache/clear`. |
| **2. Tỷ lệ timeout của LLM khi lưu lượng cao** | Trung bình | Thấp | Đã nâng timeout HTTP lên 120s; tầng cache giảm tải 60-80% truy vấn lặp lại. | Cân nhắc thêm cơ chế retry có exponential backoff ở cấp độ backend service. |
| **3. Tài liệu mới thiếu thông tin phạm vi áp dụng (`branch_scope`)** | Trung bình | Thấp | Workflow Ingestion (`HR_Doc_Ingest_API`) mặc định gán `role_access=['all']` và yêu cầu chọn branch rõ ràng. | Bắt buộc Admin HR điền trường `branch_scope` khi upload văn bản qua Admin Portal. |
| **4. Độ dài hội thoại đa lượt vượt quá token budget** | Thấp | Thấp | `routes/policy.js` cắt gọn tối đa 6 tin nhắn gần nhất; nội dung mỗi tin nhắn cắt 1.000 ký tự. | Duy trì cơ chế tóm tắt lịch sử hội thoại nếu cuộc trò chuyện kéo dài trên 20 lượt. |

---

## 2. KHUYẾN NGHỊ VẬN HÀNH VÀ BẢO TRÌ (OPERATIONAL GUIDELINES)

1. **Chuẩn hóa quy trình đặt tên và metadata văn bản:**
   - Tránh nhập tay tiêu đề có ký tự trắng liên tiếp hoặc lỗi chính tả tiếng Việt không dấu (như `Khong` thay vì `Khoi`).
   - Mọi văn bản quy định ca kíp đặc thù phải nêu rõ trong phần đầu: *"Áp dụng cho nhân viên thuộc [Tên đơn vị] làm việc theo ca [Tên ca]"*.

2. **Duy trì kiểm thử hồi quy tự động:**
   - Đưa kịch bản `tests/rag_policy_regression_suite.js` vào pipeline CI/CD hoặc chạy định kỳ trước mỗi lần cập nhật phiên bản hệ thống.
   - Lệnh thực thi:
     ```bash
     node tests/rag_policy_regression_suite.js
     ```

3. **Giám sát câu hỏi chưa có câu trả lời (Unanswered Questions Log):**
   - Node `Log Unanswered` trong n8n tự động ghi lại các câu hỏi trả về `answerable: false` vào bảng `unanswered_questions`.
   - Đội ngũ Nhân sự định kỳ rà soát các câu hỏi này hàng tuần để bổ sung văn bản quy chế còn thiếu.
