const config = require('./config');

/**
 * Bugünün tarihini ddmmyy formatında döndürür (yerel saat).
 * @returns {string}
 */
function formatTodayDdMmYy() {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yy = String(now.getFullYear()).slice(-2);
  return `${dd}${mm}${yy}`;
}

/**
 * formula: proposal_prefix + ddmmyy + "-" + (last_proposal_id + 1)
 */
function computeNextTeklifNumber(data) {
  const prefix = data.proposal_prefix || '';
  const nextId = Number(data.last_proposal_id) + 1;
  return `${prefix}${formatTodayDdMmYy()}-${nextId}`;
}

function formatTeklifNumber(prefix, proposalId) {
  return `${prefix || ''}${formatTodayDdMmYy()}-${Number(proposalId)}`;
}

function getAuthHeaders(extra = {}) {
  const cfg = config.get();
  return {
    [cfg.authHeaderName]: cfg.authToken,
    Accept: 'application/json',
    ...extra,
  };
}

async function apiRequest(method, path, body) {
  const cfg = config.get();
  const base = cfg.baseUrl.replace(/\/$/, '');
  const p = String(path || '').replace(/^\//, '');
  const url = `${base}/${p}`;

  const headers = getAuthHeaders(
    body !== undefined
      ? { 'Content-Type': 'application/json; charset=utf-8' }
      : {}
  );

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text().catch(() => '');
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  return {
    ok: res.ok,
    status: res.status,
    text,
    json,
    url,
  };
}

/**
 * GET /api/teklif/last_number
 */
async function fetchLastNumber() {
  const result = await apiRequest('GET', 'api/teklif/last_number');
  if (!result.ok) {
    throw new Error(
      `API hatası (${result.status}): ${result.text || 'last_number alınamadı'}`
    );
  }

  const data = result.json;
  if (!data || data.status === false) {
    throw new Error('API geçersiz yanıt döndü (status false).');
  }

  const nextId = Number(data.last_proposal_id) + 1;
  const nextTeklifNumber = computeNextTeklifNumber(data);
  return { ...data, nextId, nextTeklifNumber };
}

function extractProposalId(payload) {
  if (!payload || typeof payload !== 'object') return 0;
  const candidates = [
    payload.proposal_id,
    payload.id,
    payload.teklif_id,
    payload.data && payload.data.proposal_id,
    payload.data && payload.data.id,
    payload.result && payload.result.proposal_id,
    payload.result && payload.result.id,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

/**
 * POST api/teklif/create_safe — VBA MrpApi_TeklifCreate
 * subject olarak teklif numarası gönderilir.
 * create_safe yoksa api/teklif'e düşer.
 */
async function createTeklifRecord(teklifNumber) {
  const cfg = config.get();
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');

  const body = {
    subject: teklifNumber,
    rel_type: 'customer',
    rel_id: Number(cfg.defaultRelId) || 1,
    proposal_to: cfg.defaultProposalTo || 'Desktop Teklif',
    email: cfg.defaultEmail || 'no-reply@local.invalid',
    date: `${yyyy}-${mm}-${dd}`,
    currency: '1',
    status: '6',
    subtotal: 1,
    total: 1,
    newitems: [
      {
        description: teklifNumber,
        long_description: '',
        qty: 1,
        rate: 1,
        order: 1,
        unit: '',
      },
    ],
  };

  let result = await apiRequest('POST', 'api/teklif/create_safe', body);

  const needFallback =
    result.status === 404 ||
    result.status === 405 ||
    (result.text && /Unknown method/i.test(result.text));

  if (needFallback) {
    result = await apiRequest('POST', 'api/teklif', body);
  }

  if (!result.ok) {
    throw new Error(
      `Teklif API kaydı başarısız (HTTP ${result.status}): ${result.text.slice(0, 400)}`
    );
  }

  if (result.json && result.json.status === false) {
    throw new Error(
      `Teklif API kaydı reddedildi: ${result.json.message || result.text.slice(0, 300)}`
    );
  }

  const proposalId = extractProposalId(result.json);
  return {
    proposalId,
    response: result.json,
    requestUrl: result.url,
    subject: teklifNumber,
  };
}

function stripHtml(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseCompanyFromHtml(html) {
  const raw = String(html || '');
  const titleMatch = raw.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) {
    let title = stripHtml(titleMatch[1]);
    title = title
      .replace(/\s*[-|–]\s*Login\s*$/i, '')
      .replace(/\s*[-|–]\s*Giriş\s*$/i, '')
      .replace(/\s*Please login or register\s*$/i, '')
      .trim();
    if (title && !/^please login/i.test(title)) return title;
  }

  const altMatch = raw.match(/<img[^>]+alt=["']([^"']+)["']/i);
  if (altMatch) {
    const alt = stripHtml(altMatch[1]);
    if (alt) return alt;
  }

  return '';
}

/**
 * Firma / şirket adını admin API guide (veya login) sayfasından alır.
 * Kaynak: {adminRoot}/api/api_guide → login HTML title/alt
 */
async function fetchCompanyName() {
  const cfg = config.getPublic();
  const adminRoot = (cfg.adminRoot || `${cfg.baseUrl}/admin`).replace(/\/+$/, '');
  const candidates = [
    `${adminRoot}/api/api_guide`,
    adminRoot,
    `${cfg.baseUrl.replace(/\/+$/, '')}/admin/authentication`,
  ];

  for (const url of candidates) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'text/html,application/xhtml+xml' },
        redirect: 'follow',
      });
      const html = await res.text();
      const name = parseCompanyFromHtml(html);
      if (name) {
        return { ok: true, companyName: name, source: url };
      }
    } catch {
      // sonraki aday
    }
  }

  try {
    const companyApi = await apiRequest('GET', 'api/teklif/company');
    const apiName = companyApi.json &&
      companyApi.json.company &&
      companyApi.json.company.company_name;
    if (apiName && String(apiName).trim()) {
      return {
        ok: true,
        companyName: String(apiName).trim(),
        source: 'api/teklif/company',
      };
    }
  } catch {
    // ignore
  }

  const fallback = cfg.firmaAdi || 'Desktop Teklif';
  return { ok: false, companyName: fallback, source: 'fallback' };
}

/**
 * JWT payload lokal decode (VBA: MrpApi_TokenOwnerInfo).
 */
function decodeTokenOwner() {
  const token = config.get().authToken || '';
  const parts = token.split('.');
  if (parts.length < 2) return null;

  try {
    let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = (4 - (payload.length % 4)) % 4;
    if (pad) payload += '='.repeat(pad);
    const json = Buffer.from(payload, 'base64').toString('utf8');
    const raw = JSON.parse(json);
    const name = String(raw.name || raw.user || '').trim();
    const user = String(raw.user || '').trim();
    return { name: name || user || 'Kullanıcı', user, raw };
  } catch {
    return null;
  }
}

module.exports = {
  formatTodayDdMmYy,
  computeNextTeklifNumber,
  formatTeklifNumber,
  fetchLastNumber,
  createTeklifRecord,
  fetchCompanyName,
  decodeTokenOwner,
  getConfigPublic: () => config.getPublic(),
};
