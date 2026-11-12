# SOTRANS HUB — QUY TRÌNH HOÀN NGUYÊN AN TOÀN HỆ THỐNG QUẢN TRỊ VĂN BẢN (DOC GOVERNANCE SAFE ROLLBACK RUNBOOK)

**Tài liệu chuẩn hóa:** `docs/DOC_GOVERNANCE_SAFE_ROLLBACK_RUNBOOK.md`  
**Dự án:** SOTRANS Hub (Logistics AI Platform)  
**Môi trường áp dụng:** Production & Staging  
**Phiên bản Runbook:** 1.1 (Cập nhật sau Đợt 1.1 — Tenant Boundary Security & Safe Rollback)  
**Thời điểm phê duyệt:** 04/11/2026  

---

## 1. NGUYÊN TẮC BẤT DI BẤT DỊCH (CORE GOVERNANCE DIRECTIVES)

1. **Tuyệt đối không DROP Schema hoặc Bảng dữ liệu:**
   - Không được chạy các lệnh `DROP TABLE public.document_retrieval_controls CASCADE;` hoặc xóa các trường/ràng buộc schema đang được Backend API và n8n Workflow truy vấn.
   - Việc xóa bảng đột ngột sẽ lập tức gây lỗi `relation does not exist` trên n8n và làm sập API truy vấn chính sách nhân sự.
2. **Tuyệt đối không tạo phê duyệt giả (No False Approvals):**
   - Không bao giờ được tự động chuyển trạng thái quan hệ từ `pending_review` sang `approved`.
   - Nghiêm cấm gán `approved_by = 'system'` hoặc `rollback_operator`. Toàn bộ quan hệ chính sách phải giữ nguyên `pending_review` cho đến khi có phê duyệt chính thức bằng văn bản từ HR/Legal cấp có thẩm quyền.
3. **Bảo toàn dữ liệu Audit Log & Tính toàn vẹn:**
   - Mọi thao tác hoàn nguyên (dù ở cấp độ nào) đều phải được ghi nhận vào `document_audit_logs`.
   - Không được xóa bất kỳ dòng log kiểm toán nào.
4. **Đồng bộ đa tầng (Multi-tier Synchronization):**
   - Một đợt khôi phục hệ thống (Full Restore) chỉ hợp lệ khi cả 4 thành phần: **PostgreSQL**, **Qdrant Vector DB**, **n8n Workflow**, và **Source Code Backend** được đồng bộ cùng một phiên bản checkpoint. Không bao giờ restore riêng lẻ một thành phần.

---

## 2. ĐIỀU KIỆN KÍCH HOẠT VÀ PHÂN CẤP THẨM QUYỀN

### 2.1. Điều kiện kích hoạt
Hoàn nguyên chỉ được phép kích hoạt khi xuất hiện một trong các sự cố sau:
- **Sự cố Nghiêm trọng (P0):** Toàn bộ chatbot ngưng hoạt động do lỗi logic tại workflow hoặc backend sau khi nâng cấp và không thể khắc phục nhanh trong 15 phút.
- **Lỗi Bảo mật / Rò rỉ dữ liệu (P1):** Phát hiện lỗi logic cho phép nhân sự chi nhánh này truy cập / sửa đổi dữ liệu trái phép của chi nhánh khác mà bản vá tại chỗ chưa xử lý được.
- **Lệnh trực tiếp từ Ban Giám đốc hoặc Trưởng ban CNTT / Nhân sự.**

### 2.2. Phân cấp thẩm quyền phê duyệt
| Cấp độ Rollback | Người có thẩm quyền phê duyệt | Hình thức phê duyệt |
|---|---|---|
| **Cấp độ A — Feature Rollback** | Trưởng nhóm Kỹ thuật (Lead Tech / Solution Architect) | Email xác nhận hoặc Ticket hệ thống |
| **Cấp độ B — Full System Restore** | Ban Giám đốc / Giám đốc Khối CNTT (CTO) | Văn bản phê duyệt chính thức |

---

## 3. CHECKLIST XÁC NHẬN TRƯỚC KHI THỰC HIỆN (PRE-FLIGHT CHECKLIST)

Người vận hành phải đánh dấu kiểm tra đủ toàn bộ các tiêu chí trước khi gõ lệnh:

