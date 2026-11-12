/**
 * SOTRANS HUB — ANSWER QUALITY ENHANCER SERVICE
 * 
 * Pipeline toàn diện nâng cấp chất lượng câu trả lời cho toàn bộ AI Agents:
 * 1. Phân tích yêu cầu trước khi sinh (Pre-generation Intent & Constraint Decomposition)
 * 2. Khung trả lời có cấu trúc (Structured Cognitive Answering Architecture)
 * 3. Định tuyến tham số mô hình theo tác vụ (Dynamic Task-Oriented Parameters & Temperature)
 * 4. Hậu kiểm và tự động hiệu chỉnh câu trả lời (Deterministic Post-Generation Verification)
 */

// Danh sách domain được phép xuất hiện trong câu trả lời (Whitelist Domains)
const ALLOWED_DOMAINS = [
  'sotrans.com.vn',
  'vietranstimex.com.vn',
  'sowatco.com.vn',
  'openstreetmap.org',
  'open-meteo.com',
  'wikipedia.org',
  'chinhphu.vn',
  'customs.gov.vn',
  'gdt.gov.vn'
];

const universalDataEngine = require('./universalDataEngine');

/**
 * 1. PHÂN TÍCH YÊU CẦU TRƯỚC KHI SINH (PRE-GENERATION ANALYSIS)
 */
function analyzeQueryAndDecompose(userMessage = '', history = [], agentContext = {}) {
  const q = String(userMessage || '').trim();
  const qLower = q.toLowerCase();

  // Nhận diện ý định và thực thể chuyên sâu qua Universal Data Understanding Engine
  const queryUnderstanding = universalDataEngine.understandUserQuery(
    userMessage,
    history,
    agentContext.activeFiles || []
  );

  // Xác định định dạng đầu ra mong muốn (Desired Output Format)
  const isCodeRequested = /(viết code|viết mã|hàm python|đoạn code|script|vba|macro|sql query|javascript|cú pháp)/i.test(qLower);
  const isTableRequested = /(bảng|table|danh sách dạng bảng|kẻ bảng|bảng tính|báo cáo bảng)/i.test(qLower) || queryUnderstanding.isAllRecordsRequested;
  const isBilingualRequested = /(song ngữ|tiếng anh|bilingual|dịch sang tiếng anh|bản tiếng anh|tiếng việt và tiếng anh)/i.test(qLower);
  const isJsonRequested = /(dạng json|định dạng json|format json|output json|trả về json)/i.test(qLower);
  const isCalculationRequested = /(tính|tổng|trọng lượng|chi phí|cước|công thức|sumifs|vlookup|xlookup|average|chia|nhân|tỷ lệ|cộng dồn)/i.test(qLower) || queryUnderstanding.isAggregationRequested;
  const isEmailRequested = /(soạn email|viết thư|soạn thư|gửi khách hàng|thư chào hàng|thư ngỏ|thông báo)/i.test(qLower);
  const isPolicyRequested = /(quy định|chính sách|nghỉ phép|công tác phí|thử việc|bảo hiểm|lương thưởng|kỷ luật)/i.test(qLower);
  const isHoSoRequested = /(hồ sơ|thông tin của tôi|nhân viên|mã nhân viên|phòng ban|ngày vào làm|cccd)/i.test(qLower);

  // Phân loại danh mục tác vụ chính (Task Category)
  let taskCategory = 'GENERAL_KNOWLEDGE';
  if (isCalculationRequested || isTableRequested || queryUnderstanding.intent === 'ALL_RECORDS' || queryUnderstanding.intent === 'STRUCTURED_SPREADSHEET') taskCategory = 'DATA_CALCULATION';
  else if (isCodeRequested) taskCategory = 'CODE_DEVELOPMENT';
  else if (isEmailRequested) taskCategory = 'COMMERCIAL_WRITING';
  else if (isPolicyRequested) taskCategory = 'POLICY_INQUIRY';
  else if (isHoSoRequested) taskCategory = 'HOSO_INQUIRY';

  // Định tuyến tham số tối ưu (Optimal Parameters)
  let optimalTemperature = 0.30;
  let maxTokens = 4096;

  switch (taskCategory) {
    case 'DATA_CALCULATION':
      optimalTemperature = 0.15; // Cực kỳ xác định, chống sai số
      break;
    case 'CODE_DEVELOPMENT':
      optimalTemperature = 0.20; // Chuẩn xác cú pháp mã nguồn
      break;
    case 'COMMERCIAL_WRITING':
      optimalTemperature = 0.45; // Tự nhiên, văn phong ngoại giao trang trọng
      break;
    case 'POLICY_INQUIRY':
    case 'HOSO_INQUIRY':
      optimalTemperature = 0.15; // Bám sát văn bản, tuyệt đối không suy đoán
      break;
    default:
      optimalTemperature = 0.35;
      break;
  }

  // Tôn trọng thiết lập của agent nếu người dùng đã chỉ định nhiệt độ tùy biến hợp lệ
  if (typeof agentContext.temperature === 'number' && agentContext.temperature >= 0.0 && agentContext.temperature <= 1.0) {
    optimalTemperature = agentContext.temperature;
  }

  return {
    primaryIntent: taskCategory,
    queryUnderstanding,
    constraints: {
      isCodeRequested,
      isTableRequested,
      isBilingualRequested,
      isJsonRequested,
      isCalculationRequested,
      isEmailRequested,
      isAllRecordsRequested: queryUnderstanding.isAllRecordsRequested,
      isComparisonRequested: queryUnderstanding.isComparisonRequested,
      isExportRequested: queryUnderstanding.isExportRequested
    },
    optimalParameters: {
      temperature: optimalTemperature,
      maxOutputTokens: maxTokens
    }
  };
}

