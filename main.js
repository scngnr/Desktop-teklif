const { app, BrowserWindow, ipcMain, shell, Menu, session } = require('electron');
const path = require('path');
const config = require('./src/config');
const {
  fetchLastNumber,
  fetchCompaniesContacts,
  createTeklifRecord,
  formatTeklifNumber,
  getConfigPublic,
  decodeTokenOwner,
  fetchCompanyName,
} = require('./src/mrpApi');
const { createTeklifFolder, resolveSampleFolder } = require('./src/folderService');
const history = require('./src/history');
const { checkAndEnsureLicense } = require('./src/licenseService');

const WEBVIEW_PARTITION = 'persist:mrp';
let lastLicenseStatus = null;
const SESSION_COOKIE_RE =
  /^(sp_session|ci_session|PHPSESSID|laravel_session|remember|session)/i;

let mainWindow = null;

function getMrpSession() {
  return session.fromPartition(WEBVIEW_PARTITION);
}

async function isWebLoggedIn() {
  const cfg = config.getPublic();
  const urls = [cfg.baseUrl, cfg.adminRoot].filter(Boolean);
  const ses = getMrpSession();
  const seen = new Set();
  const names = [];

  for (const url of urls) {
    try {
      const cookies = await ses.cookies.get({ url });
      for (const c of cookies) {
        if (seen.has(c.name)) continue;
        seen.add(c.name);
        names.push(c.name);
      }
    } catch {
      // ignore per-url failures
    }
  }

  const loggedIn = names.some((name) => SESSION_COOKIE_RE.test(name));
  return { ok: true, loggedIn, cookieNames: names };
}

function createWindow() {
  const iconPath = path.join(__dirname, 'build', 'icon.png');
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 560,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0f1419',
    show: false,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile('index.html');
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  config.load();
  createWindow();

  const mrpSession = getMrpSession();
  let cookieNotifyTimer = null;
  mrpSession.cookies.on('changed', (_event, cookie) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!cookie || !SESSION_COOKIE_RE.test(cookie.name)) return;
    if (cookieNotifyTimer) clearTimeout(cookieNotifyTimer);
    cookieNotifyTimer = setTimeout(async () => {
      cookieNotifyTimer = null;
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const status = await isWebLoggedIn();
      mainWindow.webContents.send('session:changed', status);
    }, 250);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('window:minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.handle('window:close', () => {
  if (mainWindow) mainWindow.close();
});

ipcMain.handle('config:get', () => getConfigPublic());

ipcMain.handle('config:save', (_event, partial) => {
  try {
    const saved = config.save(partial || {});
    return { ok: true, config: saved };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('user:info', () => {
  const owner = decodeTokenOwner();
  if (!owner) {
    return { ok: false, error: 'JWT çözümlenemedi' };
  }
  return {
    ok: true,
    name: owner.name,
    user: owner.user,
  };
});

ipcMain.handle('sample:resolve', () => {
  try {
    return { ok: true, path: resolveSampleFolder() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('customers:list', async () => {
  try {
    if (!config.hasAuthToken()) {
      return {
        ok: false,
        companies: [],
        error: 'JWT token yok. Ayarlar’dan token girin.',
        needSettings: true,
      };
    }
    const companies = await fetchCompaniesContacts();
    return { ok: true, companies };
  } catch (err) {
    return { ok: false, companies: [], error: err.message || String(err) };
  }
});

ipcMain.handle('license:check', async () => {
  try {
    const owner = decodeTokenOwner();
    const status = await checkAndEnsureLicense({
      userAdi: owner && owner.name ? owner.name : undefined,
      firmaAdi: config.getPublic().firmaAdi || undefined,
    });
    lastLicenseStatus = status;
    return status;
  } catch (err) {
    lastLicenseStatus = {
      ok: false,
      licensed: false,
      error: err.message || String(err),
      apiReachable: false,
    };
    return lastLicenseStatus;
  }
});

ipcMain.handle('teklif:create', async (_event, payload = {}) => {
  try {
    if (!config.hasAuthToken()) {
      return {
        ok: false,
        error: 'JWT token yok. Ayarlar’dan token girin.',
        needSettings: true,
      };
    }

    let license = lastLicenseStatus;
    if (!license || !license.licensed) {
      license = await checkAndEnsureLicense();
      lastLicenseStatus = license;
    }
    if (!license.licensed) {
      return {
        ok: false,
        error:
          'Lisans aktif değil. Bu cihaz için teklif sunucu lisansı gerekli.',
        needLicense: true,
        license,
      };
    }

    const relId = Number(payload.relId) || 0;
    const customerName = String(payload.customerName || '').trim();
    const contactName = String(payload.contactName || '').trim();
    const contactEmail = String(payload.contactEmail || '').trim();
    const projectName = String(payload.projectName || '').trim();

    const last = await fetchLastNumber();
    let teklifName = last.nextTeklifNumber;
    let proposalId = last.nextId;

    // proposal_to: proje adı (yoksa kişi/firma); Desktop Teklif yerine
    const proposalTo =
      projectName || contactName || customerName || undefined;

    const created = await createTeklifRecord(teklifName, {
      relId: relId > 0 ? relId : undefined,
      proposalTo,
      email: contactEmail || undefined,
    });
    if (created.proposalId > 0) {
      proposalId = created.proposalId;
      teklifName = formatTeklifNumber(last.proposal_prefix, proposalId);
    }

    const folder = createTeklifFolder(
      teklifName,
      customerName || '',
      projectName || ''
    );
    const displayName = folder.folderLabel || teklifName;
    const item = {
      teklifName: displayName,
      proposalId,
      destPath: folder.destPath,
      customerName: customerName || '',
      projectName: projectName || '',
      createdAt: new Date().toISOString(),
    };
    history.add(item);

    return {
      ok: true,
      teklifName: displayName,
      proposalNumber: teklifName,
      proposalId,
      customerName: customerName || '',
      projectName: projectName || '',
      api: {
        proposal_prefix: last.proposal_prefix,
        last_proposal_id: last.last_proposal_id,
        last_proposal_number: last.last_proposal_number,
        created: true,
        createResponse: created.response,
      },
      destPath: folder.destPath,
      sampleSource: folder.sampleSource,
      renamedExcels: folder.renamedExcels,
    };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('history:list', () => {
  try {
    return { ok: true, items: history.load() };
  } catch (err) {
    return { ok: false, items: [], error: err.message || String(err) };
  }
});

ipcMain.handle('shell:openPath', async (_event, targetPath) => {
  if (!targetPath) return { ok: false };
  const result = await shell.openPath(targetPath);
  return { ok: !result, error: result || null };
});

ipcMain.handle('session:isLoggedIn', async () => {
  try {
    return await isWebLoggedIn();
  } catch (err) {
    return { ok: false, loggedIn: false, error: err.message || String(err) };
  }
});

ipcMain.handle('company:name', async () => {
  try {
    return await fetchCompanyName();
  } catch (err) {
    return {
      ok: false,
      companyName: 'Desktop Teklif',
      error: err.message || String(err),
    };
  }
});
