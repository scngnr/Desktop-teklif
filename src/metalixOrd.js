const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DIR_MAX = 200;
const CSV_MAX_BYTES = 8 * 1024 * 1024;
const NEST_PROFILE = 'metalix_perfex';

const MESSAGES = {
  dir_required: 'Klasör gerekli.',
  dir_too_long: 'Klasör 200 karakteri aşıyor.',
  dir_invalid: 'Klasör tırnak veya kontrol karakteri içeremez.',
  group_invalid: 'Grup anahtarında bölü veya tırnak var.',
  no_parts: 'Adedi girilmiş parça yok.',
  dxf_missing:
    'Parça var ama sunucu DXF zip’ini okuyamadı. Klasör yolu geçerli; üretim emrindeki parçanın DXF dosyası sunucuda yok, bozuk ya da zip değil.',
  mo_not_found: 'Üretim emri yok.',
  csv_required: 'Gövde CSV değil.',
  csv_empty: 'CSV boş.',
  csv_only: 'Dosya adı .csv veya .txt olmalı.',
  csv_too_large: 'CSV 8 MB sınırını aşıyor.',
  profile_required: 'Profil id veya kod gerekli.',
  parse_failed: 'Şablon tanınmadı veya sac satırı yok.',
  nest_not_ready: 'Yerleşim tabloları yok.',
  mo_invalid: 'Üretim emri numarası geçersiz.',
  zip_slip: 'Zip klasörün dışına yazmaya çalıştı.',
  zip_invalid: 'Zip dosyası okunamadı.',
  zip_unsupported: 'Bu zip sıkıştırması açılmıyor.',
  sheet_size_required: 'AutoNest LoadOrdFile için sac ölçüsü (X ve Y, mm) gerekli.',
  machine_required: 'AutoNest makine numarası Ayarlar’da tanımlanmalı.',
  report_template_required: 'Perfex rapor şablonu Ayarlar’da tanımlanmalı.',
  script_windows_only: 'Metalix yerleşim betiği yalnızca Windows üzerinde çalışır.',
  script_missing: 'Paket içindeki Metalix yerleşim betiği bulunamadı.',
  script_protocol: 'Metalix betiği beklenen CSV/HATA çıktısını vermedi.',
  report_missing: 'AutoNest Perfex CSV raporunu üretmedi.',
  ord_missing: 'ORD dosyası bulunamadı.',
  ord_invalid: 'Yalnızca .ord dosyası açılır.',
  ord_com_only: 'ORD dosyaları Windows ile açılmaz; yalnızca AutoNest COM’a gönderilir.',
};

function explainMetalixCode(code) {
  if (!code) return '';
  return MESSAGES[String(code)] || '';
}

function fail(code, extra) {
  return {
    ok: false,
    code,
    error: explainMetalixCode(code) || code,
    ...(extra || {}),
  };
}

function validateMoId(moId) {
  const s = String(moId == null ? '' : moId).trim();
  if (!/^[1-9]\d*$/.test(s)) return fail('mo_invalid');
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) return fail('mo_invalid');
  return { ok: true, moId: String(n) };
}

function hasControlChar(value) {
  return /[\u0000-\u001f\u007f]/.test(String(value));
}

