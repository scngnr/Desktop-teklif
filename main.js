const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  Menu,
  session,
  screen,
  Tray,
} = require('electron');
const path = require('path');
const fs = require('fs');
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
const remoteModule = require('./src/remoteModuleService');
const desktopIdentity = require('./src/desktopIdentity');
const floatingWindow = require('./src/floatingWindow');
const perfexMenuInject = require('./src/perfexMenuInject');

if (process.platform === 'linux') {
  floatingWindow.enableLinuxTransparency(app);
}

const WEBVIEW_PARTITION = 'persist:mrp';
let lastLicenseStatus = null;
const SESSION_COOKIE_RE =
  /^(sp_session|ci_session|PHPSESSID|laravel_session|remember|session)/i;

const FAB_W = 188;
const FAB_H = 64;
const FAB_MARGIN = 22;
const TEKLIF_MODAL_W = 520;
const TEKLIF_MODAL_H = 620;

let mainWindow = null;
let fabWindow = null;
let teklifModalWindow = null;
let tray = null;
let isQuitting = false;
let fabBusy = false;

function getAppIconPath() {
  const pngPath = path.join(__dirname, 'build', 'icon.png');
  const icoPath = path.join(__dirname, 'build', 'icon.ico');
  if (process.platform === 'win32' && fs.existsSync(icoPath)) return icoPath;
  if (fs.existsSync(pngPath)) return pngPath;
  if (fs.existsSync(icoPath)) return icoPath;
  return undefined;
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function hideMainWindowToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.hide();
}

function destroyTray() {
  if (!tray) return;
  tray.destroy();
  tray = null;
}

function createTray() {
  if (tray) return;
  const iconPath = getAppIconPath();
  if (!iconPath) return;

  try {
    tray = new Tray(iconPath);
  } catch (err) {
    console.log('[main] tray ikonu yüklenemedi:', err.message || err);
    return;
  }
  tray.setToolTip('Desktop Teklif');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Göster',
        click: () => showMainWindow(),
      },
      {
        label: 'Gizle',
        click: () => hideMainWindowToTray(),
      },
      { type: 'separator' },
      {
        label: 'Çıkış',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on('click', () => showMainWindow());
  tray.on('double-click', () => showMainWindow());
}

function getMrpSession() {
  return session.fromPartition(WEBVIEW_PARTITION);
}

function mrpIdentityUrls() {
  const cfg = config.getPublic();
  return [cfg.baseUrl, cfg.adminRoot].filter(Boolean);
}

