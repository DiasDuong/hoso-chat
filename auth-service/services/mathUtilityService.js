/**
 * Module: Math & Utility Calculation Service for SOTRANS Hub General AI
 * 
 * Capabilities:
 * 1. Safe arithmetic & math expressions parser (Shunting-Yard algorithm, NO eval).
 * 2. Percentage, ratio, difference, and growth/decrease calculations.
 * 3. Banking & financial loan calculations (Lãi phẳng & Lãi dư nợ giảm dần / PMT).
 * 4. Common unit conversions (Length, Weight, Area, Volume, Temperature, Speed, Data size).
 * 5. Date & time intervals, weekday calculation, age and working days.
 * 
 * Safety & Security:
 * - NO eval() or Function() constructors.
 * - Division by zero validation, boundary checks.
 * - Formatted outputs in Vietnamese locale standards (1.000.000,50).
 */

function formatNumberVN(num, maxDec = 2) {
  if (typeof num !== 'number' || isNaN(num) || !isFinite(num)) return 'Không hợp lệ';
  return new Intl.NumberFormat('vi-VN', { maximumFractionDigits: maxDec }).format(num);
}

/* =========================================================================
   1. SAFE MATH EXPRESSION EVALUATOR (Shunting-Yard, ZERO eval)
   ========================================================================= */

function tokenize(expr) {
  const tokens = [];
  let i = 0;
  // Chuẩn hóa dấu phẩy thập phân sang dấu chấm, bỏ khoảng trắng
  const s = String(expr || '').replace(/\s+/g, '');

  while (i < s.length) {
    const ch = s[i];

    // Numbers (integer & float)
    if (/[0-9]/.test(ch) || (ch === '.' && i + 1 < s.length && /[0-9]/.test(s[i + 1]))) {
      let numStr = '';
      while (i < s.length && (/[0-9]/.test(s[i]) || s[i] === '.')) {
        numStr += s[i];
        i++;
      }
      tokens.push({ type: 'NUM', val: parseFloat(numStr) });
      continue;
    }

    // Mathematical Functions: sqrt, abs, round, floor, ceil, log, ln
    if (/[a-zA-Z]/.test(ch)) {
      let fn = '';
      while (i < s.length && /[a-zA-Z]/.test(s[i])) {
        fn += s[i];
        i++;
      }
      fn = fn.toLowerCase();
      if (['sqrt', 'abs', 'round', 'floor', 'ceil', 'log', 'ln'].includes(fn)) {
        tokens.push({ type: 'FN', val: fn });
      } else {
        throw new Error(`Hàm toán học không được hỗ trợ: "${fn}"`);
      }
      continue;
    }

    // Operators: +, -, *, /, x, X, ×, :, ÷, ^, %
    if (['+', '-', '*', '/', 'x', 'X', '×', ':', '÷', '^', '%'].includes(ch)) {
      let op = ch;
      if (op === 'x' || op === 'X' || op === '×') op = '*';
      if (op === ':' || op === '÷') op = '/';

      // Unary minus handling (e.g. -5, 3 * -2, (-5))
      if (op === '-') {
        const prev = tokens[tokens.length - 1];
        if (!prev || prev.type === 'OP' || (prev.type === 'P' && prev.val === '(')) {
          tokens.push({ type: 'NUM', val: 0 }); // covert -X to 0 - X
        }
      }

      tokens.push({ type: 'OP', val: op });
      i++;
      continue;
    }

    // Parentheses
    if (ch === '(' || ch === ')') {
      tokens.push({ type: 'P', val: ch });
      i++;
      continue;
    }

    throw new Error(`Ký tự không hợp lệ trong biểu thức: "${ch}"`);
  }

  return tokens;
}

const PRECEDENCE = {
  '+': 1,
  '-': 1,
  '*': 2,
  '/': 2,
  '%': 2,
  '^': 3
};

function infixToRPN(tokens) {
  const output = [];
  const opStack = [];

  for (const t of tokens) {
    if (t.type === 'NUM') {
      output.push(t);
    } else if (t.type === 'FN') {
      opStack.push(t);
    } else if (t.type === 'OP') {
      while (
        opStack.length &&
        opStack[opStack.length - 1].type === 'OP' &&
        PRECEDENCE[opStack[opStack.length - 1].val] >= PRECEDENCE[t.val] &&
        t.val !== '^'
      ) {
        output.push(opStack.pop());
      }
      opStack.push(t);
    } else if (t.type === 'P' && t.val === '(') {
      opStack.push(t);
    } else if (t.type === 'P' && t.val === ')') {
      while (opStack.length && !(opStack[opStack.length - 1].type === 'P' && opStack[opStack.length - 1].val === '(')) {
        output.push(opStack.pop());
      }
      if (!opStack.length) throw new Error('Dấu ngoặc đơn không hợp lệ (thừa dấu ngoặc đóng)');
      opStack.pop(); // remove '('
      if (opStack.length && opStack[opStack.length - 1].type === 'FN') {
        output.push(opStack.pop());
      }
    }
  }

  while (opStack.length) {
    const top = opStack.pop();
    if (top.type === 'P') throw new Error('Dấu ngoặc đơn không hợp lệ (thiếu dấu ngoặc đóng)');
    output.push(top);
  }

  return output;
}

