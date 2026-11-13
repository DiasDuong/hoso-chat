const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { getGoogleAccessToken, GOOGLE_SPREADSHEET_ID } = require('../services/googleAuthHelper');
const https = require('https');
const fs = require('fs');

function requestGoogle(urlPath, options = {}) {
  return new Promise(async (resolve, reject) => {
    try {
      const token = await getGoogleAccessToken();
      const req = https.request(`https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SPREADSHEET_ID}${urlPath}`, {
        ...options,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(options.headers || {})
        }
      }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(data || '{}');
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(json);
            } else {
              reject(new Error(`Google API HTTP ${res.statusCode}: ${data}`));
            }
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on('error', reject);
      if (options.body) req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

async function backup() {
  console.log('Fetching spreadsheet metadata...');
  const meta = await requestGoogle('');
  console.log('Spreadsheet title:', meta.properties?.title);
  const sheets = meta.sheets || [];
  console.log('Sheets:');
  sheets.forEach(s => {
    console.log(`- SheetId: ${s.properties?.sheetId}, Title: "${s.properties?.title}", Index: ${s.properties?.index}, RowCount: ${s.properties?.gridProperties?.rowCount}, ColCount: ${s.properties?.gridProperties?.columnCount}`);
  });

  console.log('\nFetching all data from Trang tính1...');
  const data = await requestGoogle('/values/Trang%20t%C3%ADnh1!A1:ZZ500');
  
  const backupDir = path.join(__dirname, '../../backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  const backupFile = path.join(backupDir, `google_sheets_backup_${Date.now()}.json`);
  const fullBackup = {
    metadata: meta,
    values: data.values || [],
    backed_up_at: new Date().toISOString()
  };

  fs.writeFileSync(backupFile, JSON.stringify(fullBackup, null, 2), 'utf8');
  console.log(`\nSuccessfully backed up to: ${backupFile}`);
  console.log(`Total rows backed up: ${(data.values || []).length}`);
  process.exit(0);
}

backup().catch(err => {
  console.error('Backup error:', err);
  process.exit(1);
});
