# BẢNG MA TRẬN TÍNH NĂNG BI TÍCH HỢP — AS-BUILT
## GENERALAI × BI × WRENAI FORK
**Mã tài liệu:** `DOC-BI-FEAT-03`  
**Phiên bản:** 2.0.0 (Đã đối soát mã nguồn thực tế)  
**Trạng thái:** ACCEPTED / RELEASE READY  
**Ngày cập nhật:** 18/11/2026  
**Commit Baseline:** `dbed29a187b09a7b8eac09b6b65c10ae408053c1` (`main`)

---

## 1. TỔNG QUAN HỆ THỐNG TÍNH NĂNG BI

Hệ thống Business Intelligence (BI) tích hợp trong GeneralAI Chatbot cung cấp giải pháp phân tích dữ liệu đàm thoại thông qua hai phân hệ:
1. **Self-Service Uploaded Spreadsheet BI:** Phân tích dữ liệu trong bộ nhớ (In-Memory Columnar Hermetic Engine) từ bảng tính Excel (.xlsx/.csv) tải lên, hoàn toàn không can thiệp bảng dữ liệu nhân sự của PostgreSQL.
2. **Internal System BI & WrenAI Semantic Layer:** Kết nối CSDL nội bộ qua mô hình ngữ nghĩa (MDL) của WrenAI Fork (Sidecar container `wrenai-wren-bi-1` trên cổng 8091), thực thi truy vấn `SELECT` chỉ đọc (Read-only) với quyền phân quyền tối thiểu `bi_readonly`.

---

## 2. MA TRẬN 16 THÀNH PHẦN TÍNH NĂNG VÀ MÃ NGUỒN THỰC TẾ