function evaluateRPN(rpn) {
  const stack = [];

  for (const t of rpn) {
    if (t.type === 'NUM') {
      stack.push(t.val);
    } else if (t.type === 'OP') {
      if (stack.length < 2) throw new Error('Biểu thức thiếu toán hạng');
      const b = stack.pop();
      const a = stack.pop();
      let res;
      switch (t.val) {
        case '+': res = a + b; break;
        case '-': res = a - b; break;
        case '*': res = a * b; break;
        case '/':
          if (Math.abs(b) < 1e-14) throw new Error('Lỗi chia cho 0 (Division by zero)');
          res = a / b;
          break;
        case '%':
          if (Math.abs(b) < 1e-14) throw new Error('Lỗi chia cho 0 trong phép chia lấy dư');
          res = a % b;
          break;
        case '^': res = Math.pow(a, b); break;
        default: throw new Error(`Toán tử không hợp lệ: ${t.val}`);
      }
      stack.push(res);
    } else if (t.type === 'FN') {
      if (stack.length < 1) throw new Error(`Hàm ${t.val} thiếu đối số`);
      const a = stack.pop();
      let res;
      switch (t.val) {
        case 'sqrt':
          if (a < 0) throw new Error('Lỗi căn bậc hai của số âm');
          res = Math.sqrt(a);
          break;
        case 'abs': res = Math.abs(a); break;
        case 'round': res = Math.round(a); break;
        case 'floor': res = Math.floor(a); break;
        case 'ceil': res = Math.ceil(a); break;
        case 'ln':
          if (a <= 0) throw new Error('Lỗi logarit tự nhiên của số không dương');
          res = Math.log(a);
          break;
        case 'log':
          if (a <= 0) throw new Error('Lỗi logarit cơ số 10 của số không dương');
          res = Math.log10(a);
          break;
        default: throw new Error(`Hàm không xác định: ${t.val}`);
      }
      stack.push(res);
    }
  }

  if (stack.length !== 1) throw new Error('Biểu thức toán học không hợp lệ');
  return stack[0];
}

function safeEvalMath(expr) {
  try {
    const tokens = tokenize(expr);
    if (!tokens.length) return null;
    const rpn = infixToRPN(tokens);
    const val = evaluateRPN(rpn);
    const rounded = Math.round(val * 1e10) / 1e10;
    return {
      success: true,
      expression: expr,
      result: rounded,
      formattedResult: formatNumberVN(rounded, 6)
    };
  } catch (err) {
    return {
      success: false,
      expression: expr,
      error: err.message
    };
  }
}

/* =========================================================================
   2. PERCENTAGE & RATIO CALCULATOR
   ========================================================================= */

function calculatePercentage(text) {
  const q = String(text || '').toLowerCase().trim();

  // Mẫu 1: "X% của Y" hoặc "tính X phần trăm của Y"
  const m1 = q.match(/(\d+(?:[.,]\d+)?)\s*(?:%|phần\s+trăm)\s+của\s+([0-9]+(?:[.,][0-9]+)*(?:\s*(?:tỷ|triệu|tr|nghìn|k|m|b))?)/i);
  if (m1) {
    const pct = parseFloat(m1[1].replace(',', '.'));
    const total = parseVietnameseAmount(m1[2]);
    if (total !== null && !isNaN(pct)) {
      const val = (pct / 100) * total;
      return {
        type: 'PERCENT_OF',
        pct,
        total,
        result: val,
        explanation: `${pct}% của ${formatNumberVN(total)} = ${formatNumberVN(val)}`
      };
    }
  }

  // Mẫu 2: "Y tăng X%"
  const m2 = q.match(/([0-9]+(?:[.,][0-9]+)*(?:\s*(?:tỷ|triệu|tr|nghìn|k|m|b))?)\s+tăng\s+(\d+(?:[.,]\d+)?)\s*(?:%|phần\s+trăm)/i);
  if (m2) {
    const base = parseVietnameseAmount(m2[1]);
    const pct = parseFloat(m2[2].replace(',', '.'));
    if (base !== null && !isNaN(pct)) {
      const diff = base * (pct / 100);
      const val = base + diff;
      return {
        type: 'PERCENT_INCREASE',
        base,
        pct,
        diff,
        result: val,
        explanation: `${formatNumberVN(base)} tăng ${pct}% (tăng thêm ${formatNumberVN(diff)}) = ${formatNumberVN(val)}`
      };
    }
  }

  // Mẫu 3: "Y giảm X%"
  const m3 = q.match(/([0-9]+(?:[.,][0-9]+)*(?:\s*(?:tỷ|triệu|tr|nghìn|k|m|b))?)\s+giảm\s+(\d+(?:[.,]\d+)?)\s*(?:%|phần\s+trăm)/i);
  if (m3) {
    const base = parseVietnameseAmount(m3[1]);
    const pct = parseFloat(m3[2].replace(',', '.'));
    if (base !== null && !isNaN(pct)) {
      const diff = base * (pct / 100);
      const val = base - diff;
      return {
        type: 'PERCENT_DECREASE',
        base,
        pct,
        diff,
        result: val,
        explanation: `${formatNumberVN(base)} giảm ${pct}% (giảm bớt ${formatNumberVN(diff)}) = ${formatNumberVN(val)}`
      };
    }
  }

  // Mẫu 4: "tỷ lệ tăng trưởng từ A lên B" hoặc "chênh lệch giữa A và B"
  const m4 = q.match(/(?:tăng\s+trưởng|thay\s+đổi|tăng|chênh\s+lệch)?\s*từ\s+([0-9]+(?:[.,][0-9]+)*(?:\s*(?:tỷ|triệu|tr|nghìn|k|m|b))?)\s+(?:lên|đến|sang)\s+([0-9]+(?:[.,][0-9]+)*(?:\s*(?:tỷ|triệu|tr|nghìn|k|m|b))?)/i);
  if (m4) {
    const a = parseVietnameseAmount(m4[1]);
    const b = parseVietnameseAmount(m4[2]);
    if (a !== null && b !== null && a !== 0) {
      const diff = b - a;
      const pct = (diff / a) * 100;
      const isUp = diff >= 0;
      return {
        type: 'GROWTH_RATE',
        from: a,
        to: b,
        diff,
        pct,
        explanation: `Từ ${formatNumberVN(a)} lên ${formatNumberVN(b)}: chênh lệch ${diff >= 0 ? '+' : ''}${formatNumberVN(diff)}, tương ứng mức ${isUp ? 'tăng' : 'giảm'} ${formatNumberVN(Math.abs(pct), 2)}%`
      };
    }
  }

  // Mẫu 5: "A chiếm bao nhiêu phần trăm của B" hoặc "A bằng bao nhiêu % của B"
  const m5 = q.match(/([0-9]+(?:[.,][0-9]+)*(?:\s*(?:tỷ|triệu|tr|nghìn|k|m|b))?)\s+(?:chiếm|bằng|là)\s+bao\s+nhiêu\s*(?:%|phần\s+trăm)?\s+(?:của|so\s+với)\s+([0-9]+(?:[.,][0-9]+)*(?:\s*(?:tỷ|triệu|tr|nghìn|k|m|b))?)/i);
  if (m5) {
    const a = parseVietnameseAmount(m5[1]);
    const b = parseVietnameseAmount(m5[2]);
    if (a !== null && b !== null && b !== 0) {
      const pct = (a / b) * 100;
      return {
        type: 'RATIO_PERCENT',
        part: a,
        total: b,
        pct,
        explanation: `${formatNumberVN(a)} chiếm ${formatNumberVN(pct, 2)}% so với ${formatNumberVN(b)}`
      };
    }
  }

  return null;
}

