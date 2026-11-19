# HƯỚNG DẪN TRIỂN KHAI VÀ ROLLBACK HỆ THỐNG BI
## GENERALAI × BI × WRENAI FORK
**Mã tài liệu:** `DOC-BI-OPS-06`  
**Phiên bản:** 2.0.0 (Đã đối soát biến môi trường và quy trình rollback thực tế)  
**Trạng thái:** ACCEPTED / OPERATIONAL  
**Ngày cập nhật:** 18/11/2026  
**Commit Baseline:** `dbed29a187b09a7b8eac09b6b65c10ae408053c1` (`main`)

---

## 1. YÊU CẦU TIỀN ĐỀ VÀ MA TRẬN MÔI TRƯỜNG

### 1.1. Hạ tầng Kỹ thuật Tối thiểu
- **Hệ điều hành:** Linux (Ubuntu 22.04 LTS khuyến nghị) hoặc Windows Server có Docker Desktop.
- **Docker Engine:** Phiên bản `>= 24.0.0`
- **Docker Compose:** Phiên bản `>= 2.20.0`
- **Tài nguyên tối thiểu:** RAM 8GB (khuyến nghị 16GB để chạy Gateway, Auth, Postgres, Qdrant và WrenAI Sidecar), 20GB ổ cứng trống.

### 1.2. Ma trận Dịch vụ và Ánh xạ Cổng (Port Mapping)

| Thành phần Dịch vụ | Môi trường Dev | Môi trường Staging | Môi trường Production (Dự kiến) |
|:---|:---:|:---:|:---:|
| **Gateway (Nginx Reverse Proxy & Chat UI)** | `8082` | `8086` | `80` / `443` (hoặc sau Load Balancer) |
| **Auth Service (Node.js Backend & BI Engine)** | `3000` | `3001` | `3000` (Nội bộ Docker) |
| **PostgreSQL 16 Database** | `5432` | `5433` | `5432` (Managed DB / Cluster) |
| **WrenAI Fork Sidecar (Python 3.12 Engine)** | `8091` | `8091` | `8091` (Nội bộ Docker Network) |
| **Qdrant Vector Database** | `6333` | `6334` | `6333` (Nội bộ Docker) |

---

## 2. BIẾN MÔI TRƯỜNG CHUẨN HÓA (.ENV TEMPLATE CHO PRODUCTION)

Tạo file `.env` tại thư mục triển khai (đảm bảo file này nằm trong `.gitignore`):

```env
# ==========================================
# CẤU HÌNH NODE.JS & AUTH SERVICE
# ==========================================
NODE_ENV=production
PORT=3000

# ==========================================
# CƠ SỞ DỮ LIỆU POSTGRESQL (TÁCH BIỆT QUYỀN GHI & ĐỌC)
# ==========================================
PG_HOST=postgres
PG_PORT=5432
PG_DATABASE=hrbot_prod
PG_USER=hr_app_user
PG_PASSWORD=${PROD_APP_PG_PASSWORD}

# TÀI KHOẢN CHỈ ĐỌC CHO PHÂN HỆ BI (LEAST PRIVILEGE)
PG_RO_USER=bi_readonly
PG_RO_PASSWORD=${PROD_BI_RO_PASSWORD}

# ==========================================
# BẬT TÍNH NĂNG BI VÀ PHÂN HỆ EXCEL
# ==========================================
FEATURE_BI_REPORTING=true
BI_REPORTING_ENABLED=true
FEATURE_UPLOADED_FILE_BI=true

# ==========================================
# KHÓA BÍ MẬT XÁC THỰC VÀ KÝ BÁO CÁO (TỐI THIỂU 32 KÝ TỰ)
# ==========================================
JWT_SECRET=${PROD_JWT_SECRET_RANDOM_32_CHARS}
JWT_EXPIRES_IN=24h

# ==========================================
# CẤU HÌNH WRENAI SIDECAR CONTAINER
# ==========================================
WREN_PG_HOST=postgres
WREN_PG_PORT=5432
WREN_PG_DATABASE=hrbot_prod
WREN_PG_USER=bi_readonly
WREN_PG_PASSWORD=${PROD_BI_RO_PASSWORD}
WREN_API_KEY=${PROD_WRENAI_API_KEY}

# ==========================================
# GIỚI HẠN FILE BẢNG TÍNH VÀ LƯU TRỮ
# ==========================================
BI_FILE_MAX_SIZE_BYTES=26214400
BI_STORAGE_DIR=/app/storage/bi_datasets
```

---

## 3. QUY TRÌNH TRIỂN KHAI PRODUCTION TỪNG BƯỚC