| STT | Thành phần tính năng | Endpoint API / Giao tiếp | Module Mã nguồn Thực tế | Hàm / Logic Cốt lõi | Test Suite Xác minh | Trạng thái |
|:---:|:---|:---|:---|:---|:---|:---:|
| **01** | **GeneralAI Chatbot Core** | `POST /api/general/chat`<br>(Nginx Gateway: `/chat/api`) | `auth-service/routes/general_ai.js`<br>`auth-service/services/answerQualityEnhancer.js` | `router.post('/chat')`<br>`analyzeQueryAndDecompose`<br>`verifyAndRefineAnswer` | `tests/test_p0_5_query_understanding.js`<br>Main Smoke Test #1, #3 | **PASS** |
| **02** | **BI Intent Detection** | Nội bộ trong luồng Chat Gateway | `auth-service/services/biReportingHelper.js`<br>`auth-service/services/biQueryPlanner.js` | `detectBIIntent`<br>`planAnalyticalQuery`<br>`normalizeText` | `tests/test_p0_5_query_understanding.js` (33/33 PASS) | **PASS** |
| **03** | **Dynamic Tool Routing** | Nội bộ Router General AI | `auth-service/routes/general_ai.js`<br>`auth-service/services/biReportingHelper.js` | `executeBIReporting`<br>`detectCompanyFromText` | `tests/test_wren_bi_orchestration.js` (8/8 PASS) | **PASS** |
| **04** | **WrenAI Sidecar Integration** | HTTP RPC: `http://wrenai:8091/query`<br>`http://wrenai:8091/catalog` | `auth-service/services/wrenBiService.js`<br>`integrations/wrenai/bridge/query_service.py` | `serviceRequest`<br>`runReport`<br>`ThreadingHTTPServer` | `integrations/wrenai/tests/test_query_service.py`<br>`tests/test_wren_bi_orchestration.js` (8/8 PASS) | **PASS** |
| **05** | **Semantic Model & SQL Planning** | Nội bộ WrenAI Sidecar | `integrations/wrenai/bridge/plan_worker.py`<br>`integrations/wrenai/models/hub.mdl.template.json` | `plan_request`<br>`manifest_for_company`<br>MDL Schema AST | `integrations/wrenai/tests/test_plan_worker.py`<br>(21/21 Python unit tests in container) | **PASS** |
| **06** | **Read-only SQL Execution** | CSDL kết nối `bi_readonly` | `auth-service/services/biQueryValidator.js`<br>`integrations/wrenai/upstream/runtime/wren/policy.py`<br>`integrations/wrenai/bridge/query_service.py` | `validateQueryPlan`<br>`validate_planned_sql`<br>`SET TRANSACTION READ ONLY`<br>`APPROVED_TABLES` | `tests/test_task01_dataset_security.js` (13/13 PASS)<br>`tests/test_bi_release_foundation.js` | **PASS** |
| **07** | **Uploaded File BI (Excel/CSV)** | `POST /api/bi/files/upload`<br>`POST /api/analytics/files/upload`<br>`DELETE /api/bi/files/:id` | `auth-service/routes/bi_files.js`<br>`auth-service/services/biFileSecurityService.js`<br>`auth-service/services/biSpreadsheetEngine.js`<br>`auth-service/services/biDatasetRegistry.js` | `validateAndStoreIntakeFile`<br>`processAndProfileDataset`<br>`queryIsolatedDataset`<br>`registerDataset` | `tests/test_bi_phase1_oracle_regression.js` (29/29 PASS)<br>`tests/test_bi_release_browser.js` | **PASS** |
| **08** | **Internal DB BI Analytics** | `POST /api/general/chat`<br>`POST /api/analytics` | `auth-service/routes/analytics.js`<br>`auth-service/services/analyticsEngine.js`<br>`auth-service/services/wrenBiService.js` | `scopeFor`<br>`runReport`<br>`analyticsEngine.query` | `tests/test_staging_phase_2_3_live_e2e.js` (11/11 PASS)<br>Audit log real Wren query | **PASS** |
| **09** | **KPI Reporting & Metrics** | Đóng gói trong payload Dashboard V2 | `auth-service/services/biDashboardSchemaValidator.js`<br>`auth-service/services/biDatasetPresenter.js`<br>`auth-service/services/biReportingHelper.js` | `assertValidDashboardPayload`<br>Kiểm soát 4 trạng thái KPI:<br>`AVAILABLE`, `CONDITIONAL`, `BLOCKED`, `DATA_UNAVAILABLE`<br>*(3 KPI quy trình `INTAKE_FAILURE`, `INTAKE_DURATION`, `POLICY_CONFLICT` ghi nhận `BLOCKED` / `UNVERIFIED` do thiếu log/schema)* | `tests/test_bi_dashboard_contract.js` (25/25 PASS)<br>`tests/test_bi_release_foundation.js` (14/14 PASS) | **PASS** |
| **10** | **ECharts Dynamic Visualization** | Giao diện Web Client | `chat/bi-dashboard.js`<br>`chat/echarts.min.js`<br>`chat/bi-dashboard.css`<br>`chat/index.html` | Client-side render: BAR, LINE, PIE, DONUT, STACKED_BAR.<br>Cross-filter & drill-down | `tests/test_bi_release_browser.js` (10 checks PASS trên Edge)<br>`tests/test_p1_1_echarts_renderer.js` | **PASS** |
| **11** | **Multi-turn BI Conversations** | `POST /api/general/chat` | `auth-service/services/biQueryPlanner.js`<br>`auth-service/services/conversationReferenceResolver.js` | `planFollowUpQuery`<br>`loadConversationContext`<br>`resolveUserReferences` | `tests/test_phase4_dashboard_composition.js` (13/13 PASS)<br>`tests/test_p0_5_query_understanding.js` | **PASS** |
| **12** | **Multi-tenant Dataset Security** | Middleware & Access Guards | `auth-service/services/biDatasetRegistry.js`<br>`auth-service/services/biFileSecurityService.js`<br>`auth-service/services/wrenBiService.js` | `canUserAccessDataset`<br>`assertSafeStorageDir`<br>`scopeFor` (kiểm tra tenant STL/VTX/SWC) | `tests/test_task01_dataset_security.js` (13/13 PASS)<br>Staging UAT #11 PASS | **PASS** |
| **13** | **PII Masking & Data Privacy** | Bộ lọc dữ liệu trước phản hồi | `auth-service/services/biPrivacy.js` | `sanitizeBiData`<br>`sanitizeBiProfile`<br>`buildSafeInsightContext`<br>(Định dạng che: `079******234`) | `tests/test_bi_release_foundation.js` (Subtest 10 PASS)<br>Staging UAT #10 PASS | **PASS** |
| **14** | **Secure Report Export** | `POST /api/analytics/export` | `auth-service/routes/bi_exports.js`<br>`auth-service/services/biExportToken.js`<br>`chat/bi-dashboard.js` | `signReport`, `verifyReport`<br>HMAC-SHA256 (TTL: 1h)<br>Xuất Excel (.xlsx) qua `XLSX.write`<br>Xuất PDF qua `window.print()` | `tests/test_wren_bi_orchestration.js` (Subtest 7 PASS)<br>`tests/test_bi_release_browser.js` | **PASS** |
| **15** | **Audit Logging & Telemetry** | File log & DB Audit | `auth-service/services/biAuditLogger.js`<br>`auth-service/audit.js`<br>`auth-service/services/conversationLogger.js` | `logBiAuditEvent`<br>`logAudit`<br>Lưu `bi_audit.log` & DB audit_logs | Smoke Test #9 PASS<br>Xác minh file `bi_audit.log` | **PASS** |
| **16** | **Containerized Runtime** | Docker Compose Architecture | `docker-compose.yml`<br>`integrations/wrenai/compose.wren.yml`<br>`docker-compose.staging.yml` | `hr-auth` (3000), `hr-gateway` (8082), `wrenai-wren-bi-1` (8091), `postgres` (5432) | Docker Healthchecks HTTP 200<br>Uptime & live connection verified | **PASS** |

