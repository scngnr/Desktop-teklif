const btnMinimize = document.getElementById('btnMinimize');
const btnClose = document.getElementById('btnClose');
const btnSidebarToggle = document.getElementById('btnSidebarToggle');
const layout = document.getElementById('layout');
const content = document.getElementById('content');
const btnCreateTeklif = document.getElementById('btnCreateTeklif');
const btnCreateTeklifFab = document.getElementById('btnCreateTeklifFab');
const toastHost = document.getElementById('toastHost');
const settingsForm = document.getElementById('settingsForm');
const inputBaseUrl = document.getElementById('inputBaseUrl');
const inputFirmaAdi = document.getElementById('inputFirmaAdi');
const girisUrlPreview = document.getElementById('girisUrlPreview');
const inputJwt = document.getElementById('inputJwt');
const toggleJwtVisible = document.getElementById('toggleJwtVisible');
const userNameEl = document.getElementById('userName');
const userRoleEl = document.getElementById('userRole');
const userAvatarEl = document.getElementById('userAvatar');
const pageWebview = document.getElementById('pageWebview');
const titlebarBrand = document.getElementById('titlebarBrand');

const SIDEBAR_KEY = 'desktop-teklif-sidebar-collapsed';
let toastTimer = null;
let cachedBaseUrl = '';
let cachedFirmaAdi = '';
let cachedAdminRoot = '';
let lastWebPath = '';
let webLoggedIn = false;
let creatingTeklif = false;

function showToast(message, kind = 'info', durationMs = 4200) {
  const text = String(message || '').trim();
  if (!text) return;

  toastHost.innerHTML = '';
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }

  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.setAttribute('role', 'status');

  const body = document.createElement('p');
  body.className = 'toast-body';
  body.textContent = text;
  el.appendChild(body);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'toast-close';
  closeBtn.setAttribute('aria-label', 'Kapat');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => hideToast(el));
  el.appendChild(closeBtn);

  toastHost.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));

  toastTimer = setTimeout(() => hideToast(el), durationMs);
}

function hideToast(el) {
  if (!el || !el.parentNode) return;
  el.classList.remove('show');
  el.classList.add('hide');
  setTimeout(() => {
    if (el.parentNode) el.parentNode.removeChild(el);
  }, 220);
}

function initialsFromName(name) {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function normalizeFirmaAdi(name) {
  return String(name || '')
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/\s+/g, '');
}

function buildAdminRoot(baseUrl, firmaAdi) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const firma = normalizeFirmaAdi(firmaAdi);
  if (firma) return `${base}/${firma}/ps/admin`;
  return `${base}/admin`;
}

function applySidebarCollapsed(collapsed) {
  layout.classList.toggle('sidebar-collapsed', collapsed);
  updateSidebarToggleUi();
  try {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
  } catch {
    // ignore
  }
}

function updateSidebarToggleUi() {
  const collapsed = layout.classList.contains('sidebar-collapsed');
  const hidden = layout.classList.contains('sidebar-hidden');
  if (hidden) {
    btnSidebarToggle.setAttribute('aria-label', 'Menüyü göster');
    btnSidebarToggle.title = 'Menüyü göster';
    return;
  }
  btnSidebarToggle.setAttribute(
    'aria-label',
    collapsed ? 'Menüyü genişlet' : 'Menüyü daralt'
  );
  btnSidebarToggle.title = collapsed ? 'Menüyü genişlet' : 'Menüyü daralt';
}

function setCreateButtonsDisabled(disabled) {
  btnCreateTeklif.disabled = disabled;
  btnCreateTeklifFab.disabled = disabled;
}

function syncFabVisibility() {
  const sidebarHidden = layout.classList.contains('sidebar-hidden');
  btnCreateTeklifFab.hidden = !sidebarHidden;
}

function setSidebarHidden(hidden) {
  layout.classList.toggle('sidebar-hidden', hidden);
  if (hidden) {
    layout.classList.remove('sidebar-collapsed');
  }
  syncFabVisibility();
  updateSidebarToggleUi();
}

function restoreSidebarState() {
  try {
    applySidebarCollapsed(localStorage.getItem(SIDEBAR_KEY) === '1');
  } catch {
    applySidebarCollapsed(false);
  }
}