/* =========================================================================
   3. LOAN & FINANCIAL INTEREST CALCULATOR
   ========================================================================= */

function parseVietnameseAmount(str) {
  if (!str) return null;
  const s = String(str).toLowerCase().trim();

  // Pattern: số + đơn vị tiền tệ
  const m = s.match(/([0-9]+(?:[.,][0-9]+)*)\s*(tỷ|ty|triệu|trieu|tr|nghìn|ngan|k|m|b)?/i);
  if (!m) return null;

  let numPart = m[1];
  const unit = (m[2] || '').toLowerCase();

  if (numPart.includes('.') && numPart.includes(',')) {
    // Ví dụ 2.500.000,50 hoặc 2,500,000.50
    if (numPart.lastIndexOf(',') > numPart.lastIndexOf('.')) {
      numPart = numPart.replace(/\./g, '').replace(',', '.');
    } else {
      numPart = numPart.replace(/,/g, '');
    }
  } else if (numPart.split('.').length > 2) {
    // 2.500.000 -> 2500000
    numPart = numPart.replace(/\./g, '');
  } else if (numPart.split(',').length > 2) {
    // 2,500,000 -> 2500000
    numPart = numPart.replace(/,/g, '');
  } else if (numPart.includes('.')) {
    if (unit) {
      // 2.5 triệu -> decimal
    } else {
      const parts = numPart.split('.');
      if (parts[1].length === 3) {
        // Dấu chấm phân tách hàng nghìn: 500.000 -> 500000
        numPart = numPart.replace('.', '');
      }
    }
  } else if (numPart.includes(',')) {
    if (unit) {
      numPart = numPart.replace(',', '.');
    } else {
      const parts = numPart.split(',');
      if (parts[1].length === 3) {
        numPart = numPart.replace(',', '');
      } else {
        numPart = numPart.replace(',', '.');
      }
    }
  }

  let val = parseFloat(numPart);
  if (isNaN(val)) return null;

  if (unit === 'tỷ' || unit === 'ty' || unit === 'b') val *= 1e9;
  else if (unit === 'triệu' || unit === 'trieu' || unit === 'tr' || unit === 'm') val *= 1e6;
  else if (unit === 'nghìn' || unit === 'ngan' || unit === 'k') val *= 1e3;

  return val;
}

function calculateLoan(queryText) {
  const q = String(queryText || '').toLowerCase();

  // 1. Trích xuất số tiền vay (Principal)
  let principal = null;
  const pMatch = q.match(/(?:vay|khoản\s+vay|mượn|vay\s+vốn|số\s+tiền|gốc)\s+(?:là\s+)?([0-9]+(?:[.,][0-9]+)*\s*(?:tỷ|triệu|tr|nghìn|k|đ|vnd|đồng)?)/i) ||
                 q.match(/([0-9]+(?:[.,][0-9]+)*\s*(?:tỷ|triệu|tr))\s+(?:với|lãi)/i);
  if (pMatch) {
    principal = parseVietnameseAmount(pMatch[1]);
  }

  // 2. Trích xuất lãi suất (Interest Rate %/năm hoặc %/tháng)
  let annualRate = null;
  const rMatch = q.match(/(?:lãi\s+suất|lãi)\s+(?:là\s+)?(\d+(?:[.,]\d+)?)\s*%\s*(?:\/\s*(?:năm|tháng)|mỗi\s*(?:năm|tháng)|năm|tháng)?/i) ||
                 q.match(/(\d+(?:[.,]\d+)?)\s*%\s*(?:\/\s*năm|hàng\s*năm|\s*năm)?/i);
  if (rMatch) {
    annualRate = parseFloat(rMatch[1].replace(',', '.'));
    if (/tháng|mỗi\s*tháng|\/\s*tháng/i.test(rMatch[0])) {
      annualRate *= 12; // chuyển lãi suất tháng thành năm
    }
  }

  // 3. Trích xuất thời hạn vay (Term months / years)
  let months = null;
  const tMatch = q.match(/(?:thời\s+gian|kỳ\s+hạn|trong\s+vòng|trong|hạn)\s+(\d+(?:[.,]\d+)?)\s*(năm|tháng)/i) ||
                 q.match(/(\d+)\s*(năm|tháng)/i);
  if (tMatch) {
    const num = parseFloat(tMatch[1].replace(',', '.'));
    const unit = tMatch[2].toLowerCase();
    if (unit.startsWith('năm')) {
      months = Math.round(num * 12);
    } else {
      months = Math.round(num);
    }
  }

  if (!principal || !annualRate || !months) {
    return {
      success: false,
      missing: {
        principal: !principal,
        annualRate: !annualRate,
        months: !months
      },
      parsed: { principal, annualRate, months }
    };
  }

  const r = annualRate / 100 / 12; // lãi suất tháng
  const n = months;

  // Phương pháp 1: Lãi trên dư nợ gốc ban đầu (Lãi phẳng)
  const flatMonthlyInterest = principal * r;
  const flatMonthlyPrincipal = principal / n;
  const flatMonthlyPayment = flatMonthlyPrincipal + flatMonthlyInterest;
  const flatTotalInterest = flatMonthlyInterest * n;
  const flatTotalPayment = principal + flatTotalInterest;

  // Phương pháp 2: Lãi trên dư nợ giảm dần (Gốc chia đều, lãi giảm dần)
  const reducingMonthlyPrincipal = principal / n;
  const reducingMonth1Interest = principal * r;
  const reducingMonth1Total = reducingMonthlyPrincipal + reducingMonth1Interest;
  const reducingLastMonthInterest = reducingMonthlyPrincipal * r;
  const reducingLastMonthTotal = reducingMonthlyPrincipal + reducingLastMonthInterest;
  const reducingTotalInterest = (principal * (n + 1) / 2) * r;
  const reducingTotalPayment = principal + reducingTotalInterest;

  // Phương pháp 3: Trả góp đều hàng tháng (Niên kim cố định - PMT)
  const pmt = r > 0 ? (principal * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1) : principal / n;
  const pmtTotalPayment = pmt * n;
  const pmtTotalInterest = pmtTotalPayment - principal;

  return {
    success: true,
    principal,
    annualRate,
    months,
    years: Math.round((months / 12) * 10) / 10,
    flat: {
      monthlyPrincipal: flatMonthlyPrincipal,
      monthlyInterest: flatMonthlyInterest,
      monthlyPayment: flatMonthlyPayment,
      totalInterest: flatTotalInterest,
      totalPayment: flatTotalPayment
    },
    reducingLinear: {
      monthlyPrincipal: reducingMonthlyPrincipal,
      month1Interest: reducingMonth1Interest,
      month1Total: reducingMonth1Total,
      lastMonthInterest: reducingLastMonthInterest,
      lastMonthTotal: reducingLastMonthTotal,
      totalInterest: reducingTotalInterest,
      totalPayment: reducingTotalPayment
    },
    annuityPmt: {
      monthlyPayment: pmt,
      totalInterest: pmtTotalInterest,
      totalPayment: pmtTotalPayment
    }
  };
}

