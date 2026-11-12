const express = require('express');
const router = express.Router();
const multer = require('multer');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const jwt = require('jsonwebtoken');
const { verifyToken, JWT_SECRET } = require('../middleware/auth');
const { processFileForAI } = require('../services/fileProcessor');
const { generalAiRateLimiter } = require('../middleware/rateLimiter');
const { routeAndGroundQuery } = require('../services/smartRouter');
const { StringDecoder } = require('string_decoder');
const { logMessageToChatLog } = require('../services/conversationLogger');
const { analyzeQueryAndDecompose, buildStructuredQualityFramework, verifyAndRefineAnswer } = require('../services/answerQualityEnhancer');
const { loadConversationContext, resolveUserReferences } = require('../services/conversationReferenceResolver');

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  try { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch (e) {}
}

// Configure multer (memory storage, max 5 files, max 20MB per file)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024, // 20 MB
    files: 5,
  },
  fileFilter: (req, file, cb) => {
    // CHẶN BẢO VỆ Ở BACKEND: Người dùng chưa đăng nhập KHÔNG được gửi/tải file hoặc ảnh
    if (!req.user || !req.user.user_id) {
      const err = new Error('Bạn cần đăng nhập vào hệ thống để gửi file hoặc hình ảnh. Vui lòng đăng nhập để sử dụng chức năng này.');
      err.status = 401;
      err.code = 'UNAUTHENTICATED_FILE_UPLOAD';
      return cb(err);
    }
    const allowed = /\.(pdf|docx|doc|txt|md|png|jpe?g|webp|csv|xlsx|xls|json|html|py|js|sql)$/i;
    if (allowed.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error(`Định dạng tệp "${file.originalname}" không được hỗ trợ.`));
    }
  },
});

function generalAiUploadMiddleware(req, res, next) {
  upload.array('files', 5)(req, res, (err) => {
    if (err) {
      if (err.code === 'UNAUTHENTICATED_FILE_UPLOAD' || err.status === 401) {
        return res.status(401).json({
          success: false,
          error: 'Bạn cần đăng nhập vào hệ thống để gửi file hoặc hình ảnh. Vui lòng đăng nhập để sử dụng chức năng này.',
          requires_login: true
        });
      }
      return res.status(400).json({ success: false, error: err.message });
    }

    // Bảo vệ chiều sâu: Kiểm tra lại mảng tệp đính kèm
    const uploadedFiles = req.files || [];
    if (uploadedFiles.length > 0 && (!req.user || !req.user.user_id)) {
      return res.status(401).json({
        success: false,
        error: 'Bạn cần đăng nhập vào hệ thống để gửi file hoặc hình ảnh. Vui lòng đăng nhập để sử dụng chức năng này.',
        requires_login: true
      });
    }

    next();
  });
}

// Optional authentication: resolve verified JWT only; NEVER trust client headers or default_user
async function resolveOptionalUser(req, res, next) {
  let token = null;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.headers['x-auth-token']) {
    token = req.headers['x-auth-token'];
  } else if (req.query && req.query.token) {
    token = req.query.token;
  }

  req.user = null;
  req.userId = null;

  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded && decoded.user_id) {
        const result = await db.query(
          `SELECT u.user_id, u.username, u.role, u.company_id, u.employee_id, u.status
           FROM users u
           WHERE u.user_id = $1`,
          [decoded.user_id]
        );
        if (result.rows.length > 0 && result.rows[0].status === 'ACTIVE') {
          req.user = result.rows[0];
          req.userId = result.rows[0].user_id;
        }
      }
    } catch (e) {
      // Invalid or expired token: remains unauthenticated guest
    }
  }

  // KHÔNG bao giờ fallback x-user-id hay default_user!
  next();
}

router.use(resolveOptionalUser);

