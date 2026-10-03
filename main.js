const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  dialog,
  Menu,
  session,
  screen,
  Tray,
  protocol,
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
  apiRequest,
} = require('./src/mrpApi');
const { createTeklifFolder, resolveSampleFolder } = require('./src/folderService');
const history = require('./src/history');
const { checkAndEnsureLicense } = require('./src/licenseService');
const remoteModule = require('./src/remoteModuleService');
const desktopIdentity = require('./src/desktopIdentity');
const floatingWindow = require('./src/floatingWindow');
const perfexMenuInject = require('./src/perfexMenuInject');
const metalix = require('./src/metalixApi');
const metalixOrd = require('./src/metalixOrd');

if (process.platform === 'linux') {
  floatingWindow.enableLinuxTransparency(app);
}

try {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'teklif',
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
    {
      scheme: 'desktop-teklif',
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
  ]);
} catch {
  // şema kaydı app.ready sonrası başarısız olur; handle yine denenir
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

function sendDesktopAction(action) {
  const key = desktopIdentity.parseDesktopAction(action) || action;
  if (!key) return;
  showMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('desktop:action', key);
  }
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
  return [cfg.baseUrl, cfg.apiRoot, cfg.adminRoot].filter(Boolean);
}

function apiAuthContext() {
  const pub = config.getPublic();
  const hosts = [];
  [pub.baseUrl, pub.apiRoot, pub.adminRoot].forEach((raw) => {
    try {
      if (raw) hosts.push(new URL(raw).host);
    } catch {
      // geçersiz adres
    }
  });
  return {
    token: pub.authToken,
    headerName: pub.authHeaderName || 'authtoken',
    hosts,
  };
}

async function applyMrpDesktopIdentity() {
  const ses = getMrpSession();
  desktopIdentity.attachUserAgentRewrite(ses, apiAuthContext);
  try {
    await desktopIdentity.applyDesktopIdentity(ses, mrpIdentityUrls());
  } catch (err) {
    console.log('[main] desktop identity:', err.message || err);
  }
}

async function isWebLoggedIn() {
  const cfg = config.getPublic();
  const urls = [cfg.baseUrl, cfg.apiRoot, cfg.adminRoot].filter(Boolean);
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
    syncDesktopFab();
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

function fabOverlapsMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (!mainWindow.isVisible() || mainWindow.isMinimized()) return false;
  const m = mainWindow.getBounds();
  const display = screen.getPrimaryDisplay();
  const f = floatingWindow.cornerBounds(
    display.workArea,
    FAB_W,
    FAB_H,
    FAB_MARGIN
  );
  return !(
    f.x + f.width <= m.x ||
    f.x >= m.x + m.width ||
    f.y + f.height <= m.y ||
    f.y >= m.y + m.height
  );
}

function syncDesktopFab() {
  const enabled = !!config.getPublic().showDesktopFab;
  if (!enabled) {
    destroyFabWindow();
    return;
  }
  createFabWindow();
  if (!fabWindow || fabWindow.isDestroyed()) return;
  if (fabOverlapsMainWindow()) {
    fabWindow.hide();
  } else {
    showFabWindow();
  }
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
    syncDesktopFab();
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
  mainWindow.webContents.on('will-attach-webview', (_event, webPreferences, params) => {
    // The relative preload attribute can be dropped by Electron when the webview is
    // recreated during navigation. Bind the trusted guest preload from the main
    // process so Meseliha always sees window.mrpDesktop.
    webPreferences.preload = path.join(__dirname, 'preload-webview.js');
    webPreferences.contextIsolation = true;
    webPreferences.nodeIntegration = false;
    webPreferences.sandbox = false;
    try {
      params.useragent = desktopIdentity.withUaToken(
        params.useragent || getMrpSession().getUserAgent()
      );
    } catch (err) {
      console.log('[main] will-attach-webview:', err.message || err);
    }
  });
  mainWindow.loadFile('index.html');
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    syncDesktopFab();
  });
  ['move', 'resize', 'show', 'hide', 'minimize', 'restore', 'maximize', 'unmaximize'].forEach(
    (ev) => {
      mainWindow.on(ev, () => syncDesktopFab());
    }
  );
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

  const handleCustomProtocol = (request) => {
    const action = desktopIdentity.parseDesktopAction(request.url);
    if (action) sendDesktopAction(action);
    return new Response('', { status: 204 });
  };
  try {
    protocol.handle('teklif', handleCustomProtocol);
  } catch (err) {
    console.log('[main] teklif protocol:', err.message || err);
  }
  try {
    protocol.handle('desktop-teklif', handleCustomProtocol);
  } catch (err) {
    console.log('[main] desktop-teklif protocol:', err.message || err);
  }

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