/* =========================================================================
   4. UNIT CONVERTER
   ========================================================================= */

const UNIT_GROUPS = {
  length: {
    name: 'Độ dài',
    base: 'm',
    units: {
      'mm': 0.001, 'milimét': 0.001, 'milimet': 0.001,
      'cm': 0.01, 'centimét': 0.01, 'centimet': 0.01,
      'dm': 0.1, 'đêximét': 0.1,
      'm': 1, 'mét': 1, 'met': 1,
      'km': 1000, 'kilômét': 1000, 'kilomet': 1000, 'cây số': 1000,
      'inch': 0.0254, 'in': 0.0254,
      'foot': 0.3048, 'ft': 0.3048, 'feet': 0.3048,
      'yard': 0.9144, 'yd': 0.9144,
      'mile': 1609.344, 'dặm': 1609.344, 'dam': 1609.344,
      'hải lý': 1852, 'nautical mile': 1852
    }
  },
  weight: {
    name: 'Khối lượng',
    base: 'kg',
    units: {
      'mg': 0.000001,
      'g': 0.001, 'gam': 0.001, 'gram': 0.001,
      'kg': 1, 'kilôgam': 1, 'kilogam': 1, 'ký': 1, 'ky': 1,
      'yến': 10, 'yen': 10,
      'tạ': 100, 'ta': 100,
      'tấn': 1000, 'tan': 1000, 'ton': 1000,
      'lb': 0.45359237, 'pound': 0.45359237, 'lbs': 0.45359237,
      'oz': 0.0283495, 'ounce': 0.0283495
    }
  },
  volume: {
    name: 'Thể tích & Dung tích',
    base: 'lít',
    units: {
      'ml': 0.001, 'mililít': 0.001,
      'l': 1, 'lít': 1, 'lit': 1, 'liter': 1,
      'm3': 1000, 'm³': 1000, 'mét khối': 1000, 'met khoi': 1000, 'cbm': 1000,
      'gallon': 3.78541, 'gal': 3.78541
    }
  },
  area: {
    name: 'Diện tích',
    base: 'm²',
    units: {
      'cm2': 0.0001, 'cm²': 0.0001,
      'm2': 1, 'm²': 1, 'mét vuông': 1, 'met vuong': 1,
      'km2': 1000000, 'km²': 1000000, 'kilômét vuông': 1000000,
      'ha': 10000, 'hecta': 10000, 'héc-ta': 10000,
      'sào': 360, 'sào bắc bộ': 360,
      'mẫu': 3600,
      'sqft': 0.092903, 'ft2': 0.092903, 'ft²': 0.092903,
      'acre': 4046.86
    }
  },
  speed: {
    name: 'Tốc độ',
    base: 'km/h',
    units: {
      'km/h': 1, 'kmh': 1,
      'm/s': 3.6,
      'mph': 1.60934,
      'knot': 1.852, 'hải lý/giờ': 1.852
    }
  },
  data: {
    name: 'Dung lượng dữ liệu',
    base: 'MB',
    units: {
      'b': 1 / (1024 * 1024), 'byte': 1 / (1024 * 1024),
      'kb': 1 / 1024,
      'mb': 1,
      'gb': 1024,
      'tb': 1024 * 1024
    }
  }
};

function convertUnit(queryText) {
  const q = String(queryText || '').toLowerCase().trim();

  // 1. Chuyển đổi nhiệt độ riêng (°C, °F, K)
  const tempMatch = q.match(/(-?\d+(?:[.,]\d+)?)\s*(?:độ\s*)?(c|f|k|°c|°f)\s+(?:sang|bằng|ra|đổi\s*sang)\s*(?:độ\s*)?(c|f|k|°c|°f)/i);
  if (tempMatch) {
    const val = parseFloat(tempMatch[1].replace(',', '.'));
    const fromUnit = tempMatch[2].replace('°', '').toUpperCase();
    const toUnit = tempMatch[3].replace('°', '').toUpperCase();

    let cVal = val;
    if (fromUnit === 'F') cVal = (val - 32) * 5 / 9;
    else if (fromUnit === 'K') cVal = val - 273.15;

    let res = cVal;
    if (toUnit === 'F') res = (cVal * 9 / 5) + 32;
    else if (toUnit === 'K') res = cVal + 273.15;

    return {
      success: true,
      category: 'Nhiệt độ',
      fromValue: val,
      fromUnit: '°' + fromUnit,
      toValue: Math.round(res * 100) / 100,
      toUnit: '°' + toUnit,
      explanation: `${val}°${fromUnit} = ${formatNumberVN(res, 2)}°${toUnit}`
    };
  }

  // 2. Chuyển đổi các đơn vị đo lường khác: X [unit1] bằng/sang/ra bao nhiêu [unit2]
  const unitMatch = q.match(/(\d+(?:[.,]\d+)?)\s*([a-z\u00C0-\u024F\u1EA0-\u1EF9³²\/]+)\s+(?:bằng|sang|đổi\s*sang|quy\s*ra|ra)\s+(?:bao\s+nhiêu\s+)?([a-z\u00C0-\u024F\u1EA0-\u1EF9³²\/]+)/i);
  if (unitMatch) {
    const val = parseFloat(unitMatch[1].replace(',', '.'));
    const u1 = unitMatch[2].trim().toLowerCase();
    const u2 = unitMatch[3].trim().toLowerCase();

    for (const [catKey, cat] of Object.entries(UNIT_GROUPS)) {
      if (cat.units[u1] !== undefined && cat.units[u2] !== undefined) {
        const baseVal = val * cat.units[u1];
        const resVal = baseVal / cat.units[u2];
        const rounded = Math.round(resVal * 1e6) / 1e6;

        return {
          success: true,
          category: cat.name,
          fromValue: val,
          fromUnit: u1,
          toValue: rounded,
          toUnit: u2,
          explanation: `${formatNumberVN(val)} ${u1} = ${formatNumberVN(rounded, 4)} ${u2}`
        };
      }
    }
  }

  return null;
}

