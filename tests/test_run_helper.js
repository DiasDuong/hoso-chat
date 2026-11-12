/**
 * SOTRANS HUB — TEST RUN NAMESPACE & SAFE TEARDOWN HELPER
 * Provides dedicated test namespaces, tagging, and idempotent cleanup.
 */

const crypto = require('crypto');

/**
 * Generate a unique, traceable test run ID
 * @param {string} prefix Optional prefix e.g. 'REGRESSION'
 * @returns {string} e.g. 'TEST_RUN_REGRESSION_1792982845_a1b2'
 */
function generateTestRunId(prefix = 'TEST') {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(2).toString('hex');
  return `TEST_RUN_${prefix.toUpperCase()}_${timestamp}_${nonce}`;
}

/**
 * Create a metadata object containing test run tracing information
 * @param {string} testRunId
 * @param {object} additionalMeta
 * @returns {object}
 */
function createTestMetadata(testRunId, additionalMeta = {}) {
  if (!testRunId || !testRunId.startsWith('TEST_RUN_')) {
    throw new Error('Safety guard: Valid testRunId required to prevent untagged test resource creation');
  }
  return {
    is_test_fixture: true,
    test_run_id: testRunId,
    created_at: new Date().toISOString(),
    ...additionalMeta
  };
}

/**
 * Tag a filename or resource name with test run prefix
 * @param {string} testRunId
 * @param {string} baseName
 * @returns {string}
 */
function tagResourceName(testRunId, baseName) {
  return `[${testRunId}]_${baseName}`;
}

/**
 * Safe teardown query generator - ensures queries CANNOT execute without test_run_id
 * @param {string} testRunId
 * @returns {object}
 */
function getSafeTeardownSql(testRunId) {
  if (!testRunId || typeof testRunId !== 'string' || !testRunId.startsWith('TEST_RUN_')) {
    throw new Error('Teardown guard: Refusing teardown without explicit, valid testRunId');
  }

  return {
    deleteConversations: {
      text: "DELETE FROM public.ai_conversations WHERE metadata->>'test_run_id' = $1",
      values: [testRunId]
    },
    deleteAgentOutputs: {
      text: "DELETE FROM public.agent_output_files WHERE metadata->>'test_run_id' = $1",
      values: [testRunId]
    },
    deleteOneDriveSources: {
      text: "DELETE FROM public.user_onedrive_sources WHERE metadata->>'test_run_id' = $1",
      values: [testRunId]
    }
  };
}

module.exports = {
  generateTestRunId,
  createTestMetadata,
  tagResourceName,
  getSafeTeardownSql
};
