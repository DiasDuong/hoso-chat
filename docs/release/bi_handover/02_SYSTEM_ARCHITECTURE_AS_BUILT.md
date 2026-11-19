# TÀI LIỆU KIẾN TRÚC HỆ THỐNG THỰC TẾ (AS-BUILT ARCHITECTURE)
## GENERALAI × BI × WRENAI FORK

> **MÃ TÀI LIỆU:** `DOC-BI-ARCH-02`  
> **PHIÊN BẢN:** `2.0.0`  
> **CẬP NHẬT:** 18/11/2026

---

### 1. SƠ ĐỒ KIẾN TRÚC TỔNG THỂ

```mermaid
flowchart TB
    subgraph ClientLayer["Lớp Người Dùng & Giao Diện"]
        Browser["Trình Duyệt Web Client<br/>(GeneralAI Chat UI)"]
        ECharts["Apache ECharts Engine v5.5.0<br/>(bi-dashboard.js)"]
    end

    subgraph GatewayLayer["Lớp Cổng Điều Phối (Nginx Gateway)"]
        MainGW["Main Gateway: Port 8082<br/>(hr-gateway)"]
        StagingGW["Staging Gateway: Port 8086<br/>(sotrans-gateway-staging)"]
    end

    subgraph BackendLayer["Lớp Dịch Vụ Backend (Node.js 20 Alpine)"]
        AuthService["HR Auth & General AI Service<br/>(Port 3000 / 3001)"]
        BIRouter["BI Router & Dispatcher<br/>(routes/bi_files.js, routes/general_ai.js)"]
        QueryPlanner["NL Query Planner & NLP<br/>(biQueryPlanner.js)"]
        SpreadsheetEngine["In-Memory Columnar Engine<br/>(biSpreadsheetEngine.js)"]
        WrenService["Wren Adapter Service<br/>(wrenBiService.js)"]
        SecurityPrivacy["PII Masking & Access Control<br/>(biPrivacy.js, biFileSecurityService.js)"]
        SchemaValidator["Dashboard V2 Contract Validator<br/>(biDashboardSchemaValidator.js)"]
    end

    subgraph WrenSidecarLayer["Lớp Ngữ Nghĩa Nâng Cao (WrenAI Fork)"]
        WrenContainer["wrenai-wren-bi-1<br/>(Python 3.12 / sqlglot, Port 8091)"]
        SemanticModels["Mô Hình Ngữ Nghĩa (MDL)<br/>(hub_documents, hub_batches, hub_staged)"]
        ASTValidator["SQL AST & Policy Validator<br/>(validate_planned_sql)"]
    end

    subgraph DataStorageLayer["Lớp Lưu Trữ Dữ Liệu"]
        PostgresDev["PostgreSQL 16 (Port 5432 / 5433)<br/>(Operational Pool: hr_app_user / Read-Only: bi_readonly)"]
        IsolatedFiles["Kho Bảng Tính Tạm Thời Tách Biệt<br/>(/chat-files / /chat-files-staging)"]
        QdrantDB["Qdrant Vector Engine<br/>(Port 6333 / 6334)"]
    end

    Browser <--> MainGW
    Browser <--> StagingGW
    MainGW --> AuthService
    StagingGW --> AuthService
    AuthService --> BIRouter
    BIRouter --> QueryPlanner
    BIRouter --> SpreadsheetEngine
    BIRouter --> WrenService
    SpreadsheetEngine <--> IsolatedFiles
    WrenService <-->|Bearer Token HTTP| WrenContainer
    WrenContainer --> SemanticModels
    WrenContainer --> ASTValidator
    WrenContainer -->|SET TRANSACTION READ ONLY| PostgresDev
    AuthService -->|Operational Read/Write| PostgresDev
    AuthService -->|Vector Search| QdrantDB
    AuthService --> SecurityPrivacy
    SecurityPrivacy --> SchemaValidator
    SchemaValidator --> Browser
    Browser --> ECharts
```

---

### 2. CÁC THÀNH PHẦN CỐT LÕI

#### 2.1. Phân Hệ File BI Độc Lập (Self-Service Columnar Engine)
- **Đặc tính:** Hermetic, In-Memory Columnar. Khi người dùng tải file `.xlsx`, hệ thống nạp dữ liệu vào cấu trúc cột trong bộ nhớ tạm thời của tiến trình, tự động phát hiện kiểu dữ liệu (`INTEGER`, `FLOAT`, `DATE`, `TEXT`), định danh các chiều phân tích (dimensions), chỉ số (measures) và nhãn thực thể.
- **Tính toán:** Hỗ trợ tính toán song song:
  - Hàm tổng hợp: `SUM`, `AVG`, `COUNT`, `DISTINCT_COUNT`, `MIN`, `MAX`, `MEDIAN`.
  - Phân tích tương quan: Tỷ trọng phân bổ (`PERCENTAGE`), Tăng trưởng chuỗi thời gian (`GROWTH_RATE`), So sánh chu kỳ (`PERIOD_COMPARISON`).
- **An toàn CSDL:** **Hoàn toàn không ghi bất kỳ dòng dữ liệu nào vào bảng nhân sự của PostgreSQL** (Zero HR table intrusion).

#### 2.2. Phân Hệ WrenAI Semantic Layer
- **Kiến trúc:** Sidecar container chạy Python 3.12 độc lập (`wrenai-wren-bi-1`), gắn mạng nội bộ Docker.
- **Giao thức:** Trao đổi qua API nội bộ (`/catalog`, `/query`) có xác thực Bearer token mã hóa an toàn.
- **Ràng buộc an toàn:** Mọi truy vấn SQL từ WrenAI được biên dịch qua thư viện `sqlglot`, phân tích cú pháp AST, đối soát với danh sách bảng cho phép (`public.documents`, `public.hr_intake_batches`, `public.hr_employee_staging`), và thực thi trên kết nối CSDL có cờ `SET TRANSACTION READ ONLY` dưới quyền `bi_readonly`.

#### 2.3. Hợp Đồng Dữ Liệu Tự Mô Tả (Dashboard Contract V2.0)
- Mọi kết quả phân tích được đóng gói vào payload JSON chuẩn hóa phiên bản 2.0 (`bi-dashboard-v2`):
  - `provenance`: Ghi nhận hệ thống tạo, checksum, version, thời gian thực thi.
  - `kpi_strip`: Dải thẻ chỉ số then chốt (hỗ trợ các trạng thái `AVAILABLE`, `CONDITIONAL`, `BLOCKED`, `DATA_UNAVAILABLE`).
  - `visualizations`: Cấu hình đồ họa cho 5 loại biểu đồ ECharts.
  - `data_tables`: Bảng số liệu chi tiết có phân trang và định dạng số.
  - `export_token`: Chữ ký số HMAC SHA-256 bảo đảm tính toàn vẹn khi tải file.
