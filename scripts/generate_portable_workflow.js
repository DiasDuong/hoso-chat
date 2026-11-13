const fs = require('fs');

const raw = fs.readFileSync('D:/hoso-chat/n8n-workflows/SOTRANS_HR_EMPLOYEE_LIFECYCLE.json', 'utf8');
let wf = JSON.parse(raw);

// Clean metadata
delete wf.shared;
delete wf.versionMetadata;
delete wf.meta;
wf.id = 'SOTRANS_HR_EMPLOYEE_LIFECYCLE_PORTABLE';
wf.name = 'SOTRANS_HR_EMPLOYEE_LIFECYCLE (Phase 1.2 Portable)';

const SECRET_RAW = '8973d464f5f1475b83d6ab88d222d824';
const SECRET_PLACEHOLDER = 'REPLACE_WITH_INTERNAL_SECRET';

// Traverse nodes and sanitize
wf.nodes.forEach(node => {
  if (node.type === 'n8n-nodes-base.stickyNote') return;

  // Code nodes
  if (node.parameters && node.parameters.jsCode) {
    node.parameters.jsCode = node.parameters.jsCode
      .split(SECRET_RAW)
      .join(SECRET_PLACEHOLDER);
  }

  // HTTP Request nodes
  if (node.parameters && node.parameters.url) {
    if (typeof node.parameters.url === 'string' && node.parameters.url.startsWith('http://hr-auth:3000')) {
      const endpoint = node.parameters.url.replace('http://hr-auth:3000', '');
      node.parameters.url = `={{ ($env.AUTH_SERVICE_INTERNAL_URL || "http://hr-auth:3000") + "${endpoint}" }}`;
    }
  }

  // Headers
  if (node.parameters && node.parameters.headerParameters && node.parameters.headerParameters.parameters) {
    node.parameters.headerParameters.parameters.forEach(h => {
      if (h.value && h.value.includes(SECRET_RAW)) {
        h.value = `={{ $env.N8N_INTERNAL_SECRET || "${SECRET_PLACEHOLDER}" }}`;
      }
    });
  }

  // Body expressions
  if (node.parameters && node.parameters.jsonBody) {
    node.parameters.jsonBody = node.parameters.jsonBody
      .split(SECRET_RAW)
      .join(SECRET_PLACEHOLDER);
  }

  // Credentials
  if (node.credentials) {
    if (node.credentials.httpHeaderAuth) {
      node.credentials.httpHeaderAuth = {
        id: 'REPLACE_WITH_YOUR_GEMINI_CREDENTIAL_ID',
        name: 'Gemini Header Auth (x-goog-api-key)'
      };
    }
  }
});

fs.writeFileSync(
  'D:/hoso-chat/exports/hr-employee-lifecycle-audit/SOTRANS_HR_EMPLOYEE_LIFECYCLE_PHASE1_2_PORTABLE.json',
  JSON.stringify(wf, null, 2),
  'utf8'
);

console.log('Saved PORTABLE workflow successfully. Nodes count:', wf.nodes.length);