function joinUrl(base, path) {
  const b = String(base || '').replace(/\/+$/, '');
  const p = String(path || '');
  if (!p || p === '/') return b;
  if (/^https?:\/\//i.test(p)) return p;
  return b + (p.startsWith('/') ? p : '/' + p);
}

function loadWebPath(path) {
  lastWebPath = path === undefined ? lastWebPath : path;
  const url = joinUrl(cachedAdminRoot, lastWebPath || '');
  pageWebview.setAttribute('src', url);
}

function updateGirisUrlPreview() {
  const base = (inputBaseUrl.value || cachedBaseUrl || '').trim();
  const firma = inputFirmaAdi.value;
  if (!base) {
    girisUrlPreview.textContent = 'Giriş URL: —';
    return;
  }
  girisUrlPreview.textContent = 'Giriş URL: ' + buildAdminRoot(base, firma);
}

async function refreshConfigCache() {
  const cfg = await window.teklifApp.getConfig();
  cachedBaseUrl = cfg.baseUrl || '';
  cachedFirmaAdi = cfg.firmaAdi || '';
  cachedAdminRoot =
    cfg.adminRoot || buildAdminRoot(cachedBaseUrl, cachedFirmaAdi);
  return cfg;
}

async function loadUserInfo() {
  try {
    const info = await window.teklifApp.getUserInfo();
    if (!info.ok) {
      userNameEl.textContent = 'Kullanıcı yok';
      userRoleEl.textContent = info.error || 'JWT geçersiz';
      userAvatarEl.textContent = '?';
      return;
    }
    userNameEl.textContent = info.name;
    userRoleEl.textContent = info.user ? `@${info.user}` : 'API kullanıcısı';
    userAvatarEl.textContent = initialsFromName(info.name);
  } catch (err) {
    userNameEl.textContent = 'Hata';
    userRoleEl.textContent = err.message || String(err);
    userAvatarEl.textContent = '!';
  }
}

async function loadCompanyBrand() {
  try {
    const result = await window.teklifApp.getCompanyName();
    const name = (result && result.companyName) || cachedFirmaAdi || 'Desktop Teklif';
    titlebarBrand.textContent = name;
    document.title = name;
  } catch {
    const fallback = cachedFirmaAdi || 'Desktop Teklif';
    titlebarBrand.textContent = fallback;
    document.title = fallback;
  }
}

async function loadSettingsForm() {
  const cfg = await refreshConfigCache();
  inputBaseUrl.value = cfg.baseUrl || '';
  inputFirmaAdi.value = cfg.firmaAdi || '';
  inputJwt.value = cfg.authToken || '';
  updateGirisUrlPreview();
}

function setActiveNav(btn) {
  document.querySelectorAll('.nav-item').forEach((el) => {
    el.classList.toggle('active', el === btn);
  });
}

async function applyLoginSidebarState(loggedIn) {
  webLoggedIn = !!loggedIn;
  setSidebarHidden(webLoggedIn);
}

async function refreshLoginState() {
  try {
    const status = await window.teklifApp.isWebLoggedIn();
    await applyLoginSidebarState(!!(status && status.loggedIn));
    return webLoggedIn;
  } catch {
    await applyLoginSidebarState(false);
    return false;
  }
}

async function showView(viewId, options = {}) {
  const { path, navBtn } = options;

  document.querySelectorAll('.view').forEach((el) => {
    el.hidden = el.id !== `view-${viewId}`;
  });

  content.classList.toggle('content-web', viewId === 'web');

  if (navBtn) {
    setActiveNav(navBtn);
  } else {
    document.querySelectorAll('.nav-item').forEach((btn) => {
      const isWeb = viewId === 'web' && btn.dataset.view === 'web';
      const pathMatch =
        path === undefined ||
        btn.dataset.path === undefined ||
        btn.dataset.path === path;
      btn.classList.toggle(
        'active',
        btn.dataset.view === viewId && (!isWeb || pathMatch)
      );
    });
  }

  if (viewId === 'ayarlar') {
    await loadSettingsForm();
    await refreshLoginState();
    return;
  }

  if (viewId === 'web') {
    await refreshConfigCache();
    if (!cachedBaseUrl) {
      showToast('Önce Ayarlar’dan Base URL girin.', 'err');
      return;
    }
    loadWebPath(path !== undefined ? path : lastWebPath);
    await refreshLoginState();
  }
}

async function createTeklifAction() {
  if (creatingTeklif) return;
  creatingTeklif = true;
  setCreateButtonsDisabled(true);
  showToast('API kaydı ve klasör oluşturuluyor…', 'info', 6000);

  try {
    const result = await window.teklifApp.createTeklif();
    if (!result.ok) {
      showToast('Hata: ' + result.error, 'err', 6500);
      return;
    }

    showToast(
      'Başarılı — ' +
        result.teklifName +
        (result.proposalId ? ' (id: ' + result.proposalId + ')' : ''),
      'ok',
      5000
    );

    if (result.destPath) {
      await window.teklifApp.openPath(result.destPath);
    }
  } catch (err) {
    showToast('Beklenmeyen hata: ' + (err.message || err), 'err', 6500);
  } finally {
    creatingTeklif = false;
    setCreateButtonsDisabled(false);
  }
}

btnMinimize.addEventListener('click', () => window.teklifApp.minimize());
btnClose.addEventListener('click', () => window.teklifApp.close());

btnSidebarToggle.addEventListener('click', () => {
  if (layout.classList.contains('sidebar-hidden')) {
    setSidebarHidden(false);
    applySidebarCollapsed(true);
    return;
  }
  applySidebarCollapsed(!layout.classList.contains('sidebar-collapsed'));
});

btnCreateTeklif.addEventListener('click', () => {
  createTeklifAction();
});

btnCreateTeklifFab.addEventListener('click', () => {
  createTeklifAction();
});

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    showView(btn.dataset.view, {
      path: btn.dataset.path,
      navBtn: btn,
    });
  });
});