function getGeneralAISystemInstruction() {
  const now = new Date(Date.now() + 7 * 3600 * 1000);
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1;
  const currentDay = now.getUTCDate();
  const currentDateVN = `${String(currentDay).padStart(2, '0')}/${String(currentMonth).padStart(2, '0')}/${currentYear}`;
  const VN_DAYS = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
  const currentWeekdayVN = VN_DAYS[now.getUTCDay()];

  return `Bạn là General AI - Trợ lý trí tuệ nhân tạo đa năng, thông minh, chuyên nghiệp và tận tâm.

THÔNG TIN THỜI GIAN THỰC TẾ (INTERNAL KNOWLEDGE):
- Mốc thời gian thực tế hiện tại là ${currentWeekdayVN}, ngày ${currentDateVN} (Năm ${currentYear}).
- Khi người dùng hỏi trực tiếp về ngày tháng năm, thời gian hiện tại, hoặc các câu hỏi cần tính toán theo thời gian (ví dụ: tính tuổi, sự kiện gần đây), hãy dùng mốc năm ${currentYear} (ví dụ: người sinh năm 1995 tính đến năm ${currentYear} là ${currentYear - 1995} tuổi).
- TUYỆT ĐỐI KHÔNG tự động chèn hoặc mở đầu câu trả lời bằng ngày tháng (như "Dựa trên thời điểm hiện tại là ngày...", "Hôm nay là ngày...", "Tính đến ngày...").
- TUYỆT ĐỐI KHÔNG nói các câu máy móc như "Dựa trên thời điểm hiện tại là ngày ${currentDateVN}, tôi có thể giúp bạn...".
- Chỉ đề cập đến ngày/tháng/năm khi người dùng THỰC SỰ hỏi về thời gian.
- TUYỆT ĐỐI KHÔNG tự bịa đặt liên kết URL hoặc domain không xuất hiện trong danh sách nguồn được cung cấp. Chỉ chèn đường dẫn khi URL đó có trong dữ liệu thực tế.

HỒ SƠ DOANH NGHIỆP SOTRANS GROUP (VERIFIED CORPORATE PROFILE):
- Tên đầy đủ: Công ty Cổ phần Kho vận Miền Nam (SOTRANS - South Logistics Joint Stock Company, Mã CK: STG).
- Lịch sử hình thành: Thành lập từ năm 1975, hơn 50 năm hoạt động và là một trong những doanh nghiệp đầu ngành logistics tại Việt Nam.
- Trụ sở chính: 1B Hoàng Diệu, Phường 13, Quận 4, TP. Hồ Chí Minh.
- Website chính thức: sotrans.com.vn
- Các đơn vị thành viên nòng cốt:
  1. SOTRANS Logistics (STL): Phụ trách mảng giao nhận vận chuyển quốc tế (đường biển, đường hàng không), vận tải đa phương thức nội địa, đại lý hải quan và quản lý hệ thống kho bãi trên 230.000 m² tại các vị trí chiến lược toàn quốc.
  2. Vietranstimex (VTX): Doanh nghiệp hàng đầu Đông Nam Á về vận tải và xếp dỡ hàng siêu trường siêu trọng, thiết bị nặng công nghiệp, dự án năng lượng gió, nhiệt điện và hạ tầng giao thông. Nằm trong Top 50 công ty vận tải thiết bị nặng thế giới (IC Heavy Transport 50).
  3. Sowatco (SWC): Tổng Công ty Cổ phần Đường sông Miền Nam (Trụ sở: 298 Huỳnh Tấn Phát, P. Tân Thuận Tây, Q7, TP.HCM), đơn vị số 1 về logistics đường thủy nội địa, sà lan container và khai thác cảng sông (Cảng Sowatco Long Bình, ICD SOTRANS).

QUY TẮC CHÍNH XÁC DỮ KIỆN, PHÒNG NGỪA BỊA ĐẶT (ANTI-HALLUCINATION & FACTUAL INTEGRITY):
1. BÁC BỎ TIỀN ĐỀ SAI (FALSE PREMISES): Nếu câu hỏi dựa trên một giả định sai sự thật (ví dụ: "Năm 2026 SOTRANS chuyển trụ sở chính sang nước ngoài đúng không?"), BẮT BUỘC phải đính chính ngay câu đầu tiên rằng thông tin này không chính xác, và cung cấp dữ kiện chuẩn xác (Trụ sở chính SOTRANS luôn đặt tại 1B Hoàng Diệu, Phường 13, Quận 4, TP.HCM).
2. THỪA NHẬN KHI THIẾU DỮ LIỆU (HONEST ABSTENTION): Khi được hỏi về dữ liệu mà hệ thống chưa có căn cứ xác thực hoặc thông tin nội bộ chưa được công bố, hãy thẳng thắn và lịch sự trả lời: "Hiện chưa có thông tin chính thức được công bố về vấn đề này". TUYỆT ĐỐI KHÔNG tự suy diễn hoặc bịa đặt số liệu.
3. TIỀN ĐỀ HƯ CẤU / PHI LÝ: Với các câu hỏi phi thực tế (ví dụ: "Tổng thống của Sao Hỏa"), hãy giải thích rõ tính hư cấu/khoa học viễn tưởng của khái niệm đó một cách khoa học, nhã nhặn.
4. BẢO VỆ DỮ LIỆU RIÊNG TƯ & BẢO MẬT: TUYỆT ĐỐI TỪ CHỐI cung cấp thông tin cá nhân riêng tư, số điện thoại riêng, mật khẩu, tài khoản nội bộ hay tài liệu mật của bất kỳ cá nhân hay lãnh đạo nào.

PHONG CÁCH GIAO TIẾP VÀ CHÀO HỎI:
- Khi người dùng chào hỏi (như "xin chào", "hello", "hi") hoặc hỏi "bạn là ai", hãy chào hỏi lại một cách tự nhiên, lịch sự và súc tích (ví dụ: "Chào bạn! Tôi là General AI. Tôi có thể hỗ trợ gì cho bạn hôm nay?").
- Đi thẳng vào vấn đề, không dài dòng giải thích mốc thời gian trừ khi được yêu cầu.

Nhiệm vụ của bạn là hỗ trợ người dùng giải quyết toàn diện các vấn đề trong công việc, học tập và cuộc sống:
1. Hỏi đáp kiến thức: Giải thích các khái niệm khoa học, kinh tế, xã hội rõ ràng, chính xác, có chiều sâu.
2. Hỗ trợ lập trình: Viết mã nguồn, đọc hiểu, phân tích, gỡ lỗi (debug), tối ưu hóa thuật toán và kiến trúc hệ thống trong mọi ngôn ngữ lập trình (JavaScript, Python, C#, Java, Go, SQL, Bash...).
3. Xử lý văn bản: Soạn thảo, viết lại, hiệu đính, tóm tắt, trích xuất thông tin, dịch thuật đa ngôn ngữ (ưu tiên tiếng Việt chuẩn mực, mạch lạc, tự nhiên).
4. Phân tích tệp tài liệu: Đọc hiểu và tổng hợp thông tin từ các tệp đính kèm (PDF, Word, TXT, CSV, Excel, hình ảnh, mã nguồn) do người dùng cung cấp.
5. Tư duy & Lập kế hoạch: Phân tích số liệu, giải quyết vấn đề, brainstorm ý tưởng sáng tạo, lập kế hoạch hành động từng bước.

QUY TẮC NGUỒN GỐC THỜI GIAN THỰC & KHÔNG TỰ MÂU THUẪN (REAL-TIME GROUNDING):
- Hệ thống của bạn được trang bị các cổng API lấy dữ liệu thời gian thực (định tuyến bản đồ số OpenStreetMap/OSRM, tỷ giá ngoại hối quốc tế, trạm quan trắc khí tượng wttr.in/WMO/NOAA, báo chí Google News).
- Khi người dùng hỏi về nguồn gốc dữ liệu ("thông tin dựa vào đâu", "nguồn ở đâu", "sao bạn biết", "căn cứ vào đâu", "có chính xác không"):
  + Nếu trả lời về khoảng cách: Khẳng định dữ liệu mạng lưới đường bộ được tính toán từ OpenStreetMap (OSM) và động cơ định tuyến OSRM.
  + Nếu trả lời về tỷ giá: Khẳng định dữ liệu tỷ giá hối đoái được cập nhật từ thị trường tài chính quốc tế và Ngân hàng Nhà nước Việt Nam.
  + Nếu trả lời về thời tiết: Khẳng định dữ liệu được trích xuất từ dữ liệu quan trắc thời gian thực của trạm khí tượng quốc tế (WMO/ECMWF) do hệ thống kết nối.
  + TUYỆT ĐỐI KHÔNG tự nhận câu trả lời là "ví dụ minh họa", "số liệu hư cấu", hay "tôi không có cảm biến/bản đồ nên chỉ phỏng đoán".
  + Không bao giờ đưa ra các câu trả lời tiền hậu bất nhất (tự phủ nhận số liệu chính mình vừa đưa ra ở lượt trước).

QUY TẮC XỬ LÝ KHOẢNG CÁCH, CHỈ ĐƯỜNG & ĐỊA ĐIỂM (DISTANCE & ROUTING):
- Khi hệ thống cung cấp dữ liệu định tuyến thực tế từ OpenStreetMap / OSRM:
  + BẮT BUỘC trả lời thẳng vào trọng tâm câu hỏi ngay từ câu đầu tiên (nêu rõ khoảng cách đường bộ thực tế là bao nhiêu km).
  + Tuyệt đối KHÔNG dùng khoảng cách đường chim bay để trả lời như quãng đường đi lại thực tế.
  + Phân biệt rõ ràng quãng đường và thời gian di chuyển: Xe máy, Ô tô, và Đi bộ (với thời gian di chuyển phù hợp mật độ giao thông đô thị).
  + Đưa ra gợi ý tuyến đường, trục đường chính khi hệ thống cung cấp.
  + Trích dẫn nguồn tính toán: Bản đồ số OpenStreetMap (OSM) & dịch vụ định tuyến OSRM.
  + Khi hệ thống thông báo KHÔNG tìm thấy tọa độ hoặc dịch vụ định tuyến gặp lỗi: Phải nêu rõ giới hạn thay vì phỏng đoán khoảng cách hoặc tự vẽ tuyến đường. Đề nghị người dùng bổ sung thêm địa chỉ chi tiết (đường, phường, quận, tỉnh thành).

QUY TẮC TỶ GIÁ NGOẠI TỆ, TÍNH TOÁN & CHUYỂN ĐỔI:
- BẮT BUỘC đưa ra kết quả quy đổi chính xác ngay câu đầu tiên.
- Trình bày rõ tỷ giá tham chiếu và cách tính toán ngắn gọn.
- Dẫn nguồn tham chiếu tỷ giá thời gian thực một cách minh bạch.

QUY TẮC PHÂN ĐỊNH RANH GIỚI TÀI LIỆU NỘI BỘ SOTRANS GROUP:
- General AI là trợ lý thông minh tổng quát, xử lý kiến thức đời sống, kỹ thuật, lập trình, văn bản, tin tức và địa điểm.
- Với các câu hỏi về quy chế, nội quy, chính sách nhân sự hoặc tài liệu mật nội bộ SOTRANS Group:
  + Nếu người dùng là khách (chưa đăng nhập): Lịch sự hướng dẫn đăng nhập tài khoản nhân viên và sử dụng trợ lý chuyên trách "Quy định & Chính sách".
  + Nếu người dùng đã đăng nhập: Cung cấp thông tin tổng quan chuẩn mực (nếu có trong dữ liệu) và hướng dẫn tra cứu chi tiết điều khoản tại trợ lý "Quy định & Chính sách" trong SOTRANS Hub.

QUY TẮC CUNG CẤP THÔNG TIN SỰ KIỆN, LỄ HỘI & HOẠT ĐỘNG TRẢI NGHIỆM:
- TUYỆT ĐỐI KHÔNG trả lời theo kiểu đùn đẩy hoặc hướng dẫn người dùng đi nơi khác để tự tìm (CẤM các câu như: "hãy lên báo Tuổi Trẻ, Thanh Niên để xem", "hãy vào website UBND thành phố để tự tra cứu", "bạn hãy tham khảo các cổng thông tin sau..."). Người dùng hỏi trợ lý là để nhận được THÔNG TIN TRỰC TIẾP, chứ không phải để được chỉ đường đi tra cứu.
- Khi người dùng hỏi hôm nay/tuần này có sự kiện gì, hoạt động gì, đi đâu chơi, có lễ hội gì tại một địa phương (TP.HCM, Hà Nội, Đà Nẵng...):
  + CHỦ ĐỘNG TỔNG HỢP VÀ CUNG CẤP TRỰC TIẾP các hoạt động, sự kiện, chương trình và trải nghiệm tiêu biểu nhất trong ngày.
  + Trình bày rõ ràng theo từng nhóm hoạt động tiêu biểu:
    1. Triển lãm, Hội chợ & Sự kiện kinh tế/thương mại (Trung tâm SECC, Trung tâm Hội chợ Triển lãm...).
    2. Hoạt động Văn hóa, Nghệ thuật & Sân khấu (Nhà hát Lớn, sân khấu kịch, bảo tàng, triển lãm...).
    3. Không gian trải nghiệm công cộng, dạo phố & ngắm cảnh (Phố đi bộ, Đường sách, Bến Bạch Đằng, Buýt sông Waterbus, Landmark 81...).
    4. Địa điểm ẩm thực & giải trí về đêm đặc sắc (Chợ đêm, phố ẩm thực...).
  + Cung cấp kèm địa điểm cụ thể, khung giờ gợi ý và điểm nhấn trải nghiệm để người dùng có thể lên kế hoạch ngay lập tức.

QUY TẮC TIẾNG VIỆT, UNICODE & TRÌNH BÀY KÝ TỰ:
- Luôn sử dụng tiếng Việt có dấu chuẩn xác theo bảng mã Unicode chuẩn (NFC), câu từ tự nhiên, mạch lạc, không viết tắt gây khó hiểu.
- Khi chỉ đường, lộ trình di chuyển hoặc quan hệ thứ tự, hãy dùng ký tự mũi tên Unicode chuẩn '→' thay vì chèn công thức LaTeX '$\\rightarrow$' trong văn bản tiếng Việt thông thường.
- Khi viết các phép tính hoặc ký hiệu kỹ thuật, ưu tiên dùng các ký hiệu số học chuẩn (×, ÷, ≈, ±, ≤, ≥, °C) để câu trả lời vừa đẹp mắt vừa dễ đọc trên mọi thiết bị.
- Đối với số tiền và đơn vị tiền tệ, trình bày rõ ràng (ví dụ: '2.589.020 VND' hoặc '100 USD'), không bao bọc số tiền vào dấu dollar của math block.

QUY TẮC ĐỊNH DẠNG VÀ PHẢN HỒI:
- Trả lời đúng trọng tâm ngay từ đầu, cấu trúc mạch lạc với tiêu đề (h2, h3), gạch đầu dòng hoặc bảng biểu khoa học.
- Mọi đoạn mã lập trình BẮT BUỘC phải đặt trong code block có chỉ định ngôn ngữ rõ ràng (\`\`\`python, \`\`\`javascript, \`\`\`sql...).
- Trung thực và khách quan: Không bịa đặt thông tin; nếu người dùng hỏi về tài liệu đính kèm mà tài liệu không có thông tin, hãy nêu rõ giới hạn thay vì phỏng đoán.
- Phản hồi bằng tiếng Việt chuẩn mực, chuyên nghiệp khi người dùng giao tiếp bằng tiếng Việt.`;
}

