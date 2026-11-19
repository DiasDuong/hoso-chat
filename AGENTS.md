# SOTRANS GENERAL AI — AGENT GOVERNANCE & OPERATIONAL RULES

> **Tiêu chuẩn quản trị và quy tắc vận hành cho AI Agents (Antigravity, Cursor, Claude, Copilot)**  
> **Phiên bản:** 1.0.0 (Ban hành: 19/11/2026)  
> **Áp dụng cho:** Toàn bộ hệ thống SOTRANS Hub & GeneralAI Platform

---

## 1. QUY TẮC BẢO VỆ TÀI LIỆU VÀ CHỐNG TÁI DIỄN MARKDOWN SPAM

> [!CAUTION]
> **TUYỆT ĐỐI KHÔNG TỰ ĐỘNG TẠO FILE MARKDOWN (.md) BÁO CÁO SAU MỖI TASK HOÀN THÀNH.**

1. **Kênh xuất báo cáo:**
   - Mọi kết quả phân tích, kiểm tra, audit, debug, tiến độ công việc, log thực thi PHẢI được xuất trực tiếp ra **chat response** hoặc Antigravity Artifacts (theo chỉ thị hệ thống).
   - Nghiêm cấm tạo các file báo cáo tạm thời như `*_REPORT.md`, `AUDIT_*.md`, `TEST_RESULTS_*.md`, `SUMMARY_*.md` ở thư mục gốc hoặc trong source code.

2. **Điều kiện tạo file Markdown mới:**
   - Chỉ được phép tạo file `.md` mới khi có **yêu cầu rõ ràng và trực tiếp từ người dùng** về việc tạo tài liệu kỹ thuật chính thức (Architecture Spec, Deployment Guide, Runbook, API Reference).
   - Nghiêm cấm commit các file Markdown tạm thời, bản nháp, kết quả test tạm thời vào Git repository.

3. **Vị trí tài liệu chuẩn hóa:**
   - Thư mục gốc (`/`) **CHỈ ĐƯỢC CHỨA DUY NHẤT**: `README.md` và `AGENTS.md`.
   - Mọi tài liệu kỹ thuật mới PHẢI được đặt đúng cấu trúc phân loại trong `docs/`:
     * `docs/architecture/`: Tài liệu thiết kế kiến trúc, luồng dữ liệu, đặc tả hệ thống.
     * `docs/ai-platform/`: Tài liệu AI platform, LLM orchestration, WrenAI, RAG.
     * `docs/audit/`: Tài liệu kiểm toán bảo mật, tuân thủ dữ liệu chính thức.
     * `docs/business-decisions/`: Quyết định phê duyệt nghiệp vụ và chính sách phân quyền.
     * `docs/release/`: Tài liệu bàn giao, quy trình phát hành, hướng dẫn rollback khôi phục.
     * `docs/maintenance/`: Manifest bảo trì, quy định lưu trữ dữ liệu.

---

## 2. QUY TẮC BẢO TOÀN DỮ LIỆU SẢN XUẤT VÀ RUNTIME

1. **Dữ liệu hội thoại (Conversations):**
   - Thư mục `auth-service/storage/conversations/*.md` và `auth-service/exports/*.md` là dữ liệu hội thoại người dùng thời gian thực (runtime storage).
   - **NGHIÊM CẤM XÓA HOẶC SỬA ĐỔI** các file trong các thư mục này trong các đợt dọn dẹp tài liệu.

2. **Dữ liệu Database & Docker:**
   - Tuyệt đối không xóa container volumes, pgdata, qdrant storage khi chưa có phê duyệt bằng văn bản và snapshot an toàn.

---

## 3. QUY TẮC MÃ NGUỒN VÀ GIT HYGIENE

1. **Không để lại file rác:**
   - Mọi script kiểm thử tạm thời (scratch scripts) phải được dọn dẹp sau khi hoàn tất nhiệm vụ.
   - Không commit file `.bak`, file copy tạm thời, prompt chunks hoặc synthetic test data vào git.

2. **Kiểm thử trước khi bàn giao:**
   - Trước khi hoàn tất task hoặc tạo commit liên quan đến nghiệp vụ BI/GeneralAI, phải chạy kiểm thử bộ acceptance test:
     ```bash
     node tests/test_bi_v2_final_e2e_acceptance.js
     ```
   - Kết quả bắt buộc phải đạt **100% PASS** (79/79 checks).

3. **Phân quyền và Cổng dịch vụ chuẩn (Port Registry):**
   - Production Gateway: `8082` | Staging Gateway: `8086`
   - Production Auth Service: `3000` | Staging Auth Service: `3001`
   - Production WrenAI BI Service: `8091`
   - Production PostgreSQL: `5432` | Staging PostgreSQL: `5433`
   - Production Qdrant: `6333` | Staging Qdrant: `6334`
