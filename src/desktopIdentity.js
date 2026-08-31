/**
 * Perfex mrp_theme PR #12 sözleşmesi:
 * Electron webview, User-Agent içinde `DesktopTeklif/1` taşır ve
 * `mrp_desktop=1` çerezi set eder. Tema bu işaretlerle kenar çubuğuna
 * Yeni teklif / Operasyon / Ayarlar ekler (normal tarayıcıda yok).
 *
 * Tespit güvenlik sınırı değildir — yalnızca UI işaretidir.
 */

const UA_TOKEN = 'DesktopTeklif/1';
const COOKIE_NAME = 'mrp_desktop';
const COOKIE_VALUE = '1';
const PROTOCOL = 'desktop-teklif:';

const ACTION_ALIASES = {
  yeni: 'yeni-teklif',
  'yeni-teklif': 'yeni-teklif',
  yeni_teklif: 'yeni-teklif',
  yeniteklif: 'yeni-teklif',
  'new-proposal': 'yeni-teklif',
  new_proposal: 'yeni-teklif',
  teklif: 'yeni-teklif',
  operasyon: 'operasyon',
  operations: 'operasyon',
  operation: 'operasyon',
  ops: 'operasyon',
  ayarlar: 'ayarlar',
  settings: 'ayarlar',
  'desktop-settings': 'ayarlar',
  desktop_settings: 'ayarlar',
};

function withUaToken(existing) {
  const ua = String(existing || '').trim();
  if (!ua) return UA_TOKEN;
  if (ua.includes(UA_TOKEN)) return ua;
  return `${ua} ${UA_TOKEN}`;
}

function normalizeAction(raw) {
  if (raw == null) return null;
  const key = String(raw)
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, '')
    .replace(/[\s]+/g, '-');
  if (!key) return null;
  if (ACTION_ALIASES[key]) return ACTION_ALIASES[key];
  const stripped = key.replace(/^dt-/, '').replace(/^desktop[-_]?/, '');
  if (ACTION_ALIASES[stripped]) return ACTION_ALIASES[stripped];
  return null;
}

