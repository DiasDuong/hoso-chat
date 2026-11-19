# Phân tích WrenAI và ứng dụng cho SOTRANS Hub

Ngày đánh giá: 16/11/2026, giờ Việt Nam. “WremAI” trong yêu cầu được hiểu là WrenAI, theo thư mục mã nguồn đã cung cấp.

## 1. Kết luận và phạm vi bằng chứng

**Khuyến nghị: tiếp tục dùng WrenAI làm lớp ngữ nghĩa và lập kế hoạch truy vấn cho BI linh hoạt trong General AI của SOTRANS Hub.** Giữ Analytics Engine cho KPI chuẩn, File BI cho bảng tính và Qdrant/RAG cho nội dung tài liệu. Dùng cùng một giao diện chat và hợp đồng báo cáo.

Giá trị chính là giúp chatbot truy vấn theo định nghĩa nghiệp vụ được kiểm soát: chỉ số nào, nguồn nào, mức chi tiết nào, đơn vị nào và kỳ nào. Lắp thêm engine không tự tạo ra định nghĩa đúng, dữ liệu còn thiếu hay cơ chế phân quyền hoàn chỉnh.

Phân biệt bốn mức:
- **Đã đọc mã:** xác nhận có đường xử lý, model, kiểm tra quyền hoặc renderer trong workspace.
- **Đã kiểm tra trực tiếp ở lượt này:** health, feature flag, planner không DB, hash source và số lượng trạng thái registry.
- **Bằng chứng đợt trước:** test/đối chiếu được mô tả trong tài liệu triển khai; không coi là đã chạy lại ở lượt này.
- **Đề xuất:** kiến trúc mở rộng, use case và tiêu chí nghiệm thu cần xây thêm.

Đã đọc hai kho:
- [WrenAI snapshot](C:/Users/Admin/Downloads/WrenAI-main/WrenAI-main/README.md): phiên bản khai báo wrenai 0.18.0, Python >=3.11.
- [Hoso-chat](D:/hoso-chat/README.md): Node/Express, PostgreSQL, n8n, Qdrant, NocoDB, Nginx, Gemini, giao diện chat và BI/ECharts.

Kiểm tra trực tiếp khoảng 14:46–14:51 ngày 16/11/2026:
- Container Wren đang healthy; host bind 127.0.0.1:8091.
- Health Wren trả 200 và execution_enabled=true; API Hub qua gateway trả 200.
- Cấu hình Wren BI đọc bằng module hiện hữu trả enabled=true.
- Demo Node → Python → Wren tạo SQL PostgreSQL có scope STL và LIMIT 100; executed=false, không đọc dữ liệu nghiệp vụ.
- 41 tệp đã trích vào Hoso-chat có hash khớp manifest và khớp snapshot trong Downloads; không có mismatch.
- Registry BI hiệu lực trong hr-auth có **17 mục: 3 READY, 14 MISSING_DATA** khi kiểm tra metadata. Đây là ảnh chụp trạng thái, không đánh giá nội dung các dataset. Báo cáo cũ lúc 12:19 ghi 20 mục/18 thiếu/2 sẵn sàng; không dùng số cũ làm hiện trạng mới.

Không thực hiện ở lượt này: đăng nhập bằng tài khoản nghiệp vụ, gọi Gemini, truy vấn bảng nghiệp vụ, kiểm thử xâm nhập, benchmark tải hoặc triển khai thay đổi. Chỉ tạo tài liệu phân tích và Canvas.

## 2. WrenAI đang cung cấp gì?

### 2.1. Hiểu đúng kiến trúc

Bản hiện tại là một semantic/context engine dùng cho AI agent. MDL (Modeling Definition Language) mô tả model, cột, quan hệ, trường tính toán, view và các đối tượng phân tích. Knowledge lưu quy tắc và ví dụ câu hỏi–SQL. Engine mở rộng SQL viết theo model sang SQL của nguồn đích; connector thực thi và trả dữ liệu.

Chuỗi điển hình:
1. Người dùng hỏi nghiệp vụ.
2. Agent/LLM lấy schema, định nghĩa và ví dụ phù hợp.
3. LLM sinh SQL hoặc chọn truy vấn cấu trúc.
4. Wren lập kế hoạch/kiểm tra và chuyển SQL theo MDL.
5. Nguồn dữ liệu thực thi.
6. Ứng dụng dựng bảng, KPI, biểu đồ và giải thích dựa trên kết quả.

**WrenEngine.dry_plan nhận SQL, không nhận tiếng Việt để tự sinh SQL.** Trong Hub, Gemini đảm nhiệm bước sinh kế hoạch. dry-plan thành công chứng minh lập kế hoạch được; không chứng minh SQL diễn đạt đúng ý người hỏi hay số liệu đã được thực thi.

### 2.2. Chú ý hướng dẫn theo thế hệ sản phẩm

