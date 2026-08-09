const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  baseUrl: 'https://mrp.cangungor.tr',
  firmaAdi: '',
  authHeaderName: 'authtoken',
  authToken: '',
  /** Uygulama açıkken ekran sağ altında yüzen Yeni Teklif butonu */
  showDesktopFab: false,
  lastNumberPath: '/api/teklif/last_number',
  sampleFolderName: 'örnek klasör',
  teklifSubfolder: '4-Teklif',
  excelNamePrefix: 'Yeni Teklif V1.21',
  // create_safe / api/teklif için varsayılan müşteri alanları
  defaultRelId: 1,
  defaultProposalTo: 'Desktop Teklif',
  defaultEmail: 'no-reply@local.invalid',
};

let runtime = { ...DEFAULTS };

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function normalizeBaseUrl(url) {
  let b = String(url || '').trim();
  if (/:\/\/rmp\.cangungor\.tr/i.test(b)) {
    b = b.replace(/:\/\/rmp\.cangungor\.tr/gi, '://mrp.cangungor.tr');
  }
  while (b.endsWith('/')) b = b.slice(0, -1);
  return b;
}

function normalizeFirmaAdi(name) {
  return String(name || '')
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/\s+/g, '');
}

/** Giriş / panel kökü: base / firma / ps / admin  (firma yoksa base / admin) */
function buildAdminRoot(baseUrl, firmaAdi) {
  const base = normalizeBaseUrl(baseUrl || runtime.baseUrl);
  const firma = normalizeFirmaAdi(
    firmaAdi !== undefined ? firmaAdi : runtime.firmaAdi
  );
  if (firma) return `${base}/${firma}/ps/admin`;
  return `${base}/admin`;
}

function load() {
  try {
    const file = settingsPath();
    if (!fs.existsSync(file)) return;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw.baseUrl) runtime.baseUrl = normalizeBaseUrl(raw.baseUrl);
    if (typeof raw.firmaAdi === 'string') {
      runtime.firmaAdi = normalizeFirmaAdi(raw.firmaAdi);
    }
    if (typeof raw.authToken === 'string') runtime.authToken = raw.authToken.trim();
    if (typeof raw.showDesktopFab === 'boolean') {
      runtime.showDesktopFab = raw.showDesktopFab;
    }
  } catch {
    // varsayılanlarla devam
  }
}

function save(partial) {
  if (partial.baseUrl !== undefined) {
    runtime.baseUrl = normalizeBaseUrl(partial.baseUrl);
  }
  if (partial.firmaAdi !== undefined) {
    runtime.firmaAdi = normalizeFirmaAdi(partial.firmaAdi);
  }
  if (partial.authToken !== undefined) {
    runtime.authToken = String(partial.authToken || '').trim();
  }
  if (partial.showDesktopFab !== undefined) {
    runtime.showDesktopFab = !!partial.showDesktopFab;
  }

  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        baseUrl: runtime.baseUrl,
        firmaAdi: runtime.firmaAdi,
        authToken: runtime.authToken,
        showDesktopFab: !!runtime.showDesktopFab,
      },
      null,
      2
    ),
    'utf8'
  );

  return getPublic();
}

function get() {
  return runtime;
}

function hasAuthToken() {
  return Boolean(String(runtime.authToken || '').trim());
}

function getPublic() {
  return {
    baseUrl: runtime.baseUrl,
    firmaAdi: runtime.firmaAdi,
    adminRoot: buildAdminRoot(runtime.baseUrl, runtime.firmaAdi),
    authToken: runtime.authToken,
    hasAuthToken: hasAuthToken(),
    showDesktopFab: !!runtime.showDesktopFab,
    lastNumberPath: runtime.lastNumberPath,
    authHeaderName: runtime.authHeaderName,
    sampleFolderName: runtime.sampleFolderName,
  };
}

module.exports = {
  load,
  save,
  get,
  getPublic,
  hasAuthToken,
  buildAdminRoot,
  normalizeFirmaAdi,
  DEFAULTS,
};
