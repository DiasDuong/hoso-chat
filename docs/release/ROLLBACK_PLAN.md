# SOTRANS HUB — KẾ HOẠCH HOÀN NGUYÊN KHẨN CẤP (ROLLBACK RUNBOOK)
## PRODUCTION RELEASE EMERGENCY ROLLBACK RUNBOOK
- **Mã tài liệu:** `SOTRANS-ROLLBACK-PLAN-FINAL-15`
- **Dự án:** `D:\hoso-chat`
- **Mục tiêu RTO (Recovery Time Objective):** < 3 phút
- **Mục tiêu RPO (Recovery Point Objective):** 0 phút (Zero data loss)
- **Phiên bản áp dụng:** SOTRANS Hub AI Platform (`rc-ai-platform-v1.0.0`, commit `b24c8ddf5228219e44262f3b5b16a23d9acc84c8`)

---

## 1. NGUYÊN TẮC HOÀN NGUYÊN AN TOÀN

1. **Ưu tiên hoàn nguyên ứng dụng (Application-Level Rollback First):**
   - Đợt phát hành này **HOÀN TOÀN KHÔNG THAY ĐỔI SCHEMA CSDL** (Zero DDL, không chạy migration, không sửa bảng/cột/index).
   - Do đó, việc hoàn nguyên ứng dụng về release artifact phiên bản trước là phương án an toàn nhất và bảo toàn 100% dữ liệu phát sinh.
2. **Không phụ thuộc vào `git checkout` đơn thuần:**
   - Sử dụng kho lưu trữ **Release Artifact Snapshot** độc lập đã được kiểm thử để khôi phục mã nguồn và tài nguyên frontend, tránh rủi ro merge conflict hoặc working tree dirty.
3. **Tuyệt đối không tự động restore CSDL đè lên CSDL Production đang chạy:**
   - Nghiêm cấm chạy `pg_restore` trực tiếp vào database `hrbot` đang online khi chưa qua bước kiểm định độc lập.
   - Nếu có nghi ngờ về dữ liệu, bắt buộc phải restore thử nghiệm vào CSDL cô lập (`hrbot_test`) để thẩm định tính toàn vẹn trước khi lập kế hoạch chuyển đổi có kiểm soát.

---

## 2. TIÊU CHÍ KÍCH HOẠT HOÀN NGUYÊN (ROLLBACK TRIGGERS)

Kích hoạt rollback khẩn cấp nếu xuất hiện bất kỳ sự cố nào sau đây trong vòng 60 phút sau triển khai:
- `TRIGGER-1`: Container `hr-auth` bị crash loop liên tục (Exit code != 0) do lỗi nạp thư viện hoặc cấu hình.
- `TRIGGER-2`: Toàn bộ các API xác thực cốt lõi (`POST /api/auth/login`) trả về HTTP 500.
- `TRIGGER-3`: Xảy ra hiện tượng rò rỉ dữ liệu lương hoặc CCCD chéo đơn vị qua các giao diện Chatbot hoặc API.
- `TRIGGER-4`: Tắc nghẽn kết nối cơ sở dữ liệu kéo dài (Connection Pool exhaustion) gây treo Gateway.

---

## 3. QUY TRÌNH HOÀN NGUYÊN TỪNG BƯỚC (STEP-BY-STEP RUNBOOK)

### Bước 1: Phát lệnh và cô lập hệ thống
- Người điều phối phát lệnh: `"KÍCH HOẠT HOÀN NGUYÊN PHIÊN BẢN SOTRANS HUB"`.
- Ghi nhận thời điểm kích hoạt và lý do sự cố.