toggleJwtVisible.addEventListener('change', () => {
  inputJwt.type = toggleJwtVisible.checked ? 'text' : 'password';
});

inputBaseUrl.addEventListener('input', updateGirisUrlPreview);
inputFirmaAdi.addEventListener('input', updateGirisUrlPreview);

settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  showToast('Ayarlar kaydediliyor…', 'info', 2000);

  const result = await window.teklifApp.saveConfig({
    baseUrl: inputBaseUrl.value.trim(),
    firmaAdi: inputFirmaAdi.value.trim(),
    authToken: inputJwt.value.trim(),
  });

  if (!result.ok) {
    showToast('Hata: ' + result.error, 'err', 5500);
    return;
  }

  await refreshConfigCache();
  updateGirisUrlPreview();
  showToast('Ayarlar kaydedildi.', 'ok');
  await loadUserInfo();
  await loadCompanyBrand();
});

pageWebview.addEventListener('did-navigate', () => {
  refreshLoginState();
});

pageWebview.addEventListener('did-navigate-in-page', () => {
  refreshLoginState();
});

pageWebview.addEventListener('did-finish-load', () => {
  refreshLoginState();
});

pageWebview.addEventListener('did-fail-load', (e) => {
  if (e.errorCode === -3) return;
  showToast('Sayfa yüklenemedi: ' + (e.errorDescription || e.errorCode), 'err', 5000);
});

window.teklifApp.onSessionChanged((payload) => {
  if (!payload) return;
  applyLoginSidebarState(!!payload.loggedIn);
  if (payload.loggedIn) {
    const webVisible = !document.getElementById('view-web').hidden;
    if (!webVisible) {
      showView('web', { path: lastWebPath || '' });
    }
  }
});

restoreSidebarState();
refreshConfigCache().then(async () => {
  await Promise.all([loadUserInfo(), loadCompanyBrand()]);
  const loggedIn = await refreshLoginState();
  if (loggedIn) {
    await showView('web', { path: '' });
  } else {
    await showView('web', { path: '' });
    const panelBtn = document.querySelector('.nav-item[data-view="web"][title="Panel"]');
    if (panelBtn) setActiveNav(panelBtn);
  }
});