README của snapshot và [repository chính thức](https://github.com/Canner/WrenAI) ghi ứng dụng chat-first cũ đã chuyển sang legacy/v1, tag v1-final, không nhận tính năng hoặc bản sửa bảo mật mới. Vì vậy, sơ đồ triển khai wren-ui + wren-ai-service + launcher trong bài cũ không phải sơ đồ nên áp dụng nguyên xi cho source này.

[Open-core của nhà cung cấp](https://www.getwren.ai/en/open-core) phân tách engine/MDL/CLI/MCP mã nguồn mở với nền tảng thương mại có GenBI UI, dashboard, embedded/API, quản lý người dùng/nhóm, bảo mật hàng/cột, audit nâng cao và hỗ trợ doanh nghiệp.

Phân biệt: có thể tự xây dashboard/API quanh engine mở và tận dụng WASM/SDK trong repo; điều đó không đồng nghĩa nhận miễn phí toàn bộ nền tảng thương mại. Mã type/policy trong engine cũng không tự tạo hệ thống danh tính và quyền cho Sotrans.

### 2.3. Công dụng và điều kiện

1. **Hỏi dữ liệu bằng ngôn ngữ tự nhiên:** thống kê, phân nhóm, xu hướng, so sánh kỳ, top-N. Cần LLM, model và dữ liệu phù hợp; tiếng Việt cần kiểm thử riêng.
2. **Chuẩn hóa chỉ số:** định nghĩa “văn bản”, “lô”, “file”, “nhân viên”, “doanh thu” một lần; tránh mỗi prompt tự hiểu khác.
3. **Chuẩn hóa joins:** khai báo khóa và cardinality, giảm sai join. Vẫn phải kiểm tra grain và quan hệ nhiều–nhiều.
4. **Trường tính toán/views:** đóng gói logic được duyệt, tránh để LLM viết lại phép tính mỗi lượt.
5. **Cube và truy vấn cấu trúc:** model measures/dimensions/time-grain để agent chọn tham số thay vì tự viết GROUP BY. Không mặc định cube đã có bảng vật lý/cache hoặc giải quyết mọi vấn đề hiệu năng.
6. **Kiểm tra trước khi chạy:** dry-plan để xem SQL mở rộng; dry-run theo connector để kiểm tra với nguồn sống. Cần credential, timeout và cách kiểm tra phù hợp nguồn.
7. **Kết nối nhiều loại hệ dữ liệu:** PostgreSQL, SQL Server, MySQL, BigQuery, Snowflake, ClickHouse, Databricks, Trino, DuckDB và các nguồn khác. Số “20+/22+” còn tùy cách tính biến thể connector.
8. **Knowledge và memory:** giữ định nghĩa, enum, đơn vị, ví dụ NL–SQL đã duyệt; có LanceDB retrieval tùy chọn. Đây là truy hồi ví dụ, không tự huấn luyện lại LLM.
9. **Dashboard do agent hỗ trợ tạo:** từ kết quả dựng chart/app qua code, SDK hoặc nền tảng thương mại. Backend Hub vẫn quyết định người nào được lấy dữ liệu nào.
10. **Dùng chung ngữ nghĩa:** nhiều agent, script, notebook và ứng dụng dùng một model version.
11. **Giải trình:** lưu metric/model version, nguồn, phạm vi và trace để điều tra sai lệch.
12. **Hỗ trợ đánh giá hồi quy:** đối chiếu bộ câu hỏi chuẩn sau khi đổi schema/model/prompt. Wren không tự cung cấp benchmark nghiệp vụ Sotrans.

Wren không tự thay thế ETL, OCR, quản trị hồ sơ, duyệt nghiệp vụ, cơ sở dữ liệu, toàn bộ BI enterprise hay dự báo/causal analysis.

## 3. Các cách sử dụng và tích hợp

### 3.1. CLI và skill cho phát triển

Phù hợp với kỹ sư/analyst khi dựng model, kiểm tra SQL, quản lý profile, build MDL và chuẩn bị ví dụ. Các primitive đáng dùng: context build/validate, dry-plan, dry-run, query, memory và cube. Nên thực hiện trong môi trường riêng có khóa phiên bản; không cần cài thêm toàn bộ CLI để dùng adapter hiện hữu.

wren ask chủ yếu chuẩn bị prompt/workflow cho agent; không nên hiểu là một dịch vụ NL-to-SQL độc lập không cần LLM.

### 3.2. Python SDK trực tiếp

Nhúng WrenEngine vào backend Python. Phù hợp khi cần kiểm soát policy, connection lifecycle và result schema. Sotrans đang dùng runtime Python được trích chọn lọc; không cần đổi backend Node sang Python.

### 3.3. Node/Express → dịch vụ Python nội bộ — phù hợp nhất hiện tại

General AI gọi private service theo HTTP, service tự lấy MDL và connection từ server, lập lại kế hoạch rồi thực thi. Đây là **API do Sotrans tự xây quanh engine**, khác API sản phẩm thương mại Wren.

Lợi ích: tận dụng auth/conversation/Gemini/report của Hub; cô lập dependency Rust/Python; giới hạn tài nguyên riêng. Đổi lại phải vận hành sidecar, version API, health, token, lỗi, timeout và tải đồng thời.

### 3.4. Subprocess Node → Python

Adapter hubPlanner.js và plan_worker.py phù hợp thử planner, dev hoặc kiểm tra không DB. Không nên coi việc tạo process mỗi câu hỏi là lựa chọn mặc định cho lưu lượng lớn khi sidecar đã có.

### 3.5. MCP

Có thể cho các agent/IDE dùng công cụ schema, dry-plan, query, cube, knowledge. Tài liệu [MCP chính thức](https://docs.getwren.ai/oss/guides/mcp) có stdio/HTTP, chế độ no-connect và quyền ghi ví dụ tùy chọn. Snapshot ghi HTTP MCP chưa có bearer auth tích hợp; nếu mở rộng ra mạng phải đặt sau gateway/xác thực/phân quyền. Không thay dịch vụ riêng có token của Hub bằng một endpoint MCP public.

### 3.6. LangChain/LangGraph hoặc Pydantic AI

Repo có toolkit query, dry-plan, list models, fetch context, recall/store ví dụ. Xem [SDK overview](https://docs.getwren.ai/oss/sdk/overview). Hữu ích khi chuyển agent orchestration sang framework này. Với Node + Gemini hiện tại, đổi framework chỉ để thêm Wren sẽ tăng phạm vi mà chưa có lợi ích được chứng minh.

### 3.7. WebAssembly phía trình duyệt

Có engine WASM chạy MDL/SQL trên dữ liệu đã đưa vào browser. Hợp cho demo, dữ liệu công khai hoặc dataset người dùng được phép tải đầy đủ. Không dùng browser làm ranh giới phân quyền với dữ liệu nhạy cảm: dữ liệu đã gửi xuống máy người dùng có thể bị sao chép. Bundle WASM khá lớn; cần đo thời gian tải và RAM. Hub đã có ECharts, nên backend Wren + ECharts là hướng gọn hơn cho giai đoạn này.

### 3.8. n8n, lịch báo cáo và hệ thống BI khác

n8n có thể chạy ingestion, refresh snapshot, gọi API BI theo lịch, tạo báo cáo hoặc cảnh báo. Mỗi job phải có scope/quyền/version và audit; output chia sẻ cần đi đúng người nhận được cấp quyền. Không gắn quyền admin toàn cục vào mọi job.

Nếu “BI” còn bao gồm Microsoft Power BI, tách hai lựa chọn:
- Cùng truy vấn warehouse/data mart và đồng bộ định nghĩa KPI giữa MDL với báo cáo đã duyệt.
- Giữ semantic model/DAX trong Power BI và xây tool riêng gọi API Microsoft; đây không phải đường SQL Wren mặc định. [Execute Queries](https://learn.microsoft.com/en-us/rest/api/power-bi/datasets/execute-queries) nhận DAX, có yêu cầu quyền, giới hạn và hạn chế riêng với RLS/service principal. Nhúng report cũng là một bài toán riêng.

Không giả định file PBIX/DAX được Wren tự nhập thành MDL hay giữ nguyên bảo mật Power BI.

## 4. Sotrans Hub hiện có gì?

### 4.1. Những lớp có thể tái sử dụng

- General AI: route chat, Gemini, history, HTTP/SSE và lưu hội thoại.
- PostgreSQL: dữ liệu có cấu trúc để tổng hợp.
- Qdrant/RAG: tìm nội dung quy định/tài liệu.
- Analytics Engine: 17 KPI có catalog, SQL và scope cố định.
- File BI: tiếp nhận bảng tính, profile, registry, quyền, truy vấn và report.
- Dashboard v2/ECharts: KPI, charts, tables, filters, export.
- Auth/RBAC: ADMIN/HR và phạm vi công ty.
- n8n/NocoDB/OneDrive/OCR: quy trình nguồn và quản lý dữ liệu.

Đây là nền tốt để Wren bổ sung BI linh hoạt trong giao diện hiện có.

### 4.2. Tích hợp Wren đã có trong mã

Các file chính:
- [Route General AI](D:/hoso-chat/auth-service/routes/general_ai.js).
- [Orchestration Wren](D:/hoso-chat/auth-service/services/wrenBiService.js).
- [Planner bridge](D:/hoso-chat/integrations/wrenai/bridge/plan_worker.py).
- [Executor nội bộ](D:/hoso-chat/integrations/wrenai/bridge/query_service.py).
- [Model template](D:/hoso-chat/integrations/wrenai/models/hub.mdl.template.json).
- [Business rules](D:/hoso-chat/integrations/wrenai/models/business-rules.md).
- [Dashboard UI](D:/hoso-chat/chat/bi-dashboard.js).
- [Trạng thái triển khai trước đó](D:/hoso-chat/docs/BI_WREN_IMPLEMENTATION_STATUS.md).

Luồng Wren hiện có:
1. Routing bằng intent và mẫu từ khóa/follow-up.
2. Kiểm tra user ACTIVE, ADMIN/HR và company scope.
3. Đọc catalog/quy tắc; Gemini trả JSON SQL/title/chart_type hoặc câu hỏi làm rõ.
4. Tối đa hai lượt sinh kế hoạch trong retry loop hiện hữu.
5. Gọi /query nội bộ; service replan với MDL server.
6. Thực thi PostgreSQL READ ONLY.
7. Chuẩn hóa thành dashboard v2; kiểm schema, privacy, ký export.
8. Lưu context Wren và audit metadata.

Bản hiện tại có đúng ba model:
- **hub_documents:** loại/chuyên mục/trạng thái, ngày hiệu lực/hết hạn và parse_quality; loại bản ghi đã xóa; scope gồm tài liệu toàn nhóm và tài liệu đơn vị.
- **hub_intake_batches:** lô tiếp nhận, trạng thái, total_files, thời điểm tạo.
- **hub_staged_records:** hồ sơ staging, trạng thái và cờ suspected_duplicate; không expose tên/CCCD/email/điện thoại/lương.

relationships và views trong template đang rỗng. Chưa phải semantic layer cho toàn bộ dữ liệu doanh nghiệp.

### 4.3. Bộ KPI cố định cần giữ

Catalog hiện ghi 11 READY, 3 CONDITIONAL và 3 BLOCKED. Đây là phân loại trong mã, không phải kết quả nghiệm thu mới.

Nhóm READY gồm DOC_TOTAL, DOC_BY_EFFECTIVE_DATE, DOC_BY_TYPE, DOC_STATUS, INTAKE_UPLOADS, INTAKE_BY_USER, INTAKE_TRENDS, DUPLICATE_RATE, APPROVAL_QUEUE, DATA_INTEGRITY và ACTIVE_USERS.

Nhóm CONDITIONAL: INTAKE_SUCCESS, OCR_QUALITY, RAG_ANSWERABLE.

Nhóm BLOCKED:
- INTAKE_FAILURE: chưa ghi nhận đầy đủ lỗi pipeline vào nguồn truy vấn.
- INTAKE_DURATION: telemetry thời gian chưa đủ tin cậy theo ghi nhận trong catalog.
- POLICY_CONFLICT: kết quả detector động chưa được lưu thành nguồn tĩnh phù hợp.

Wren không biến KPI BLOCKED thành khả dụng. Cần sửa nguồn/định nghĩa trước.

### 4.4. Ranh giới vận hành hiện có

- Một SELECT, chặn nguồn không duyệt, kiểm model/cột và một số hàm; không nhận MDL/connection/planned SQL từ frontend.
- Replan tại service; credential BI riêng; transaction READ ONLY.
- PostgreSQL statement timeout 3 giây; tối đa 500 dòng; service có semaphore bốn query đồng thời.
- Node giới hạn response 1 MiB và timeout request service 12 giây; đây không phải SLA thời gian toàn câu trả lời có LLM.
- Sidecar cấu hình filesystem read-only, bỏ capabilities, giới hạn CPU/RAM/PID, bearer token và host loopback.
- HR chỉ đơn vị mình; ADMIN chọn rõ STL/VTX/SWC/ALL.
- **Chưa có RLS PostgreSQL mới trong tích hợp này.** Private service tin backend xác nhận scope, không tự xác minh JWT từng người dùng. Token/mạng nội bộ và Hub là ranh giới cần bảo vệ.
- Core mặc định có strict_mode=false; adapter Hub đã chủ động bật strict_mode và fallback=false. Không suy rộng cấu hình an toàn của adapter cho mọi cách dùng SDK.

## 5. Có thể áp dụng gì cho Sotrans?

### 5.1. Ưu tiên cao, dựa trên nguồn đang có

1. **Báo cáo văn bản theo nhiều chiều.** Ví dụ: “Dùng Wren thống kê văn bản STL theo loại và trạng thái.” Dùng COUNT(DISTINCT doc_version_id), xử lý quyền và soft-delete. “Còn hiệu lực” phải xét thêm ngày hiệu lực/hết hạn theo định nghĩa được duyệt.
2. **Xu hướng tiếp nhận hồ sơ/file.** “Tổng số file tiếp nhận theo tháng và trạng thái của STL trong quý này.” Tách COUNT(batch) với SUM(total_files).
3. **Theo dõi tồn staging.** “Phân bổ hồ sơ staging theo trạng thái và cờ nghi trùng của STL.” Cờ nghi ngờ không đồng nghĩa trùng lặp đã xác nhận.
4. **Báo cáo tiếp nối trong chat.** “Còn tháng trước?”, “Đổi sang biểu đồ cột.” Context Wren đã có; cần nghiệm thu với chuyển chủ đề, đổi đơn vị và đổi nguồn.
5. **Dashboard điều hành trong General AI.** Một câu hỏi tạo KPI/bảng/chart, không cần chuyển sang UI Wren riêng. Hiện Wren producer dùng một result set, tạo chart theo các cột số; chưa phải bộ lập kế hoạch dashboard nhiều truy vấn độc lập.
6. **Báo cáo bảng tính tải lên.** Tổng/trung bình/count theo sheet và cột, lọc, chart và xuất Excel. Có nền File BI nhưng hiện chạy engine JSON của Hub, chưa qua Wren.

### 5.2. Ưu tiên tiếp theo, cần mở model hoặc công cụ

7. **Chất lượng số hóa.** Phân tích parse_quality/văn bản; nếu muốn chất lượng OCR hồ sơ, cần model nguồn OCR tương ứng và coverage. Không gộp hai loại chất lượng làm một.
8. **Hiệu quả chatbot/RAG.** Chủ đề không trả lời được, xu hướng nhu cầu, tỷ lệ đáp ứng theo kỳ. Cần chuẩn hóa event và model chat_log, kiểm quyền nội dung. Model Wren hiện chưa có.
9. **Giải thích số liệu bằng quy định.** “Bao nhiêu hồ sơ đang chờ và theo quy định cần xử lý thế nào?” SQL cung cấp số lượng, RAG cung cấp điều khoản còn hiệu lực; orchestrator hợp nhất nguồn. Chỉ nêu nguyên nhân khi có chứng cứ tương ứng.
10. **Báo cáo định kỳ/cảnh báo.** Tồn tăng, chất lượng OCR thấp, tài liệu sắp hết hạn. Cần scheduler, ngưỡng, danh sách người nhận và query được duyệt; không phải tính năng đã bật chỉ nhờ có Wren.
11. **Bộ câu hỏi chuẩn có tái sử dụng.** Lưu câu hỏi tiếng Việt và query đã kiểm chứng để tăng độ ổn định. Đánh version theo model, scope, ngày và định nghĩa metric.

### 5.3. Cần dữ liệu/mapping mới

12. **Headcount, biến động nhân sự, payroll.** Cần employee master và lịch sử hiệu lực được phép dùng. Không lấy số staging làm số nhân viên.
13. **File đối chiếu với hệ thống.** Ví dụ danh sách Excel đối chiếu trạng thái hồ sơ. Cần khóa ghép, cardinality, xử lý trùng, timestamp, chủ sở hữu, TTL và quyền trên cả hai nguồn. HYBRID hiện bị validator từ chối có chủ đích.
14. **Logistics:** sản lượng vận chuyển, chuyến/đơn hàng, đúng hạn, sử dụng xe, công suất kho. Cần TMS/WMS/ERP hoặc data mart; chưa thấy trong ba model hiện tại. Định nghĩa đúng hạn cần deadline/thực tế/quy tắc loại trừ.
15. **Tài chính/kinh doanh:** doanh thu, chi phí, lợi nhuận theo khách hàng/tuyến/đơn vị. Cần nguồn tài chính, định nghĩa gross/net, VAT, tiền tệ, tỷ giá và ngày ghi nhận được phê duyệt.
16. **Dự báo và bất thường:** Wren lấy features/chuỗi số liệu; mô hình thống kê/ML hoặc rule engine riêng làm dự báo/phát hiện. Câu trả lời LLM tự suy đoán không phải dự báo đã kiểm định.

## 6. Điểm mạnh đối với bài toán của anh

1. **Dễ gắn vào hệ hiện hữu:** Node gọi Python nội bộ, giữ Gemini và UI Hub.
2. **Giảm hiểu nhầm nghiệp vụ:** cùng một tên chỉ số có định nghĩa và nguồn rõ ràng.
3. **Linh hoạt hơn KPI viết sẵn:** hỗ trợ nhóm chiều và khoảng thời gian mới trong phạm vi model.
4. **Định nghĩa có thể review/version:** model và rules thành tài sản của Sotrans.
5. **Kiểm soát truy vấn nhiều lớp:** planning + admission + quyền DB + quota của ứng dụng.
6. **Nguồn và trace giúp giải trình:** điều tra sai lệch tới model/version/scope thay vì chỉ nhìn câu trả lời.
7. **Mở rộng sang nhiều nguồn về sau:** có nền connector thay vì mỗi chatbot viết riêng từ đầu.
8. **Không phụ thuộc một LLM:** có thể đổi model tạo SQL sau khi benchmark.
9. **Tận dụng đầu tư BI hiện có:** schema/renderer/report/export của Hub tiếp tục dùng được.
10. **Có đường nâng chất lượng:** rules → ví dụ duyệt → cube/structured queries → bộ đánh giá hồi quy.

## 7. Điểm yếu và giới hạn cần tính vào quyết định

1. **Tốn công làm semantic layer.** Metadata tự sinh không thay thế người hiểu nghiệp vụ.
2. **SQL hợp lệ vẫn có thể sai.** Sai grain, kỳ, denominator, trạng thái hoặc join đều có thể cho số hợp lý nhưng sai ý.
3. **Phân quyền là trách nhiệm hệ thống.** MDL/prompt/read-only không đồng nghĩa chống đọc chéo công ty; READ ONLY chỉ bảo vệ khỏi ghi trong phạm vi transaction.
4. **Dữ liệu thiếu/sai không được engine sửa hộ.** Ba KPI khóa và dataset mất file là ví dụ hiện hữu.
5. **Chi phí/độ trễ phụ thuộc LLM.** Schema prompt, retry, dry-run và DB đều cộng vào thời gian; cần đo thay vì hứa phản hồi ngay.
6. **Thêm thành phần vận hành.** Python/binding Rust, image, policy, SQL dialect, model và API phải tương thích phiên bản.
7. **Khác biệt SQL giữa nguồn.** Snapshot ghi hạn chế correlated subquery; integration cũ cũng ghi đã gặp toán tử PostgreSQL phải điều chỉnh trong refSql. Cần kiểm theo workload thực.
8. **Nhiều connector không đồng nghĩa join mọi nguồn tự động.** Cần federation layer hoặc staging/data mart thích hợp.
9. **OSS không kèm toàn bộ nền tảng BI enterprise.** Dashboard tự xây vẫn cần persistence, sharing, refresh, export, quyền và vận hành.
10. **Routing tiếng Việt hiện thiên về heuristic.** Cần đánh giá paraphrase, không dấu, câu mơ hồ và chuyển chủ đề; chưa có benchmark toàn bộ nghiệp vụ.
11. **Memory cần được quản trị.** Chỉ lưu ví dụ đã xác nhận; tránh ví dụ sai, stale và lẫn tenant. Hub chưa tích hợp bộ Wren/LanceDB memory.
12. **LIMIT không giới hạn công việc DB tương ứng.** GROUP BY/COUNT trên bảng lớn vẫn có thể quét nhiều dòng; cần index, query plan, replica hoặc bảng tổng hợp.
13. **Bảo mật dữ liệu tới LLM phụ thuộc từng route.** Self-host Wren không làm Gemini trở thành nội bộ. Wren route gửi catalog/rules/câu hỏi; KPI route hiện có thể gửi số liệu tổng hợp đã sanitize để tạo nhận xét. Cần policy riêng trước khi mở thêm PII.
14. **Mức hoàn thiện hiện tại còn giới hạn.** Filter Wren/KPI chỉ lọc các nhóm đã trả về; drill không tự phát sinh truy vấn xuống mức dữ liệu chưa lấy. Slicer/search/page chưa persist qua reload; follow-up dựa context lượt chat, không tự nhận state filter tạm.

## 8. Kiến trúc đề xuất

Người dùng → General AI Orchestrator → xác định nguồn/phạm vi/metric/kỳ → kiểm quyền → chọn một hoặc nhiều công cụ:

- **KPI chuẩn:** Analytics Engine.
- **Phân tích linh hoạt trên model:** semantic catalog → Gemini draft → Wren planning → authorized executor.
- **Bảng tính:** registry/ACL → File BI, sau đó cân nhắc DuckDB/Parquet khi có nhu cầu.
- **Nội dung quy định:** Qdrant/RAG.
- **Tác vụ ghi:** workflow nghiệp vụ hiện hữu có quyền riêng; không gộp vào executor BI.

Kết quả → report contract v2 → KPI/chart/table + nguồn/phạm vi/thời điểm → UI chat.

Nên nâng orchestration thành kế hoạch có cấu trúc:
- source_mode, metric_id, dimensions, time_range/time_grain;
- company_scope do server chọn;
- dataset/version và source freshness;
- filters, group limit, sort;
- clarification khi thiếu định nghĩa;
- yêu cầu quyền và mức chi tiết được phép trả.

Các trường trên là thiết kế đề xuất, không phải API đã triển khai. Với chỉ số thường dùng, ưu tiên structured metric/cube rồi mới tới SQL ad-hoc có kiểm soát.

Một câu hỏi cần SQL + RAG nên có hai kết quả riêng được hợp nhất: số liệu đã thực thi và trích dẫn văn bản có quyền. Không biến suy đoán từ tài liệu thành giá trị đo lường.

## 9. Quy tắc đúng số liệu và an toàn cần giữ

- Xác định grain: một văn bản/version, một batch, một file, một staging record hay một employee.
- COUNT DISTINCT văn bản khi định nghĩa yêu cầu; không mặc định COUNT(*) tương đương.
- Khi join batch–staging, tránh nhân total_files theo số staging con; aggregate ở đúng cấp trước khi join.
- AVG cần trọng số nếu tổng hợp lại; không cộng median/distinct giữa các nhóm chồng nhau.
- Trục thời gian sort đúng; kỳ thiếu phải có chính sách; mẫu số bằng 0 không tự đổi thành tăng trưởng 0%.
- Phân biệt null/unavailable/không có dữ liệu với 0 thực sự.
- Biên kỳ theo giờ Việt Nam: đầu kỳ bao gồm, đầu kỳ tiếp theo loại trừ; đối chiếu kiểu timestamp vật lý.
- Tài liệu còn hiệu lực cần cả lifecycle và khoảng ngày; suspected_duplicate chỉ là nghi ngờ.
- Scope, connection và manifest do server quyết định; không dùng company_id người dùng đưa lên như bằng chứng có quyền.
- Kiểm quyền lại khi hỏi tiếp, refresh, export và đọc report đã lưu; cache phải có khóa scope/quyền/version.
- Với dữ liệu nhỏ/nhạy cảm, cân nhắc ngưỡng tối thiểu và mức chi tiết, vì aggregate vẫn có thể tiết lộ cá nhân.
- Không coi “không có PII trong model” là đánh giá đầy đủ cho mọi nguồn sau này.
- Không đưa token, credential, raw row hoặc dữ liệu nhạy cảm vào report/log/prompt ngoài policy được duyệt.
- Lỗi phải có mã truy vết và thông báo đúng; không dựng báo cáo giả khi DB/LLM thất bại.
- Nếu triển khai RLS/view riêng/role theo scope về sau, kiểm bằng test trực tiếp tại DB; không gắn nhãn đã có RLS khi chưa thực hiện.

## 10. Lộ trình ưu tiên theo điều kiện hoàn thành

### Bước 1 — Nghiệm thu phạm vi hiện tại

Chọn bộ câu hỏi tiếng Việt có expected result và quyền thật cho ba model. Đối chiếu nguồn, scope, thời gian, follow-up, đổi nguồn, export và lỗi. Đồng bộ Staging bằng artifact xác định trước UAT. Sửa/khôi phục dataset thiếu dữ liệu từ bản gốc/backup xác minh; không tạo lại từ preview.

Hoàn thành khi người phụ trách nghiệp vụ xác nhận số đúng; test UI bằng tài khoản thật; kết quả gắn version. Health và fixture hiện hữu chưa đủ thay bước này.

### Bước 2 — Chuẩn hóa semantic catalog

Mỗi metric có owner, định nghĩa, nguồn, grain, unit, time dimension, filter mặc định, null/zero policy, quyền và version. Duyệt enum tiếng Việt/viết tắt. Bổ sung quan hệ/cube chỉ sau khi chốt cardinality.

Hoàn thành khi cùng câu hỏi cho cùng định nghĩa giữa KPI, Wren và dashboard tham chiếu.

### Bước 3 — Hoàn thiện trải nghiệm report

Filter Wren/KPI gọi server để tính lại khi cần; giữ tách summary toàn phạm vi và top-N. Lưu report_id/query specification/filter state. Chuẩn hóa saved report, pagination nguồn, chart hierarchy, snapshot/freshness và export.

Hoàn thành khi chat follow-up, slicer, bảng, KPI và export dùng cùng phạm vi được phép và cùng version.

### Bước 4 — Kết hợp BI và RAG

Thêm composite plan, kiểm quyền từng nguồn, trả số liệu với trích dẫn điều khoản và nêu thiếu bằng chứng khi hỏi nguyên nhân. Tái kiểm quyền theo lượt, không chỉ lúc mở hội thoại.

### Bước 5 — Mở rộng File/Unified BI

Chỉ chuyển File BI sang DuckDB/Parquet nếu workload/joins/quy mô chứng minh nhu cầu. Registry lưu owner, grants, checksum, version, expiry và nguồn gốc. Join file–system phải có mapping đã duyệt và kiểm quyền trên mọi phía; mở HYBRID bằng phiên bản contract và test tương ứng.

### Bước 6 — Nguồn doanh nghiệp và vận hành dài hạn

Thêm employee master/TMS/WMS/ERP/finance theo từng miền. Bổ sung telemetry ba KPI đang khóa. Đo concurrency/latency/cost; cân nhắc data mart/replica, cache có scope và materialized aggregate. Sau đó triển khai lịch báo cáo/cảnh báo và cơ chế review model.

Không nên khởi đầu bằng việc đưa tất cả bảng vào prompt, cài lại UI legacy hoặc cho agent tự join mọi nguồn.

## 11. Cách thử bằng giao diện hiện có

Dùng ADMIN/HR hợp lệ trong General AI; kiểm lại quyền bằng tài khoản thật khi UAT. Khi thử nguồn hệ thống, bỏ chọn dataset file đang active.

Ví dụ:
1. “Dùng Wren phân tích số lô tiếp nhận theo trạng thái của STL.”
2. “Dùng Wren thống kê văn bản của STL theo loại và trạng thái.”
3. “Dùng Wren tính tổng số file tiếp nhận theo tháng của STL trong quý này.”
4. “Còn tháng trước?”
5. “Đổi sang biểu đồ cột.”

ADMIN cần scope rõ STL/VTX/SWC/ALL; HR bị giới hạn theo đơn vị. Câu hỏi KPI cố định có thể được định tuyến về Analytics Engine. Câu hỏi có từ Wren đi vào nhánh nâng cao theo logic hiện tại.

File: tải một Excel/CSV, chọn dataset/sheet và hỏi phép tổng hợp theo tên cột thật. Giới hạn hiện tại trong mã: 25 MiB/file, tối đa 10 sheet và tổng 50.000 dòng/workbook, 100 cột; kết quả/report có giới hạn riêng.

Lưu ý:
- Filter hệ thống hiện lọc snapshot đã trả về; hỏi câu mới để truy vấn lại theo phạm vi khác.
- Export Excel theo snapshot/giới hạn hiện có; không đồng nghĩa xuất toàn bộ bảng nguồn.
- PDF hiện là In trên trình duyệt với chart và trang bảng đang hiển thị, chưa phải dịch vụ PDF toàn bộ dữ liệu.
- Dashboard Wren có thể có nhiều chart từ nhiều cột số; chỉ số “Nhóm kết quả” là số dòng đã trả, không phải tổng số bản ghi nguồn.

## 12. Chi phí, hiệu năng và phương án chọn

Không có benchmark hoặc chi phí người dùng cụ thể trong lượt này; không gán số tiền/độ chính xác ước đoán làm số thực tế.

Tổng chi phí gồm:
- LLM: token catalog/rules/question và retry; memory embedding nếu bật.
- Hạ tầng: Python sidecar, DB/replica/data mart, kho file và log.
- Nhân lực: định nghĩa model, quyền, dữ liệu, UI và UAT; thường là phần đáng ưu tiên đo.
- Vận hành: versioning, monitoring, backup, khôi phục và bảo mật.
- Phí thương mại nếu chọn dùng nền tảng Wren Cloud/Enterprise hoặc dịch vụ BI khác.

Cấu hình sidecar hiện đặt 1 CPU/512 MiB và bốn query đồng thời. Đây là cấu hình triển khai, chưa chứng minh sức tải sản xuất. LIMIT 500 là số dòng trả, không phải giới hạn 500 dòng đọc trong DB.

Lựa chọn phù hợp:
- Chỉ 17 KPI cố định: Analytics Engine đã có có thể đủ.
- KPI cộng câu hỏi mới theo nhiều chiều: kết hợp Analytics Engine + Wren.
- Tài liệu/quy định là chủ đạo: RAG vẫn là công cụ chính.
- Bảng tính nhỏ, phép tổng hợp đơn giản: giữ File BI hiện hữu trong khi hoàn thiện correctness.
- Nhiều nguồn/bảng lớn: data mart/federation phù hợp trước, Wren đứng trên lớp đã quản trị.
- Muốn nền tảng BI enterprise trọn gói: đánh giá bản thương mại hoặc BI hiện có; so sánh chi phí hoàn thiện Hub với phí và yêu cầu dữ liệu.

## 13. Bộ nghiệm thu nên có

Các tiêu chí sau là đề xuất, chưa phải kết quả đạt được:
- 50–100 câu hỏi tiếng Việt có expected result do nghiệp vụ xác nhận, gồm không dấu/viết tắt/đổi cách hỏi/câu mơ hồ.
- Đối chiếu số, grain, scope và kỳ; query chạy được không được tính là câu trả lời đúng.
- Quyền HR/STL, HR/VTX, HR/SWC, ADMIN/ALL, guest, tài khoản khóa và thay đổi quyền.
- Hội thoại người khác; follow-up sau đổi chủ đề, dataset, sheet, đơn vị, kỳ và quyền.
- Trường hợp zero/null/empty, ngày sai, kỳ thiếu, top-N, giới hạn 500, join làm nhân dòng, số lớn và số thập phân.
- Khớp giữa chat, chart, KPI, filter, export và report tải lại.
- Timeout, DB/LLM unavailable, concurrency limit, model stale, source stale, file expiry/revoke/missing.
- Đo p50/p95, số LLM call/câu, token, query error, clarification rate và tần suất người dùng sửa lại câu hỏi.
- Mục tiêu tham khảo: số KPI chuẩn khớp hoàn toàn bộ expected; không có ca vượt quyền trong bộ test; tỷ lệ đúng của câu hỏi hỗ trợ do business owner chốt. Không coi đạt bộ test hữu hạn là chứng minh tuyệt đối mọi trường hợp an toàn.

## 14. Nguồn tham chiếu

Đọc mã local là cơ sở chính cho nhận định về Sotrans; tài liệu web dùng để xác nhận hướng sản phẩm tại ngày đánh giá:
- [WrenAI README local](C:/Users/Admin/Downloads/WrenAI-main/WrenAI-main/README.md).
- [Architecture local](C:/Users/Admin/Downloads/WrenAI-main/WrenAI-main/docs/core/reference/architecture.md).
- [SDK/CLI module guidance](C:/Users/Admin/Downloads/WrenAI-main/WrenAI-main/core/wren/.claude/CLAUDE.md).
- [License map của snapshot](C:/Users/Admin/Downloads/WrenAI-main/WrenAI-main/LICENSE): core/sdk/skills/examples Apache-2.0; docs CC BY 4.0; file AGPL có sẵn không có nghĩa mọi module chịu AGPL.
- [WrenAI chính thức](https://github.com/Canner/WrenAI).
- [Ranh giới open-core](https://www.getwren.ai/en/open-core).
- [SDKs](https://docs.getwren.ai/oss/sdk/overview).
- [MCP](https://docs.getwren.ai/oss/guides/mcp).
- [Power BI Execute Queries](https://learn.microsoft.com/en-us/rest/api/power-bi/datasets/execute-queries).
- [Tích hợp Wren của Hub](D:/hoso-chat/integrations/wrenai/README.md).
- [Bằng chứng triển khai trước đó](D:/hoso-chat/docs/BI_WREN_IMPLEMENTATION_STATUS.md).

Hạn chế: workspace có nhiều thay đổi chưa commit; đây là đánh giá snapshot quan sát, không xác nhận mọi file trên đĩa tương ứng artifact đang nạp trong runtime. Cần gắn commit/image/model hash khi nghiệm thu chính thức.