ipcMain.handle('api:request', async (_event, payload = {}) => {
  const method = String(payload.method || 'GET').toUpperCase();
  const rawPath = String(payload.path || '').replace(/^\//, '');
  if (!rawPath.startsWith('api/')) {
    return { ok: false, status: 0, error: 'yalnızca api/ yolları' };
  }
  try {
    const result = await apiRequest(method, rawPath, payload.body);
    return {
      ...result,
      error: result.ok ? undefined : result.text || `HTTP ${result.status}`,
    };
  } catch (err) {
    return { ok: false, status: 0, error: err.message || String(err) };
  }
});

function metalixAuth() {
  if (!config.hasAuthToken()) {
    return {
      ok: false,
      needSettings: true,
      error: 'JWT token yok. Ayarlar’dan token girin.',
    };
  }
  return null;
}

function rememberMetalixPrefs(partial) {
  const next = {};
  if (partial.metalixDir !== undefined) next.metalixDir = partial.metalixDir;
  if (partial.metalixSheetX !== undefined) next.metalixSheetX = partial.metalixSheetX;
  if (partial.metalixSheetY !== undefined) next.metalixSheetY = partial.metalixSheetY;
  if (partial.metalixReportTemplate !== undefined) {
    next.metalixReportTemplate = partial.metalixReportTemplate;
  }
  if (Object.keys(next).length) config.save(next);
}

ipcMain.handle('metalix:groups', async (_event, moId) => {
  const missing = metalixAuth();
  if (missing) return missing;
  try {
    return await metalix.fetchGroups(moId);
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('metalix:pickDir', async () => {
  const current = config.get().metalixDir;
  const picked = await dialog.showOpenDialog(mainWindow || undefined, {
    title: 'Metalix klasörü',
    defaultPath: current || undefined,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (picked.canceled || !picked.filePaths || !picked.filePaths[0]) {
    return { ok: false, canceled: true };
  }
  const dir = picked.filePaths[0];
  rememberMetalixPrefs({ metalixDir: dir });
  return { ok: true, dir };
});

function sendMetalixResult(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('metalix:result', payload);
}

function armNestWatch(dir, moId, profile) {
  let queue = Promise.resolve();
  metalix.watchForNestCsv(dir, (filePath, prepared) => {
    queue = queue.then(async () => {
      try {
        const file = prepared || metalix.readNestFile(filePath);
        if (!file.ok) return;
        const posted = await metalix.submitNest({
          moId,
          profile: profile || 'metalix_perfex',
          filename: file.filename,
          csv: file.csv,
        });
        sendMetalixResult({
          ok: !!posted.ok,
          error: posted.error,
          report: posted.report || null,
          filename: file.filename,
        });
      } catch (err) {
        sendMetalixResult({ ok: false, error: err.message || String(err) });
      }
    });
  });
}

ipcMain.handle('metalix:download', async (_event, payload = {}) => {
  const missing = metalixAuth();
  if (missing) return missing;
  try {
    const result = await metalix.downloadOrd(payload);
    if (result.ok) {
      const prefs = { metalixDir: result.dir };
      if (payload.sheetX) prefs.metalixSheetX = String(payload.sheetX);
      if (payload.sheetY) prefs.metalixSheetY = String(payload.sheetY);
      rememberMetalixPrefs(prefs);
      if (payload.watchCsv) {
        armNestWatch(result.dir, result.moId, payload.profile);
      }
    }
    return result;
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('metalix:process', async (_event, payload = {}) => {
  const missing = metalixAuth();
  if (missing) return missing;
  try {
    const downloaded = await metalix.downloadOrd(payload);
    if (!downloaded.ok) return downloaded;
    rememberMetalixPrefs({
      metalixDir: downloaded.dir,
      metalixSheetX: String(payload.sheetX || ''),
      metalixSheetY: String(payload.sheetY || ''),
      metalixReportTemplate: String(payload.reportTemplate || ''),
    });
    return await metalix.processOrdBatch(downloaded, payload, (progress) => {
      sendMetalixResult(progress);
    });
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('metalix:open', async (_event, payload = {}) => {
  try {
    const result = await metalix.openOrd(payload);
    const prefs = {};
    if (payload.sheetX !== undefined) prefs.metalixSheetX = String(payload.sheetX);
    if (payload.sheetY !== undefined) prefs.metalixSheetY = String(payload.sheetY);
    if (payload.reportTemplate !== undefined) {
      prefs.metalixReportTemplate = String(payload.reportTemplate);
    }
    rememberMetalixPrefs(prefs);
    return result;
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('metalix:submitNest', async (_event, payload = {}) => {
  const missing = metalixAuth();
  if (missing) return missing;
  try {
    const picked = await dialog.showOpenDialog(mainWindow || undefined, {
      title: 'Metalix Perfex CSV',
      properties: ['openFile'],
      filters: [{ name: 'CSV', extensions: ['csv', 'txt'] }],
    });
    if (picked.canceled || !picked.filePaths || !picked.filePaths[0]) {
      return { ok: false, canceled: true };
    }
    const file = metalix.readNestFile(picked.filePaths[0]);
    if (!file.ok) return file;
    return await metalix.submitNest({
      moId: payload.moId,
      profile: payload.profile,
      filename: file.filename,
      csv: file.csv,
    });
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('metalix:reports', async (_event, moId) => {
  const missing = metalixAuth();
  if (missing) return missing;
  try {
    return await metalix.listReports(moId);
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
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
  if (metalixOrd.isOrdFilePath(targetPath)) {
    return {
      ok: false,
      code: 'ord_com_only',
      error: metalixOrd.explainMetalixCode('ord_com_only'),
    };
  }
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
