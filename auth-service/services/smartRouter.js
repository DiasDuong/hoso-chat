const { resolveDistanceAndRouting, extractOriginAndDestination } = require('./geoRoutingService');
const { resolveCurrencyInfo, isCurrencyQuery } = require('./currencyRateService');
const {
  fetchOpenMeteo,
  fetchGoogleNews,
  fetchWikipedia,
  searchGeneralWebAndGround,
  VIETNAM_CITIES
} = require('./webSearch');
const { resolveCalculation, isCalculationQuery } = require('./mathUtilityService');

// In-memory cache for router results (TTL 5 minutes)
const routerCache = new Map();
const ROUTER_CACHE_TTL = 5 * 60 * 1000;

function getCached(key) {
  const item = routerCache.get(key);
  if (item && (Date.now() - item.ts < ROUTER_CACHE_TTL)) {
    return item.data;
  }
  routerCache.delete(key);
  return null;
}

function setCache(key, data) {
  if (routerCache.size > 200) {
    const oldest = routerCache.keys().next().value;
    routerCache.delete(oldest);
  }
  routerCache.set(key, { data, ts: Date.now() });
}

/**
 * Phân loại ý định thông minh (Multi-Intent Classification)
 */
function classifyIntent(query, historyText = '') {
  const q = (query || '').toLowerCase().trim();
  const comb = q + ' ' + (historyText || '').toLowerCase();

  // 1. Tiện ích Tính toán & Số học (Calculator / Utility)
  if (isCalculationQuery(q)) {
    return 'INTENT_CALCULATION';
  }

  // 2. Khoảng cách & Chỉ đường
  const isDistanceQuestion = /(khoảng cách|bao xa|cách bao xa|đi đường nào|chỉ đường|lộ trình|từ\s+.+?\s+(?:đến|tới|sang|qua)|mất bao lâu.+?(?:xe|đi bộ|xe máy|ô tô)|bao nhiêu cây số|bao nhiêu km)/i.test(q);
  const isDistanceFollowUp = /(thế còn đi bộ|nếu đi bộ|xe máy thì sao|ô tô thì sao|đi đường khác|tuyến đường nào|lộ trình nào)/i.test(q) &&
                             /(khoảng cách|bao xa|km|quận|đường|de la sol|sotrans|hoàng diệu|tôn thất thuyết)/i.test(historyText);
  if (isDistanceQuestion || isDistanceFollowUp) {
    return 'INTENT_DISTANCE_ROUTING';
  }

  // 3. Tỷ giá ngoại tệ & Tài chính
  if (isCurrencyQuery(q)) {
    return 'INTENT_CURRENCY';
  }

  // 4. Thời tiết & Khí tượng
  const isWeatherDirect = /(thời tiết|nhiệt độ|trời mưa|mưa không|nắng không|dự báo thời tiết|hôm nay trời|nóng không|lạnh không|độ ẩm)/i.test(q);
  const isWeatherFollowUp = /(thông tin dựa vào đâu|nguồn ở đâu|sao biết|lấy ở đâu|dựa vào đâu|có thật không|căn cứ vào đâu|trạm nào|chính xác không)/i.test(q) &&
                            /(thời tiết|nhiệt độ|độ ẩm|mưa|nắng|hà nội|đà nẵng|hồ chí minh|sài gòn)/i.test(historyText);
  if (isWeatherDirect || isWeatherFollowUp) {
    return 'INTENT_WEATHER';
  }

  // 5. Tra cứu Quy định & Chính sách nội bộ SOTRANS Group
  const isInternalPolicy = /(?:quy chế|chính sách|nội quy|quy định|nghỉ phép|công tác phí|thử việc|hợp đồng|phúc lợi|bảo hiểm|kỷ luật|khen thưởng|lương|thưởng|đồng phục)[\s\S]*?(?:của\s+)?(?:công ty|sotrans|vietranstimex|sowatco|tập đoàn|nội bộ)/i.test(q) ||
                           /(?:thời giờ làm việc|chế độ|làm thêm giờ|chế độ thai sản)[\s\S]*?(?:tại\s+)?(?:sotrans|vietranstimex|sowatco)/i.test(q);
  if (isInternalPolicy) {
    return 'INTENT_COMPANY_POLICY';
  }

  // 6. Tìm kiếm thông tin trên Internet / Dữ kiện thời gian thực / Lãnh đạo / Giá cả / Tin tức
  const isPublicLeadership = /(chủ tịch nước|tổng thống|tổng bí thư|thủ tướng|chủ tịch quốc hội|bộ trưởng|thống đốc|chủ tịch ubnd|thị trưởng|ceo|tổng giám đốc)/i.test(q);
  const isTemporalFact = /(hiện nay|hiện tại|bây giờ|năm nay|năm 2026|năm 2025|gần đây|vừa qua|mới nhất|dạo này)/i.test(q) && /(ai là|ở đâu|bao nhiêu|thế nào|ra sao|khi nào|tình hình|sự kiện|tin|kết quả)/i.test(q);
  const isMarketEconomic = /(giá vàng|giá xăng|giá dầu|giá cổ phiếu|chứng khoán|vn-index|lạm phát|gdp|dân số|giá xe|giá vé|giá điện thoại|iphone)/i.test(q);
  const isNewsEvent = /(tin tức|thời sự|bầu cử|chiến sự|giải vô địch|bóng đá|kết quả|giải đấu|sự kiện|mới ra mắt)/i.test(q);
  const isExplicitSearch = /(tìm kiếm|tra cứu|tra mạng|search|tra trên mạng|tìm trên mạng|thông tin về|tin tức về|giá cả|thị trường|giá cước)/i.test(q);

  if (isPublicLeadership || isTemporalFact || isMarketEconomic || isNewsEvent || isExplicitSearch) {
    return 'INTENT_GENERAL_SEARCH';
  }

  // 7. Định nghĩa / Khái niệm Bách khoa
  const isWiki = /(là gì|định nghĩa|nguồn gốc|tiểu sử|lịch sử hình thành|khái niệm|nguyên lý)/i.test(q) && q.split(' ').length <= 15;
  if (isWiki) {
    return 'INTENT_WIKI';
  }

  // Mặc định: Kiến thức tổng quát, lập trình, viết bài, dịch thuật
  return 'INTENT_GENERAL';
}