async function applyMrpDesktopIdentity() {
  const ses = getMrpSession();
  desktopIdentity.attachUserAgentRewrite(ses);
  try {
    await desktopIdentity.applyDesktopIdentity(ses, mrpIdentityUrls());
  } catch (err) {
    console.log('[main] desktop identity:', err.message || err);
  }
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

function positionFabWindow() {
  if (!fabWindow || fabWindow.isDestroyed()) return;
  const display = screen.getPrimaryDisplay();
  const bounds = floatingWindow.cornerBounds(
    display.workArea,
    FAB_W,
    FAB_H,
    FAB_MARGIN
  );
  fabWindow.setBounds(bounds);
}

function canUseDesktopFab() {
  const licensed = !!(lastLicenseStatus && lastLicenseStatus.licensed);
  const modalOpen = !!(teklifModalWindow && !teklifModalWindow.isDestroyed());
  return config.hasAuthToken() && licensed && !fabBusy && !modalOpen;
}

function pushFabState() {
  if (!fabWindow || fabWindow.isDestroyed()) return;
  fabWindow.webContents.send('desktop-fab:state', {
    enabled: canUseDesktopFab(),
    busy: fabBusy,
  });
}

function destroyFabWindow() {
  if (!fabWindow || fabWindow.isDestroyed()) {
    fabWindow = null;
    return;
  }
  fabWindow.destroy();
  fabWindow = null;
}

function showFabWindow() {
  if (!fabWindow || fabWindow.isDestroyed()) return;
  positionFabWindow();
  floatingWindow.showOverlay(fabWindow, { stealFocus: false });
  pushFabState();
}

function createFabWindow() {
  if (fabWindow && !fabWindow.isDestroyed()) {
    showFabWindow();
    return;
  }

  fabWindow = new BrowserWindow(
    floatingWindow.overlayBrowserOptions({
      width: FAB_W,
      height: FAB_H,
      preload: path.join(__dirname, 'preload-fab.js'),
    })
  );

  floatingWindow.applyFloatingBehavior(fabWindow);
  positionFabWindow();
  fabWindow.loadFile('fab.html');
  fabWindow.once('ready-to-show', () => {
    if (!fabWindow || fabWindow.isDestroyed()) return;
    showFabWindow();
  });
  fabWindow.on('show', () => {
    if (!fabWindow || fabWindow.isDestroyed()) return;
    floatingWindow.applyFloatingBehavior(fabWindow);
    positionFabWindow();
  });
  fabWindow.on('closed', () => {
    fabWindow = null;
  });
}

function syncDesktopFab() {
  const enabled = !!config.getPublic().showDesktopFab;
  if (enabled) createFabWindow();
  else destroyFabWindow();
}

function destroyTeklifModalWindow() {
  if (!teklifModalWindow || teklifModalWindow.isDestroyed()) {
    teklifModalWindow = null;
    return;
  }
  teklifModalWindow.destroy();
  teklifModalWindow = null;
}

function positionTeklifModalWindow() {
  if (!teklifModalWindow || teklifModalWindow.isDestroyed()) return;
  const display = screen.getPrimaryDisplay();
  const bounds = floatingWindow.centerBounds(
    display.workArea,
    TEKLIF_MODAL_W,
    TEKLIF_MODAL_H
  );
  teklifModalWindow.setBounds(bounds);
}

function openTeklifModalWindow() {
  if (teklifModalWindow && !teklifModalWindow.isDestroyed()) {
    floatingWindow.showOverlay(teklifModalWindow, { stealFocus: true });
    return { ok: true };
  }

  if (
    !config.hasAuthToken() ||
    !(lastLicenseStatus && lastLicenseStatus.licensed) ||
    fabBusy
  ) {
    return { ok: false, error: 'JWT veya lisans eksik' };
  }

  teklifModalWindow = new BrowserWindow(
    floatingWindow.overlayBrowserOptions({
      width: TEKLIF_MODAL_W,
      height: TEKLIF_MODAL_H,
      preload: path.join(__dirname, 'preload-teklif-modal.js'),
    })
  );

  floatingWindow.applyFloatingBehavior(teklifModalWindow);
  positionTeklifModalWindow();
  teklifModalWindow.loadFile('teklif-modal.html');
  teklifModalWindow.once('ready-to-show', () => {
    if (!teklifModalWindow || teklifModalWindow.isDestroyed()) return;
    floatingWindow.showOverlay(teklifModalWindow, { stealFocus: true });
  });
  teklifModalWindow.on('closed', () => {
    teklifModalWindow = null;
    pushFabState();
    if (fabWindow && !fabWindow.isDestroyed() && config.getPublic().showDesktopFab) {
      showFabWindow();
    }
  });

  if (fabWindow && !fabWindow.isDestroyed()) {
    fabWindow.hide();
  }
  pushFabState();
  return { ok: true };
}

function createWindow() {
  const iconPath = getAppIconPath();
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
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    syncDesktopFab();
  });
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    hideMainWindowToTray();
  });
  mainWindow.on('closed', () => {
    destroyTeklifModalWindow();
    destroyFabWindow();
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  config.load();
  createTray();
  await applyMrpDesktopIdentity();
  createWindow();

  // VBA zInternet.RunBootAutoStartIfNeeded karşılığı
  setTimeout(() => {
    remoteModule.runBootAutoStartIfNeeded().catch((err) => {
      console.log('[main] boot auto-start:', err.message || err);
    });
  }, 1500);

  screen.on('display-metrics-changed', () => {
    positionFabWindow();
    positionTeklifModalWindow();
  });
  screen.on('display-added', () => {
    positionFabWindow();
    positionTeklifModalWindow();
  });
  screen.on('display-removed', () => {
    positionFabWindow();
    positionTeklifModalWindow();
  });

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
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    else showMainWindow();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  destroyTray();
  destroyTeklifModalWindow();
  destroyFabWindow();
});