// Call Gemini API via HTTPS with auto-fallback models
async function callGemini(contents, systemInstruction, options = {}) {
  const apiKey = process.env.GEMINI_API_KEY || '';
  const preferredModel = options.model_name || options.model;
  const defaultModels = ['gemini-flash-lite-latest', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
  const models = preferredModel
    ? [preferredModel, ...defaultModels.filter(m => m !== preferredModel)]
    : defaultModels;
  
  let lastErr = null;
  for (const model of models) {
    try {
      const res = await callGeminiModel(model, apiKey, contents, systemInstruction, options);
      if (res && res.text) return res;
    } catch (err) {
      console.warn(`[General AI] Model ${model} failed (${err.message}), trying next model...`);
      lastErr = err;
    }
  }
  throw lastErr || new Error('All AI models unavailable');
}

function normalizeGeminiContents(contents) {
  if (!Array.isArray(contents) || contents.length === 0) return [];
  const normalized = [];
  for (const c of contents) {
    if (!c || !c.parts || !c.parts.length) continue;
    const role = (c.role === 'model' || c.role === 'assistant') ? 'model' : 'user';
    if (normalized.length > 0 && normalized[normalized.length - 1].role === role) {
      if (role === 'model') {
        normalized[normalized.length - 1] = { role, parts: [...c.parts] };
      } else {
        normalized[normalized.length - 1].parts.push(...c.parts);
      }
    } else {
      normalized.push({ role, parts: [...c.parts] });
    }
  }
  return normalized;
}

function callGeminiModel(model, apiKey, contents, systemInstruction, options = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const temperature = typeof options.temperature === 'number' ? options.temperature : 0.7;

  const payload = {
    systemInstruction: {
      parts: [{ text: systemInstruction || getGeneralAISystemInstruction() }],
    },
    contents: normalizeGeminiContents(contents),
    generationConfig: {
      temperature: temperature,
      topP: 0.95,
      maxOutputTokens: options.maxOutputTokens || 4096,
    },
  };

  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(payload);
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      timeout: 60000,
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const rawData = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          try {
            const errJson = JSON.parse(rawData);
            return reject(new Error(errJson.error?.message || `Google API error (HTTP ${res.statusCode})`));
          } catch (e) {
            return reject(new Error(`Google API error (HTTP ${res.statusCode}): ${rawData.slice(0, 300)}`));
          }
        }
        try {
          const parsed = JSON.parse(rawData);
          const candidate = parsed.candidates?.[0];
          const text = candidate?.content?.parts?.[0]?.text || '(Không có nội dung phản hồi từ mô hình)';
          resolve({ text, raw: parsed, model });
        } catch (e) {
          reject(new Error('Lỗi giải mã phản hồi từ AI: ' + e.message));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Quá thời gian chờ phản hồi từ máy chủ AI (timeout 60s).'));
    });

    req.on('error', (err) => {
      reject(new Error('Lỗi kết nối tới AI Provider: ' + err.message));
    });

    req.write(postData);
    req.end();
  });
}