/**
 * Trình điều phối và định tuyến thông minh (Smart Grounding Coordinator)
 * Hỗ trợ Compound Query (Truy vấn kết hợp: Tính toán + Thời tiết + Tra cứu web)
 */
async function routeAndGroundQuery(userMessage, history = null, currentUser = null) {
  const query = (userMessage || '').trim();
  if (!query) return null;

  // Thu thập văn bản lịch sử để phân tích ngữ cảnh tiếp nối
  let historyText = '';
  if (Array.isArray(history)) {
    historyText = history.map(h => (typeof h === 'object' ? (h.content || '') : String(h))).join(' ');
  } else if (typeof history === 'string') {
    historyText = history;
  }

  const qLower = query.toLowerCase();
  const comb = qLower + ' ' + (historyText || '').toLowerCase();

  let combinedPrompt = '';
  const combinedSources = [];
  const detectedIntents = [];
  const compoundData = {};

  // =========================================================================
  // 1. NHÓM TIỆN ÍCH TÍNH TOÁN & SỐ HỌC (CALCULATOR & MATH UTILITY)
  // =========================================================================
  try {
    const calcResult = resolveCalculation(query);
    if (calcResult && calcResult.contextPrompt) {
      combinedPrompt += calcResult.contextPrompt;
      if (calcResult.sources && calcResult.sources.length) {
        combinedSources.push(...calcResult.sources);
      }
      detectedIntents.push('CALCULATION');
      compoundData.calculation = calcResult;
    }
  } catch (calcErr) {
    console.warn('[SmartRouter] Calculation error:', calcErr.message);
  }

  // =========================================================================
  // 2. NHÓM KHOẢNG CÁCH & ĐỊNH TUYẾN GIAO THÔNG (DISTANCE & ROUTING)
  // =========================================================================
  const isDistanceQuestion = /(khoảng cách|bao xa|cách bao xa|đi đường nào|chỉ đường|lộ trình|từ\s+.+?\s+(?:đến|tới|sang|qua)|mất bao lâu.+?(?:xe|đi bộ|xe máy|ô tô)|bao nhiêu cây số|bao nhiêu km)/i.test(qLower);
  const isDistanceFollowUp = /(thế còn đi bộ|nếu đi bộ|xe máy thì sao|ô tô thì sao|đi đường khác|tuyến đường nào|lộ trình nào)/i.test(qLower) &&
                             /(khoảng cách|bao xa|km|quận|đường|de la sol|sotrans|hoàng diệu|tôn thất thuyết)/i.test(historyText);

  if (isDistanceQuestion || isDistanceFollowUp) {
    let queryToResolve = query;
    if (!extractOriginAndDestination(query) && historyText) {
      const prevTurns = Array.isArray(history) ? history.slice(-4) : [];
      for (const t of prevTurns.reverse()) {
        const txt = typeof t === 'object' ? (t.content || '') : String(t);
        if (extractOriginAndDestination(txt)) {
          queryToResolve = txt;
          break;
        }
      }
    }

    try {
      const routeResult = await resolveDistanceAndRouting(queryToResolve);
      if (routeResult && routeResult.contextPrompt) {
        combinedPrompt += routeResult.contextPrompt;
        if (routeResult.sources && routeResult.sources.length) {
          combinedSources.push(...routeResult.sources);
        }
        detectedIntents.push('DISTANCE_ROUTING');
        compoundData.distance = routeResult;
      }
    } catch (routeErr) {
      console.warn('[SmartRouter] Distance routing error:', routeErr.message);
    }
  }

  // =========================================================================
  // 3. NHÓM TỶ GIÁ NGOẠI TỆ & TÀI CHÍNH (CURRENCY & FINANCE)
  // =========================================================================
  if (isCurrencyQuery(qLower)) {
    try {
      const curResult = await resolveCurrencyInfo(query);
      if (curResult && curResult.contextPrompt) {
        combinedPrompt += curResult.contextPrompt;
        if (curResult.sources && curResult.sources.length) {
          combinedSources.push(...curResult.sources);
        }
        detectedIntents.push('CURRENCY');
        compoundData.currency = curResult;
      }
    } catch (curErr) {
      console.warn('[SmartRouter] Currency error:', curErr.message);
    }
  }

function detectTargetCity(currentQuery, historyText = '') {
  const q = (currentQuery || '').toLowerCase();
  // 1. Ưu tiên tuyệt đối địa danh xuất hiện trong câu hỏi hiện tại
  if (/hà nội|ha noi|thủ đô/i.test(q)) return 'Ha_Noi';
  if (/hồ chí minh|tp hcm|tphcm|sài gòn|hcm/i.test(q)) return 'Ho_Chi_Minh';
  if (/đà nẵng|da nang/i.test(q)) return 'Da_Nang';
  if (/hải phòng|hai phong/i.test(q)) return 'Hai_Phong';
  if (/cần thơ|can tho/i.test(q)) return 'Can_Tho';
  if (/huế|hue/i.test(q)) return 'Hue';
  if (/nha trang/i.test(q)) return 'Nha_Trang';
  if (/vũng tàu|vung tau/i.test(q)) return 'Vung_Tau';
  if (/đà lạt|da lat/i.test(q)) return 'Da_Lat';
  if (/quảng ninh|hạ long/i.test(q)) return 'Ha_Long';

  // 2. Chỉ khi câu hỏi hiện tại KHÔNG có tên thành phố (câu hỏi tiếp nối ngữ cảnh), mới xét đến lịch sử
  const h = (historyText || '').toLowerCase();
  if (/hà nội|ha noi|thủ đô/i.test(h)) return 'Ha_Noi';
  if (/hồ chí minh|tp hcm|tphcm|sài gòn|hcm/i.test(h)) return 'Ho_Chi_Minh';
  if (/đà nẵng|da nang/i.test(h)) return 'Da_Nang';
  if (/hải phòng|hai phong/i.test(h)) return 'Hai_Phong';
  if (/cần thơ|can tho/i.test(h)) return 'Can_Tho';
  if (/huế|hue/i.test(h)) return 'Hue';
  if (/nha trang/i.test(h)) return 'Nha_Trang';
  if (/vũng tàu|vung tau/i.test(h)) return 'Vung_Tau';
  if (/đà lạt|da lat/i.test(h)) return 'Da_Lat';
  if (/quảng ninh|hạ long/i.test(h)) return 'Ha_Long';

  return 'Ho_Chi_Minh'; // Trụ sở chính mặc định
}

  // =========================================================================
  // 4. NHÓM THỜI TIẾT & KHÍ TƯỢNG (WEATHER)
  // =========================================================================
  const isWeatherDirect = /(thời tiết|nhiệt độ|trời mưa|mưa không|nắng không|dự báo thời tiết|hôm nay trời|nóng không|lạnh không|độ ẩm)/i.test(qLower);
  const isWeatherFollowUp = /(thông tin dựa vào đâu|nguồn ở đâu|sao biết|lấy ở đâu|dựa vào đâu|có thật không|căn cứ vào đâu|trạm nào|chính xác không)/i.test(qLower) &&
                            /(thời tiết|nhiệt độ|độ ẩm|mưa|nắng|hà nội|đà nẵng|hồ chí minh|sài gòn)/i.test(historyText);

  if (isWeatherDirect || isWeatherFollowUp) {
    const cityKey = detectTargetCity(qLower, historyText);
    const city = VIETNAM_CITIES[cityKey] || VIETNAM_CITIES.Ho_Chi_Minh;

    try {
      const live = await fetchOpenMeteo(city.lat, city.lon);
      const sources = [
        {
          title: `Trạm quan trắc khí tượng ${city.name} (Tổ chức Khí tượng Thế giới WMO / ECMWF)`,
          url: `https://open-meteo.com/en/docs#latitude=${city.lat}&longitude=${city.lon}`
        }
      ];

      const contextPrompt = `\n\n[DỮ LIỆU ĐO ĐẠC THỰC TẾ THỜI GIAN THỰC TỪ TRẠM QUAN TRẮC KHÍ TƯỢNG ${city.name.toUpperCase()} (TỌA ĐỘ ${city.lat}, ${city.lon})]:
- Nhiệt độ đo đạc thực tế: ${live.temp}°C (Cảm nhận thực tế: ${live.feelsLike}°C)
- Tình trạng thời tiết: ${live.desc}
- Độ ẩm không khí: ${live.humidity}%
- Tốc độ gió: ${live.windSpeed} km/h
- Lượng mưa: ${live.precip} mm (Xác suất mưa trong ngày: ${live.rainProb}%)
- Dự báo nhiệt độ hôm nay: Cao nhất ${live.maxTemp}°C / Thấp nhất ${live.minTemp}°C
- Chỉ số bức xạ UV cực đại: ${live.uv}
- Cập nhật từ: Trạm quan trắc khí tượng tự động và vệ tinh quốc tế (WMO / ECMWF).

HƯỚNG DẪN TRẢ LỜI:
1. TRẢ LỜI RÕ RÀNG: Nêu ngay nhiệt độ và thời tiết thực tế tại ${city.name} là ${live.temp}°C, ${live.desc}.
2. Cung cấp đầy đủ các thông số chi tiết (độ ẩm, gió, xác suất mưa).
3. Gợi ý thiết thực về trang phục, sức khỏe.
4. TUYỆT ĐỐI KHÔNG tự nhận là phỏng đoán hay ví dụ hư cấu.`;

      combinedPrompt += contextPrompt;
      combinedSources.push(...sources);
      detectedIntents.push('WEATHER');
      compoundData.weather = live;
    } catch (weatherErr) {
      console.warn('[SmartRouter] Weather error:', weatherErr.message);
    }
  }

  // =========================================================================
  // 5. NHÓM CHÍNH SÁCH / THỦ TỤC NỘI BỘ DOANH NGHIỆP SOTRANS
  // =========================================================================
  const isInternalPolicy = /(?:quy chế|chính sách|nội quy|quy định|nghỉ phép|công tác phí|thử việc|hợp đồng|phúc lợi|bảo hiểm|kỷ luật|khen thưởng|lương|thưởng|đồng phục)[\s\S]*?(?:của\s+)?(?:công ty|sotrans|vietranstimex|sowatco|tập đoàn|nội bộ)/i.test(qLower) ||
                           /(?:thời giờ làm việc|chế độ|làm thêm giờ|chế độ thai sản)[\s\S]*?(?:tại\s+)?(?:sotrans|vietranstimex|sowatco)/i.test(qLower);

  if (isInternalPolicy) {
    const isGuest = !currentUser || !currentUser.user_id || currentUser.role === 'GUEST' || currentUser.role === 'USER';

    if (isGuest) {
      const contextPrompt = `\n\n[LƯU Ý PHÂN QUYỀN TRUY CẬP CHÍNH SÁCH DOANH NGHIỆP SOTRANS]:
Người dùng đang hỏi về quy định, chế độ hoặc chính sách nội bộ của SOTRANS Group nhưng hiện chưa đăng nhập tài khoản nhân viên hoặc đang dùng tài khoản Khách.
HƯỚNG DẪN TRẢ LỜI:
1. Trả lời một cách lịch sự, nhã nhặn.
2. Nêu rõ: Để tra cứu chi tiết các quy định, văn bản nội bộ và chế độ phúc lợi chính thức của SOTRANS Logistics, Vietranstimex hay Sowatco, vui lòng đăng nhập tài khoản nhân viên được cấp và chuyển sang trợ lý chuyên trách "Quy định & Chính sách" trên hệ thống SOTRANS Hub.
3. Nếu câu hỏi có liên quan đến thông tin công khai cơ bản của SOTRANS (ví dụ: trụ sở chính tại 1B Hoàng Diệu, Phường 13, Quận 4, TP.HCM; website sotrans.com.vn), trợ lý có thể cung cấp thông tin công khai này một cách chuẩn xác.`;

      combinedPrompt += contextPrompt;
      combinedSources.push({ title: 'Cổng thông tin doanh nghiệp SOTRANS Group', url: 'https://sotrans.com.vn' });
      detectedIntents.push('COMPANY_POLICY_GUEST');
    } else {
      const contextPrompt = `\n\n[HƯỚNG DẪN TRA CỨU CHÍNH SÁCH NỘI BỘ DÀNH CHO NHÂN VIÊN SOTRANS]:
Người dùng là nhân sự nội bộ (Vai trò: ${currentUser.role || 'Nhân viên'}, Đơn vị: ${currentUser.company_id || 'SOTRANS Group'}).
HƯỚNG DẪN TRẢ LỜI:
1. Giải đáp các nguyên tắc chung của doanh nghiệp nếu có trong kiến thức chuẩn (như khối văn phòng làm việc 08:30 - 17:30 từ Thứ Hai đến Thứ Sáu, nghỉ trưa 12:00 - 13:00, nghỉ Thứ Bảy và Chủ Nhật).
2. Hướng dẫn người dùng có thể bấm vào thẻ trợ lý "Quy định & Chính sách" ở menu bên trái để tra cứu toàn văn từng điều khoản và văn bản quy chế mới nhất được ban hành.`;

      combinedPrompt += contextPrompt;
      combinedSources.push({ title: 'Sổ tay Văn hóa & Quy định Nội bộ SOTRANS Hub', url: '/chat/' });
      detectedIntents.push('COMPANY_POLICY_MEMBER');
    }
  }

  // =========================================================================
  // 6. NHÓM TÌM KIẾM WEB TỔNG QUÁT / TIN TỨC / SỰ KIỆN / DỮ KIỆN THỜI GIAN THỰC (WEB SEARCH & NEWS)
  // =========================================================================
  const isPublicLeadership = /(chủ tịch nước|tổng thống|tổng bí thư|thủ tướng|chủ tịch quốc hội|bộ trưởng|thống đốc|chủ tịch ubnd|thị trưởng|ceo|tổng giám đốc)/i.test(qLower);
  const isTemporalFact = /(hiện nay|hiện tại|bây giờ|năm nay|năm 2026|năm 2025|gần đây|vừa qua|mới nhất|dạo này)/i.test(qLower) &&
                         /(ai là|ở đâu|bao nhiêu|thế nào|ra sao|khi nào|tình hình|sự kiện|tin|kết quả|giá|doanh số|vô địch)/i.test(qLower);
  const isMarketEconomic = /(giá vàng|giá xăng|giá dầu|giá cổ phiếu|chứng khoán|vn-index|lạm phát|gdp|dân số|giá xe|giá vé|giá điện thoại|iphone)/i.test(qLower);
  const isNewsEvent = /(tin tức|thời sự|bầu cử|chiến sự|giải vô địch|bóng đá|kết quả|giải đấu|sự kiện|mới ra mắt)/i.test(qLower);
  const isExplicitSearch = /(tìm kiếm|tra cứu|tra mạng|search|tra trên mạng|tìm trên mạng|thông tin về|tin tức về|giá cả|thị trường|giá cước)/i.test(qLower);

  const shouldSearchWeb = isPublicLeadership || isTemporalFact || isMarketEconomic || isNewsEvent || isExplicitSearch;

  // Đảm bảo không kích hoạt Web Search cho các câu hỏi thuần túy ngày tháng/lịch đã giải quyết bởi CALCULATION
  const isPureDateCalculation = detectedIntents.includes('CALCULATION') &&
    (compoundData.calculation?.type?.includes('DATE') ||
     compoundData.calculation?.type?.includes('DATETIME') ||
     compoundData.calculation?.data?.type?.includes('AGE'));

  if (shouldSearchWeb && !isPureDateCalculation && !detectedIntents.includes('WEB_SEARCH')) {
    try {
      const searchResult = await searchGeneralWebAndGround(query, { maxResults: 5, readPagesCount: 1 });
      if (searchResult && searchResult.contextPrompt) {
        combinedPrompt += searchResult.contextPrompt;
        if (searchResult.sources && searchResult.sources.length) {
          combinedSources.push(...searchResult.sources);
        }
        detectedIntents.push('WEB_SEARCH');
        compoundData.webSearch = searchResult;
      }
    } catch (searchErr) {
      console.warn('[SmartRouter] Web search error:', searchErr.message);
    }
  }

  // =========================================================================
  // 7. NHÓM BÁCH KHOA TOÀN THƯ (WIKIPEDIA)
  // =========================================================================
  const isWiki = /(là gì|định nghĩa|nguồn gốc|tiểu sử|lịch sử hình thành|khái niệm|nguyên lý)/i.test(qLower) && qLower.split(' ').length <= 15;
  if (isWiki && !detectedIntents.includes('WIKI') && !detectedIntents.includes('WEB_SEARCH')) {
    try {
      const wikiItems = await fetchWikipedia(query);
      if (wikiItems.length > 0) {
        const sources = wikiItems.map(w => ({
          title: `Bách khoa toàn thư Wikipedia: ${w.title}`,
          url: w.url
        }));

        const contextPrompt = `\n\n[DỮ LIỆU THAM KHẢO TỪ BÁCH KHOA TOÀN THƯ WIKIPEDIA]:
${wikiItems.map((w, i) => `${i + 1}. Chủ đề "${w.title}": ${w.snippet}`).join('\n')}

Hãy sử dụng tư liệu bách khoa chuẩn xác này để giải thích cho người dùng sâu sắc, mạch lạc và có cơ sở khoa học.`;

        combinedPrompt += contextPrompt;
        combinedSources.push(...sources);
        detectedIntents.push('WIKI');
        compoundData.wiki = wikiItems;
      }
    } catch (wikiErr) {
      console.warn('[SmartRouter] Wiki error:', wikiErr.message);
    }
  }

  // =========================================================================
  // 8. TỔNG HỢP KẾT QUẢ VÀ TRẢ VỀ CHO CONTROLLER
  // =========================================================================
  if (detectedIntents.length > 0) {
    // Loại bỏ các nguồn trùng URL nếu có
    const uniqueSources = [];
    const seenUrls = new Set();
    for (const s of combinedSources) {
      if (s && s.url && !seenUrls.has(s.url)) {
        seenUrls.add(s.url);
        uniqueSources.push(s);
      }
    }

    return {
      intent: detectedIntents.join('+'),
      contextPrompt: combinedPrompt,
      sources: uniqueSources,
      data: compoundData
    };
  }

  // Mặc định: Kiến thức tổng quát, lập trình, viết bài, dịch thuật (LLM thuần túy)
  return {
    intent: 'GENERAL',
    contextPrompt: '',
    sources: []
  };
}

module.exports = {
  classifyIntent,
  routeAndGroundQuery
};