app.on('window-all-closed', () => {
  // Tray aktifken arka planda kal; cikis tray menuden yapilir.
  if (!isQuitting) return;
  destroyTeklifModalWindow();
  destroyFabWindow();
});

ipcMain.handle('window:minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.handle('window:close', () => {
  hideMainWindowToTray();
});

ipcMain.handle('config:get', () => getConfigPublic());

ipcMain.handle('config:save', (_event, partial) => {
  try {
    const saved = config.save(partial || {});
    syncDesktopFab();
    pushFabState();
    applyMrpDesktopIdentity();
    return { ok: true, config: saved };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.on('desktop:parseAction', (event, url) => {
  event.returnValue = desktopIdentity.parseDesktopAction(url);
});

ipcMain.on('desktop:perfexInject', (event, payload) => {
  event.returnValue = perfexMenuInject.buildPerfexMenuInjectScript(
    perfexMenuInject.buildPerfexMenuPayload(payload || {})
  );
});

ipcMain.on('app:webviewPreload', (event) => {
  event.returnValue = path.join(__dirname, 'preload-webview.js');
});

ipcMain.handle('desktop:identity', () => ({
  ok: true,
  uaToken: desktopIdentity.UA_TOKEN,
  cookieName: desktopIdentity.COOKIE_NAME,
  cookieValue: desktopIdentity.COOKIE_VALUE,
}));

ipcMain.on('desktop-fab:ready', () => {
  pushFabState();
});

ipcMain.handle('desktop-fab:click', () => {
  return openTeklifModalWindow();
});

ipcMain.handle('desktop-fab:setBusy', (_event, busy) => {
  fabBusy = !!busy;
  pushFabState();
  return { ok: true };
});

ipcMain.handle('teklif-modal:close', () => {
  destroyTeklifModalWindow();
  return { ok: true };
});

ipcMain.on('teklif-modal:created', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('history:changed');
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

ipcMain.handle('teklif:previewNext', async () => {
  try {
    if (!config.hasAuthToken()) {
      return {
        ok: false,
        error: 'JWT token yok. Ayarlar’dan token girin.',
        needSettings: true,
      };
    }
    const last = await fetchLastNumber();
    return {
      ok: true,
      nextTeklifNumber: last.nextTeklifNumber,
      proposal_prefix: last.proposal_prefix,
      last_proposal_id: last.last_proposal_id,
    };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
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
    pushFabState();
    return status;
  } catch (err) {
    lastLicenseStatus = {
      ok: false,
      licensed: false,
      error: err.message || String(err),
      apiReachable: false,
    };
    pushFabState();
    return lastLicenseStatus;
  }
});

ipcMain.handle('remote:run', async (_event, methodName, extraParam) => {
  try {
    return await remoteModule.runRemoteCode(methodName, extraParam, false);
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('remote:runQuiet', async (_event, methodName, extraParam) => {
  try {
    return await remoteModule.runRemoteCodeQuiet(methodName, extraParam);
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('remote:runAutoStart', async (_event, methodName, runOnce) => {
  try {
    return await remoteModule.runAutoStartModule(methodName, !!runOnce);
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('remote:bootAutoStart', async () => {
  try {
    return await remoteModule.runBootAutoStartIfNeeded();
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
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