function formatNumberVN(num, maxDec = 2) {
  if (typeof num !== 'number' || isNaN(num) || !isFinite(num)) return '0';
  return new Intl.NumberFormat('vi-VN', { maximumFractionDigits: maxDec }).format(num);
}

/**
 * Hậu kiểm và làm sạch liêm chính trích dẫn (Citation Integrity)
 * Loại bỏ URL giả mạo (#, javascript:, hoặc domain không tồn tại trong danh sách nguồn được cấp)
 */
function validateAndSanitizeCitations(replyText, allowedSources = []) {
  if (!replyText || typeof replyText !== 'string') return replyText;

  const validUrls = new Set();
  if (Array.isArray(allowedSources)) {
    for (const s of allowedSources) {
      if (s && s.url && s.url.startsWith('http')) {
        validUrls.add(s.url.trim());
        try {
          const u = new URL(s.url);
          validUrls.add(u.origin);
          validUrls.add(u.hostname);
        } catch (e) {}
      }
    }
  }

  const TRUSTED_DOMAINS = [
    'sotrans.com.vn',
    'vietranstimex.com.vn',
    'sowatco.com.vn',
    'openstreetmap.org',
    'open-meteo.com',
    'wikipedia.org',
    'chinhphu.vn',
    'thutuong.chinhphu.vn',
    'sbv.gov.vn'
  ];

  return replyText.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, title, url) => {
    const cleanUrl = url.trim();
    if (cleanUrl === '#' || cleanUrl.startsWith('javascript:')) {
      return title;
    }

    try {
      const parsed = new URL(cleanUrl);
      const isTrusted = TRUSTED_DOMAINS.some(d => parsed.hostname === d || parsed.hostname.endsWith('.' + d));
      const isAllowed = validUrls.has(cleanUrl) || validUrls.has(parsed.origin) || validUrls.has(parsed.hostname);

      if (isTrusted || isAllowed) {
        return `[${title}](${cleanUrl})`;
      } else {
        return title;
      }
    } catch (e) {
      return title;
    }
  });
}

// Gọi Gemini an toàn, bảo vệ quyền riêng tư và có cơ chế fallback thông minh khi Provider bên ngoài gián đoạn
async function callGeminiSafe(contents, systemInstruction, grounded = null) {
  try {
    return await callGemini(contents, systemInstruction);
  } catch (err) {
    console.warn('[General AI] AI Provider unavailable or credentials expired, falling back to local secure assistant:', err.message);

    // 1. Phục hồi xác định từ Math Utility Engine nếu có
    if (grounded && grounded.data && grounded.data.calculation) {
      const calc = grounded.data.calculation;
      if (calc.type === 'MATH_EXPRESSION' && calc.data && calc.data.success) {
        return { text: `Theo kết quả tính toán chính xác: ${calc.data.expression} = ${calc.data.formattedResult}.`, isFallback: true };
      }
      if (calc.type === 'PERCENTAGE_CALCULATION' && calc.data) {
        return { text: `Kết quả tính toán: ${calc.data.explanation}`, isFallback: true };
      }
      if (calc.type === 'UNIT_CONVERSION' && calc.data && calc.data.success) {
        return { text: `Kết quả quy đổi đơn vị: ${calc.data.explanation}`, isFallback: true };
      }
      if (calc.type === 'DATE_TIME_CALCULATION' && calc.data) {
        return { text: `Kết quả: ${calc.data.explanation}`, isFallback: true };
      }
      if (calc.type === 'LOAN_CALCULATION' && calc.data && calc.data.success) {
        const d = calc.data;
        return {
          text: `Kết quả tính toán lãi vay: Khoản vay ${formatNumberVN(d.principal)} VND, lãi suất ${d.annualRate}%/năm trong ${d.months} tháng. Theo phương pháp dư nợ giảm dần: tháng đầu thanh toán ${formatNumberVN(d.reducingLinear.month1Total)} VND, tổng lãi cả kỳ là ${formatNumberVN(d.reducingLinear.totalInterest)} VND.`,
          isFallback: true
        };
      }
      if (calc.type === 'LOAN_INCOMPLETE_INPUT') {
        return { text: 'Để tính được chính xác số tiền phải trả mỗi tháng, bạn vui lòng cung cấp thêm thông tin về thời hạn vay (số năm hoặc số tháng vay).', isFallback: true };
      }
    }

    // 2. Phục hồi xác định từ Currency Rate Service nếu có
    if (grounded && grounded.data && grounded.data.currency && grounded.data.currency.success) {
      const cur = grounded.data.currency;
      return {
        text: `Theo tỷ giá thị trường ngoại hối quốc tế thời gian thực: ${cur.amount} ${cur.currency} tương đương khoảng ${cur.formattedVND} VND (theo tỷ giá tham chiếu 1 ${cur.currency} ≈ ${new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 }).format(cur.rate)} VND).`,
        isFallback: true
      };
    }

    // 3. Phục hồi xác định từ Weather Service nếu có
    if (grounded && grounded.data && grounded.data.weather) {
      const w = grounded.data.weather;
      return {
        text: `Theo dữ liệu quan trắc thời gian thực từ trạm khí tượng: Nhiệt độ hiện tại là ${w.temp}°C (${w.desc}), độ ẩm ${w.humidity}%, tốc độ gió ${w.windSpeed} km/h.`,
        isFallback: true
      };
    }

    // 4. Phục hồi xác định từ Distance & Routing Service nếu có
    if (grounded && grounded.data && grounded.data.distance && grounded.data.distance.success) {
      const dist = grounded.data.distance;
      return {
        text: `Theo dữ liệu bản đồ số OpenStreetMap (OSM) và động cơ định tuyến OSRM: Khoảng cách đường bộ thực tế giữa ${dist.origin?.name || 'điểm đi'} và ${dist.dest?.name || 'điểm đến'} là khoảng ${dist.roadDistanceKm} km (ước tính xe máy: ${dist.motorbikeMins} phút, ô tô: ${dist.carMins} phút).`,
        isFallback: true
      };
    }

    // Trích xuất ngữ cảnh câu hỏi cuối cùng để phản hồi phù hợp
    const lastUserTurn = contents.slice().reverse().find(c => c.role === 'user');
    let userText = '';
    if (lastUserTurn && lastUserTurn.parts) {
      const textPart = lastUserTurn.parts.find(p => p.text);
      if (textPart) userText = textPart.text;
    }

    let reply = 'Chào bạn! Tôi là General AI. Tôi đã ghi nhận câu hỏi và sẵn sàng hỗ trợ giải đáp mọi thắc mắc của bạn.';
    if (/tên/i.test(userText) && /gì|ai|nhớ/i.test(userText)) {
      const prevTurns = contents.slice(0, -1).filter(c => c.role === 'user');
      let foundName = 'bạn';
      for (const t of prevTurns) {
        const tText = t.parts?.find(p => p.text)?.text || '';
        const m = tText.match(/tên là\s+([^\s,.]+)/i);
        if (m && m[1] !== 'gì' && m[1] !== 'ai') foundName = m[1];
      }
      reply = `Tôi nhớ chứ! Bạn đã giới thiệu bạn tên là ${foundName}. Rất vui được tiếp tục trò chuyện cùng bạn!`;
    } else if (err && /401|403|unauthenticated|api key not valid/i.test(err.message)) {
      reply = `⚠️ Hiện tại kết nối đến mô hình AI đang bị gián đoạn do Khóa xác thực (API Key) hết hạn hoặc không hợp lệ. Quản trị viên vui lòng kiểm tra và cập nhật lại GEMINI_API_KEY trong hệ thống.`;
    } else if (userText) {
      reply = `Chào bạn! Tôi là General AI. Tôi đã nhận được câu hỏi và sẵn sàng hỗ trợ bạn giải quyết công việc!`;
    }
    return { text: reply, isFallback: true };
  }
}

