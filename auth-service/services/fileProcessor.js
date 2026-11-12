const path = require('path');
const universalDataEngine = require('./universalDataEngine');

/**
 * Process an uploaded file into content suitable for Gemini AI prompt
 * Unified under Universal Data Understanding Engine
 * @param {Object} file - Multer file object with buffer, originalname, mimetype
 * @returns {Promise<Object>} - Processed file metadata and content/parts
 */
async function processFileForAI(file) {
  const parsed = await universalDataEngine.parseUniversalFile(file.buffer, {
    fileName: file.originalname,
    mimeType: file.mimetype
  });

  return {
    fileName: parsed.fileName,
    mimeType: parsed.mimeType,
    size: parsed.fileSize,
    text: parsed.promptText,
    dataProfile: parsed.dataProfile,
    sections: parsed.sections,
    manifest: parsed.manifest,
    fileType: parsed.fileType,
    parseStatus: parsed.parseStatus,
    part: parsed.part,
    universalFile: parsed
  };
}

module.exports = {
  processFileForAI,
};
