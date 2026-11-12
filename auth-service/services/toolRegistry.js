const dataEngine = require('./dataEngine');
const universalDataEngine = require('./universalDataEngine');
const excelExportService = require('./excelExportService');

/**
 * Tool Registry for Personal AI Agents
 * Định nghĩa danh mục công cụ chuẩn hóa theo Native Gemini Function Declarations Schema.
 */

const TOOL_DECLARATIONS = [
  {
    name: 'calculate_spreadsheet_metrics',
    description: 'Thực hiện tính toán xác định chính xác 100% các chỉ số (Tổng SUM, Trung bình AVERAGE, Đếm COUNT, Min, Max, hoặc Nhóm theo cột GROUP BY) trên dữ liệu bảng tính đã tải lên.',
    parameters: {
      type: 'OBJECT',
      properties: {
        sheetName: {
          type: 'STRING',
          description: 'Tên sheet cần tính toán (nếu file có nhiều sheet).'
        },
        operations: {
          type: 'ARRAY',
          description: 'Danh sách các phép tính toán cần thực thi.',
          items: {
            type: 'OBJECT',
            properties: {
              opType: {
                type: 'STRING',
                enum: ['SUM', 'AVERAGE', 'COUNT', 'GROUP_BY'],
                description: 'Loại phép tính: SUM (tổng), AVERAGE (trung bình), COUNT (đếm dòng), GROUP_BY (nhóm và cộng dồn).'
              },
              column: {
                type: 'STRING',
                description: 'Tên cột mục tiêu cần tính toán.'
              },
              sumCol: {
                type: 'STRING',
                description: 'Tên cột cần tính tổng khi dùng GROUP_BY (tùy chọn).'
              },
              filterCol: {
                type: 'STRING',
                description: 'Tên cột điều kiện lọc (tùy chọn).'
              },
              filterVal: {
                type: 'STRING',
                description: 'Giá trị điều kiện lọc (tùy chọn).'
              }
            },
            required: ['opType', 'column']
          }
        }
      },
      required: ['operations']
    }
  },
  {
    name: 'search_spreadsheet_data',
    description: 'Tìm kiếm, lọc và trích xuất chi tiết các bản ghi trong bảng tính Excel (tất cả các sheet) theo tuyến đường (điểm đi, điểm đến), nhà cung cấp (vendor), mã REF, ngày báo giá, hoặc từ khóa bất kỳ. Hỗ trợ tìm kiếm trên toàn bộ các sheet, tìm không dấu và tìm biến thể địa danh.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: {
          type: 'STRING',
          description: 'Từ khóa tìm kiếm tự do (ví dụ: "KCN Tân Bình", "Dĩ An", "3S", "42_LAU_LCL").'
        },
        origin: {
          type: 'STRING',
          description: 'Điểm đi / Nơi xuất phát (ví dụ: "KCN Tân Bình", "Tân Bình").'
        },
        destination: {
          type: 'STRING',
          description: 'Điểm đến / Nơi giao hàng (ví dụ: "Dĩ An", "Bình Dương").'
        },
        vendor: {
          type: 'STRING',
          description: 'Tên nhà cung cấp / Vendor (ví dụ: "3S", "Vendor 3S", "Thilogi").'
        },
        refCode: {
          type: 'STRING',
          description: 'Mã REF hoặc mã báo giá (ví dụ: "42_LAU_LCL").'
        },
        sheetName: {
          type: 'STRING',
          description: 'Tên sheet cần tìm (ví dụ: "Miền Nam", "Miền Bắc"). Bỏ trống để tìm trên TẤT CẢ các sheet.'
        },
        limit: {
          type: 'INTEGER',
          description: 'Số lượng dòng tối đa trả về (mặc định 50 dòng).'
        }
      }
    }
  },
  {
    name: 'search_document_sections',
    description: 'Tìm kiếm, trích xuất các điều khoản, phân đoạn hoặc trang văn bản trong các tệp Word (.docx), PDF (.pdf) hoặc tệp văn bản (.txt, .md, .json) đính kèm trong cuộc trò chuyện theo từ khóa hoặc chủ đề.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: {
          type: 'STRING',
          description: 'Từ khóa hoặc câu hỏi cần tra cứu trong văn bản (ví dụ: "chính sách bồi thường", "quy trình kiểm toán", "Điều 5").'
        },
        fileName: {
          type: 'STRING',
          description: 'Tên tệp cụ thể muốn tra cứu (tùy chọn, bỏ trống để tìm trên tất cả các tệp).'
        },
        limit: {
          type: 'INTEGER',
          description: 'Số lượng phân đoạn tối đa trả về (mặc định 10 phân đoạn).'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'get_file_manifest',
    description: 'Kiểm tra danh sách và trạng thái toàn vẹn của tất cả các tệp tài liệu, bảng tính đang được đính kèm trong cuộc trò chuyện (tên tệp, loại tệp, số sheet/trang/dòng, trạng thái sẵn sàng).',
    parameters: {
      type: 'OBJECT',
      properties: {}
    }
  },
  {
    name: 'export_excel_report',
    description: 'Tạo tệp bảng tính Excel (.xlsx) chuẩn hóa để người dùng tải về máy khi người dùng yêu cầu xuất file, tạo bảng tổng hợp hoặc tải báo cáo đối soát.',
    parameters: {
      type: 'OBJECT',
      properties: {
        fileName: {
          type: 'STRING',
          description: 'Tên tệp Excel kết xuất (ví dụ: Bao_cao_tong_hop.xlsx).'
        },
        sheetName: {
          type: 'STRING',
          description: 'Tên sheet trong file Excel.'
        },
        columns: {
          type: 'ARRAY',
          items: { type: 'STRING' },
          description: 'Danh sách tiêu đề các cột.'
        },
        rows: {
          type: 'ARRAY',
          items: {
            type: 'ARRAY',
            items: { type: 'STRING' }
          },
          description: 'Dữ liệu các dòng dạng mảng 2 chiều.'
        }
      },
      required: ['fileName', 'columns', 'rows']
    }
  },
  {
    name: 'web_research',
    description: 'Tìm kiếm thông tin thời gian thực trên Internet (tin tức thời sự, kinh tế vĩ mô, giá cả thị trường, công nghệ, chính sách công bố, tra cứu bách khoa Wikipedia). Sử dụng khi người dùng hỏi về thông tin cập nhật bên ngoài hệ thống nội bộ.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: {
          type: 'STRING',
          description: 'Từ khóa hoặc câu hỏi cụ thể cần tìm kiếm trên Internet.'
        },
        topic: {
          type: 'STRING',
          enum: ['general', 'news', 'wiki'],
          description: 'Chủ đề tìm kiếm: general (tìm kiếm web tổng quát), news (tin tức báo chí thời sự), wiki (khái niệm bách khoa).'
        }
      },
      required: ['query']
    }
  }
];