/* =========================================================================
   5. DATE & TIME CALCULATOR
   ========================================================================= */

function parseVNDate(str) {
  if (!str) return null;
  const s = String(str).trim();

  // Match: DD/MM/YYYY hoặc DD-MM-YYYY
  const m1 = s.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/);
  if (m1) {
    return new Date(parseInt(m1[3], 10), parseInt(m1[2], 10) - 1, parseInt(m1[1], 10));
  }

  // Match: ngày D tháng M năm YYYY
  const m2 = s.match(/(?:ngày\s+)?(\d{1,2})\s+tháng\s+(\d{1,2})(?:\s+năm\s+(\d{4}))?/i);
  if (m2) {
    const y = m2[3] ? parseInt(m2[3], 10) : 2026;
    return new Date(y, parseInt(m2[2], 10) - 1, parseInt(m2[1], 10));
  }

  return null;
}

const VN_WEEKDAYS = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];

function calculateDateAndTime(queryText) {
  const q = String(queryText || '').toLowerCase().trim();
  const nowVN = new Date(Date.now() + 7 * 3600 * 1000);
  const currentYear = nowVN.getUTCFullYear();
  const currentMonth = nowVN.getUTCMonth() + 1;
  const currentDay = nowVN.getUTCDate();
  const currentHours = nowVN.getUTCHours();
  const currentMins = nowVN.getUTCMinutes();
  const currentDayOfWeek = VN_WEEKDAYS[nowVN.getUTCDay()];
  const currentDateStr = `${String(currentDay).padStart(2, '0')}/${String(currentMonth).padStart(2, '0')}/${currentYear}`;
  const currentTimeStr = `${String(currentHours).padStart(2, '0')}:${String(currentMins).padStart(2, '0')}`;

  // 0. Hỏi về ngày, giờ, thứ hiện tại (Hôm nay, bây giờ, thời gian hiện tại)
  if (/(?:hôm\s+nay|bây\s+giờ|hiện\s+tại)\s+(?:là\s+)?(?:thứ\s+mấy|ngày\s+mấy|ngày\s+bao\s+nhiêu|mấy\s+giờ|thời\s+gian)/i.test(q) ||
      /^(?:hôm\s+nay\s+là\s+thứ\s+mấy|hôm\s+nay\s+ngày\s+mấy|bây\s+giờ\s+là\s+mấy\s+giờ|mấy\s+giờ\s+rồi)\??$/i.test(q) ||
      /(thời\s+gian\s+hiện\s+tại|ngày\s+tháng\s+năm\s+hiện\s+tại)/i.test(q)) {
    return {
      type: 'CURRENT_DATETIME',
      date: currentDateStr,
      dayName: currentDayOfWeek,
      time: currentTimeStr,
      year: currentYear,
      explanation: `Thời điểm hiện tại (giờ Việt Nam UTC+7): ${currentDayOfWeek}, ngày ${currentDateStr} (lúc ${currentTimeStr}).`
    };
  }

  // 0b. Ngày mai là ngày mấy, thứ mấy
  if (/ngày\s+mai\s+(?:là\s+)?(?:thứ\s+mấy|ngày\s+mấy|ngày\s+bao\s+nhiêu)/i.test(q)) {
    const tomVN = new Date(nowVN.getTime() + 24 * 3600 * 1000);
    const tomDay = String(tomVN.getUTCDate()).padStart(2, '0');
    const tomMonth = String(tomVN.getUTCMonth() + 1).padStart(2, '0');
    const tomYear = tomVN.getUTCFullYear();
    const tomDayName = VN_WEEKDAYS[tomVN.getUTCDay()];
    const tomDateStr = `${tomDay}/${tomMonth}/${tomYear}`;
    return {
      type: 'TOMORROW_DATETIME',
      date: tomDateStr,
      dayName: tomDayName,
      explanation: `Ngày mai là ${tomDayName}, ngày ${tomDateStr}.`
    };
  }

  // 0c. Hôm qua là ngày mấy, thứ mấy
  if (/hôm\s+qua\s+(?:là\s+)?(?:thứ\s+mấy|ngày\s+mấy|ngày\s+bao\s+nhiêu)/i.test(q)) {
    const yestVN = new Date(nowVN.getTime() - 24 * 3600 * 1000);
    const yestDay = String(yestVN.getUTCDate()).padStart(2, '0');
    const yestMonth = String(yestVN.getUTCMonth() + 1).padStart(2, '0');
    const yestYear = yestVN.getUTCFullYear();
    const yestDayName = VN_WEEKDAYS[yestVN.getUTCDay()];
    const yestDateStr = `${yestDay}/${yestMonth}/${yestYear}`;
    return {
      type: 'YESTERDAY_DATETIME',
      date: yestDateStr,
      dayName: yestDayName,
      explanation: `Hôm qua là ${yestDayName}, ngày ${yestDateStr}.`
    };
  }

  // 1. Tính tuổi: "sinh năm 1995 tính đến nay bao nhiêu tuổi"
  const ageMatch = q.match(/(?:sinh\s+năm|sinh)\s+(\d{4})/i);
  if (ageMatch && /(tuổi|bao\s+nhiêu\s+tuổi|tính\s+tuổi)/i.test(q)) {
    const birthYear = parseInt(ageMatch[1], 10);
    const age = currentYear - birthYear;
    return {
      type: 'AGE_CALCULATION',
      birthYear,
      currentYear,
      age,
      explanation: `Người sinh năm ${birthYear} tính đến năm hiện tại (${currentYear}) là ${age} tuổi.`
    };
  }

  // 2. Tính ngày trong tuần: "ngày 30/04/2026 là thứ mấy"
  if (/(thứ\s+mấy|vào\s+thứ\s+mấy)/i.test(q)) {
    const d = parseVNDate(q);
    if (d && !isNaN(d.getTime())) {
      const dayName = VN_WEEKDAYS[d.getDay()];
      const dStr = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
      return {
        type: 'DAY_OF_WEEK',
        date: dStr,
        dayName,
        explanation: `Ngày ${dStr} rơi vào ${dayName}.`
      };
    }
  }

  // 3. Khoảng cách giữa 2 ngày: "từ 01/01/2026 đến 30/04/2026 là bao nhiêu ngày"
  const rangeMatch = q.match(/từ\s+(.+?)\s+(?:đến|tới)\s+(.+?)(?:\s+là\s+bao\s+nhiêu\s+ngày|\s+bao\s+xa|\?|$)/i);
  if (rangeMatch) {
    const d1 = parseVNDate(rangeMatch[1]);
    const d2 = parseVNDate(rangeMatch[2]);
    if (d1 && d2 && !isNaN(d1.getTime()) && !isNaN(d2.getTime())) {
      const diffTime = Math.abs(d2.getTime() - d1.getTime());
      const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
      const diffWeeks = Math.round((diffDays / 7) * 10) / 10;

      // Đếm số ngày làm việc (không tính Thứ Bảy và Chủ Nhật)
      let cur = new Date(Math.min(d1.getTime(), d2.getTime()));
      const target = new Date(Math.max(d1.getTime(), d2.getTime()));
      let workingDays = 0;
      while (cur <= target) {
        const day = cur.getDay();
        if (day !== 0 && day !== 6) workingDays++;
        cur.setDate(cur.getDate() + 1);
      }

      const s1 = `${String(d1.getDate()).padStart(2, '0')}/${String(d1.getMonth() + 1).padStart(2, '0')}/${d1.getFullYear()}`;
      const s2 = `${String(d2.getDate()).padStart(2, '0')}/${String(d2.getMonth() + 1).padStart(2, '0')}/${d2.getFullYear()}`;

      return {
        type: 'DATE_RANGE',
        startDate: s1,
        endDate: s2,
        totalDays: diffDays,
        workingDays,
        weeks: diffWeeks,
        explanation: `Khoảng cách từ ngày ${s1} đến ngày ${s2}: ${diffDays} ngày (khoảng ${diffWeeks} tuần, trong đó có ${workingDays} ngày làm việc không tính T7/CN).`
      };
    }
  }

  // 4. Cộng trừ ngày tháng: "ngày 15/05/2026 sau 45 ngày là ngày nào" hoặc "cộng thêm 30 ngày"
  const addMatch = q.match(/(?:ngày\s+)?(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{4})\s*(?:sau|cộng\s+thêm|\+)\s*(\d+)\s*(ngày|tháng|năm)/i);
  if (addMatch) {
    const baseDate = parseVNDate(addMatch[1]);
    const num = parseInt(addMatch[2], 10);
    const unit = addMatch[3];

    if (baseDate && !isNaN(baseDate.getTime())) {
      const resDate = new Date(baseDate.getTime());
      if (unit === 'ngày') resDate.setDate(resDate.getDate() + num);
      else if (unit === 'tháng') resDate.setMonth(resDate.getMonth() + num);
      else if (unit === 'năm') resDate.setFullYear(resDate.getFullYear() + num);

      const dStr = `${String(resDate.getDate()).padStart(2, '0')}/${String(resDate.getMonth() + 1).padStart(2, '0')}/${resDate.getFullYear()}`;
      const dayName = VN_WEEKDAYS[resDate.getDay()];
      return {
        type: 'DATE_ADD',
        baseDate: addMatch[1],
        added: `${num} ${unit}`,
        resultDate: dStr,
        dayName,
        explanation: `Từ ngày ${addMatch[1]} sau ${num} ${unit} là ngày ${dStr} (${dayName}).`
      };
    }
  }

  return null;
}