### Bước 1: Sao lưu An toàn Trước Triển khai
1. Sao lưu Cơ sở dữ liệu:
   ```bash
   pg_dump -h <DB_HOST> -U <PG_USER> -d <PG_DATABASE> -F c -b -v -f /backups/pre_bi_deploy_$(date +%Y%m%d_%H%M%S).dump
   ```
2. Xác nhận bản sao lưu mã nguồn và cấu hình tại `D:\hoso-chat-backups\pre_merge_20261118_150858` vẫn nguyên vẹn.

### Bước 2: Đồng bộ Mã nguồn Đã Nghiệm thu Kỹ thuật
1. Lấy mã nguồn từ nhánh `main` tại commit đã kiểm chứng:
   ```bash
   git fetch origin
   git checkout main
   git verify-commit dbed29a187b09a7b8eac09b6b65c10ae408053c1
   ```
2. Xác nhận HEAD commit khớp: `dbed29a`.

### Bước 3: Khởi động Dịch vụ WrenAI Sidecar
1. Khởi chạy container WrenAI:
   ```bash
   docker compose -f integrations/wrenai/compose.wren.yml up -d
   ```
2. Kiểm tra container `wrenai-wren-bi-1` đạt trạng thái healthy:
   ```bash
   curl -f http://127.0.0.1:8091/catalog || exit 1
   ```

### Bước 4: Khởi động Toàn bộ Hệ thống Ứng dụng
1. Khởi chạy Gateway và Auth Service:
   ```bash
   docker compose up -d --build
   ```
2. Kiểm tra log khởi động:
   ```bash
   docker compose logs -f auth gateway --tail=50
   ```

### Bước 5: Kiểm tra Khởi động (Post-Deployment Verification)
1. Kiểm tra health endpoints:
   - Gateway: `curl http://127.0.0.1:80/api/health` (HTTP 200)
   - Auth Service: `curl http://127.0.0.1:3000/api/health` (HTTP 200)
2. Thực thi kịch bản kiểm tra smoke test để xác nhận đăng nhập, phân tích bảng tính, và truy vấn WrenAI live:
   ```bash
   node scratch/test_main_smoke.js
   ```
3. Xác nhận 9/9 bước kiểm tra đạt yêu cầu.

---

## 4. QUY TRÌNH ROLLBACK NHANH (FAST ROLLBACK PROCEDURE)

Trong trường hợp phát sinh sự cố kỹ thuật nghiêm trọng trong quá trình phát hành:

### 4.1. Điểm Khôi phục An toàn (Restore Checkpoints)
- **Commit Baseline Rollback:** `569f857` (Commit của nhánh `main` trước khi tích hợp phân hệ BI).
- **Bản sao lưu tệp nguồn độc lập:** `D:\hoso-chat-backups\pre_merge_20261118_150858` (3.524 tệp nguồn nguyên bản).
- **Git Stash ID:** `stash@{0}: On main: pre-merge-working-tree-20261118`.

### 4.2. Các bước Thực hiện Rollback
1. **Cô lập Phân hệ BI (Không cần dừng CSDL):**
   - Đặt biến môi trường `FEATURE_BI_REPORTING=false` và `BI_REPORTING_ENABLED=false` trong file `.env`.
   - Khởi động lại `hr-auth`: hệ thống Chatbot Core tiếp tục trả lời chitchat và tra cứu văn bản bình thường.
2. **Khôi phục Mã nguồn về Baseline `569f857`:**
   ```bash
   git checkout 569f857
   ```
   *(Hoặc giải nén bản backup vật lý `pre_merge_20261118_150858` vào thư mục làm việc)*.
3. **Khởi động lại Containers:**
   ```bash
   docker compose restart auth gateway
   ```
4. **Đo lường thời gian gián đoạn:**
   - Ước tính thời gian dịch vụ tạm ngắt trong quá trình khởi động lại: **30 – 60 giây**.
   - Không có thời gian chết kéo dài do không phải chờ khôi phục dữ liệu database.

### 4.3. Đánh giá Tác động Cơ sở dữ liệu (Database Impact Assessment)
- **Đặc thù kỹ thuật:** Toàn bộ tính năng BI chỉ thực hiện các câu lệnh `SELECT` (Read-only) và lưu trữ dữ liệu tạm thời trong thư mục bảng tính độc lập (`storage/bi_datasets`).
- **Kết luận:** **Không có bất kỳ câu lệnh DDL thay đổi cấu trúc bảng nào trên CSDL PostgreSQL.** Do đó, quá trình rollback mã nguồn hoàn toàn độc lập và **không đòi hỏi chạy script rollback database**.