/**
 * Thực thi công cụ dựa trên tên và tham số đã kiểm tra
 */
async function executeTool(toolName, args, context = {}) {
  const { userId, agentId, conversationId, activeSpreadsheets = [], activeFiles = [] } = context;

  // Đồng bộ danh sách bảng tính từ activeFiles nếu activeSpreadsheets rỗng
  const effectiveSpreadsheets = activeSpreadsheets.length > 0
    ? activeSpreadsheets
    : activeFiles.filter(f => f.fileType === 'spreadsheet').map(f => f.dataProfile).filter(Boolean);

  if (toolName === 'get_file_manifest') {
    const manifests = activeFiles.map(f => f.manifest || {
      fileId: f.fileId,
      fileName: f.fileName,
      fileType: f.fileType,
      parseStatus: f.parseStatus || 'READY'
    });

    return {
      success: true,
      totalFiles: manifests.length,
      files: manifests,
      message: `Đang có ${manifests.length} tệp được đính kèm trong phiên hội thoại.`
    };
  }

  if (toolName === 'search_document_sections') {
    if (!activeFiles.length) {
      return {
        success: false,
        error: 'Không tìm thấy tệp tài liệu nào đính kèm trong hội thoại để tra cứu.'
      };
    }

    try {
      const searchRes = universalDataEngine.searchUniversalContent(activeFiles, {
        query: args.query,
        limit: args.limit || 10
      });

      return {
        success: true,
        status: searchRes.status,
        totalMatches: searchRes.totalMatches,
        returnedMatches: searchRes.returnedMatches,
        results: searchRes.results,
        message: `Đã tìm thấy ${searchRes.totalMatches} phân đoạn tài liệu phù hợp.`
      };
    } catch (docErr) {
      return {
        success: false,
        error: 'Lỗi tra cứu tài liệu: ' + docErr.message
      };
    }
  }

  if (toolName === 'calculate_spreadsheet_metrics') {
    if (!effectiveSpreadsheets.length) {
      return {
        success: false,
        error: 'Không tìm thấy bảng tính nào đính kèm trong hội thoại để thực thi tính toán.'
      };
    }

    // Chọn bảng tính mục tiêu: Ưu tiên theo tên file nếu có nhiều bảng tính
    let targetDoc = effectiveSpreadsheets[0];
    if (args.fileName) {
      const matchedDoc = effectiveSpreadsheets.find(s => s.fileName && s.fileName.toLowerCase().includes(args.fileName.toLowerCase()));
      if (matchedDoc) targetDoc = matchedDoc;
    }

    const targetSheetName = args.sheetName || targetDoc.sheetNames[0];
    const targetSheet = targetDoc.sheets[targetSheetName];

    if (!targetSheet) {
      return {
        success: false,
        error: `Không tìm thấy sheet "${targetSheetName}" trong tệp "${targetDoc.fileName}". Các sheet hiện có: ${targetDoc.sheetNames.join(', ')}`
      };
    }

    try {
      const metrics = dataEngine.calculateAggregates(targetSheet, args.operations);
      return {
        success: true,
        fileName: targetDoc.fileName,
        sheetName: targetSheetName,
        totalRowsEvaluated: targetSheet.validDataRows,
        metrics
      };
    } catch (calcErr) {
      return {
        success: false,
        error: 'Lỗi thực thi phép tính: ' + calcErr.message
      };
    }
  }

  if (toolName === 'search_spreadsheet_data') {
    if (!effectiveSpreadsheets.length) {
      return {
        success: false,
        error: 'Không tìm thấy bảng tính nào đính kèm trong hội thoại để tra cứu dữ liệu.'
      };
    }

    try {
      let docsToSearch = effectiveSpreadsheets;
      if (args.fileName) {
        const filtered = effectiveSpreadsheets.filter(s => s.fileName && s.fileName.toLowerCase().includes(args.fileName.toLowerCase()));
        if (filtered.length > 0) docsToSearch = filtered;
      }

      let combinedResults = [];
      let totalMatchesAcrossDocs = 0;
      let combinedReversedMatches = [];
      const limit = Math.max(1, Math.min(100, parseInt(args.limit, 10) || 50));

      for (const doc of docsToSearch) {
        const searchRes = dataEngine.searchSpreadsheetRecords(doc, args);
        if (searchRes && Array.isArray(searchRes.results)) {
          totalMatchesAcrossDocs += searchRes.totalMatches || searchRes.results.length;
          for (const r of searchRes.results) {
            combinedResults.push({
              ...r,
              fileName: doc.fileName
            });
          }
        }
        if (searchRes && Array.isArray(searchRes.reversedRouteResults)) {
          for (const rev of searchRes.reversedRouteResults) {
            combinedReversedMatches.push({
              ...rev,
              fileName: doc.fileName
            });
          }
        }
      }

      // Sắp xếp kết quả theo độ ưu tiên ngày giảm dần
      combinedResults.sort((a, b) => {
        const dateA = a.data ? (a.data['NGÀY BÁO GIÁ'] || '') : '';
        const dateB = b.data ? (b.data['NGÀY BÁO GIÁ'] || '') : '';
        return String(dateB).localeCompare(String(dateA));
      });

      const finalRecords = combinedResults.slice(0, limit);
      const hasUnreadySpreadsheets = activeFiles.some(f => f.fileType === 'spreadsheet' && f.manifest && f.manifest.readyForQuery === false);
      let status = 'FOUND';
      if (totalMatchesAcrossDocs === 0) {
        status = hasUnreadySpreadsheets ? 'PARTIAL_UNVERIFIED' : 'NOT_FOUND_VERIFIED';
      } else if (totalMatchesAcrossDocs > limit) {
        status = 'PARTIAL';
      }

      const hasReversedOnly = totalMatchesAcrossDocs === 0 && combinedReversedMatches.length > 0;
      let message = '';
      if (hasReversedOnly) {
        message = `⚠️ [CHÚ Ý ĐỊNH HƯỚNG TUYẾN ĐƯỜNG LOGISTICS]: Không tìm thấy bất kỳ báo giá nào cho chiều yêu cầu (từ "${args.origin || 'Điểm đi yêu cầu'}" đến "${args.destination || 'Điểm đến yêu cầu'}"). ` +
          `Tuy nhiên, bảng tính CÓ ${combinedReversedMatches.length} bản ghi báo giá cho CHIỀU NGƯỢC LẠI (từ "${args.destination || 'Điểm đến'}" đến "${args.origin || 'Điểm đi'}"). ` +
          `QUY TẮC BẮT BUỘC DÀNH CHO AI: Trong vận tải và logistics, giá cước chiều đi và chiều về thường KHÁC NHAU. BẠN BẮT BUỘC PHẢI THÔNG BÁO RÕ RÀNG cho người dùng rằng chiều yêu cầu CHƯA CÓ báo giá, chỉ có báo giá chiều ngược lại để tham khảo, TUYỆT ĐỐI KHÔNG ngầm định hoặc khẳng định giá 2 chiều bằng nhau.`;
      } else if (status === 'NOT_FOUND_VERIFIED') {
        message = `Đã quét toàn bộ ${docsToSearch.length} bảng tính nhưng không tìm thấy bản ghi phù hợp.`;
      } else {
        message = `Đã tìm thấy ${totalMatchesAcrossDocs} bản ghi phù hợp trong ${docsToSearch.length} bảng tính (hiển thị ${finalRecords.length} bản ghi).`;
      }

      return {
        success: true,
        status,
        totalMatches: totalMatchesAcrossDocs,
        returnedMatches: finalRecords.length,
        isExhaustive: totalMatchesAcrossDocs <= limit,
        results: finalRecords,
        hasReversedRouteOnly: hasReversedOnly,
        reversedRouteReferences: hasReversedOnly ? combinedReversedMatches.slice(0, 5) : [],
        searchedFiles: docsToSearch.map(d => d.fileName),
        message
      };
    } catch (searchErr) {
      return {
        success: false,
        status: 'PROCESSING_FAILED',
        error: 'Lỗi tra cứu dữ liệu bảng tính: ' + searchErr.message
      };
    }
  }

  if (toolName === 'export_excel_report') {
    try {
      const generated = await excelExportService.generateExcelReport({
        userId,
        agentId,
        conversationId,
        fileName: args.fileName,
        sheets: [{
          sheetName: args.sheetName || 'Báo cáo',
          columns: args.columns,
          rows: args.rows
        }]
      });

      return {
        success: true,
        fileId: generated.fileId,
        fileName: generated.fileName,
        fileSize: generated.fileSize,
        downloadUrl: generated.downloadUrl,
        expiresAt: generated.expiresAt,
        message: `Đã tạo tệp Excel "${generated.fileName}" (${(generated.fileSize / 1024).toFixed(1)} KB) thành công.`
      };
    } catch (expErr) {
      return {
        success: false,
        error: 'Lỗi tạo tệp Excel: ' + expErr.message
      };
    }
  }

  if (toolName === 'web_research') {
    try {
      const { searchGeneralWebAndGround, fetchGoogleNews, fetchWikipedia } = require('./webSearch');
      const topic = args.topic || 'general';
      let searchRes = null;

      if (topic === 'news') {
        const newsItems = await fetchGoogleNews(args.query);
        if (newsItems && newsItems.length > 0) {
          searchRes = {
            groundingText: newsItems.map((n, idx) => `[${idx + 1}] ${n.title} (${n.published || ''}): ${n.snippet || ''}`).join('\n'),
            sources: newsItems.map(n => ({ title: n.title, url: n.url }))
          };
        }
      } else if (topic === 'wiki') {
        const wikiItems = await fetchWikipedia(args.query);
        if (wikiItems && wikiItems.length > 0) {
          searchRes = {
            groundingText: wikiItems.map((w, idx) => `[${idx + 1}] ${w.title}: ${w.snippet}`).join('\n'),
            sources: wikiItems.map(w => ({ title: w.title, url: w.url }))
          };
        }
      } else {
        const res = await searchGeneralWebAndGround(args.query, { maxResults: 5, readPagesCount: 1 });
        if (res) {
          searchRes = {
            groundingText: res.contextPrompt || JSON.stringify(res.data),
            sources: res.sources || []
          };
        }
      }

      if (!searchRes || !searchRes.groundingText) {
        return {
          success: true,
          status: 'NO_RESULTS',
          query: args.query,
          message: `Không tìm thấy kết quả phù hợp trên Internet cho từ khóa "${args.query}".`
        };
      }

      return {
        success: true,
        status: 'SUCCESS',
        query: args.query,
        topic,
        sources: searchRes.sources || [],
        data: searchRes.groundingText,
        message: `Đã tìm thấy thông tin trên Internet từ các nguồn xác thực.`
      };
    } catch (webErr) {
      return {
        success: false,
        status: 'ERROR',
        error: 'Lỗi tra cứu web: ' + webErr.message
      };
    }
  }

  return {
    success: false,
    error: `Công cụ "${toolName}" chưa được hỗ trợ.`
  };
}

module.exports = {
  TOOL_DECLARATIONS,
  executeTool
};
