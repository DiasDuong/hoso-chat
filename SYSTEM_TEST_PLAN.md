# KẾ HOẠCH KIỂM THỬ TOÀN DIỆN HỆ THỐNG SOTRANS HUB
## SOTRANS HUB — MASTER SYSTEM TEST PLAN (STP-20261029)

> **Tài liệu:** Kế hoạch kiểm thử toàn diện hệ thống SOTRANS Hub  
> **Phiên bản:** 1.0 (Audit & Testing Baseline)  
> **Ngày lập:** 29/10/2026  
> **Trạng thái thực thi:** READ-ONLY / VERIFICATION ONLY  
> **Nguyên tắc an toàn:** Tuyệt đối không thay đổi mã nguồn, không xóa hoặc ghi đè dữ liệu nhân sự thật, không restart/rebuild container trong quá trình kiểm thử.

---

### MỤC LỤC
1. [Mục tiêu và Phạm vi](#1-mục-tiêu-và-phạm-vi)
2. [Khung phân loại an toàn kiểm thử (Safety Classification Framework)](#2-khung-phân-loại-an-toàn-kiểm-thử)
3. [Danh mục Test Suite hiện có và Bổ sung](#3-danh-mục-test-suite-hiện-có-và-bổ-sung)
4. [Ma trận kiểm thử bao phủ 11 Lĩnh vực (Coverage Matrix)](#4-ma-trận-kiểm-thử-bao-phủ-11-lĩnh-vực)
5. [Môi trường kiểm thử và Điều kiện tiên quyết](#5-môi-trường-kiểm-thử-và-điều-kiện-tiên-quyết)
6. [Tiêu chí Đạt/Không đạt (Pass/Fail Criteria) & Dừng khẩn cấp](#6-tiêu-chí-đạtkhông-đạt-passfail-criteria--dừng-khẩn-cấp)
7. [Quy trình Bảo vệ dữ liệu và Kế hoạch Phục hồi (Rollback Strategy)](#7-quy-trình-bảo-vệ-dữ-liệu-và-kế-hoạch-phục-hồi)

---

### 1. MỤC TIÊU VÀ PHẠM VI

#### 1.1 Mục tiêu chính
- Kiểm định độc lập và khách quan toàn bộ hệ thống SOTRANS Hub sau đợt kiểm toán hệ thống `SYSTEM_AUDIT_REPORT_20261028.md` và các bản vá hotfix (Hạng mục 3: Bảo mật xem tệp đính kèm; Hạng mục 4: Đóng cổng Docker LAN; Khắc phục Phần F: Phân quyền HR/Admin).
- Xác minh tính chính xác của các phát hiện kiểm toán trên môi trường thực tế (running services, database schema, network isolation, external integrations).
- Phân biệt rõ giữa các tính năng đang hoạt động ổn định (Working Features), các lỗi đã xác minh (Verified Bugs), và các rủi ro tiềm ẩn (Latent Vulnerabilities).
- Thu thập bằng chứng kỹ thuật (log, HTTP status, SQL query, port bindings) để phục vụ việc lập Báo cáo Kiểm thử, Sổ đăng ký lỗi và Kế hoạch khắc phục.

#### 1.2 Phạm vi 11 Lĩnh vực kiểm thử
1. **Lĩnh vực 1 (FE): Frontend & Giao diện người dùng** — Chat UI, Admin Portal, phân trang, Markdown rendering, cơ chế xác thực tệp đính kèm `?token=`.
2. **Lĩnh vực 2 (API): Backend & REST API** — Endpoint routing, xác thực JWT, xử lý mã lỗi HTTP, tính nhất quán của JSON response.
3. **Lĩnh vực 3 (RBAC): Tài khoản, Phân quyền & Quản trị truy cập** — Phân tách quyền ADMIN vs HR, Multi-tenancy (SWC vs STL), ngăn chặn IDOR và truy cập trái phép.
4. **Lĩnh vực 4 (HR): Nghiệp vụ Nhân sự & Vòng đời hồ sơ** — Trạng thái ACTIVE / RESIGNED / DELETED, tính nhất quán dữ liệu giữa bảng `employees` và `hr_employee_profiles`, hồ sơ cần xóa theo yêu cầu.
5. **Lĩnh vực 5 (INTAKE): Tiếp nhận hồ sơ, OCR & Staging** — Quản trị trạng thái staging (`pending_review`, `approved`, `rejected`), retention cleanup 7 ngày, OCR parser text extraction.
6. **Lĩnh vực 6 (AI): Chatbot, AI Router & Gemini Token Quota** — Điều hướng mô hình (Routing Engine), quản lý hạn ngạch Free Tier (250k input tokens/ngày), bảo mật API key.
7. **Lĩnh vực 7 (RAG): RAG Pipeline & Qdrant Vector DB** — Vector embeddings (dim 768 cosine), collection `hr_docs`, hybrid search, đồng bộ dữ liệu vector.
8. **Lĩnh vực 8 (INT): Tích hợp bên ngoài (External Integrations)** — Google Service Account (Google Sheets), n8n workflow engine, NocoDB CRUD, OneDrive Hybrid Sync.
9. **Lĩnh vực 9 (DB): PostgreSQL & Tính toàn vẹn dữ liệu** — Cấu trúc bảng, khóa ngoại (FK constraints), bảng backup cũ trong public schema, cơ chế sao lưu định kỳ.
10. **Lĩnh vực 10 (OPS): Docker, Nginx Gateway & Vận hành** — Cấu hình Nginx reverse proxy, internal routing `X-Accel-Redirect`, cô lập cổng Docker (`127.0.0.1`), LAN exposure (`0.0.0.0:8082`).
11. **Lĩnh vực 11 (PERF): Hiệu năng, Độ ổn định & Tải kết nối** — Connection Pool limits, Docker container memory limits, xử lý lỗi timeout và tái kết nối.

---

### 2. KHUNG PHÂN LOẠI AN TOÀN KIỂM THỬ (SAFETY CLASSIFICATION FRAMEWORK)

Mọi bài kiểm thử trong đợt kiểm thử này đều phải được gán nhãn nghiêm ngặt theo 5 cấp độ an toàn trước khi kích hoạt:

| Cấp độ | Tên phân loại | Định nghĩa & Tác động | Điều kiện thực thi |
| :--- | :--- | :--- | :--- |
| **L1** | `READ_ONLY` | Kiểm tra trạng thái, đọc file mã nguồn, kiểm tra cấu hình, gửi request GET HTTP, truy vấn `SELECT` database. Tuyệt đối không thay đổi state. | **Cho phép thực thi tự động** |
| **L2** | `ISOLATED` | Thao tác ghi/sửa trên tài khoản thử nghiệm chuyên biệt hoặc bảng tạm đã được đánh dấu cô lập (ví dụ `test_*`), không đụng chạm dữ liệu kinh doanh thật. | **Cho phép thực thi có giám sát** |
| **L3** | `STATE_CHANGING` | Có thao tác ghi (INSERT, UPDATE, DELETE) vào bảng nghiệp vụ thật hoặc sửa cấu hình runtime. Có thể cần rollback sau khi chạy. | **CẦN PHÊ DUYỆT (NEEDS APPROVAL)** |
| **L4** | `EXTERNAL_SIDE_EFFECT` | Tác động đến bên thứ ba ngoài máy chủ: gửi mail, ghi Google Sheet thật qua API, đồng bộ OneDrive qua Microsoft Graph API, gọi Gemini tốn quota. | **CẦN PHÊ DUYỆT (NEEDS APPROVAL)** |
| **L5** | `DESTRUCTIVE` | Có nguy cơ làm mất dữ liệu, drop database, xoá file hệ thống, dừng container production, hoặc làm gián đoạn người dùng. | **NGHIÊM CẤM THỰC THI** |

---

### 3. DANH MỤC TEST SUITE HIỆN CÓ VÀ BỔ SUNG

#### 3.1 Khảo sát các kịch bản kiểm thử sẵn có trong thư mục `tests/`

| STT | Tên file kịch bản | Lĩnh vực | Phân loại an toàn | Trạng thái hiện tại | Ghi chú an toàn |
| :---: | :--- | :---: | :---: | :---: | :--- |
| 1 | `test_secure_files_and_docker_port_hardening.js` | FE, OPS, RBAC | `READ_ONLY` | PASS (14/14) | Kiểm tra bảo mật cổng Docker và `X-Accel-Redirect` |
| 2 | `verify_section_f_remediation.js` | RBAC, HR | `ISOLATED` | PASS (14/14) | Kiểm tra phân quyền phục hồi hồ sơ HR vs ADMIN |
| 3 | `test_hr_governance_rbac_security.js` | RBAC, API | `ISOLATED` | PASS (25/25) | Bộ test phân quyền Multi-tenant SWC vs STL |
| 4 | `test_staging_retention_7days.js` | INTAKE, OPS | `ISOLATED` | PASS (8/8) | Kiểm tra worker dọn dẹp file staging > 7 ngày |
| 5 | `test_markdown_numbering.js` | FE | `READ_ONLY` | PASS (7/7) | Kiểm tra regex đánh số liên tục trong chat UI |
| 6 | `runtime_acceptance_test.js` | API, DB, AI | `READ_ONLY` | PASS (12/12) | Kiểm tra sức khỏe các container và API |
| 7 | `audit_scenario_a.js` đến `audit_scenario_e.js` | AI, RAG | `READ_ONLY` | PASS | Benchmark kịch bản hội thoại nhân sự |
| 8 | `universal_ai_agent_intelligence_test.js` | AI, RAG | `EXTERNAL_SIDE_EFFECT` | NEEDS APPROVAL | Gọi Gemini API liên tục, tiêu tốn quota |
| 9 | `live_onedrive_acceptance_test.js` | INT | `EXTERNAL_SIDE_EFFECT` | NEEDS APPROVAL | Gọi Graph API OneDrive thật |
| 10 | `test_onedrive_lifecycle_and_disconnect.js` | INT, DB | `STATE_CHANGING` | NEEDS APPROVAL | Thay đổi trạng thái tài khoản OneDrive |
| 11 | `test_migration_purged.js` | DB, HR | `DESTRUCTIVE` | BỊ CHẶN | Có lệnh xóa/purge dữ liệu nhân sự |

#### 3.2 Kịch bản kiểm tra tổng thể bổ sung (Master Verification Suite)
Để đảm bảo an toàn 100% không làm xáo trộn hệ thống đang chạy, bộ kiểm thử **`scratch/master_system_tester.js`** được thiết kế hoàn toàn theo chuẩn **`READ_ONLY`**, bao quát 22 kiểm tra cốt lõi trên 11 lĩnh vực:
- **FE-01 -> FE-05:** Kích thước UI, token preview tệp, bộ lọc trạng thái, regex numbering, memory pagination.
- **API-01 -> API-03:** Healthcheck 200, JWT rejection 401, dữ liệu nhân viên xác thực.
- **RBAC-01 -> RBAC-02:** Chặn HR xóa nhân viên 403, chặn HR truy cập cross-tenant 403.
- **HR-01 -> HR-02:** Đối soát 1:1 `employees` và `hr_employee_profiles`, kiểm tra 4 nhân sự cần xóa.
- **INTAKE-01:** Phân loại trạng thái staging.
- **AI-01:** Quét plaintext secret trong compose.
- **RAG-01:** Kiểm tra cluster Qdrant và số lượng vector.
- **INT-01 -> INT-03:** Quét Private Key trong `syncWorker.js`, kiểm tra n8n và NocoDB response.
- **DB-01:** Quét bảng backup tàn dư trong schema public.
- **OPS-01 -> OPS-02:** Kiểm tra port binding Docker `127.0.0.1` vs `0.0.0.0`.
- **PERF-01:** Kiểm tra cấu hình Connection Pool PostgreSQL.

---

### 4. MA TRẬN KIỂM THỬ BAO PHỦ 11 LĨNH VỰC (COVERAGE MATRIX)

```
+---------------------------------------------------------------------------------------------------------+
| DOMAIN  | PHẠM VI KIỂM THỬ                     | MÃ TEST    | CƠ CHẾ KIỂM TRA           | MỨC AN TOÀN   |
+---------------------------------------------------------------------------------------------------------+
| 1. FE   | UI Assets, Token File Preview, Lists | FE-01..05  | Static Code + HTTP GET    | READ_ONLY     |
| 2. API  | Gateway Routing, Healthz, JWT Auth   | API-01..03 | HTTP GET qua Nginx 8082   | READ_ONLY     |
| 3. RBAC | Phân quyền HR/ADMIN, Multi-tenant    | RBAC-01..02| API GET/POST với Mock JWT | READ_ONLY     |
| 4. HR   | Đồng bộ 2 bảng, 4 hồ sơ cần xóa      | HR-01..02  | SQL SELECT nội bộ         | READ_ONLY     |
| 5. INTAKE| Staging statuses, 7d retention logic| INTAKE-01  | SQL SELECT + File Stat    | READ_ONLY     |
| 6. AI   | Secret exposure, Gemini token limits | AI-01      | Yaml inspection + Code    | READ_ONLY     |
| 7. RAG  | Qdrant hr_docs health & point count  | RAG-01     | HTTP GET Qdrant API 6333  | READ_ONLY     |
| 8. INT  | Google SA Key, n8n port, NocoDB      | INT-01..03 | Regex Scan + HTTP GET     | READ_ONLY     |
| 9. DB   | Schema cleanliness, Backup tables    | DB-01      | Information Schema Query  | READ_ONLY     |
| 10. OPS | Netstat port bindings, Nginx routing | OPS-01..02 | PowerShell Get-NetTCPConn | READ_ONLY     |
| 11. PERF| Postgres pool, Docker memory limits  | PERF-01    | Inspect db.js & docker    | READ_ONLY     |
+---------------------------------------------------------------------------------------------------------+
```

---

### 5. MÔI TRƯỜNG KIỂM THỬ VÀ ĐIỀU KIỆN TIÊN QUYẾT

#### 5.1 Cấu hình môi trường thử nghiệm
- **Hệ điều hành Host:** Windows (Workstation tại `D:\hoso-chat`)
- **Docker Engine:** Docker Desktop for Windows, Docker Compose v2
- **Mạng nội bộ:**
  - Cổng mở ra LAN: `0.0.0.0:8082` (Nginx Reverse Gateway)
  - Cổng dịch vụ nội bộ (Loopback): `127.0.0.1:3000` (hr-auth), `127.0.0.1:5432` (PostgreSQL), `127.0.0.1:6333` (Qdrant), `127.0.0.1:5679` (n8n), `127.0.0.1:8081` (NocoDB).
- **Cơ sở dữ liệu:** PostgreSQL 16 trong container `hrbot-postgres-1`, database `hr_auth` và `n8n`.
- **Vector DB:** Qdrant v1.13.0 trong container `hrbot-qdrant-1`, collection `hr_docs`.

#### 5.2 Điều kiện tiên quyết trước khi kiểm thử
1. Tất cả 7 container Docker phải ở trạng thái `Up` và lành mạnh (Healthy).
2. Không thực hiện restart, stop, rm container hoặc lệnh `docker compose down`.
3. Không thực hiện các lệnh `npm install` hoặc thay đổi `package.json`.
4. Không thực hiện các lệnh `UPDATE`, `DELETE`, `DROP TABLE`, `TRUNCATE` đối với database nghiệp vụ.
5. Kiểm tra kết nối mạng cục bộ tới Gateway `http://127.0.0.1:8082/api/health`.

---

### 6. TIÊU CHÍ ĐẠT/KHÔNG ĐẠT (PASS/FAIL CRITERIA) & DỪNG KHẨN CẤP

#### 6.1 Tiêu chí Đạt (Pass Criteria)
- Tất cả các endpoint bảo vệ từ chối truy cập không có token (HTTP 401).
- Tất cả các thao tác vượt quyền HR bị chặn đúng chuẩn (HTTP 403).
- Dữ liệu nhân sự giữa bảng `employees` và `hr_employee_profiles` khớp nhau 100% về số lượng.
- Các cổng backend nhạy cảm (`3000`, `5432`, `6333`, `5679`, `8081`) chỉ lắng nghe trên `127.0.0.1`.
- Xem tệp đính kèm hoạt động qua token đính kèm và `X-Accel-Redirect` của Nginx mà không bị lộ thư mục tĩnh.

#### 6.2 Tiêu chí Không đạt (Fail Criteria)
- Phát hiện secret (Private Key, API Key, JWT Secret) ở dạng plaintext trong file mã nguồn hoặc docker-compose.
- HR có thể tự khôi phục hồ sơ đã bị Admin xóa hoặc can thiệp chéo sang công ty khác.
- Dữ liệu rác, hồ sơ yêu cầu xóa thật vẫn tồn tại ACTIVE mà không được cách ly.
- Tồn tại bảng backup/tạm thời không được kiểm soát trong schema `public`.

#### 6.3 Điều kiện Dừng khẩn cấp (Emergency Stop Triggers)
Nếu phát hiện bất kỳ dấu hiệu nào sau đây, toàn bộ quá trình kiểm thử phải dừng ngay lập tức:
1. Container PostgreSQL hoặc Nginx bị crash hoặc rơi vào vòng lặp restart (Restarting loop).
2. Dung lượng ổ đĩa `C:` hoặc `D:` tụt đột ngột dưới 2GB.
3. Có kịch bản test phát sinh lỗi xóa hoặc thay đổi dữ liệu bảng `employees`.
4. Phát hiện lưu lượng mạng bất thường ra bên ngoài từ tài khoản service.

---

### 7. QUY TRÌNH BẢO VỆ DỮ LIỆU VÀ KẾ HOẠCH PHỤC HỒI (ROLLBACK STRATEGY)

#### 7.1 Quy tắc bảo vệ dữ liệu nghiệp vụ
- **Quy tắc Read-Only Tuyệt đối:** Các script kiểm thử được chạy ở mức tài khoản truy vấn `SELECT` hoặc mock token không thực hiện commit transaction.
- **Cách ly kiểm thử ghi:** Nếu một bài kiểm thử yêu cầu kiểm tra thao tác ghi (ví dụ: tạo nhân viên mới), bắt buộc phải chạy trong khối `BEGIN ... ROLLBACK` của transaction SQL hoặc sử dụng mã nhân viên có tiền tố quy chuẩn `TEST_ISOLATED_*` và tự động dọn sạch trong khối `finally`.

#### 7.2 Kế hoạch Phục hồi Khẩn cấp (Rollback Plan)
- **Nếu mã nguồn bị vô tình sửa đổi:** Dùng lệnh Git checkout để khôi phục trạng thái commit gốc:  
  `git checkout -- <file>`
- **Nếu container bị treo hoặc ngắt kết nối:** Không được `down -v` (xóa volume). Chỉ khởi động lại container bị ảnh hưởng thông qua lệnh an toàn đã được phê duyệt.
- **Nếu file tạm bị tạo thừa:** Toàn bộ file sinh ra trong quá trình kiểm thử phải được lưu tại thư mục quy ước `scratch/` hoặc `tests/reports/` để có thể xóa bỏ an toàn mà không ảnh hưởng mã nguồn sản phẩm.

---
*Kế hoạch đã được kiểm duyệt và áp dụng cho toàn bộ đợt kiểm thử ST-20261029.*
