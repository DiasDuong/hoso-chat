const https = require('https');
const { TOOL_DECLARATIONS, executeTool } = require('./toolRegistry');
const { verifyAndRefineAnswer } = require('./answerQualityEnhancer');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

/**
 * Gọi Gemini Generate Content với Function Calling
 */
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

/**
 * Danh sách mô hình Gemini dự phòng theo thứ tự ưu tiên
 */
const DEFAULT_FALLBACK_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-3.8-flash'
];

function callGeminiWithTools(contents, systemInstruction, tools, options = {}) {
  const apiKey = process.env.GEMINI_API_KEY || GEMINI_API_KEY;
  const preferredModel = options.model_name || options.model;
  const candidateModels = preferredModel
    ? [preferredModel, ...DEFAULT_FALLBACK_MODELS.filter(m => m !== preferredModel)]
    : DEFAULT_FALLBACK_MODELS;

  const temperature = typeof options.temperature === 'number' ? options.temperature : 0.2;
  const signal = options.signal || null;
  const timeoutMs = options.timeout || 30000;

  return (async () => {
    let lastError = null;

    // Cho phép tối đa 2 vòng thử để tự động vượt qua các đợt gián đoạn tức thời (High Demand / Spikes)
    for (let pass = 0; pass < 2; pass++) {
      if (pass > 0) {
        console.log('[AgentOrchestrator] Tự động thử lại chuỗi mô hình dự phòng sau 2 giây...');
        await new Promise(r => setTimeout(r, 2000));
      }

      for (let i = 0; i < candidateModels.length; i++) {
        const model = candidateModels[i];
        if (signal && signal.aborted) {
          throw new Error('Tác vụ bị dừng bởi người dùng.');
        }

        try {
          const result = await new Promise((resolve, reject) => {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

            const payload = {
              systemInstruction: {
                parts: [{ text: systemInstruction }]
              },
              contents: normalizeGeminiContents(contents),
              generationConfig: {
                temperature,
                topP: 0.95,
                maxOutputTokens: options.maxOutputTokens || 4096,
              }
            };

            if (Array.isArray(tools) && tools.length > 0) {
              payload.tools = [{ functionDeclarations: tools }];
            }

            const postData = JSON.stringify(payload);
            const req = https.request(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey,
              },
              timeout: timeoutMs,
            }, (res) => {
              const chunks = [];
              res.on('data', chunk => chunks.push(chunk));
              res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf-8');
                if (res.statusCode < 200 || res.statusCode >= 300) {
                  try {
                    const errJson = JSON.parse(raw);
                    const msg = errJson.error?.message || `Gemini API HTTP ${res.statusCode} on model ${model}`;
                    const err = new Error(msg);
                    err.statusCode = res.statusCode;
                    err.model = model;
                    return reject(err);
                  } catch (e) {
                    const err = new Error(`Gemini API HTTP ${res.statusCode} on model ${model}: ${raw.slice(0, 200)}`);
                    err.statusCode = res.statusCode;
                    err.model = model;
                    return reject(err);
                  }
                }
                try {
                  const parsed = JSON.parse(raw);
                  const candidate = parsed.candidates?.[0];
                  const parts = candidate?.content?.parts || [];
                  const functionCall = parts.find(p => p.functionCall)?.functionCall || null;
                  const textPart = parts.find(p => p.text)?.text || '';
                  resolve({
                    functionCall,
                    text: textPart,
                    raw: parsed,
                    parts,
                    usedModel: model
                  });
                } catch (e) {
                  reject(new Error(`Lỗi giải mã phản hồi từ AI trên model ${model}: ` + e.message));
                }
              });
            });

            req.on('timeout', () => {
              req.destroy();
              const err = new Error(`Timeout chờ Gemini API trên model ${model} (${Math.round(timeoutMs / 1000)}s).`);
              err.isTimeout = true;
              err.model = model;
              reject(err);
            });

            req.on('error', err => {
              const errObj = new Error(`Lỗi kết nối Gemini trên model ${model}: ` + err.message);
              errObj.model = model;
              reject(errObj);
            });

            req.write(postData);
            req.end();
          });

          if (preferredModel && result.usedModel !== preferredModel) {
            console.log(`[AgentOrchestrator] Model chính "${preferredModel}" gặp sự cố. Đã tự động Fallback thành công sang model dự phòng "${result.usedModel}".`);
          }

          return result;
        } catch (err) {
          lastError = err;
          console.warn(`[AgentOrchestrator] Model "${model}" thất bại (${err.message}). ${i < candidateModels.length - 1 ? 'Đang chuyển model tiếp theo trong chuỗi dự phòng...' : 'Đã thử hết toàn bộ model dự phòng.'}`);

          if (signal && signal.aborted) {
            throw err;
          }

          if (i < candidateModels.length - 1) {
            // Nghỉ ngắn trước khi gọi model dự phòng tiếp theo để chống nghẽn và vượt qua các đợt high demand tức thời
            await new Promise(r => setTimeout(r, 1200));
            continue;
          }
        }
      }
    }

    throw lastError || new Error('Tất cả các mô hình Gemini trong chuỗi Fallback đều không phản hồi.');
  })();
}