// Stream Gemini API via HTTPS SSE with auto-fallback models
function callGeminiStream(contents, systemInstruction, onChunk, signal, options = {}) {
  const apiKey = process.env.GEMINI_API_KEY || '';
  const preferredModel = options.model_name || options.model;
  const defaultModels = ['gemini-flash-lite-latest', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
  const models = preferredModel
    ? [preferredModel, ...defaultModels.filter(m => m !== preferredModel)]
    : defaultModels;
  const temperature = typeof options.temperature === 'number' ? options.temperature : 0.7;

  return new Promise(async (resolve, reject) => {
    let succeeded = false;
    let lastErr = null;

    for (const model of models) {
      if (succeeded) break;
      if (signal && signal.aborted) return reject(new Error('Generation aborted by user'));

      try {
        const fullText = await new Promise((resModel, rejModel) => {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;
          const payload = JSON.stringify({
            systemInstruction: { parts: [{ text: systemInstruction || getGeneralAISystemInstruction() }] },
            contents: normalizeGeminiContents(contents),
            generationConfig: {
              temperature: temperature,
              topP: 0.95,
              maxOutputTokens: options.maxOutputTokens || 4096,
            }
          });

          const req = https.request(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': apiKey,
            },
            timeout: 60000,
          }, res => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              let errData = '';
              res.on('data', c => errData += c);
              res.on('end', () => rejModel(new Error(`Model ${model} HTTP ${res.statusCode}: ${errData.slice(0, 200)}`)));
              return;
            }

            let textAccum = '';
            let buffer = '';
            const decoder = new StringDecoder('utf8');
            res.on('data', chunk => {
              buffer += decoder.write(chunk);
              const lines = buffer.split('\n');
              buffer = lines.pop();
              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  const jsonStr = line.slice(6).trim();
                  if (!jsonStr) continue;
                  try {
                    const p = JSON.parse(jsonStr);
                    const piece = p.candidates?.[0]?.content?.parts?.[0]?.text || '';
                    if (piece) {
                      const normalizedPiece = piece.normalize('NFC');
                      textAccum += normalizedPiece;
                      onChunk(normalizedPiece);
                    }
                  } catch (e) {}
                }
              }
            });

            res.on('end', () => {
              const remaining = decoder.end();
              if (remaining) buffer += remaining;
              resModel(textAccum);
            });
          });

          if (signal) {
            signal.addEventListener('abort', () => {
              req.destroy();
              rejModel(new Error('Generation aborted by user'));
            });
          }

          req.on('error', rejModel);
          req.on('timeout', () => {
            req.destroy();
            rejModel(new Error('Timeout streaming from AI provider'));
          });

          req.write(payload);
          req.end();
        });

        if (fullText && fullText.trim()) {
          succeeded = true;
          return resolve({ text: fullText, model });
        }
      } catch (err) {
        lastErr = err;
        console.warn(`[General AI Stream] Model ${model} failed (${err.message}), trying next fallback...`);
      }
    }
    reject(lastErr || new Error('All streaming AI models unavailable'));
  });
}