- [ ] **1. Xác định đúng nguyên nhân:** Đã xác nhận nguyên nhân sự cố và có biên bản ghi nhận lỗi.
- [ ] **2. Phê duyệt hợp lệ:** Đã nhận được phê duyệt bằng văn bản của người có thẩm quyền tương ứng (Mục 2.2).
- [ ] **3. Tính toàn vẹn của bản sao lưu (Backup Manifest):** Đã kiểm tra thư mục backup, tệp `MANIFEST.json` báo trạng thái `READY_FOR_DEPLOYMENT`, dung lượng tệp > 0 bytes.
- [ ] **4. Thông báo dừng hoạt động bảo trì (Maintenance Window):** Đã treo banner bảo trì hoặc chuyển hướng traffic nếu thực hiện Full Restore.
- [ ] **5. Môi trường cô lập:** Nếu là Full Restore, đã kiểm tra lệnh thành công trên môi trường thử nghiệm cô lập trước khi áp dụng lên môi trường vận hành.

---

## 4. CHI TIẾT HAI CẤP ĐỘ HOÀN NGUYÊN (TWO ROLLBACK TIERS)

### CẤP ĐỘ A: HOÀN NGUYÊN TÍNH NĂNG (FEATURE ROLLBACK) — *ƯU TIÊN HÀNG ĐẦU*

Áp dụng khi cần tạm ngưng hoặc tắt cơ chế kiểm soát mới nhưng **bảo tồn toàn bộ dữ liệu, quan hệ và lịch sử kiểm toán**.

#### Thứ tự thực hiện:
```
[BƯỚC A1: Vô hiệu hóa cấu hình DB] -> [BƯỚC A2: Khôi phục Code Backend] -> [BƯỚC A3: Khôi phục n8n Workflow] -> [BƯỚC A4: Đồng bộ Qdrant]
```

#### Các lệnh thực thi chi tiết (Đã xác minh trên môi trường hiện tại):

**Bước A1: Vô hiệu hóa cấu hình kiểm soát trong Database (Không DROP bảng)**
Chạy script safe rollback:
```powershell
docker exec -i hrbot-postgres-1 psql -U hrbot -d hrbot -f - < d:\hoso-chat\sql\migrations\rollback_20261104_doc_risk_remediation.sql
```
*Kết quả xác minh:* Bảng `document_retrieval_controls` được cập nhật `is_active = false`, các quan hệ giữ nguyên `pending_review`.

**Bước A2: Hoàn nguyên mã nguồn Backend từ thư mục Backup**
```powershell
# Copy mã nguồn an toàn từ thư mục backup đã kiểm định
Copy-Item "d:\hoso-chat\backups\batch1_1_tenant_rollback_20261104\documents.js" "d:\hoso-chat\auth-service\routes\documents.js" -Force

# Khởi động lại container hr-auth
docker restart hr-auth
docker logs --tail 20 hr-auth
```

**Bước A3: Khôi phục n8n Workflow từ bản Backup**
1. Mở giao diện n8n: `http://localhost:5678` (hoặc domain nội bộ).
2. Chọn workflow `wbGnHNQ7oGkpQFEW` (`HR_Policy_Chat`).
3. Chọn menu `Workflow` -> `Import from File` -> Chọn `d:\hoso-chat\backups\batch1_1_tenant_rollback_20261104\wf_risk_remediated.json`.
4. Nhấn `Save` và kích hoạt `Active`.

**Bước A4: Kích hoạt đối soát đồng bộ Qdrant**
```powershell
# Gọi hàm đồng bộ lại toàn bộ trạng thái sang Qdrant
docker exec hr-auth node -e "require('./services/qdrantSyncService').syncAllDocumentsToQdrant().then(() => console.log('Qdrant sync done'));"
```

---

### CẤP ĐỘ B: PHỤC HỒI TOÀN HỆ THỐNG ĐỒNG BỘ (FULL SYSTEM RESTORE)

Chỉ sử dụng khi dữ liệu bị lỗi nghiêm trọng và cần đưa toàn bộ nền tảng về đúng mốc thời gian snapshot đã được kiểm định.

#### Thứ tự phụ thuộc bắt buộc:
```
[BƯỚC B1: Dừng Traffic] -> [BƯỚC B2: Restore PostgreSQL] -> [BƯỚC B3: Restore Qdrant] -> [BƯỚC B4: Restore Code/Config] -> [BƯỚC B5: Import n8n Workflow] -> [BƯỚC B6: Kiểm thử & Mở lại Traffic]
```

#### Thư mục bản sao lưu chuẩn:
`D:\hoso-chat\backups\batch1_1_tenant_rollback_20261104\`
- PostgreSQL dump: `pg_batch1_1.dump`
- Qdrant dump: `qdrant_hr_docs_points.json`
- Workflow backup: `wf_risk_remediated.json`
- Code backup: `documents.js`
- Manifest: `MANIFEST.json`

#### Các lệnh thực thi chi tiết:

**Bước B1: Dừng các container dịch vụ tiếp nhận traffic**
```powershell
docker stop hr-auth hr-gateway
```

**Bước B2: Khôi phục PostgreSQL từ tệp Custom Dump**
```powershell
# Copy dump vào container
docker cp "d:\hoso-chat\backups\batch1_1_tenant_rollback_20261104\pg_batch1_1.dump" hrbot-postgres-1:/tmp/restore_checkpoint.dump