function validateDir(dir) {
  const s = String(dir == null ? '' : dir).trim();
  if (!s) return fail('dir_required');
  if (s.length > DIR_MAX) return fail('dir_too_long');
  if (/["']/.test(s) || hasControlChar(s)) return fail('dir_invalid');
  return { ok: true, dir: s };
}

function validateGroup(group) {
  const s = String(group == null ? '' : group).trim();
  if (!s) return { ok: true, group: '' };
  if (/[/\\"']/.test(s) || hasControlChar(s)) return fail('group_invalid');
  return { ok: true, group: s };
}

function metalixNumber(value) {
  if (value == null || value === '') return '';
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (Object.is(n, -0)) return '0';
  if (Number.isInteger(n)) return String(n);
  return String(n);
}

/**
 * cncKad AutoNest "Add list to ORD" satırı.
 * "sipariş"   "tam dxf yolu"   min   max   @M=malzemeNo   @T=kalınlık
 */
function formatOrdLine(part) {
  const orderName = String(part.orderName == null ? '' : part.orderName);
  const filePath = String(part.filePath == null ? '' : part.filePath);
  const minQty = metalixNumber(part.minQty);
  const maxQty = metalixNumber(part.maxQty);
  const material = metalixNumber(part.material);
  const thickness = metalixNumber(part.thickness);
  return (
    '"' +
    orderName +
    '"   "' +
    filePath +
    '"   ' +
    minQty +
    '   ' +
    maxQty +
    '   @M=' +
    material +
    '   @T=' +
    thickness
  );
}

function parseOrdLine(line) {
  const raw = String(line || '').trim();
  if (!raw || raw.startsWith('#')) return null;
  const quoted = [];
  const re = /"([^"]*)"/g;
  let match;
  while ((match = re.exec(raw))) quoted.push(match[1]);
  if (!quoted.length && !/@[MT]=/i.test(raw)) return null;
  const rest = raw.replace(/"[^"]*"/g, ' ').replace(/@[MT]=[^\s]+/gi, ' ');
  const nums = rest.match(/\d+(?:\.\d+)?/g) || [];
  const material = raw.match(/@M=([^\s]+)/i);
  const thickness = raw.match(/@T=([^\s]+)/i);
  return {
    orderName: quoted[0] || '',
    filePath: quoted[1] || '',
    minQty: nums[0] || '',
    maxQty: nums[1] || '',
    material: material ? material[1] : '',
    thickness: thickness ? thickness[1] : '',
  };
}

function normalizeWinPath(value) {
  return String(value || '')
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase();
}

function pathIsUnderDir(filePath, dir) {
  const file = normalizeWinPath(filePath);
  const root = normalizeWinPath(dir);
  if (!file || !root) return false;
  return file === root || file.startsWith(root + '\\');
}

function partIdFromDxf(filePath) {
  const base = path.win32.basename(String(filePath || '').replace(/\//g, '\\'));
  const match = base.match(/^P(\d+)-/i);
  return match ? match[1] : '';
}

function isOrdFilePath(filePath) {
  return path.extname(String(filePath || '').trim()).toLowerCase() === '.ord';
}

function decodeTextBuffer(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8');
  }
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    return new TextDecoder('windows-1254').decode(buf);
  } catch {
    return utf8;
  }
}

function decodeOrdText(buffer) {
  return decodeTextBuffer(buffer);
}

function isPerfexNestCsv(filename, text) {
  if (!/\.csv$/i.test(String(filename || ''))) return false;
  return /perfex/i.test(path.basename(String(filename || ''))) ||
    /Parts\s+in\s+Sub\s+Nests/i.test(String(text || ''));
}

function parseCsvLine(line) {
  const cells = [];
  let value = '';
  let quoted = false;
  const raw = String(line || '');
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (char === '"') {
      if (quoted && raw[i + 1] === '"') {
        value += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      cells.push(value.trim());
      value = '';
    } else {
      value += char;
    }
  }
  cells.push(value.trim());
  return cells;
}

function inspectPerfexNestCsv(text) {
  const lines = String(text || '').split(/\r?\n/);
  let header = null;
  let inParts = false;
  const parts = [];
  for (const line of lines) {
    if (/^\s*Parts\s+in\s+Order\s*:/i.test(line)) {
      inParts = true;
      header = null;
      continue;
    }
    if (inParts && /^\s*Parts\s+in\s+Sub\s+Nests\s*:/i.test(line)) break;
    if (!inParts || !line.trim() || /^[-\s,]+$/.test(line)) continue;
    const cells = parseCsvLine(line);
    if (!header) {
      const normalized = cells.map((cell) => cell.toLowerCase().replace(/\s+/g, ' '));
      if (normalized.includes('num') && normalized.includes('name')) header = normalized;
      continue;
    }
    const fileIndex = cells.findIndex((cell) => /\.(?:dft|dxf)\b/i.test(cell));
    if (fileIndex < 0) continue;
    const filePath = cells[fileIndex];
    const idMatch = path.win32.basename(filePath.replace(/\//g, '\\')).match(/^P(\d+)(?:[-_.]|$)/i);
    const indexOf = (name) => header.indexOf(name);
    const cellAt = (name) => {
      const index = indexOf(name);
      return index >= 0 ? cells[index] || '' : '';
    };
    parts.push({
      id: idMatch ? idMatch[1] : '',
      number: cellAt('num'),
      name: cellAt('name'),
      filePath,
      orderedQty: cellAt('ordered qty'),
      placedQty: cellAt('placed qty'),
    });
  }
  return {
    partCount: parts.length,
    partIds: [...new Set(parts.map((part) => part.id).filter(Boolean))],
    parts,
  };
}

function inspectOrdText(text, dir) {
  const parsed = String(text || '')
    .split(/\r?\n/)
    .map(parseOrdLine)
    .filter(Boolean);
  const warnings = [];
  parsed.forEach((line) => {
    if (!line.filePath) {
      warnings.push({ code: 'ord_path_missing', orderName: line.orderName });
      return;
    }
    if (dir && !pathIsUnderDir(line.filePath, dir)) {
      warnings.push({ code: 'ord_dir_mismatch', filePath: line.filePath });
    }
    if (!partIdFromDxf(line.filePath)) {
      warnings.push({ code: 'part_id_missing', filePath: line.filePath });
    }
  });
  return { lineCount: parsed.length, lines: parsed, warnings };
}

function nestFilename(name) {
  let base = path.basename(String(name || '').trim());
  if (!base || base === '.' || base === '..') base = 'rapor.csv';
  if (!path.extname(base)) base += '.csv';
  const ext = path.extname(base).toLowerCase();
  if (ext !== '.csv' && ext !== '.txt') return fail('csv_only');
  return { ok: true, filename: base };
}

function prepareNestCsv(filename, csv) {
  const named = nestFilename(filename);
  if (!named.ok) return named;
  const text = csv == null ? '' : String(csv);
  if (!text.trim()) return fail('csv_empty');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > CSV_MAX_BYTES) return fail('csv_too_large');
  const inspected = inspectPerfexNestCsv(text);
  return { ok: true, filename: named.filename, csv: text, bytes, ...inspected };
}

function nestProfile(profile) {
  const s = String(profile == null ? '' : profile).trim();
  return s || NEST_PROFILE;
}

function nestJsonBody(payload) {
  const prepared = prepareNestCsv(payload && payload.filename, payload && payload.csv);
  if (!prepared.ok) return prepared;
  return {
    ok: true,
    body: {
      filename: prepared.filename,
      profile: nestProfile(payload && payload.profile),
      csv: prepared.csv,
    },
  };
}

function ordEndpointPaths(moId) {
  const id = validateMoId(moId);
  if (!id.ok) return id;
  const tail = 'mrp/manufacturing_orders/' + id.moId + '/ord';
  return { ok: true, moId: id.moId, paths: ['api/v1/' + tail, 'api/' + tail] };
}

function nestEndpointPaths(moId) {
  const id = validateMoId(moId);
  if (!id.ok) return id;
  const tail = 'mrp/manufacturing_orders/' + id.moId + '/nest';
  return { ok: true, moId: id.moId, paths: ['api/v1/' + tail, 'api/' + tail] };
}

function joinApiUrl(apiRoot, relPath) {
  const root = String(apiRoot || '').replace(/\/+$/, '');
  const rel = String(relPath || '').replace(/^\/+/, '');
  return root + '/' + rel;
}

function isZipPayload(headers, body) {
  const ct = String((headers && (headers['content-type'] || headers['Content-Type'])) || '');
  if (/zip/i.test(ct)) return true;
  return Buffer.isBuffer(body) && body.length >= 4 && body.readUInt32LE(0) === 0x04034b50;
}

function filenameFromDisposition(header) {
  const h = String(header || '');
  const star = h.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
  if (star) {
    const raw = star[1].trim().replace(/^"|"$/g, '');
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  const quoted = h.match(/filename="([^"]+)"/i);
  if (quoted) return quoted[1];
  const plain = h.match(/filename=([^;]+)/i);
  return plain ? plain[1].trim().replace(/^"|"$/g, '') : '';
}

function headerValue(headers, name) {
  if (!headers) return '';
  const want = name.toLowerCase();
  if (headers[want] != null) return String(headers[want]);
  const key = Object.keys(headers).find((k) => k.toLowerCase() === want);
  return key ? String(headers[key]) : '';
}

function decodeHeaderParam(value) {
  const raw = String(value || '');
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function parseJsonBuffer(body) {
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '');
  if (!text.trim()) return { text, json: null };
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}

function permissionDeniedMessage(json, text) {
  const raw = String((json && json.message) || text || '');
  if (/necessary permissions/i.test(raw)) {
    return 'API token bu işlem için yetkili değil. ORD indirme okuma ile gider; üretim emri okuma (MRP) açık olmalı.';
  }
  return '';
}

function apiDir(dir) {
  const s = String(dir || '');
  if (s.startsWith('\\\\')) return s;
  return s.replace(/\\/g, '/');
}

function collectDxfNames(json) {
  const found = [];
  if (!json || typeof json !== 'object') return found;
  const visit = (value, depth) => {
    if (found.length >= 6 || depth > 4 || value == null) return;
    if (typeof value === 'string') {
      const name = value.split(/[/\\]/).pop();
      if (name && /\.dxf$/i.test(name) && found.indexOf(name) === -1) found.push(name);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (typeof value === 'object') {
      ['file', 'path', 'name', 'filename', 'dxf'].forEach((key) => {
        if (value[key] != null) visit(value[key], depth + 1);
      });
    }
  };
  ['files', 'missing', 'parts', 'dxf', 'dxfs'].forEach((key) => visit(json[key], 0));
  return found;
}

function errorFromApi(status, json, text) {
  const code = json && (json.code || (typeof json.error === 'string' ? json.error : ''));
  let message =
    explainMetalixCode(code) ||
    permissionDeniedMessage(json, text) ||
    (json && json.message) ||
    String(text || '').slice(0, 400);
  if (code === 'dxf_missing') {
    const parts = [explainMetalixCode('dxf_missing')];
    const server = json && typeof json.message === 'string' ? json.message.trim() : '';
    if (server && parts.every((line) => line.indexOf(server) === -1)) parts.push(server);
    const names = collectDxfNames(json);
    if (names.length) parts.push('Dosya: ' + names.join(', ') + '.');
    message = parts.join(' ');
  }
  return {
    ok: false,
    status: status || 0,
    code: code || (/necessary permissions/i.test(String((json && json.message) || text || '')) ? 'permission_denied' : ''),
    error: message || 'İstek başarısız.',
    json: json || null,
  };
}

function ordDownloadQuery(dir, group) {
  const params = new URLSearchParams();
  params.set('dir', apiDir(dir));
  if (group) params.set('group', group);
  return params.toString();
}

function isOrdDownloadPath(pathname) {
  return /\/manufacturing_orders\/\d+\/ord\/?$/i.test(String(pathname || ''));
}

/**
 * Paneldeki "Metalix'e gönder" çoğu kurulumda ORD’yi POST ile ister.
 * POST, API izninde oluşturma sayılır. Aynı indirme GET ile okuma iznine düşer.
 */
function rewriteOrdPostToGet(method, url, body) {
  if (String(method || '').toUpperCase() !== 'POST') return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!isOrdDownloadPath(parsed.pathname)) return null;
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '');
  let dir = parsed.searchParams.get('dir') || '';
  let group = parsed.searchParams.get('group') || '';
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const json = JSON.parse(trimmed);
      if (json && json.dir) dir = String(json.dir);
      if (json && json.group != null && String(json.group) !== '') group = String(json.group);
    } catch {
      return null;
    }
  } else if (trimmed.includes('=')) {
    const form = new URLSearchParams(trimmed);
    if (form.get('dir')) dir = form.get('dir');
    if (form.get('group')) group = form.get('group');
  }
  const checked = validateDir(dir);
  if (!checked.ok) return null;
  const groupChecked = validateGroup(group);
  if (!groupChecked.ok) return null;
  parsed.searchParams.set('dir', apiDir(checked.dir));
  if (groupChecked.group) parsed.searchParams.set('group', groupChecked.group);
  else parsed.searchParams.delete('group');
  return parsed.toString();
}