/* =========================================================================
   6. MASTER DISPATCHER: RESOLVE CALCULATION & BUILD GROUNDING PROMPT
   ========================================================================= */

function isCalculationQuery(text) {
  if (!text) return false;
  const q = text.toLowerCase().trim();

  // 1. Phép tính số học / biểu thức
  if (/^(?:tính\s+|kết\s+quả\s+của\s+|giá\s+trị\s+biểu\s+thức\s+)?[-0-9\s.,()+*\/xX×:÷^%sqrtabsfloorceilround]+$/i.test(q) &&
      /[0-9]/.test(q) && /[+*\/xX×:÷^%]|sqrt|abs/.test(q)) {
    return true;
  }
  if (/(?:tính|bằng\s+bao\s+nhiêu|kết\s+quả\s+của)\s+[-0-9\s.,()+*\/xX×:÷^%]+/i.test(q) && /[+*\/xX×:÷^%]/.test(q)) {
    return true;
  }

  // 2. Phần trăm, tỷ lệ
  if (/(?:%|phần\s+trăm)\s+của\s+\d+/i.test(q) ||
      /\d+\s+tăng\s+\d+\s*%/i.test(q) ||
      /\d+\s+giảm\s+\d+\s*%/i.test(q) ||
      /tỷ\s+lệ\s+(?:tăng\s+trưởng|thay\s+đổi|chênh\s+lệch)/i.test(q) ||
      /chiếm\s+bao\s+nhiêu\s*(?:%|phần\s+trăm)/i.test(q)) {
    return true;
  }

  // 3. Lãi vay, tài chính
  if (/(?:lãi\s+suất|vay\s+ngân\s+hàng|vay\s+vốn|trả\s+góp|khoản\s+vay|tiền\s+lãi\s+hàng\s+tháng)/i.test(q) &&
      /(?:\d+\s*(?:triệu|tỷ|tr|nghìn|vnd|đ|%)|\d+\s*năm|\d+\s*tháng)/i.test(q)) {
    return true;
  }

  // 4. Đổi đơn vị
  if (/(?:đổi|quy\s+đổi|bằng\s+bao\s+nhiêu|ra\s+bao\s+nhiêu)\s+(?:kg|tấn|m|km|inch|feet|yard|lít|cbm|m3|m²|ha|°c|°f|gb|mb)/i.test(q) ||
      /\d+\s*(?:km|m|cm|mm|kg|tấn|tạ|yến|g|lb|pound|lít|cbm|m3|m²|ha|°c|°f|gb|mb)\s+(?:bằng|sang|đổi|ra)\s+/i.test(q)) {
    return true;
  }

  // 5. Ngày tháng & Thời gian thực tế
  if (/(?:bao\s+nhiêu\s+ngày|thứ\s+mấy|sinh\s+năm\s+\d{4}\s+.*tuổi|sau\s+\d+\s+ngày|hôm\s+nay\s+.*(?:thứ|ngày)|ngày\s+mai\s+.*(?:thứ|ngày)|hôm\s+qua\s+.*(?:thứ|ngày)|bây\s+giờ\s+.*mấy\s+giờ|mấy\s+giờ\s+rồi)/i.test(q)) {
    return true;
  }

  return false;
}