/**
 * 2. XÂY DỰNG KHUNG CHỈ DẪN CẤU TRÚC (STRUCTURED QUALITY FRAMEWORK)
 * Tích hợp quy chuẩn tư duy 5 bước vào System Prompt của Agent
 */
function buildStructuredQualityFramework(agentName = 'AI Agent', taskAnalysis = {}) {
  const { constraints = {} } = taskAnalysis;

  return `
# QUY CHUẨN CHẤT LƯỢNG CÂU TRẢ LỜI CẤP DOANH NGHIỆP (SOTRANS QUALITY PROTOCOL):
Khi tạo câu trả lời, bạn BẮT BUỘC tuân thủ cấu trúc tư duy và tiêu chuẩn trình bày sau:

1. TRẢ LỜI TRỰC TIẾP TRỌNG TÂM (BOTTOM LINE UP FRONT - BLUF):
   - Đưa ngay câu trả lời cốt lõi, kết quả tính toán hoặc kết luận chính xác ở ngay 1-2 câu đầu tiên.
   - Tuyệt đối không mở đầu bằng các câu sáo rỗng, máy móc lặp lại câu hỏi (như "Dựa trên yêu cầu của bạn tôi xin trả lời...", "Hôm nay tôi sẽ giúp bạn...").

2. BAO QUÁT ĐẦY ĐỦ ĐIỀU KIỆN (COMPLETE CONDITION COVERAGE):
   - Kiểm tra và giải quyết triệt để TẤT CẢ các điều kiện phụ, tiêu chí lọc, hoặc ràng buộc số liệu mà người dùng đưa ra.
   - Không được bỏ sót bất kỳ chi tiết nào dù là nhỏ nhất.

3. NGUYÊN TẮC MINH BẠCH & CĂN CỨ THỰC TẾ (FACTUAL GROUNDING & INTEGRITY):
   - Phân biệt rõ ràng giữa: (A) Dữ kiện xác thực từ hệ thống/tài liệu; (B) Giả định hợp lý; và (C) Khuyến nghị nghiệp vụ.
   - TUYỆT ĐỐI KHÔNG tự bịa đặt: mức giá cước, tỷ lệ chiết khấu, cam kết thời gian giao hàng, mã vận đơn, số điện thoại hoặc liên kết website/App Store không có thật.
   - TUYỆT ĐỐI KHÔNG tự nhận mình đã tạo file hoặc xuất file nếu bạn chưa thực sự gọi và nhận kết quả thành công từ công cụ xuất tệp.

4. TIÊU CHUẨN ĐỊNH DẠNG CHUYÊN NGHIỆP:
   ${constraints.isTableRequested ? '- Người dùng yêu cầu BẢNG: Sử dụng bảng Markdown chuẩn mực với tiêu đề rõ ràng, căn lề thẳng hàng.' : ''}
   ${constraints.isCodeRequested ? '- Người dùng yêu cầu CODE/CÔNG THỨC: Sử dụng khối mã cú pháp nổi bật (```` ```python ````, ```` ```vba ````, v.v.), có chú thích rõ ràng, xử lý lỗi ngoại lệ và hướng dẫn cách áp dụng.' : ''}
   ${constraints.isBilingualRequested ? '- Người dùng yêu cầu SONG NGỮ: Trình bày rõ ràng gồm 2 phần riêng biệt: PHẦN 1: BẢN TIẾNG VIỆT và PHẦN 2: BẢN TIẾNG ANH (ENGLISH VERSION). Cả hai phần phải tương đương về mặt nội dung và độ trang trọng.' : ''}
   ${constraints.isEmailRequested ? '- Người dùng yêu cầu SOẠN EMAIL: Cung cấp đầy đủ Tiêu đề (Subject line), Kính gửi (Salutation), Thân bài mạch lạc có phân đoạn, Lời kêu gọi hành động (CTA), và Chữ ký chuyên nghiệp.' : ''}
   - Độ dài câu trả lời phải tương xứng với độ phức tạp của câu hỏi: Ngắn gọn với câu hỏi đơn giản, đầy đủ sâu sắc với bài toán phân tích đa bước. Không lặp lại ý thừa.

5. NGUYÊN TẮC TRÍCH XUẤT DỮ LIỆU BẢNG TÍNH & ĐỐI SOÁT (SPREADSHEET DATA RIGOR):
   - Khi làm việc với bảng tính hoặc báo giá logistics/vận tải:
     + Tuyến đường & địa danh: Luôn nhận diện cả tên đầy đủ, tên viết tắt và địa chỉ chi tiết (ví dụ: "Dĩ An", "Dĩ An, Bình Dương" và "Alley 64, Truong Van Vinh Street, Tan Binh Ward, Di An City, Binh Duong Province" đều thuộc đích đến Dĩ An; "KCN Tân Bình" và "KCN Tân Bình, HCM" đều thuộc điểm đi Tân Bình).
     + Tra cứu toàn diện & công cụ: Khi cần tra cứu bản ghi hoặc tìm kiếm đa sheet, có thể sử dụng công cụ "search_spreadsheet_data".
     + BẢO TOÀN ĐẦY ĐỦ TẤT CẢ BẢN GHI (KHÔNG BỎ SÓT): Nếu có nhiều bản ghi cho cùng tuyến đường hoặc cùng mã REF (kể cả cùng ngày nhưng khác đơn vị tính như /chuyến và /xe, hoặc khác cách ghi địa chỉ như Alley 64 và Dĩ An, Bình Dương), PHẢI liệt kê đầy đủ TẤT CẢ các bản ghi (ví dụ: ngày 13/10 có cả bản ghi 900.000/chuyến và 900.000/xe; ngày 15/10 và ngày 16/10). Tuyệt đối không tự ý gộp hoặc bỏ qua bản ghi nào.
     + Phân biệt chính xác đơn vị tính: Nêu rõ đơn vị tính của từng mức giá (ví dụ: "900.000/chuyến", "900.000/xe", hay số trần "900" nghìn) theo đúng dữ liệu gốc.
     + Không bịa đặt: Nếu tuyến đường thực sự không tồn tại trong bất kỳ sheet nào của bảng tính, trả lời rõ ràng rằng không tìm thấy bản ghi cho tuyến này, tuyệt đối không suy đoán giá.
     + TUYỆT ĐỐI KHÔNG DÙNG LẠI LỊCH SỬ CŨ KHI BẢNG TÍNH ĐÃ ĐỒNG BỘ HOẶC THAY ĐỔI:
       * Dữ liệu trong bảng tính có thể đã được người dùng chỉnh sửa, thêm mới hoặc XÓA các dòng (hệ thống liên tục đồng bộ các phiên bản mới từ Microsoft OneDrive).
       * TUYỆT ĐỐI KHÔNG sử dụng lại mức giá, số dòng hoặc câu trả lời cũ trong lịch sử hội thoại phía trên nếu chưa gọi lại công cụ "search_spreadsheet_data".
       * Nếu công cụ tra cứu báo về rằng không tìm thấy dòng dữ liệu (hoặc dòng đó đã bị xóa), bạn BẮT BUỘC phải thông báo là không tìm thấy bản ghi, tuyệt đối không được trích dẫn lại câu trả lời cũ đã hết hạn.
     + NGUYÊN TẮC CHIỀU TUYẾN ĐƯỜNG VẬN TẢI (A -> B HOÀN TOÀN KHÁC B -> A):
       * Trong vận tải và logistics, tuyến đường có hướng một chiều rõ rệt (Điểm xuất phát -> Điểm đích đến). Chi phí chiều đi và chiều về thường KHÁC NHAU do luồng xe chạy rỗng, biểu cước cầu đường, phụ phí theo chiều và tính cân đối tải trọng.
       * NẾU BẢNG TÍNH CHỈ CÓ BÁO GIÁ CHIỀU TỪ A ĐẾN B MÀ NGƯỜI DÙNG HỎI TỪ B ĐẾN A (CHIỀU NGƯỢC LẠI):
         - TUYỆT ĐỐI KHÔNG ĐƯỢC lấy giá của chiều A -> B để khẳng định hoặc trả lời như thể đó là giá của chiều B -> A.
         - BẠN BẮT BUỘC PHẢI THÔNG BÁO RÕ RÀNG: "Trong dữ liệu bảng tính hiện tại CHƯA CÓ báo giá cho chiều từ [B] đến [A]. Bảng tính hiện chỉ có báo giá cho chiều ngược lại từ [A] đến [B] (với mức giá ... VNĐ)."
         - Bạn có thể cung cấp mức giá chiều ngược lại để người dùng tham khảo kèm lưu ý rõ ràng rằng chiều [B] đến [A] chưa có báo giá chính thức, tuyệt đối không ngầm định hai chiều bằng giá nhau.
`.trim();
}