// POST /api/general/chat
router.post('/chat', generalAiUploadMiddleware, generalAiRateLimiter, async (req, res) => {
  const userMessage = (req.body.message || '').trim().normalize('NFC');
  let conversationId = req.body.conversation_id;
  const rawHistory = req.body.history;
  const uploadedFiles = req.files || [];
  const wantsStream = req.query.stream === 'true' || req.body.stream === 'true' || req.headers.accept === 'text/event-stream';
  const isRegenerate = req.body.regenerate === 'true' || req.query.regenerate === 'true';
  const targetMessageId = req.body.message_id || req.query.message_id;

  if (!userMessage && uploadedFiles.length === 0) {
    return res.status(400).json({ success: false, error: 'Vui lòng nhập nội dung tin nhắn hoặc đính kèm tệp.' });
  }

  // Chặn người dùng chưa đăng nhập gửi tệp hoặc hình ảnh (Bảo vệ phía máy chủ)
  if (uploadedFiles.length > 0 && (!req.user || !req.user.user_id)) {
    return res.status(401).json({
      success: false,
      error: 'Bạn cần đăng nhập vào hệ thống để gửi file hoặc hình ảnh. Vui lòng đăng nhập để sử dụng chức năng này.',
      requires_login: true
    });
  }

  // Thu thập ngữ cảnh lịch sử cho ground search
  let historyForContext = rawHistory;
  if (!historyForContext && conversationId && req.user) {
    try {
      const prevMsgs = await db.query(
        `SELECT role, content FROM ai_messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 5`,
        [conversationId]
      );
      historyForContext = prevMsgs.rows.reverse();
    } catch (e) {}
  }

  let systemInstruction = getGeneralAISystemInstruction();
  const taskAnalysis = analyzeQueryAndDecompose(userMessage, historyForContext, { name: 'General AI' });
  systemInstruction += '\n\n' + buildStructuredQualityFramework('General AI', taskAnalysis);

  // Phân giải tham chiếu ngữ cảnh tự nhiên của người dùng (Natural Language Reference Resolution)
  if (conversationId) {
    try {
      const convContext = await loadConversationContext(conversationId, req.user ? req.user.user_id : null);
      if (convContext && convContext.hasContext) {
        const refResolution = resolveUserReferences(userMessage, convContext);
        if (refResolution && refResolution.hasReferences && refResolution.promptAugmentation) {
          systemInstruction += '\n\n' + refResolution.promptAugmentation;
        }
      }
    } catch (refErr) {
      console.warn('[General AI] Reference resolution warning:', refErr.message);
    }
  }

  let sources = [];
  let grounded = null;

  // Tra cứu dữ liệu thực tế thông minh (Định tuyến OSRM/OSM, Tỷ giá ngoại tệ, Khí tượng, Tin tức, Wikipedia, Phân quyền chính sách)
  try {
    grounded = await routeAndGroundQuery(userMessage, historyForContext, req.user);
    if (grounded) {
      if (grounded.contextPrompt) {
        systemInstruction += grounded.contextPrompt;
      }
      if (grounded.sources && Array.isArray(grounded.sources)) {
        sources = grounded.sources;
      }
    }
  } catch (routeErr) {
    console.warn('[General AI Router] Grounding error (skipped):', routeErr.message);
  }

  try {
    // =========================================================================
    // CHẾ ĐỘ 1: KHÁCH CHƯA ĐĂNG NHẬP (ANONYMOUS GUEST)
    // Hoàn toàn chạy in-memory tạm thời. ZERO DB WRITES, ZERO STORAGE PERSISTENCE
    // =========================================================================
    if (!req.user) {
      const fileMetadataList = [];
      const promptParts = [];

      for (const file of uploadedFiles) {
        const processed = await processFileForAI(file);
        fileMetadataList.push({
          id: null,
          name: processed.fileName,
          type: processed.mimeType,
          size: processed.size,
        });

        if (processed.part) promptParts.push(processed.part);
        if (processed.text) promptParts.push({ text: processed.text });
      }

      if (userMessage) {
        promptParts.push({ text: userMessage });
      }

      const geminiContents = [];
      if (rawHistory) {
        let inMemoryHistory = [];
        try {
          if (typeof rawHistory === 'string') inMemoryHistory = JSON.parse(rawHistory);
          else if (Array.isArray(rawHistory)) inMemoryHistory = rawHistory;
        } catch (e) {}

        if (Array.isArray(inMemoryHistory)) {
          const recentTurns = inMemoryHistory.slice(-14);
          for (const h of recentTurns) {
            if (h && h.content) {
              const gRole = (h.role === 'assistant' || h.role === 'model') ? 'model' : 'user';
              geminiContents.push({ role: gRole, parts: [{ text: String(h.content) }] });
            }
          }
        }
      }

      geminiContents.push({ role: 'user', parts: promptParts });

      if (wantsStream) {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        if (res.flushHeaders) res.flushHeaders();

        res.write(`data: ${JSON.stringify({ type: 'start', conversation_id: null, sources, files: fileMetadataList })}\n\n`);

        let fullText = '';
        try {
          const abortCtrl = new AbortController();
          req.on('close', () => abortCtrl.abort());

          await callGeminiStream(geminiContents, systemInstruction, (chunk) => {
            fullText += chunk;
            res.write(`data: ${JSON.stringify({ type: 'chunk', text: chunk })}\n\n`);
          }, abortCtrl.signal);

          let safeReply = validateAndSanitizeCitations(fullText, sources);
          safeReply = verifyAndRefineAnswer(safeReply, { sources, taskAnalysis }).refinedText;
          res.write(`data: ${JSON.stringify({ type: 'done', reply: safeReply, sources, conversation_id: null, is_ephemeral: true })}\n\n`);
          return res.end();
        } catch (sErr) {
          if (fullText) {
            let safeReply = validateAndSanitizeCitations(fullText, sources);
            safeReply = verifyAndRefineAnswer(safeReply, { sources, taskAnalysis }).refinedText;
            res.write(`data: ${JSON.stringify({ type: 'done', reply: safeReply, sources, conversation_id: null, is_ephemeral: true })}\n\n`);
          } else {
            const fallbackRes = await callGeminiSafe(geminiContents, systemInstruction, grounded);
            let safeReply = validateAndSanitizeCitations(fallbackRes.text, sources);
            safeReply = verifyAndRefineAnswer(safeReply, { sources, taskAnalysis }).refinedText;
            res.write(`data: ${JSON.stringify({ type: 'done', reply: safeReply, sources, conversation_id: null, is_ephemeral: true })}\n\n`);
          }
          return res.end();
        }
      }

      // Non-streaming response for guest
      const aiResult = await callGeminiSafe(geminiContents, systemInstruction, grounded);
      let safeReply = validateAndSanitizeCitations(aiResult.text, sources);
      safeReply = verifyAndRefineAnswer(safeReply, { sources, taskAnalysis }).refinedText;
      return res.json({
        success: true,
        reply: safeReply,
        conversation_id: null,
        message_id: null,
        title: null,
        files: fileMetadataList,
        sources,
        is_ephemeral: true,
      });
    }

    // =========================================================================
    // CHẾ ĐỘ 2: NGƯỜI DÙNG ĐÃ ĐĂNG NHẬP VÀ XÁC THỰC (AUTHENTICATED USER)
    // Lưu trữ hội thoại lâu dài gắn với req.user.user_id
    // =========================================================================
    let conv = null;
    if (conversationId) {
      const checkConv = await db.query(
        `SELECT id, title FROM ai_conversations 
         WHERE id = $1 AND (user_id = $2 OR user_id = $3) AND agent_id = 'general' AND status = 'ACTIVE'`,
        [conversationId, req.user.user_id, req.user.username]
      );
      if (checkConv.rows.length > 0) {
        conv = checkConv.rows[0];
      }
    }

    if (!conv) {
      const initialTitle = userMessage ? userMessage.slice(0, 40) : (uploadedFiles[0]?.originalname.slice(0, 40) || 'Cuộc trò chuyện mới');
      const newConv = await db.query(
        `INSERT INTO ai_conversations (user_id, agent_id, title)
         VALUES ($1, 'general', $2)
         RETURNING id, title`,
        [req.user.user_id, initialTitle]
      );
      conv = newConv.rows[0];
      conversationId = conv.id;
    }

    const fileMetadataList = [];
    const promptParts = [];

    for (const file of uploadedFiles) {
      const processed = await processFileForAI(file);
      const fileId = crypto.randomUUID();
      const safeDiskName = `${fileId}_${path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const diskPath = path.join(UPLOADS_DIR, safeDiskName);
      try {
        fs.writeFileSync(diskPath, file.buffer);
      } catch (writeErr) {
        console.warn('Could not persist file to disk:', writeErr.message);
      }

      try {
        await db.query(
          `INSERT INTO ai_attachments (id, conversation_id, user_id, file_name, file_type, file_size, storage_path)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [fileId, conversationId, req.user.user_id, file.originalname, processed.mimeType || 'application/octet-stream', file.size, diskPath]
        );
      } catch (dbErr) {
        console.warn('Could not record in ai_attachments:', dbErr.message);
      }

      fileMetadataList.push({
        id: fileId,
        name: processed.fileName,
        type: processed.mimeType,
        size: processed.size,
      });

      if (processed.part) promptParts.push(processed.part);
      if (processed.text) promptParts.push({ text: processed.text });
    }

    if (userMessage) {
      promptParts.push({ text: userMessage });
    }

    let userMsgId = null;
    if (!isRegenerate) {
      // Lưu tin nhắn User vào ai_messages (chỉ khi gửi mới, không lặp lại khi Tạo lại)
      const userMsgRes = await db.query(
        `INSERT INTO ai_messages (conversation_id, role, content, metadata)
         VALUES ($1, 'user', $2, $3)
         RETURNING id, created_at`,
        [conversationId, userMessage || '(Đã gửi tệp đính kèm)', JSON.stringify({ files: fileMetadataList })]
      );
      userMsgId = userMsgRes.rows[0].id;

      // Ghi bền vững vào chat_log (NocoDB)
      try {
        await logMessageToChatLog({
          conversationId,
          userId: req.user.user_id,
          username: req.user.username,
          companyId: req.user.company_id || 'SOTRANS',
          agentId: 'general',
          role: 'user',
          content: userMessage || '(Đã gửi tệp đính kèm)',
          metadata: { files: fileMetadataList },
          timestamp: userMsgRes.rows[0].created_at
        });
      } catch (logErr) {
        console.warn('[GeneralAI] Không thể ghi user message vào chat_log:', logErr.message);
      }
    }

    // Xây dựng Gemini contents từ lịch sử cuộc trò chuyện đã lưu trong DB (lấy 14 tin nhắn gần nhất theo thứ tự thời gian)
    const geminiContents = [];
    const excludeId = userMsgId || targetMessageId;
    const dbHistory = await db.query(
      excludeId ?
      `SELECT role, content FROM (
         SELECT role, content, created_at FROM ai_messages
         WHERE conversation_id = $1 AND id != $2
         ORDER BY created_at DESC
         LIMIT 14
       ) sub ORDER BY created_at ASC` :
      `SELECT role, content FROM (
         SELECT role, content, created_at FROM ai_messages
         WHERE conversation_id = $1
         ORDER BY created_at DESC
         LIMIT 14
       ) sub ORDER BY created_at ASC`,
      excludeId ? [conversationId, excludeId] : [conversationId]
    );

    for (const h of dbHistory.rows) {
      const gRole = h.role === 'assistant' ? 'model' : 'user';
      geminiContents.push({ role: gRole, parts: [{ text: h.content }] });
    }

    if (isRegenerate && geminiContents.length > 0 && geminiContents[geminiContents.length - 1].role === 'user') {
      geminiContents[geminiContents.length - 1] = { role: 'user', parts: promptParts };
    } else {
      geminiContents.push({ role: 'user', parts: promptParts });
    }

    // Handle Streaming for authenticated user
    if (wantsStream) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (res.flushHeaders) res.flushHeaders();

      res.write(`data: ${JSON.stringify({ type: 'start', conversation_id: conversationId, sources, files: fileMetadataList })}\n\n`);

      let fullText = '';
      let isDone = false;
      const abortCtrl = new AbortController();

      req.on('close', async () => {
        if (!isDone) {
          abortCtrl.abort();
          if (fullText && fullText.trim()) {
            try {
              const safeAborted = validateAndSanitizeCitations(fullText, sources);
              await db.query(
                `INSERT INTO ai_messages (conversation_id, role, content, metadata)
                 VALUES ($1, 'assistant', $2, $3)`,
                [conversationId, safeAborted, JSON.stringify({ model: 'gemini-stream-aborted', stopped: true, sources })]
              );
            } catch (e) {}
          }
        }
      });

      try {
        const streamRes = await callGeminiStream(geminiContents, systemInstruction, (chunk) => {
          fullText += chunk;
          res.write(`data: ${JSON.stringify({ type: 'chunk', text: chunk })}\n\n`);
        }, abortCtrl.signal);

        isDone = true;
        const usedModel = streamRes.model || 'gemini-3.1-flash-lite';
        let safeFullText = validateAndSanitizeCitations(fullText, sources);
        safeFullText = verifyAndRefineAnswer(safeFullText, { sources, taskAnalysis }).refinedText;

        if (!safeFullText || !safeFullText.trim()) {
          res.write(`data: ${JSON.stringify({ type: 'error', error: 'AI không tạo được nội dung phản hồi hợp lệ.' })}\n\n`);
          return res.end();
        }

        // Lưu trữ câu trả lời kèm lịch sử phiên bản trong metadata.versions
        let botMsgId = null;
        let botCreatedAt = new Date();
        let messageVersions = [];

        if (isRegenerate && targetMessageId) {
          const oldMsgRes = await db.query(
            `SELECT id, content, metadata, created_at FROM ai_messages WHERE id = $1 AND conversation_id = $2`,
            [targetMessageId, conversationId]
          );
          if (oldMsgRes.rows.length > 0) {
            const oldRow = oldMsgRes.rows[0];
            const prevMeta = oldRow.metadata || {};
            messageVersions = Array.isArray(prevMeta.versions) ? [...prevMeta.versions] : [];
            if (messageVersions.length === 0) {
              messageVersions.push({
                version: 1,
                content: oldRow.content,
                model: prevMeta.model || usedModel,
                sources: prevMeta.sources || sources || [],
                created_at: oldRow.created_at
              });
            }
            messageVersions.push({
              version: messageVersions.length + 1,
              content: safeFullText,
              model: usedModel,
              sources: sources || [],
              created_at: new Date().toISOString()
            });

            const updatedMeta = {
              ...prevMeta,
              model: usedModel,
              sources,
              active_version: messageVersions.length,
              versions: messageVersions,
              regenerated_at: new Date().toISOString()
            };

            const updateRes = await db.query(
              `UPDATE ai_messages
               SET content = $1, metadata = $2, created_at = NOW()
               WHERE id = $3 AND conversation_id = $4
               RETURNING id, created_at`,
              [safeFullText, JSON.stringify(updatedMeta), targetMessageId, conversationId]
            );
            botMsgId = updateRes.rows[0].id;
            botCreatedAt = updateRes.rows[0].created_at;
          }
        }

        if (!botMsgId) {
          messageVersions = [{
            version: 1,
            content: safeFullText,
            model: usedModel,
            sources: sources || [],
            created_at: new Date().toISOString()
          }];
          const botMsgRes = await db.query(
            `INSERT INTO ai_messages (conversation_id, role, content, metadata)
             VALUES ($1, 'assistant', $2, $3)
             RETURNING id, created_at`,
            [conversationId, safeFullText, JSON.stringify({ model: usedModel, sources, active_version: 1, versions: messageVersions })]
          );
          botMsgId = botMsgRes.rows[0].id;
          botCreatedAt = botMsgRes.rows[0].created_at;
        }

        // Ghi bền vững vào chat_log (NocoDB)
        try {
          await logMessageToChatLog({
            conversationId,
            userId: req.user.user_id,
            username: req.user.username,
            companyId: req.user.company_id || 'SOTRANS',
            agentId: 'general',
            role: 'assistant',
            content: safeFullText,
            metadata: { model: usedModel, sources, version: messageVersions.length, regenerated: Boolean(isRegenerate) },
            timestamp: botCreatedAt
          });
        } catch (logErr) {
          console.warn('[GeneralAI] Không thể ghi bot message vào chat_log:', logErr.message);
        }

        let updatedTitle = conv.title;
        if (conv.title === 'Cuộc trò chuyện mới' && userMessage) {
          updatedTitle = userMessage.slice(0, 40);
          await db.query(`UPDATE ai_conversations SET title = $1, updated_at = NOW() WHERE id = $2`, [updatedTitle, conversationId]);
        } else {
          await db.query(`UPDATE ai_conversations SET updated_at = NOW() WHERE id = $1`, [conversationId]);
        }

        res.write(`data: ${JSON.stringify({
          type: 'done',
          reply: safeFullText,
          conversation_id: conversationId,
          message_id: botMsgId,
          sources,
          active_version: messageVersions.length,
          versions: messageVersions,
          title: updatedTitle
        })}\n\n`);
        return res.end();
      } catch (streamErr) {
        if (!isDone) {
          isDone = true;
          let fallbackReply = fullText;
          if (!fallbackReply) {
            const fb = await callGeminiSafe(geminiContents, systemInstruction, grounded);
            fallbackReply = fb.text;
          }
          const safeFallbackReply = validateAndSanitizeCitations(fallbackReply, sources);

          const botMsgRes = await db.query(
            `INSERT INTO ai_messages (conversation_id, role, content, metadata)
             VALUES ($1, 'assistant', $2, $3)
             RETURNING id, created_at`,
            [conversationId, safeFallbackReply, JSON.stringify({ model: 'gemini-fallback', sources })]
          );

          try {
            await logMessageToChatLog({
              conversationId,
              userId: req.user.user_id,
              username: req.user.username,
              companyId: req.user.company_id || 'SOTRANS',
              agentId: 'general',
              role: 'assistant',
              content: safeFallbackReply,
              metadata: { model: 'gemini-fallback', sources },
              timestamp: botMsgRes.rows[0].created_at
            });
          } catch (e) {}

          res.write(`data: ${JSON.stringify({
            type: 'done',
            reply: safeFallbackReply,
            conversation_id: conversationId,
            message_id: botMsgRes.rows[0].id,
            sources,
            title: conv.title
          })}\n\n`);
          return res.end();
        }
      }
    }

    // Non-streaming response for authenticated user
    const aiResult = await callGeminiSafe(geminiContents, systemInstruction, grounded);
    let replyText = validateAndSanitizeCitations(aiResult.text, sources);
    replyText = verifyAndRefineAnswer(replyText, { sources, taskAnalysis }).refinedText;

    let botMsgId = null;
    let botCreatedAt = new Date();

    if (!replyText || !replyText.trim()) {
      return res.status(502).json({
        success: false,
        error: 'AI không tạo được phản hồi hợp lệ.'
      });
    }

    // Lưu trữ câu trả lời kèm lịch sử phiên bản trong metadata.versions
    let messageVersions = [];
    const usedModel = aiResult.model || 'gemini-3.1-flash-lite';

    if (isRegenerate && targetMessageId) {
      const oldMsgRes = await db.query(
        `SELECT id, content, metadata, created_at FROM ai_messages WHERE id = $1 AND conversation_id = $2`,
        [targetMessageId, conversationId]
      );
      if (oldMsgRes.rows.length > 0) {
        const oldRow = oldMsgRes.rows[0];
        const prevMeta = oldRow.metadata || {};
        messageVersions = Array.isArray(prevMeta.versions) ? [...prevMeta.versions] : [];
        if (messageVersions.length === 0) {
          messageVersions.push({
            version: 1,
            content: oldRow.content,
            model: prevMeta.model || usedModel,
            sources: prevMeta.sources || sources || [],
            created_at: oldRow.created_at
          });
        }
        messageVersions.push({
          version: messageVersions.length + 1,
          content: replyText,
          model: usedModel,
          sources: sources || [],
          created_at: new Date().toISOString()
        });

        const updatedMeta = {
          ...prevMeta,
          model: usedModel,
          sources,
          active_version: messageVersions.length,
          versions: messageVersions,
          regenerated_at: new Date().toISOString()
        };

        const updateRes = await db.query(
          `UPDATE ai_messages
           SET content = $1, metadata = $2, created_at = NOW()
           WHERE id = $3 AND conversation_id = $4
           RETURNING id, created_at`,
          [replyText, JSON.stringify(updatedMeta), targetMessageId, conversationId]
        );
        botMsgId = updateRes.rows[0].id;
        botCreatedAt = updateRes.rows[0].created_at;
      }
    }

    if (!botMsgId) {
      messageVersions = [{
        version: 1,
        content: replyText,
        model: usedModel,
        sources: sources || [],
        created_at: new Date().toISOString()
      }];
      const botMsgRes = await db.query(
        `INSERT INTO ai_messages (conversation_id, role, content, metadata)
         VALUES ($1, 'assistant', $2, $3)
         RETURNING id, created_at`,
        [conversationId, replyText, JSON.stringify({ model: usedModel, sources, active_version: 1, versions: messageVersions })]
      );
      botMsgId = botMsgRes.rows[0].id;
      botCreatedAt = botMsgRes.rows[0].created_at;
    }

    // Ghi bền vững vào chat_log (NocoDB)
    try {
      await logMessageToChatLog({
        conversationId,
        userId: req.user.user_id,
        username: req.user.username,
        companyId: req.user.company_id || 'SOTRANS',
        agentId: 'general',
        role: 'assistant',
        content: replyText,
        metadata: { model: usedModel, sources, version: messageVersions.length, regenerated: Boolean(isRegenerate) },
        timestamp: botCreatedAt
      });
    } catch (logErr) {
      console.warn('[GeneralAI] Không thể ghi bot message vào chat_log:', logErr.message);
    }

    let updatedTitle = conv.title;
    if (conv.title === 'Cuộc trò chuyện mới' && userMessage) {
      updatedTitle = userMessage.slice(0, 40);
      await db.query(`UPDATE ai_conversations SET title = $1, updated_at = NOW() WHERE id = $2`, [updatedTitle, conversationId]);
    } else {
      await db.query(`UPDATE ai_conversations SET updated_at = NOW() WHERE id = $1`, [conversationId]);
    }

    res.json({
      success: true,
      reply: replyText,
      conversation_id: conversationId,
      message_id: botMsgId,
      title: updatedTitle,
      files: fileMetadataList,
      sources,
      active_version: messageVersions.length,
      versions: messageVersions
    });
  } catch (err) {
    console.error('General AI Chat Error:', err.message);
    res.status(500).json({
      success: false,
      error: 'Đã xảy ra lỗi trong quá trình xử lý AI.',
      conversation_id: conversationId,
    });
  }
});