### Bước 2: Khôi phục mã nguồn từ Release Artifact Snapshot
Thay vì sử dụng `git checkout`, hoàn nguyên trực tiếp từ thư mục Release Artifact đã được đóng gói trước triển khai tại:
`D:\hoso-chat\backups\golive_execute_09\release_artifact_final_09\` (hoặc snapshot tương ứng).

Thực hiện lệnh PowerShell:
```powershell
# 1. Hoàn tác mã nguồn backend auth-service
Copy-Item -Path "D:\hoso-chat\backups\golive_execute_09\release_artifact_final_09\intake.js" -Destination "D:\hoso-chat\auth-service\routes\intake.js" -Force
Copy-Item -Path "D:\hoso-chat\backups\golive_execute_09\release_artifact_final_09\intakeValidator.js" -Destination "D:\hoso-chat\auth-service\services\intakeValidator.js" -Force
Copy-Item -Path "D:\hoso-chat\backups\golive_execute_09\release_artifact_final_09\employees.js" -Destination "D:\hoso-chat\auth-service\routes\employees.js" -Force
Copy-Item -Path "D:\hoso-chat\backups\golive_execute_09\release_artifact_final_09\employeeRestoreService.js" -Destination "D:\hoso-chat\auth-service\services\employeeRestoreService.js" -Force

# 2. Kiểm tra cú pháp mã nguồn sau hoàn tác
node -c D:\hoso-chat\auth-service\server.js
node -c D:\hoso-chat\auth-service\routes\intake.js
node -c D:\hoso-chat\auth-service\routes\employees.js
```

### Bước 3: Tái khởi động dịch vụ ứng dụng
Chỉ tái khởi động các container ứng dụng bị ảnh hưởng:
```bash
# Khởi động lại Backend API
docker restart hr-auth

# Reload cấu hình Nginx Gateway
docker exec hr-gateway nginx -s reload
```

### Bước 4: Kiểm tra trạng thái dịch vụ (Post-Rollback Health Check)
1. Kiểm tra trạng thái container:
   ```bash
   docker ps --filter "name=hr-auth" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
   ```
2. Kiểm tra API Health:
   ```bash
   curl -I http://127.0.0.1:3000/api/health
   curl -I http://127.0.0.1:8082/api/health
   ```
3. Đăng nhập kiểm tra tài khoản `admin_stl`.

---

## 4. QUY TRÌNH PHỤC HỒI DỮ LIỆU DỰ PHÒNG TỐI HẬU (ISOLATED DATABASE RESTORE RUNBOOK)

> [!CAUTION]
> Quy trình này CHỈ áp dụng trong kịch bản thảm họa khi CSDL `hrbot` bị lỗi vật lý nghiêm trọng.
> TUYỆT ĐỐI KHÔNG restore trực tiếp đè lên CSDL `hrbot` đang online.

1. **Bước 4.1 — Kiểm tra tệp sao lưu:**
   Xác minh tệp `D:\hoso-chat\backups\golive_final_15\hrbot_prod_backup_pre_golive_15.dump` hợp lệ (TOC entries = 265).
2. **Bước 4.2 — Restore vào môi trường cô lập để thẩm định:**
   ```powershell
   # Restore vào CSDL hrbot_test để kiểm tra tính toàn vẹn trước
   docker exec hrbot-postgres-1 psql -U hrbot -d postgres -c "DROP DATABASE IF EXISTS hrbot_restore_verify; CREATE DATABASE hrbot_restore_verify OWNER hrbot;"
   docker cp "D:\hoso-chat\backups\golive_final_15\hrbot_prod_backup_pre_golive_15.dump" hrbot-postgres-1:/tmp/restore_verify.dump
   docker exec hrbot-postgres-1 pg_restore -U hrbot -d hrbot_restore_verify /tmp/restore_verify.dump
   docker exec hrbot-postgres-1 rm /tmp/restore_verify.dump
   ```
3. **Bước 4.3 — Đối soát số lượng bản ghi:**
   Xác minh số lượng bản ghi trên database khôi phục:
   - `employees`: 6 bản ghi
   - `hr_employee_profiles`: 6 bản ghi
   - `hr_employee_staging`: 11 bản ghi
   - Baseline nhân sự `STL00014`, `SWC00021` nguyên vẹn.
4. **Bước 4.4 — Chuyển đổi có kiểm soát:**
   Chỉ khi có biên bản phê duyệt của Release Gate Master, thực hiện chuyển đổi cấu hình connection pool sang cơ sở dữ liệu đã xác minh.
