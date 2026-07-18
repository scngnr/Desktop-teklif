const { execFile } = require('child_process');
const os = require('os');
const { promisify } = require('util');
const config = require('./config');

const execFileAsync = promisify(execFile);

const LICENSE_BASE =
  'https://nextjs-teklif-sunucu.vercel.app/api';
const APP_DOSYA_ADI = 'desktop-teklif';

function normalizeMac(mac) {
  return String(mac || '')
    .trim()
    .replace(/-/g, ':')
    .toUpperCase();
}

function isLicenseActive(value) {
  if (value === true || value === 1) return true;
  const s = String(value || '').trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'aktif' || s === 'active';
}

async function getMacAddress() {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          "(Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.HardwareInterface -and $_.MacAddress } | Sort-Object -Property ifIndex | Select-Object -First 1 -ExpandProperty MacAddress)",
        ],
        { windowsHide: true, timeout: 8000 }
      );
      const mac = normalizeMac(stdout);
      if (/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) return mac;
    } catch {
      // fallback below
    }
  }

  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.internal) continue;
      if (!info.mac || info.mac === '00:00:00:00:00:00') continue;
      return normalizeMac(info.mac);
    }
  }
  throw new Error('MAC adresi alınamadı.');
}

async function licenseRequest(method, path, body) {
  const url = `${LICENSE_BASE}${path.startsWith('/') ? path : `/${path}`}`;
  const res = await fetch(url, {
    method,
    headers:
      body !== undefined
        ? {
            Accept: 'application/json',
            'Content-Type': 'application/json; charset=utf-8',
          }
        : { Accept: 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'follow',
  });
  const text = await res.text().catch(() => '');
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, text, json, url };
}

async function getLicense(mac) {
  const encoded = encodeURIComponent(mac);
  return licenseRequest('GET', `/license/${encoded}/`);
}

/**
 * Yeni MAC için başvuru. Mevcut kayıtta farklı dosyaAdı ihlal tetikleyebilir —
 * bu yüzden yalnızca kayıt yoksa POST edilir.
 */
async function registerLicense(mac, meta = {}) {
  const cfg = config.getPublic();
  const body = {
    macAdresi: mac,
    firmaAdi: meta.firmaAdi || cfg.firmaAdi || 'Desktop Teklif',
    userAdi: meta.userAdi || 'Desktop Teklif',
    dosyaAdi: meta.dosyaAdi || APP_DOSYA_ADI,
  };
  return licenseRequest('POST', '/license/', body);
}

/**
 * MAC ile lisans kontrolü (+ gerekirse ilk başvuru).
 * Teklif butonu: licensed === true iken açılır.
 */
async function checkAndEnsureLicense(meta = {}) {
  const mac = await getMacAddress();
  let getResult = await getLicense(mac);
  let registered = false;
  let ihlal = false;

  const missing =
    getResult.status === 404 ||
    (getResult.json && getResult.json.success === false) ||
    !(getResult.json && getResult.json.data);

  if (missing) {
    const postResult = await registerLicense(mac, meta);
    registered = true;
    ihlal = !!(postResult.json && postResult.json.ihlal);
    getResult = await getLicense(mac);
  }

  const data = (getResult.json && getResult.json.data) || null;
  const licensed = !!(data && isLicenseActive(data.license));

  return {
    ok: true,
    mac,
    licensed,
    registered,
    ihlal,
    firmaAdi: data ? data.firmaAdi || '' : '',
    userAdi: data ? data.userAdi || '' : '',
    dosyaAdi: data ? data.dosyaAdi || '' : '',
    updatedAt: data ? data.updatedAt || null : null,
    raw: getResult.json,
    apiReachable: getResult.status > 0,
  };
}

module.exports = {
  LICENSE_BASE,
  APP_DOSYA_ADI,
  getMacAddress,
  getLicense,
  registerLicense,
  checkAndEnsureLicense,
  isLicenseActive,
  normalizeMac,
};