/**
 * ReAct Orchestrator Core
 * Điều phối vòng lặp đa bước có kiểm soát, tự động ngắt lặp vô tận, kiểm tra quyền và phát sự kiện tiến trình.
 */
async function executeAgentReActLoop(options = {}) {
  const {
    initialContents = [],
    systemInstruction = '',
    agent = {},
    user = {},
    conversationId,
    activeSpreadsheets = [],
    activeFiles = [],
    onEvent = () => {},
    signal = null
  } = options;

  const maxSteps = Math.min(Math.max(1, parseInt(agent.max_steps, 10) || 5), 8);
  const contents = [...initialContents];
  const executionContext = {
    userId: user.user_id,
    agentId: agent.id,
    conversationId,
    activeSpreadsheets,
    activeFiles
  };

  // Lọc tools: Nếu agent có enabled_tools và khớp ít nhất 1 tool trong registry thì dùng danh sách lọc
  let activeTools = TOOL_DECLARATIONS;
  if (Array.isArray(agent.enabled_tools) && agent.enabled_tools.length > 0) {
    const enabledSet = new Set(agent.enabled_tools);
    const matched = TOOL_DECLARATIONS.filter(t => enabledSet.has(t.name));
    if (matched.length > 0) {
      activeTools = matched;
    }
  }

  // Tự động kích hoạt toàn bộ Universal Intelligence Tools cho mọi Agent khi có tệp đính kèm hoặc là các loại Agent chuyên dụng
  const universalToolNames = [
    'search_spreadsheet_data',
    'search_document_sections',
    'get_file_manifest',
    'calculate_spreadsheet_metrics',
    'export_excel_report',
    'web_research'
  ];

  const hasAttachments = (activeFiles && activeFiles.length > 0) || (activeSpreadsheets && activeSpreadsheets.length > 0);
  const isKnowledgeAgent = ['DATA_ANALYST', 'DOC_WRITER', 'GENERAL_ASSISTANT'].includes(agent.agent_type);

  if (hasAttachments || isKnowledgeAgent) {
    for (const utName of universalToolNames) {
      const found = TOOL_DECLARATIONS.find(t => t.name === utName);
      if (found && !activeTools.some(t => t.name === utName)) {
        activeTools.push(found);
      }
    }
  }

  const generatedArtifacts = [];
  let reversedRouteContext = null;
  const seenCalls = new Map();
  let stepCount = 0;
  let finalAnswer = '';
  let lastUsedModel = agent.model_name || 'gemini-3.1-flash-lite';

  while (stepCount < maxSteps) {
    if (signal && signal.aborted) {
      throw new Error('Tác vụ bị dừng bởi người dùng.');
    }

    stepCount++;
    onEvent({
      type: 'step',
      stepNumber: stepCount,
      maxSteps,
      status: 'thinking',
      message: `Bước ${stepCount}/${maxSteps}: Trợ lý đang suy luận và phân tích nhiệm vụ...`
    });

    const stepResponse = await callGeminiWithTools(
      contents,
      systemInstruction,
      activeTools,
      {
        model_name: agent.model_name || 'gemini-3.1-flash-lite',
        temperature: typeof agent.temperature === 'number' ? agent.temperature : 0.2,
        signal
      }
    );

    if (stepResponse.usedModel) {
      lastUsedModel = stepResponse.usedModel;
    }

    // TH1: Mô hình quyết định gọi công cụ (Function Calling)
    if (stepResponse.functionCall) {
      const { name, args } = stepResponse.functionCall;
      const callSignature = `${name}_${JSON.stringify(args)}`;
      const prevCallCount = seenCalls.get(callSignature) || 0;

      // LOOP BREAKER: Nếu gọi cùng 1 tool với tham số giống hệt nhau quá 2 lần
      if (prevCallCount >= 2) {
        onEvent({
          type: 'step',
          stepNumber: stepCount,
          status: 'loop_broken',
          message: `Phát hiện vòng lặp vô tận của công cụ "${name}". Dừng vòng lặp để bảo vệ tài nguyên.`
        });
        break;
      }
      seenCalls.set(callSignature, prevCallCount + 1);

      onEvent({
        type: 'step',
        stepNumber: stepCount,
        status: 'executing_tool',
        toolName: name,
        toolArgs: args,
        message: `Đang thực thi công cụ: ${name}...`
      });

      const toolResult = await executeTool(name, args, executionContext);

      // Nếu phát hiện câu truy vấn hỏi chiều B -> A nhưng bảng tính chỉ có chiều ngược lại A -> B
      if (name === 'search_spreadsheet_data' && toolResult && toolResult.hasReversedRouteOnly) {
        reversedRouteContext = {
          hasReversedRouteOnly: true,
          reversedRouteInfo: {
            requestedOrigin: args.origin || (toolResult.requestedRoute && toolResult.requestedRoute.origin) || '',
            requestedDest: args.destination || (toolResult.requestedRoute && toolResult.requestedRoute.destination) || ''
          }
        };
      }

      // Nếu tool xuất file thành công, ghi nhận artifact
      if (name === 'export_excel_report' && toolResult.success && toolResult.fileId) {
        generatedArtifacts.push(toolResult);
        onEvent({
          type: 'artifact',
          artifact: toolResult
        });
      }

      onEvent({
        type: 'step',
        stepNumber: stepCount,
        status: 'tool_finished',
        toolName: name,
        toolSuccess: toolResult.success,
        message: `Hoàn tất công cụ: ${name}`
      });

      // Bổ sung phản hồi công cụ vào chuỗi hội thoại của Gemini, giữ nguyên toàn bộ original parts (kể cả thoughtSignature)
      contents.push({
        role: 'model',
        parts: stepResponse.parts || [{ functionCall: stepResponse.functionCall }]
      });

      const functionResponsePart = {
        name,
        response: toolResult
      };
      if (stepResponse.functionCall.id) {
        functionResponsePart.id = stepResponse.functionCall.id;
      }

      contents.push({
        role: 'user',
        parts: [{
          functionResponse: functionResponsePart
        }]
      });

      continue;
    }

    // TH2: Mô hình trả về kết quả cuối cùng (Final text response)
    if (stepResponse.text) {
      // GROUNDING INTERCEPTION: Nếu Agent có kết nối bảng tính và người dùng đang hỏi về báo giá/số liệu/tuyến đường,
      // nhưng ở bước đầu tiên mô hình chưa gọi công cụ `search_spreadsheet_data` mà đã trả lời ngay
      // (thường do bị neo vào trí nhớ cũ trong lịch sử hội thoại khi tệp đã được đồng bộ / xóa dòng):
      const hasSpreadsheets = Array.isArray(activeSpreadsheets) && activeSpreadsheets.length > 0;
      const toolsCalledCount = seenCalls.size;
      const userQuery = options.userMessage || '';
      const isDataInquiry = (options.taskAnalysis?.taskCategory === 'DATA_CALCULATION') ||
        (options.taskAnalysis?.constraints?.isCalculationRequested) ||
        (options.taskAnalysis?.queryUnderstanding?.intent === 'SINGLE_LOOKUP') ||
        (options.taskAnalysis?.queryUnderstanding?.intent === 'ALL_RECORDS') ||
        /(báo giá|giá|chi phí|cước|tuyến|cont|vnd|vnđ|dòng|sheet|bao nhiêu|bảng)/i.test(stepResponse.text) ||
        /(báo giá|giá|chi phí|cước|tuyến|cont|vnd|vnđ|bao nhiêu|đi từ|đến)/i.test(userQuery) ||
        (agent.agent_type === 'DATA_ANALYST' || (agent.name && agent.name.includes('Excel')));

      if (stepCount === 1 && hasSpreadsheets && toolsCalledCount === 0 && isDataInquiry && maxSteps > 1) {
        console.log(`[AgentOrchestrator] Chặn trí nhớ cũ: Mô hình trả lời trực tiếp ở bước 1 mà chưa gọi search_spreadsheet_data. Yêu cầu mô hình tra cứu dữ liệu thực tế.`);
        contents.push({
          role: 'model',
          parts: [{ text: stepResponse.text }]
        });
        contents.push({
          role: 'user',
          parts: [{
            text: `[HỆ THỐNG YÊU CẦU XÁC THỰC BẮT BUỘC]: Bạn đang đưa ra câu trả lời về số liệu/báo giá nhưng chưa gọi công cụ "search_spreadsheet_data" để kiểm tra trên phiên bản bảng tính hiện tại. Bảng tính vừa được đồng bộ và có thể đã được người dùng chỉnh sửa, thêm mới hoặc XÓA các dòng dữ liệu. TUYỆT ĐỐI KHÔNG dùng lại trí nhớ lịch sử cũ. Hãy gọi công cụ "search_spreadsheet_data" ngay bây giờ để xác thực dữ liệu thực tế.`
          }]
        });
        continue;
      }

      finalAnswer = stepResponse.text;
      break;
    }

    // Fallback nếu không có cả 2
    break;
  }

  if (!finalAnswer && stepCount >= maxSteps) {
    finalAnswer = 'Tôi đã thực hiện các bước phân tích nhưng đã chạm ngưỡng giới hạn số bước cho phép. Dưới đây là các kết quả tôi đã thu thập được.';
  }

  // Hậu kiểm và làm sạch câu trả lời bằng Answer Quality Enhancer
  const verifiedResult = verifyAndRefineAnswer(finalAnswer, {
    artifacts: generatedArtifacts,
    taskAnalysis: options.taskAnalysis || {},
    hasReversedRouteOnly: reversedRouteContext ? reversedRouteContext.hasReversedRouteOnly : false,
    reversedRouteInfo: reversedRouteContext ? reversedRouteContext.reversedRouteInfo : null
  });
  finalAnswer = verifiedResult.refinedText;

  return {
    success: true,
    reply: finalAnswer,
    stepsExecuted: stepCount,
    artifacts: generatedArtifacts,
    usedModel: lastUsedModel,
    qualityModifications: verifiedResult.modifications
  };
}

module.exports = {
  executeAgentReActLoop,
  callGeminiWithTools,
  DEFAULT_FALLBACK_MODELS
};