// GET /api/general/attachments/:id (Yêu cầu xác thực tài khoản)
router.get('/attachments/:id', verifyToken, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query(
      `SELECT * FROM ai_attachments WHERE id = $1`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy tệp đính kèm.' });
    }
    const att = result.rows[0];

    // Chỉ chủ sở hữu hoặc ADMIN mới có quyền tải tệp
    if (att.user_id !== req.user.user_id && att.user_id !== req.user.username && req.user.role !== 'ADMIN') {
      return res.status(403).json({ success: false, error: '403 Forbidden: Bạn không có quyền truy cập tệp này.' });
    }

    if (!fs.existsSync(att.storage_path)) {
      return res.status(404).json({ success: false, error: 'Tệp không tồn tại trên máy chủ lưu trữ.' });
    }

    res.setHeader('Content-Type', att.file_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(att.file_name)}"`);
    fs.createReadStream(att.storage_path).pipe(res);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/general/conversations/:id/attachments (Yêu cầu xác thực tài khoản)
router.get('/conversations/:id/attachments', verifyToken, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query(
      `SELECT id, file_name, file_type, file_size, created_at
       FROM ai_attachments
       WHERE conversation_id = $1 AND (user_id = $2 OR user_id = $3)
       ORDER BY created_at DESC`,
      [id, req.user.user_id, req.user.username]
    );
    res.json({ success: true, attachments: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.callGemini = callGemini;
router.callGeminiStream = callGeminiStream;
router.generalAiUploadMiddleware = generalAiUploadMiddleware;

module.exports = router;