/**
 * 3. HẬU KIỂM & TỰ ĐỘNG HIỆU CHỈNH CÂU TRẢ LỜI (POST-GENERATION VERIFIER)
 * Kiểm tra tính nhất quán máy (Machine-verifiable consistency) và làm sạch dữ liệu
 */
function verifyAndRefineAnswer(draftText = '', context = {}) {
  if (!draftText || typeof draftText !== 'string') {
    return {
      isValid: false,
      refinedText: 'Tôi rất tiếc, đã có lỗi gián đoạn trong quá trình xử lý câu trả lời. Vui lòng thử lại.',
      modifications: ['EMPTY_REPLY_HANDLED']
    };
  }

  let text = draftText.trim();
  const modifications = [];
  const { artifacts = [], taskAnalysis = {} } = context;

  // 1. Kiểm tra tính nhất quán giữa Tool Call và Văn bản trả lời (Tool-to-Text Consistency)
  // Nếu AI nói "đã tạo tệp" hoặc "tải tệp tại đây" nhưng không có artifact nào được ghi nhận thực tế
  const claimsFileCreated = /(đã tạo tệp|đã xuất file|tải về tệp|link tải tệp|đã tạo file excel|đã kết xuất báo cáo)/i.test(text);
  const hasActualArtifacts = Array.isArray(artifacts) && artifacts.length > 0 && artifacts.some(a => a && a.fileId);

  if (claimsFileCreated && !hasActualArtifacts) {
    // Tự động bổ sung thông báo chính trực, tránh báo thành công giả mạo
    const notice = '\n\n*(Lưu ý: Dữ liệu trên đã được tính toán và trình bày chi tiết trong bảng. Để tải về tệp Excel vật lý .xlsx vào máy tính, bạn có thể gửi yêu cầu: "Hãy kích hoạt công cụ xuất tệp Excel này".)*';
    text += notice;
    modifications.push('CORRECTED_FALSE_FILE_CREATION_CLAIM');
  }

  // 2. Kiểm tra và tự động cân bằng các cặp Markdown Code Fences (```` ``` ````)
  const codeBlockCount = (text.match(/```/g) || []).length;
  if (codeBlockCount % 2 !== 0) {
    // Có code fence chưa được đóng (do chạm token limit hoặc stream ngắt dở)
    text += '\n```';
    modifications.push('CLOSED_UNBALANCED_CODE_FENCE');
  }

  // 3. Quét và loại bỏ các liên kết URL ảo giác không thuộc Whitelist
  // Regex tìm URL: https?://[^\s)"]+
  text = text.replace(/https?:\/\/([a-zA-Z0-9.-]+)(\/[^\s)"]*)?/g, (match, domain) => {
    const isDomainAllowed = ALLOWED_DOMAINS.some(allowed => domain.toLowerCase().endsWith(allowed));
    if (!isDomainAllowed) {
      modifications.push(`REMOVED_UNVERIFIED_URL_${domain}`);
      return `[liên kết nội bộ đã được bảo mật]`;
    }
    return match;
  });

  // 4. Kiểm tra tính toàn vẹn cú pháp cơ bản cho các công thức Excel thông dụng
  if (taskAnalysis.constraints?.isCalculationRequested) {
    // Kiểm tra xem có công thức mở ngoặc mà không đóng ngoặc không (ví dụ SUMIFS( mà thiếu đóng ngoặc)
    const formulaMatches = text.match(/=(?:SUMIFS|AVERAGEIFS|COUNTIFS|XLOOKUP|VLOOKUP|INDEX|MATCH)\([^)\n]*/g);
    if (formulaMatches) {
      for (const f of formulaMatches) {
        if (!f.includes(')')) {
          // Ghi nhận cảnh báo cú pháp công thức
          modifications.push('FLAGGED_UNCLOSED_FORMULA');
        }
      }
    }
  }

  // 5. Kiểm tra và cảnh báo minh bạch nếu tuyến đường bị đảo chiều (Directional Route Integrity)
  if (context.hasReversedRouteOnly) {
    const lowerText = text.toLowerCase();
    const hasReversedCaveat = lowerText.includes('chưa có') || 
                              lowerText.includes('không có') || 
                              lowerText.includes('chiều ngược lại') || 
                              lowerText.includes('ngược lại') || 
                              lowerText.includes('chỉ có báo giá') ||
                              lowerText.includes('tham khảo');
    if (!hasReversedCaveat) {
      const orig = context.reversedRouteInfo?.requestedOrigin || 'điểm đi yêu cầu';
      const dest = context.reversedRouteInfo?.requestedDest || 'điểm đến yêu cầu';
      const headerNotice = `⚠️ **Lưu ý nghiệp vụ:** Trong bảng tính đính kèm hiện **chưa có dữ liệu báo giá cho chiều từ ${orig} đến ${dest}**.\n` +
                           `Bảng tính hiện chỉ ghi nhận dữ liệu cho **chiều ngược lại (từ ${dest} đến ${orig})**.\n\n`;
      text = headerNotice + text;
      modifications.push('ADDED_REVERSED_ROUTE_CLARIFICATION');
    }
  }

  return {
    isValid: true,
    refinedText: text,
    modifications
  };
}

module.exports = {
  analyzeQueryAndDecompose,
  buildStructuredQualityFramework,
  verifyAndRefineAnswer,
  ALLOWED_DOMAINS
};