---

## 3. CHI TIẾT CONTRACT VÀ SCHEMA GIAO TIẾP THỰC TẾ

### 3.1. General AI Chat Contract (Tích hợp BI)
- **Endpoint:** `POST /api/general/chat` (hoặc proxy qua Gateway `/chat/api`)
- **Headers:** `Content-Type: application/json`, `Authorization: Bearer <JWT_TOKEN>`
- **Request Body:**
```json
{
  "message": "Thống kê số lượng nhân viên theo từng phòng ban",
  "conversation_id": "conv-1731940000000",
  "company_id": "STL",
  "active_dataset_id": "dataset-uuid-optional"
}
```
- **Response Format:**
  Phản hồi bao gồm nội dung văn bản tự nhiên kết hợp khối mã đặc tả giao diện tự mô tả `bi-dashboard-v2`:
```html
Dưới đây là thống kê nhân sự theo từng phòng ban:

```bi-dashboard-v2
{
  "schema_version": "2.0.0",
  "dashboard_id": "dash-stl-20261118-001",
  "title": "Thống kê nhân sự phòng ban",
  "provenance": {
    "engine": "WRENAI_ORCHESTRATOR",
    "company_id": "STL",
    "execution_time_ms": 18
  },
  "kpi_strip": [
    {
      "id": "kpi_total",
      "label": "Tổng nhân sự",
      "primary_value": 42,
      "status": "AVAILABLE"
    }
  ],
  "visualizations": [
    {
      "id": "viz_dept_bar",
      "chart_type": "BAR",
      "data_ref": "dept_summary",
      "mapping": { "category": "phong_ban", "value": "so_luong" }
    }
  ],
  "data_store": {
    "dept_summary": [
      { "phong_ban": "Kỹ thuật", "so_luong": 18 },
      { "phong_ban": "Kinh doanh", "so_luong": 15 },
      { "phong_ban": "Nhân sự", "so_luong": 9 }
    ]
  },
  "export_token": "eyJhbGciOi...<signature>"
}
```
```

### 3.2. File Upload & Intake Contract
- **Endpoint:** `POST /api/bi/files/upload` (hoặc `/api/analytics/files/upload`)
- **Content-Type:** `multipart/form-data` (Field: `file`)
- **Ràng buộc an toàn (`biFileSecurityService.js`):**
  - Giới hạn dung lượng tối đa: **25 MB** (`MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024`).
  - Giới hạn giải nén file ZIP: tối đa 100 MB (`MAX_UNCOMPRESSED_ZIP_BYTES`), tỷ lệ nén tối đa 25:1 (`MAX_ZIP_RATIO`).
  - Định dạng hợp lệ: `.xlsx`, `.xls`, `.csv` (kiểm tra kép Magic Byte và MIME type).
  - Tự động trung hòa mã độc công thức bảng tính (Formula Injection defense via `sanitizeFormulaInjection`).
  - Thời hạn lưu trữ: 7 ngày (`DEFAULT_RETENTION_DAYS = 7`).

### 3.3. Secure Report Export Contract
- **Endpoint:** `POST /api/analytics/export`
- **Headers:** `Authorization: Bearer <JWT_TOKEN>`, `Content-Type: application/json`
- **Request Body:**
```json
{
  "payload": {
    "schema_version": "2.0.0",
    "dashboard_id": "dash-stl-20261118-001",
    "export_token": "<body_base64url>.<signature_base64url>",
    "...": "dữ liệu dashboard"
  },
  "filters": {}
}
```
- **Cơ chế xác thực Token (`biExportToken.js`):**
  - Chữ ký: `HMAC_SHA256(body, JWT_SECRET)` với `body = base64url({ user_id, expires, digest })`.
  - Thời hạn hiệu lực: **1 giờ (3.600.000 ms)** kể từ thời điểm tạo báo cáo.
  - So sánh chữ ký an toàn: `crypto.timingSafeEqual` (chống Timing Attacks).
  - Kiểm tra tính nguyên vẹn: Payload digest SHA-256 đối soát với nội dung hiện tại; từ chối (HTTP 403) nếu phát hiện can thiệp số liệu.
- **Định dạng xuất:**
  - File Excel (`.xlsx`) tạo trên server thông qua thư viện `xlsx` (`XLSX.write`), đính kèm sheet `Provenance` ghi rõ vết truy vấn.
  - File PDF: Xuất tại phía client thông qua `window.print()` được tối ưu hóa giao diện in ấn biểu đồ trong `chat/bi-dashboard.js`.