function queryParam(search, names) {
  try {
    const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
    for (const name of names) {
      const value = params.get(name);
      if (value) return value;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Perfex kenar çubuğu tıklamasından masaüstü eylemini çıkarır.
 * Normal Perfex sayfaları (ör. /admin/settings) yakalanmaz.
 */
function parseDesktopAction(rawUrl) {
  if (rawUrl == null) return normalizeAction(rawUrl);
  const text = String(rawUrl).trim();
  if (!text) return null;

  const direct = normalizeAction(text);
  if (direct) return direct;

  try {
    const url = new URL(text, 'https://desktop-teklif.local/');
    if (
      url.protocol === PROTOCOL ||
      url.protocol === 'desktop-teklif:' ||
      url.protocol === 'teklif:'
    ) {
      return (
        normalizeAction(url.hostname) ||
        normalizeAction(url.pathname) ||
        normalizeAction(url.pathname.replace(/^\//, ''))
      );
    }

    const fromQuery = queryParam(url.search, [
      'desktop_action',
      'dt_action',
      'dt',
      'desktop',
    ]);
    const qAction = normalizeAction(fromQuery);
    if (qAction) return qAction;

    const hash = (url.hash || '').replace(/^#/, '');
    const hashQuery = hash.includes('=') ? queryParam(hash, ['desktop-teklif', 'dt', 'action']) : null;
    const hAction =
      normalizeAction(hash) ||
      normalizeAction(hash.replace(/^dt-/, '')) ||
      normalizeAction(hashQuery);
    if (hAction) return hAction;

    const path = decodeURIComponent(url.pathname || '');
    const markers = [
      /\/(?:admin\/)?mrp_theme\/desktop\/([^/?#]+)/i,
      /\/desktop[-_]teklif\/([^/?#]+)/i,
      /\/desktop_teklif\/([^/?#]+)/i,
      /\/dt\/([^/?#]+)/i,
      /\/menu-item-dt-([^/?#]+)/i,
    ];
    for (const re of markers) {
      const m = path.match(re);
      if (m && m[1]) {
        const action = normalizeAction(m[1]);
        if (action) return action;
      }
    }

    const slugMatch = path.match(/dt-(yeni-teklif|operasyon|ayarlar|yeni_teklif|yeni)/i);
    if (slugMatch) return normalizeAction(slugMatch[1]);
  } catch {
    const proto = text.match(/^(?:desktop-teklif|teklif):\/?\/?([^/?#]+)/i);
    if (proto) return normalizeAction(proto[1]);
  }

  return null;
}

function uniqueHttpUrls(urls) {
  const seen = new Set();
  const out = [];
  for (const raw of urls || []) {
    const s = String(raw || '').trim();
    if (!s) continue;
    try {
      const u = new URL(s);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      const origin = `${u.protocol}//${u.host}`;
      if (seen.has(origin)) continue;
      seen.add(origin);
      out.push(origin + '/');
    } catch {
      // ignore invalid
    }
  }
  return out;
}

async function setDesktopCookie(ses, url) {
  await ses.cookies.set({
    url,
    name: COOKIE_NAME,
    value: COOKIE_VALUE,
    path: '/',
    httpOnly: false,
    secure: String(url).startsWith('https:'),
    expirationDate: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 400,
  });
}

async function applyDesktopIdentity(ses, urls) {
  if (!ses) return { ok: false, error: 'no-session' };

  try {
    if (typeof ses.setUserAgent === 'function') {
      const current =
        (typeof ses.getUserAgent === 'function' && ses.getUserAgent()) || '';
      ses.setUserAgent(withUaToken(current));
    }
  } catch {
    // bazı partition'larda setUserAgent yok
  }

  const origins = uniqueHttpUrls(urls);
  for (const url of origins) {
    try {
      await setDesktopCookie(ses, url);
    } catch {
      // origin henüz yüklenmemiş olabilir
    }
  }

  return { ok: true, origins, uaToken: UA_TOKEN };
}

function attachUserAgentRewrite(ses) {
  if (!ses || !ses.webRequest || attachUserAgentRewrite._done) return;
  attachUserAgentRewrite._done = true;
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders || {};
    const key = Object.keys(headers).find((k) => k.toLowerCase() === 'user-agent');
    const headerKey = key || 'User-Agent';
    headers[headerKey] = withUaToken(headers[headerKey] || '');
    callback({ requestHeaders: headers });
  });
}

module.exports = {
  UA_TOKEN,
  COOKIE_NAME,
  COOKIE_VALUE,
  PROTOCOL,
  withUaToken,
  normalizeAction,
  parseDesktopAction,
  applyDesktopIdentity,
  attachUserAgentRewrite,
};

if (require.main === module) {
  const assert = (cond, msg) => {
    if (!cond) {
      console.error('FAIL', msg);
      process.exitCode = 1;
    } else {
      console.log('ok', msg);
    }
  };
  assert(parseDesktopAction('desktop-teklif://yeni-teklif') === 'yeni-teklif', 'protocol yeni-teklif');
  assert(parseDesktopAction('teklif://yeni') === 'yeni-teklif', 'teklif protocol yeni');
  assert(parseDesktopAction('desktop-teklif://operasyon') === 'operasyon', 'protocol operasyon');
  assert(parseDesktopAction('desktop-teklif://ayarlar') === 'ayarlar', 'protocol ayarlar');
  assert(parseDesktopAction('yeni') === 'yeni-teklif', 'alias yeni');
  assert(
    parseDesktopAction('https://mrp.example/admin/mrp_theme/desktop/yeni') ===
      'yeni-teklif',
    'mrp_theme desktop yeni'
  );
  assert(
    parseDesktopAction('https://mrp.example/admin/mrp_theme/desktop/operasyon') ===
      'operasyon',
    'mrp_theme desktop operasyon'
  );
  assert(
    parseDesktopAction('https://mrp.example/admin/desktop_teklif/yeni_teklif') ===
      'yeni-teklif',
    'path yeni_teklif'
  );
  assert(
    parseDesktopAction('https://mrp.example/admin/settings') === null,
    'normal settings ignored'
  );
  assert(
    parseDesktopAction('https://mrp.example/admin?desktop_action=operasyon') ===
      'operasyon',
    'query action'
  );
  assert(parseDesktopAction('#dt-ayarlar') === 'ayarlar', 'hash slug');
  assert(withUaToken('Mozilla/5.0').includes(UA_TOKEN), 'ua token appended');
  assert(withUaToken('Mozilla/5.0 DesktopTeklif/1').split(UA_TOKEN).length === 2, 'ua not duplicated');
  if (!process.exitCode) console.log('desktopIdentity self-check passed');
}
