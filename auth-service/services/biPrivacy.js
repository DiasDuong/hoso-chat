'use strict';

const normalizedKey = key => String(key).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').toLowerCase().replace(/[^a-z0-9]/g, '');
const credentialKey = key => /^(password|passwordhash|passwd|secret|token|jwt|authtoken|apikey|credential|privatekey)$/.test(normalizedKey(key));
const personalKey = key => /citizenid|cccd|cmnd|sodienthoai|phone|email|bankaccount|sotaikhoan/.test(normalizedKey(key)) || /^(sdt|basesalary|salary|luong|luongcoban)$/.test(normalizedKey(key));

function sanitizeBiData(value, key = '') {
  if (personalKey(key)) return value == null || value === '' ? value : '[Đã ẩn]';
  if (Array.isArray(value)) return value.map(item => sanitizeBiData(item));
  if (value && typeof value === 'object') {
    const clean = {};
    for (const [field, item] of Object.entries(value)) {
      if (!credentialKey(field)) clean[field] = sanitizeBiData(item, field);
    }
    return clean;
  }
  return value;
}

function sanitizeBiProfile(profile) {
  if (!profile) return profile;
  const clean = sanitizeBiData(profile);
  clean.columns = (clean.columns || []).filter(column => !credentialKey(column.key || column.name)).map(column => {
    if (!personalKey(column.key || column.name)) return column;
    const safe = { ...column, top_values: (column.top_values || []).map(v => ({ ...v, value: '[Đã ẩn]' })) };
    for (const key of ['min', 'max', 'sum', 'avg', 'median']) if (key in safe) safe[key] = null;
    return safe;
  });
  return clean;
}

module.exports = { sanitizeBiData, sanitizeBiProfile, credentialKey, personalKey };