# Chạy pg_restore trong PostgreSQL container (Chế độ clean & restore)
docker exec hrbot-postgres-1 pg_restore -U hrbot -d hrbot --clean --if-exists -v /tmp/restore_checkpoint.dump
```

**Bước B3: Khôi phục Qdrant Vector Collection**
```powershell
# Chạy script khôi phục points và payload vào Qdrant
$env:NODE_PATH="D:\hoso-chat\auth-service\node_modules"
node -e "
const fs = require('fs');
const http = require('http');
const pointsData = JSON.parse(fs.readFileSync('d:/hoso-chat/backups/batch1_1_tenant_rollback_20261104/qdrant_hr_docs_points.json', 'utf8'));
const points = pointsData.result ? pointsData.result.points : pointsData;

console.log('Restoring ' + points.length + ' points to Qdrant collection hr_docs...');
const req = http.request({
  hostname: '127.0.0.1',
  port: 6333,
  path: '/collections/hr_docs/points?wait=true',
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' }
}, (res) => {
  let b = ''; res.on('data', c => b += c);
  res.on('end', () => console.log('Qdrant restore response status: ' + res.statusCode, b));
});
req.write(JSON.stringify({ points: points }));
req.end();
"
```

**Bước B4: Khôi phục mã nguồn Backend & Frontend**
```powershell
Copy-Item "d:\hoso-chat\backups\batch1_1_tenant_rollback_20261104\documents.js" "d:\hoso-chat\auth-service\routes\documents.js" -Force
docker start hr-auth hr-gateway
```

**Bước B5: Khôi phục Workflow trên n8n**
Import lại tệp `d:\hoso-chat\backups\batch1_1_tenant_rollback_20261104\wf_risk_remediated.json` vào n8n qua giao diện Web hoặc API.

---

## 5. KIỂM THỬ XÁC NHẬN SAU ROLLBACK (POST-ROLLBACK VERIFICATION)

Sau khi hoàn thành hoàn nguyên, người vận hành phải chạy kịch bản kiểm tra tự động để xác minh tính ổn định:

1. **Xác minh số lượng bản ghi Database:**
   ```powershell
   docker exec hrbot-postgres-1 psql -U hrbot -d hrbot -c "SELECT count(*) AS documents_count FROM documents;" -c "SELECT count(*) AS rel_count FROM document_relationships;" -c "SELECT count(*) AS controls_count FROM document_retrieval_controls;"
   ```
   *Yêu cầu:* `documents_count = 22`, `rel_count = 3`, không có lỗi truy vấn.

2. **Xác minh điểm Vector Qdrant:**
   ```powershell
   curl http://localhost:6333/collections/hr_docs
   ```
   *Yêu cầu:* `points_count` khớp chính xác với số chunk của 22 văn bản (~100 points).

3. **Kiểm tra Chatbot RAG thực tế:**
   - Đặt câu hỏi: *"Thời giờ làm việc của công ty như thế nào?"*
   - *Yêu cầu:* Chatbot trả lời chuẩn khung giờ 08:00 - 17:00, trích dẫn `01/QC-SOTRANS` và `QC-VPC-2024-V1`. Không tự động áp dụng Flexitime 09:30.

4. **Kiểm tra Phân quyền Tenant Boundary:**
   Chạy suite kiểm thử tự động 15 trường hợp:
   ```powershell
   $env:NODE_PATH="D:\hoso-chat\auth-service\node_modules"
   node scratch\test_tenant_boundary_15_cases.js
   ```
   *Yêu cầu:* Kết quả `ALL TC01-TC15 PASSED: true`.

---

## 6. PHƯƠNG ÁN XỬ LÝ KHI ROLLBACK THẤT BẠI (CONTINGENCY PLAN)

Trong trường hợp quy trình Rollback gặp lỗi kỹ thuật không mong muốn:
1. **Duy trì trạng thái Freeze:** Không chạy các câu lệnh SQL tự do không có trong Runbook.
2. **Kích hoạt Fallback Container Snapshot:** Khởi động lại các container từ Docker image tags ổn định trước đó.
3. **Liên hệ khẩn cấp:** Báo cáo ngay cho Kiến trúc sư hệ thống (System Architect) và Trưởng ban CNTT kèm theo file log:
   - Docker logs: `docker logs hr-auth > err_auth.log`
   - Database logs: `docker logs hrbot-postgres-1 > err_pg.log`
   - n8n logs: `docker logs hrbot-n8n-1 > err_n8n.log`
