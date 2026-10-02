const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  baseUrl: 'https://mrp.cangungor.tr',
  firmaAdi: '',
  authHeaderName: 'authtoken',
  authToken: '',
  /** Lisans / remote module API kökü (sonunda /api) */
  apiBaseUrl: 'https://nextjs-teklif-sunucu.vercel.app/api',
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
  /** Son seçilen Metalix klasörü — yalnızca bu bilgisayarda */
  metalixDir: '',
  /** AutoNest COM varsayılanları — Ayarlar ekranından değiştirilebilir */
  metalixMachineNo: '1',
  metalixSheetX: '2500',
  metalixSheetY: '1250',
  metalixReportTemplate: 'RPT_AN_ALL_AUT_ENG_Perfex.csv',
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

/**
 * SaaS tenant REST kökü — Giriş URL'den türetilir (adminRoot eksi /admin).
 * firma set → {base}/{firma}/ps   |  firma boş → {base}
 * İstekler: {apiRoot}/api/...
 */
function buildApiRoot(baseUrl, firmaAdi) {
  return buildAdminRoot(baseUrl, firmaAdi).replace(/\/admin\/?$/, '');
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
    if (typeof raw.apiBaseUrl === 'string' && raw.apiBaseUrl.trim()) {
      runtime.apiBaseUrl = raw.apiBaseUrl.trim().replace(/\/+$/, '');
    }
    if (typeof raw.showDesktopFab === 'boolean') {
      runtime.showDesktopFab = raw.showDesktopFab;
    }
    if (typeof raw.metalixDir === 'string') runtime.metalixDir = raw.metalixDir.trim();
    if (typeof raw.metalixMachineNo === 'string' && raw.metalixMachineNo.trim()) {
      runtime.metalixMachineNo = raw.metalixMachineNo.trim();
    } else if (Number.isFinite(raw.metalixMachineNo)) {
      runtime.metalixMachineNo = String(raw.metalixMachineNo);
    }
    if (typeof raw.metalixSheetX === 'string' && raw.metalixSheetX.trim()) {
      runtime.metalixSheetX = raw.metalixSheetX.trim();
    }
    if (typeof raw.metalixSheetY === 'string' && raw.metalixSheetY.trim()) {
      runtime.metalixSheetY = raw.metalixSheetY.trim();
    }
    if (typeof raw.metalixReportTemplate === 'string' && raw.metalixReportTemplate.trim()) {
      runtime.metalixReportTemplate = raw.metalixReportTemplate.trim();
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
  if (partial.apiBaseUrl !== undefined) {
    runtime.apiBaseUrl = String(partial.apiBaseUrl || '')
      .trim()
      .replace(/\/+$/, '');
  }
  if (partial.showDesktopFab !== undefined) {
    runtime.showDesktopFab = !!partial.showDesktopFab;
  }
  if (partial.metalixDir !== undefined) {
    runtime.metalixDir = String(partial.metalixDir || '').trim();
  }
  if (partial.metalixMachineNo !== undefined) {
    runtime.metalixMachineNo = String(partial.metalixMachineNo || '').trim();
  }
  if (partial.metalixSheetX !== undefined) {
    runtime.metalixSheetX = String(partial.metalixSheetX || '').trim();
  }
  if (partial.metalixSheetY !== undefined) {
    runtime.metalixSheetY = String(partial.metalixSheetY || '').trim();
  }
  if (partial.metalixReportTemplate !== undefined) {
    runtime.metalixReportTemplate = String(partial.metalixReportTemplate || '').trim();
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
        apiBaseUrl: runtime.apiBaseUrl,
        showDesktopFab: !!runtime.showDesktopFab,
        metalixDir: runtime.metalixDir || '',
        metalixMachineNo: runtime.metalixMachineNo || '',
        metalixSheetX: runtime.metalixSheetX || '',
        metalixSheetY: runtime.metalixSheetY || '',
        metalixReportTemplate: runtime.metalixReportTemplate || '',
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
    apiRoot: buildApiRoot(runtime.baseUrl, runtime.firmaAdi),
    authToken: runtime.authToken,
    hasAuthToken: hasAuthToken(),
    apiBaseUrl: runtime.apiBaseUrl,
    showDesktopFab: !!runtime.showDesktopFab,
    metalixDir: runtime.metalixDir || '',
    metalixMachineNo: runtime.metalixMachineNo || '',
    metalixSheetX: runtime.metalixSheetX || '',
    metalixSheetY: runtime.metalixSheetY || '',
    metalixReportTemplate: runtime.metalixReportTemplate || '',
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
  buildApiRoot,
  normalizeFirmaAdi,
  DEFAULTS,
};