function ordDownloadNeedsPost(interpreted) {
  if (!interpreted || interpreted.ok) return false;
  if (interpreted.status === 405 || interpreted.status === 404) return true;
  if (interpreted.code === 'dir_required') return true;
  if (interpreted.json && Array.isArray(interpreted.json.groups) && interpreted.json.status !== false) {
    return true;
  }
  return false;
}

function isMetalixSendLabel(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return /metalix['’'`]?e\s+g[oö]nder/i.test(s);
}

function moIdFromPageUrl(url) {
  const match = String(url || '').match(/view_manufacturing_order\/(\d+)/i);
  return match ? match[1] : '';
}

function normalizeMetalixGroup(value, label) {
  const text = String(label || '').replace(/\s+/g, ' ').trim();
  const raw = String(value || '').replace(/\s+/g, ' ').trim();
  if (/t[uü]m gruplar/i.test(text) || /t[uü]m gruplar/i.test(raw)) return '';
  if (!raw || raw === '*' || /^all$/i.test(raw)) return '';
  const checked = validateGroup(raw);
  return checked.ok ? checked.group : '';
}

function firstFilled(obj, keys) {
  for (let i = 0; i < keys.length; i += 1) {
    const value = obj[keys[i]];
    if (value != null && String(value).trim()) return value;
  }
  return '';
}

/**
 * Kesim sekmesi mrpDesktop.metalixOrd(detail) veya
 * mrp-metalix-ord olayının detail gövdesi.
 */
function metalixBridgePayload(input, pageUrl) {
  let raw = input;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        raw = JSON.parse(text);
      } catch {
        raw = {};
      }
    } else {
      raw = {};
    }
  }
  if (raw && typeof raw === 'object' && raw.detail && typeof raw.detail === 'object') {
    raw = raw.detail;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};

  let moId = '';
  const moRaw = firstFilled(raw, [
    'moId',
    'mo_id',
    'manufacturing_order_id',
    'manufacturingOrderId',
  ]);
  if (moRaw) {
    const checked = validateMoId(moRaw);
    moId = checked.ok ? checked.moId : '';
  }
  if (!moId) moId = moIdFromPageUrl(pageUrl);

  const dir = String(
    firstFilled(raw, ['dir', 'folder', 'metalixDir', 'metalix_dir', 'path']) || ''
  ).trim();
  const group = normalizeMetalixGroup(
    firstFilled(raw, ['group', 'group_key', 'groupKey']),
    firstFilled(raw, ['group_label', 'groupLabel'])
  );
  const payload = { moId, dir, group };
  const sheetX = firstFilled(raw, ['sheetX', 'sheet_x']);
  const sheetY = firstFilled(raw, ['sheetY', 'sheet_y']);
  const profile = firstFilled(raw, ['profile']);
  if (sheetX) payload.sheetX = String(sheetX);
  if (sheetY) payload.sheetY = String(sheetY);
  if (profile) payload.profile = String(profile);
  return payload;
}

function interpretGroups(status, body) {
  const parsed = parseJsonBuffer(body);
  if (status && status >= 400) return errorFromApi(status, parsed.json, parsed.text);
  const json = parsed.json;
  if (!json || json.status === false) {
    return errorFromApi(status || 0, json, parsed.text);
  }
  const groups = Array.isArray(json.groups) ? json.groups : [];
  return {
    ok: true,
    status: status || 200,
    moId: json.mo_id,
    manufacturingOrderCode: json.manufacturing_order_code || '',
    suggestedDir: json.suggested_dir || '',
    groups,
    json,
  };
}

function interpretOrdDownload(status, headers, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
  if (isZipPayload(headers, buf) && status < 400) {
    return {
      ok: true,
      status,
      filename: filenameFromDisposition(headerValue(headers, 'content-disposition')),
      ordFiles: Number(headerValue(headers, 'x-mrp-ord-files')) || 0,
      missing: Number(headerValue(headers, 'x-mrp-ord-missing')) || 0,
      ordDir: decodeHeaderParam(headerValue(headers, 'x-mrp-ord-dir')),
      zip: buf,
    };
  }
  const parsed = parseJsonBuffer(buf);
  return errorFromApi(status, parsed.json, parsed.text);
}

function reportListFromJson(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  if (Array.isArray(json.reports)) return json.reports;
  if (Array.isArray(json.data)) return json.data;
  if (json.report && typeof json.report === 'object') return [json.report];
  return [];
}

function interpretNestPost(status, body) {
  const parsed = parseJsonBuffer(body);
  if (!parsed.json || status >= 400 || parsed.json.status === false) {
    return errorFromApi(status, parsed.json, parsed.text);
  }
  const json = parsed.json;
  return {
    ok: true,
    status,
    moId: json.mo_id,
    reportId: json.report_id || (json.report && json.report.id) || null,
    message: json.message || '',
    report: json.report || null,
    supply: json.supply || null,
    json,
  };
}

function interpretNestList(status, body) {
  const parsed = parseJsonBuffer(body);
  if (status >= 400 || (parsed.json && parsed.json.status === false)) {
    return errorFromApi(status, parsed.json, parsed.text);
  }
  return {
    ok: true,
    status,
    reports: reportListFromJson(parsed.json),
    json: parsed.json,
  };
}

function nestScriptOptions(input) {
  const sx = Number(input && input.sheetX);
  const sy = Number(input && input.sheetY);
  if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx <= 0 || sy <= 0) {
    return fail('sheet_size_required');
  }
  const reportTemplate = String((input && input.reportTemplate) || '').trim();
  if (!reportTemplate) return fail('report_template_required');
  return {
    ok: true,
    sheetX: sx,
    sheetY: sy,
    sheetQty: 200,
    reportTemplate,
  };
}

function nestScriptArgs(input) {
  return [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    String(input.scriptPath),
    '-OrdFile',
    String(input.ordPath),
    '-Template',
    String(input.template),
    '-OutCsv',
    String(input.outCsv),
    '-SheetX',
    String(input.sheetX),
    '-SheetY',
    String(input.sheetY),
    '-SheetQty',
    String(input.sheetQty),
  ];
}

function parseNestScriptResult(exitCode, stdout, stderr) {
  const out = String(stdout || '').replace(/^\uFEFF/, '');
  const err = String(stderr || '').trim();
  const lines = out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1] || '';
  if (Number(exitCode) === 0 && /^CSV\s+.+/i.test(last)) {
    const incompleteLine = lines.find((line) => /^UYARI\s+yerlesmeyen parca:\s*\d+/i.test(line));
    const incompleteMatch =
      incompleteLine && incompleteLine.match(/^UYARI\s+yerlesmeyen parca:\s*(\d+)/i);
    const countsLine = lines.find((line) => /\bPARCA\s+siparis=\d+\s+yerlesen=\d+/i.test(line));
    const countsMatch =
      countsLine && countsLine.match(/\bPARCA\s+siparis=(\d+)\s+yerlesen=(\d+)/i);
    const unplacedParts = incompleteMatch ? Number(incompleteMatch[1]) : 0;
    return {
      ok: true,
      exitCode: 0,
      csvPath: last.replace(/^CSV\s+/i, '').trim(),
      incomplete: unplacedParts > 0,
      unplacedParts,
      orderedParts: countsMatch ? Number(countsMatch[1]) : null,
      placedParts: countsMatch ? Number(countsMatch[2]) : null,
      warning:
        unplacedParts > 0
          ? unplacedParts + ' parça yerleşmedi. Sac adedini artırıp tekrar deneyin.'
          : '',
      stdout: out,
      stderr: err,
    };
  }
  const hata = [...lines].reverse().find((line) => /^HATA(?:\s|$)/i.test(line));
  return {
    ok: false,
    exitCode: Number.isFinite(Number(exitCode)) ? Number(exitCode) : -1,
    code: Number(exitCode) === 0 ? 'script_protocol' : 'script_failed',
    error: hata || err || explainMetalixCode('script_protocol'),
    stdout: out,
    stderr: err,
  };
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  const err = new Error('zip_invalid');
  err.code = 'zip_invalid';
  throw err;
}

function readZipEntries(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) {
    const err = new Error('zip_invalid');
    err.code = 'zip_invalid';
    throw err;
  }
  const eocd = findEocd(buf);
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    const err = new Error('zip_unsupported');
    err.code = 'zip_unsupported';
    throw err;
  }
  const entries = [];
  let cursor = cdOffset;
  const cdEnd = cdOffset + cdSize;
  for (let n = 0; n < total; n += 1) {
    if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== 0x02014b50) {
      const err = new Error('zip_invalid');
      err.code = 'zip_invalid';
      throw err;
    }
    const flags = buf.readUInt16LE(cursor + 8);
    const method = buf.readUInt16LE(cursor + 10);
    const compSize = buf.readUInt32LE(cursor + 20);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    if (flags & 0x1) {
      const err = new Error('zip_unsupported');
      err.code = 'zip_unsupported';
      throw err;
    }
    if (localOffset === 0xffffffff || compSize === 0xffffffff) {
      const err = new Error('zip_unsupported');
      err.code = 'zip_unsupported';
      throw err;
    }
    entries.push({ name, method, compSize, localOffset });
    cursor += 46 + nameLen + extraLen + commentLen;
    if (cursor > cdEnd + 1) break;
  }
  return entries;
}

function safeZipTarget(root, name) {
  const normalized = String(name || '').replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    const err = new Error('zip_slip');
    err.code = 'zip_slip';
    throw err;
  }
  const parts = normalized.split('/').filter((part) => part && part !== '.');
  if (!parts.length || parts.some((part) => part === '..')) {
    const err = new Error('zip_slip');
    err.code = 'zip_slip';
    throw err;
  }
  const target = path.resolve(root, ...parts);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (target !== root && !target.startsWith(prefix)) {
    const err = new Error('zip_slip');
    err.code = 'zip_slip';
    throw err;
  }
  return { target, directory: normalized.endsWith('/') };
}

function entryBytes(buf, entry) {
  const local = entry.localOffset;
  if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) {
    const err = new Error('zip_invalid');
    err.code = 'zip_invalid';
    throw err;
  }
  const nameLen = buf.readUInt16LE(local + 26);
  const extraLen = buf.readUInt16LE(local + 28);
  const start = local + 30 + nameLen + extraLen;
  const end = start + entry.compSize;
  if (end > buf.length) {
    const err = new Error('zip_invalid');
    err.code = 'zip_invalid';
    throw err;
  }
  const compressed = buf.subarray(start, end);
  if (entry.method === 0) return compressed;
  if (entry.method === 8) return zlib.inflateRawSync(compressed);
  const err = new Error('zip_unsupported');
  err.code = 'zip_unsupported';
  throw err;
}

function extractZip(buffer, destDir) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const root = path.resolve(destDir);
  const entries = readZipEntries(buf);
  const planned = entries.map((entry) => ({
    entry,
    located: safeZipTarget(root, entry.name),
    bytes: entry.name.endsWith('/') ? null : entryBytes(buf, entry),
  }));
  fs.mkdirSync(root, { recursive: true });
  const files = [];
  planned.forEach((item) => {
    if (item.located.directory) {
      fs.mkdirSync(item.located.target, { recursive: true });
      return;
    }
    fs.mkdirSync(path.dirname(item.located.target), { recursive: true });
    fs.writeFileSync(item.located.target, item.bytes);
    files.push(item.located.target);
  });
  return files;
}

function localDest(dir) {
  if (path.win32.isAbsolute(dir) || path.posix.isAbsolute(dir)) return dir;
  return path.resolve(dir);
}

module.exports = {
  DIR_MAX,
  CSV_MAX_BYTES,
  NEST_PROFILE,
  MESSAGES,
  explainMetalixCode,
  validateMoId,
  validateDir,
  validateGroup,
  metalixNumber,
  formatOrdLine,
  parseOrdLine,
  pathIsUnderDir,
  partIdFromDxf,
  isOrdFilePath,
  decodeTextBuffer,
  decodeOrdText,
  isPerfexNestCsv,
  parseCsvLine,
  inspectPerfexNestCsv,
  inspectOrdText,
  nestFilename,
  prepareNestCsv,
  nestProfile,
  nestJsonBody,
  ordEndpointPaths,
  nestEndpointPaths,
  joinApiUrl,
  isZipPayload,
  filenameFromDisposition,
  interpretGroups,
  interpretOrdDownload,
  interpretNestPost,
  interpretNestList,
  nestScriptOptions,
  nestScriptArgs,
  parseNestScriptResult,
  extractZip,
  localDest,
  readZipEntries,
  apiDir,
  ordDownloadQuery,
  isOrdDownloadPath,
  rewriteOrdPostToGet,
  ordDownloadNeedsPost,
  isMetalixSendLabel,
  moIdFromPageUrl,
  normalizeMetalixGroup,
  metalixBridgePayload,
};