function resolveCalculation(queryText) {
  if (!queryText) return null;
  const q = String(queryText).trim();

  // 1. Thử Lãi vay ngân hàng
  const loan = calculateLoan(q);
  if (loan && loan.success) {
    const flat = loan.flat;
    const red = loan.reducingLinear;
    const pmt = loan.annuityPmt;

    const contextPrompt = `\n\n[KẾT QUẢ TÍNH TOÁN LÃI VAY CHUẨN XÁC TỪ ENGINE TÀI CHÍNH]:
- Khoản vay gốc: ${formatNumberVN(loan.principal)} VND
- Lãi suất: ${loan.annualRate}%/năm
- Thời hạn vay: ${loan.months} tháng (${loan.years} năm)

1. PHƯƠNG PHÁP 1: LÃI TRÊN DƯ NỢ GỐC BAN ĐẦU (LÃI PHẲNG)
   - Tiền gốc trả hàng tháng: ${formatNumberVN(flat.monthlyPrincipal)} VND
   - Tiền lãi trả hàng tháng: ${formatNumberVN(flat.monthlyInterest)} VND
   - Tổng tiền phải trả mỗi tháng (cố định): ${formatNumberVN(flat.monthlyPayment)} VND
   - Tổng tiền lãi cả kỳ: ${formatNumberVN(flat.totalInterest)} VND
   - Tổng số tiền phải trả (Gốc + Lãi): ${formatNumberVN(flat.totalPayment)} VND

2. PHƯƠNG PHÁP 2: LÃI TRÊN DƯ NỢ GIẢM DẦN (GỐC CHIA ĐỀU)
   - Tiền gốc trả hàng tháng: ${formatNumberVN(red.monthlyPrincipal)} VND
   - Tháng đầu tiên thanh toán: ${formatNumberVN(red.month1Total)} VND (Gốc: ${formatNumberVN(red.monthlyPrincipal)} + Lãi: ${formatNumberVN(red.month1Interest)})
   - Tháng cuối cùng thanh toán: ${formatNumberVN(red.lastMonthTotal)} VND (Gốc: ${formatNumberVN(red.monthlyPrincipal)} + Lãi: ${formatNumberVN(red.lastMonthInterest)})
   - Tổng tiền lãi cả kỳ: ${formatNumberVN(red.totalInterest)} VND
   - Tổng số tiền phải trả (Gốc + Lãi): ${formatNumberVN(red.totalPayment)} VND

3. PHƯƠNG PHÁP 3: TRẢ GÓP ĐỀU HÀNG THÁNG (NIÊN KIM CỐ ĐỊNH / ANNUITY)
   - Số tiền thanh toán đều mỗi tháng: ${formatNumberVN(pmt.monthlyPayment)} VND
   - Tổng tiền lãi cả kỳ: ${formatNumberVN(pmt.totalInterest)} VND
   - Tổng số tiền phải trả (Gốc + Lãi): ${formatNumberVN(pmt.totalPayment)} VND

HƯỚNG DẪN TRẢ LỜI:
- BẮT BUỘC trình bày kết quả rõ ràng, minh bạch cho người dùng cả 2 phương pháp phổ biến nhất tại Việt Nam (Lãi phẳng và Dư nợ giảm dần).
- Nêu rõ sự chênh lệch tiền lãi giữa 2 phương pháp (phương pháp dư nợ giảm dần giúp tiết kiệm được ${formatNumberVN(flat.totalInterest - red.totalInterest)} VND tiền lãi).
- Trình bày dạng bảng tóm tắt so sánh đẹp mắt.`;

    return {
      type: 'LOAN_CALCULATION',
      data: loan,
      contextPrompt,
      sources: []
    };
  }

  // 1b. Xử lý trường hợp hỏi vay nhưng thiếu thông tin đầu vào (Abstention on Incomplete Loan Query)
  if (loan && !loan.success && loan.parsed && (loan.parsed.principal || loan.parsed.annualRate)) {
    const pStr = loan.parsed.principal ? `${formatNumberVN(loan.parsed.principal)} VND` : 'Chưa cung cấp';
    const rStr = loan.parsed.annualRate ? `${loan.parsed.annualRate}%/năm` : 'Chưa cung cấp';
    const missingItems = [];
    if (loan.missing.principal) missingItems.push('Số tiền vay');
    if (loan.missing.annualRate) missingItems.push('Mức lãi suất');
    if (loan.missing.months) missingItems.push('Thời hạn vay (số năm hoặc số tháng vay)');

    const contextPrompt = `\n\n[HƯỚNG DẪN XỬ LÝ: THIẾU THÔNG TIN ĐẦU VÀO ĐỂ TÍNH TOÁN LÃI VAY]:
- Dữ liệu đã nhận diện được:
  + Khoản tiền vay gốc: ${pStr}
  + Mức lãi suất: ${rStr}
- Thông tin BẮT BUỘC còn thiếu để tính ra số tiền trả mỗi tháng: ${missingItems.join(', ')}

HƯỚNG DẪN TRẢ LỜI CHO TRỢ LÝ:
1. NÊU RÕ ĐIỀU KIỆN THIẾU: Trả lời rõ ràng, lịch sự và chỉ ra cho người dùng biết để tính được số tiền chính xác phải trả hàng tháng, cần có thêm thông tin về: ${missingItems.join(', ')}.
2. TUYỆT ĐỐI KHÔNG TỰ BỊA ĐẶT thời hạn vay mặc định như thể người dùng đã yêu cầu.
3. CUNG CẤP VÍ DỤ MINH HỌA GIẢ ĐỊNH: Nếu đã có khoản vay và lãi suất, trợ lý có thể đưa ra ví dụ minh họa với thời hạn vay phổ biến (ví dụ: giả định vay trong 1 năm / 12 tháng hoặc 5 năm / 60 tháng) nhưng BẮT BUỘC phải nêu rõ đây là giả định để người dùng tham khảo.`;

    return {
      type: 'LOAN_INCOMPLETE_INPUT',
      data: loan,
      contextPrompt,
      sources: []
    };
  }

  // 2. Thử Phần trăm & Tỷ lệ
  const pct = calculatePercentage(q);
  if (pct) {
    const contextPrompt = `\n\n[KẾT QUẢ TÍNH TOÁN PHẦN TRĂM CHUẨN XÁC TỪ ENGINE TOÁN HỌC]:
- Loại phép tính: ${pct.type}
- Kết quả chính xác: ${pct.explanation}

HƯỚNG DẪN TRẢ LỜI:
- Nêu ngay kết quả chính xác ngay từ câu đầu tiên.
- Trình bày công thức tính ngắn gọn để người dùng tiện theo dõi.`;

    return {
      type: 'PERCENTAGE_CALCULATION',
      data: pct,
      contextPrompt,
      sources: []
    };
  }

  // 3. Thử Đổi đơn vị đo lường
  const unit = convertUnit(q);
  if (unit && unit.success) {
    const contextPrompt = `\n\n[KẾT QUẢ CHUYỂN ĐỔI ĐƠN VỊ ĐO LƯỜNG CHUẨN XÁC]:
- Danh mục: ${unit.category}
- Kết quả quy đổi: ${unit.explanation}

HƯỚNG DẪN TRẢ LỜI:
- Trả lời thẳng vào kết quả quy đổi chính xác ngay câu đầu tiên.`;

    return {
      type: 'UNIT_CONVERSION',
      data: unit,
      contextPrompt,
      sources: []
    };
  }

  // 4. Thử Ngày tháng & Khoảng thời gian
  const dt = calculateDateAndTime(q);
  if (dt) {
    const contextPrompt = `\n\n[KẾT QUẢ TÍNH TOÁN NGÀY THÁNG & THỜI GIAN THỰC TẾ]:
- Loại tính toán: ${dt.type}
- Kết quả xác thực: ${dt.explanation}

HƯỚNG DẪN TRẢ LỜI CHO TRỢ LÝ:
- Nêu ngay kết quả chính xác ngay từ câu đầu tiên (ví dụ: "${dt.explanation}").
- TUYỆT ĐỐI KHÔNG tự tạo liên kết dẫn nguồn đến các trang web bên ngoài cho thông tin thời gian hiện tại.`;

    return {
      type: 'DATE_TIME_CALCULATION',
      data: dt,
      contextPrompt,
      sources: []
    };
  }

  // 5. Thử Biểu thức số học an toàn (Bỏ qua nếu câu hỏi là về vay vốn / lãi suất)
  if (/(?:vay\s+vốn|khoản\s+vay|trả\s+góp|lãi\s+suất)/i.test(q)) {
    return null;
  }

  // Trích xuất biểu thức số học từ câu hỏi: vd "Tính 123 * 456 + 789" -> "123 * 456 + 789"
  let cleanExpr = q
    .replace(/(?:tính\s+giá\s+trị\s+biểu\s+thức|tính\s+biểu\s+thức|tính|kết\s+quả\s+của|bằng\s+bao\s+nhiêu|\?|=)/gi, '')
    .trim();

  if (cleanExpr && /[0-9]/.test(cleanExpr) && /[+*\/xX×:÷^%]|sqrt|abs/.test(cleanExpr)) {
    const mathRes = safeEvalMath(cleanExpr);
    if (mathRes && mathRes.success) {
      const contextPrompt = `\n\n[KẾT QUẢ TÍNH TOÁN BIỂU THỨC SỐ HỌC CHUẨN XÁC]:
- Biểu thức: ${mathRes.expression}
- Kết quả chính xác: ${mathRes.formattedResult} (Giá trị số: ${mathRes.result})

HƯỚNG DẪN TRẢ LỜI:
- Nêu ngay kết quả ${mathRes.expression} = ${mathRes.formattedResult}.`;

      return {
        type: 'MATH_EXPRESSION',
        data: mathRes,
        contextPrompt,
        sources: []
      };
    } else if (mathRes && !mathRes.success && mathRes.error) {
      const contextPrompt = `\n\n[LƯU Ý LỖI PHÉP TÍNH TOÁN HỌC]:
- Biểu thức người dùng nhập: ${cleanExpr}
- Lỗi phát sinh: ${mathRes.error}

HƯỚNG DẪN TRẢ LỜI:
- Giải thích rõ ràng lỗi toán học cho người dùng (ví dụ: không thể chia cho 0 hoặc căn bậc hai của số âm).`;

      return {
        type: 'MATH_EXPRESSION_ERROR',
        data: mathRes,
        contextPrompt,
        sources: []
      };
    }
  }

  return null;
}

module.exports = {
  safeEvalMath,
  calculatePercentage,
  calculateLoan,
  convertUnit,
  calculateDateAndTime,
  isCalculationQuery,
  resolveCalculation,
  formatNumberVN
};
