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
const historyList = document.getElementById('historyList');
const confirmModal = document.getElementById('confirmModal');
const btnConfirmCancel = document.getElementById('btnConfirmCancel');
const btnConfirmOk = document.getElementById('btnConfirmOk');
const settingsHint = document.getElementById('settingsHint');
const customerSearch = document.getElementById('customerSearch');
const selectCustomer = document.getElementById('selectCustomer');
const selectContact = document.getElementById('selectContact');
const folderNamePreview = document.getElementById('folderNamePreview');

const SIDEBAR_KEY = 'desktop-teklif-sidebar-collapsed';
const CREATE_LABEL = 'Yeni Teklif';
const CREATE_BUSY_LABEL = 'Oluşturuluyor…';

let toastTimer = null;
let cachedBaseUrl = '';
let cachedFirmaAdi = '';
let cachedAdminRoot = '';
let cachedHasAuth = false;
let lastWebPath = '';
let webLoggedIn = false;
let creatingTeklif = false;
let companiesCache = [];
let customersLoading = false;

function showToast(message, kind = 'info', durationMs = 4200, action = null) {
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

  if (action && action.label && typeof action.onClick === 'function') {
    const actionBtn = document.createElement('button');
    actionBtn.type = 'button';
    actionBtn.className = 'toast-action';
    actionBtn.textContent = action.label;
    actionBtn.addEventListener('click', () => {
      action.onClick();
      hideToast(el);
    });
    el.appendChild(actionBtn);
  }

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

function setCreateBusy(busy) {
  creatingTeklif = busy;
  btnCreateTeklif.disabled = busy;
  btnCreateTeklifFab.disabled = busy;
  const label = busy ? CREATE_BUSY_LABEL : CREATE_LABEL;
  const navLabel = btnCreateTeklif.querySelector('.nav-label');
  const fabLabel = btnCreateTeklifFab.querySelector('.fab-label');
  if (navLabel) navLabel.textContent = label;
  if (fabLabel) fabLabel.textContent = label;
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
  cachedHasAuth = !!cfg.hasAuthToken;
  cachedAdminRoot =
    cfg.adminRoot || buildAdminRoot(cachedBaseUrl, cachedFirmaAdi);
  return cfg;
}

async function loadUserInfo() {
  try {
    if (!cachedHasAuth) {
      userNameEl.textContent = 'Token yok';
      userRoleEl.textContent = 'Ayarlar’dan JWT girin';
      userAvatarEl.textContent = '?';
      return;
    }
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
  settingsHint.textContent = cfg.hasAuthToken
    ? 'API erişimi için Base URL ve JWT token gerekli.'
    : 'İlk kurulum: JWT token girmeden teklif oluşturulamaz.';
  updateGirisUrlPreview();
}

function setActiveNav(btn) {
  document.querySelectorAll('.nav-item').forEach((el) => {
    el.classList.toggle('active', el === btn);
  });
}

async function applyLoginSidebarState(loggedIn) {
  webLoggedIn = !!loggedIn;
  if (!cachedHasAuth) {
    setSidebarHidden(false);
    return;
  }
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

function formatHistoryTime(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('tr-TR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

async function loadHistory() {
  const result = await window.teklifApp.listHistory();
  const items = (result && result.items) || [];
  historyList.innerHTML = '';

  if (items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'history-empty';
    empty.textContent = 'Henüz teklif yok';
    historyList.appendChild(empty);
    return;
  }

  items.slice(0, 8).forEach((item) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'history-item';
    btn.title = item.destPath || item.teklifName;
    btn.innerHTML =
      '<span class="history-name"></span><span class="history-meta"></span>';
    btn.querySelector('.history-name').textContent = item.teklifName || '—';
    btn.querySelector('.history-meta').textContent = formatHistoryTime(
      item.createdAt
    );
    btn.addEventListener('click', async () => {
      if (!item.destPath) return;
      await window.teklifApp.openPath(item.destPath);
    });
    historyList.appendChild(btn);
  });
}

function getSelectedCompany() {
  const id = Number(selectCustomer.value);
  if (!id) return null;
  return companiesCache.find((c) => c.userid === id) || null;
}

function getSelectedContact() {
  const company = getSelectedCompany();
  if (!company) return null;
  const id = Number(selectContact.value);
  if (!id) return null;
  return (company.contacts || []).find((ct) => ct.id === id) || null;
}

function updateFolderPreview() {
  const company = getSelectedCompany();
  if (company) {
    folderNamePreview.textContent =
      'Klasör / Excel: teklif-no ' + company.company;
  } else {
    folderNamePreview.textContent = 'Klasör / Excel: teklif-no (müşteri seçilmedi)';
  }
}

function fillContactSelect(company) {
  selectContact.innerHTML = '';
  if (!company) {
    selectContact.disabled = true;
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '— Önce müşteri seçin —';
    selectContact.appendChild(opt);
    return;
  }

  const contacts = company.contacts || [];
  selectContact.disabled = contacts.length === 0;

  if (contacts.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '— Kişi yok —';
    selectContact.appendChild(opt);
    return;
  }

  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = '— Kişi seçin —';
  selectContact.appendChild(empty);

  let primaryId = '';
  contacts.forEach((ct) => {
    const opt = document.createElement('option');
    opt.value = String(ct.id);
    const extra = ct.email && ct.email !== '-' ? ` · ${ct.email}` : '';
    opt.textContent = ct.fullName + extra;
    selectContact.appendChild(opt);
    if (ct.is_primary && !primaryId) primaryId = String(ct.id);
  });

  selectContact.value = primaryId || String(contacts[0].id);
}

function fillCustomerSelect(filterText = '') {
  const q = String(filterText || '').trim().toLocaleLowerCase('tr');
  const prev = selectCustomer.value;
  selectCustomer.innerHTML = '';

  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = '— Seçilmedi (isteğe bağlı) —';
  selectCustomer.appendChild(empty);

  const list = companiesCache
    .filter((c) => c.company && c.company !== '-')
    .filter((c) => !q || c.company.toLocaleLowerCase('tr').includes(q))
    .sort((a, b) =>
      a.company.localeCompare(b.company, 'tr', { sensitivity: 'base' })
    );

  list.forEach((c) => {
    const opt = document.createElement('option');
    opt.value = String(c.userid);
    opt.textContent = c.company;
    selectCustomer.appendChild(opt);
  });

  if (prev && list.some((c) => String(c.userid) === prev)) {
    selectCustomer.value = prev;
  } else {
    selectCustomer.value = '';
  }

  fillContactSelect(getSelectedCompany());
  updateFolderPreview();
}

async function loadCustomersForModal() {
  if (customersLoading) return;
  customersLoading = true;
  selectCustomer.disabled = true;
  selectContact.disabled = true;
  folderNamePreview.textContent = 'Müşteri listesi yükleniyor…';

  try {
    const result = await window.teklifApp.listCustomers();
    if (!result.ok) {
      companiesCache = [];
      fillCustomerSelect();
      showToast('Müşteri listesi: ' + (result.error || 'hata'), 'err', 5000);
      if (result.needSettings) {
        closeConfirmModal();
        await showView('ayarlar', {
          navBtn: document.querySelector('.nav-item[data-view="ayarlar"]'),
        });
      }
      return;
    }
    companiesCache = result.companies || [];
    fillCustomerSelect(customerSearch.value);
  } catch (err) {
    companiesCache = [];
    fillCustomerSelect();
    showToast('Müşteri listesi alınamadı: ' + (err.message || err), 'err');
  } finally {
    selectCustomer.disabled = false;
    customersLoading = false;
  }
}

async function openConfirmModal() {
  confirmModal.hidden = false;
  customerSearch.value = '';
  await loadCustomersForModal();
  customerSearch.focus();
}

function closeConfirmModal() {
  confirmModal.hidden = true;
}

function getCreatePayload() {
  const company = getSelectedCompany();
  const contact = getSelectedContact();
  if (!company) return {};
  return {
    relId: company.userid,
    customerName: company.company,
    contactName: contact ? contact.fullName : company.company,
    contactEmail:
      contact && contact.email && contact.email !== '-'
        ? contact.email
        : '',
  };
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
    setSidebarHidden(false);
    return;
  }

  if (viewId === 'web') {
    await refreshConfigCache();
    if (!cachedBaseUrl) {
      showToast('Önce Ayarlar’dan Base URL girin.', 'err');
      await showView('ayarlar');
      return;
    }
    loadWebPath(path !== undefined ? path : lastWebPath);
    await refreshLoginState();
  }
}

async function createTeklifAction(payload = {}) {
  if (creatingTeklif) return;

  await refreshConfigCache();
  if (!cachedHasAuth) {
    showToast('Önce Ayarlar’dan JWT token girin.', 'err');
    await showView('ayarlar', {
      navBtn: document.querySelector('.nav-item[data-view="ayarlar"]'),
    });
    return;
  }

  setCreateBusy(true);
  showToast('API kaydı ve klasör oluşturuluyor…', 'info', 6000);

  try {
    const result = await window.teklifApp.createTeklif(payload);
    if (!result.ok) {
      showToast('Hata: ' + result.error, 'err', 6500);
      if (result.needSettings) {
        await showView('ayarlar', {
          navBtn: document.querySelector('.nav-item[data-view="ayarlar"]'),
        });
      }
      return;
    }

    const destPath = result.destPath;
    showToast(
      'Başarılı — ' +
        result.teklifName +
        (result.proposalId ? ' (id: ' + result.proposalId + ')' : ''),
      'ok',
      8000,
      destPath
        ? {
            label: 'Klasörü Aç',
            onClick: () => window.teklifApp.openPath(destPath),
          }
        : null
    );
    await loadHistory();
  } catch (err) {
    showToast('Beklenmeyen hata: ' + (err.message || err), 'err', 6500);
  } finally {
    setCreateBusy(false);
  }
}

function requestCreateTeklif() {
  if (creatingTeklif) return;
  if (!cachedHasAuth) {
    createTeklifAction();
    return;
  }
  openConfirmModal();
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

btnCreateTeklif.addEventListener('click', () => requestCreateTeklif());
btnCreateTeklifFab.addEventListener('click', () => requestCreateTeklif());

btnConfirmCancel.addEventListener('click', () => closeConfirmModal());
btnConfirmOk.addEventListener('click', () => {
  const payload = getCreatePayload();
  closeConfirmModal();
  createTeklifAction(payload);
});

customerSearch.addEventListener('input', () => {
  fillCustomerSelect(customerSearch.value);
});

selectCustomer.addEventListener('change', () => {
  fillContactSelect(getSelectedCompany());
  updateFolderPreview();
});

selectContact.addEventListener('change', () => {
  updateFolderPreview();
});

confirmModal.addEventListener('click', (e) => {
  if (e.target === confirmModal) closeConfirmModal();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !confirmModal.hidden) {
    closeConfirmModal();
  }
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
  if (payload.loggedIn && cachedHasAuth) {
    const webVisible = !document.getElementById('view-web').hidden;
    if (!webVisible) {
      showView('web', { path: lastWebPath || '' });
    }
  }
});

restoreSidebarState();
refreshConfigCache().then(async () => {
  await Promise.all([loadUserInfo(), loadCompanyBrand(), loadHistory()]);

  if (!cachedHasAuth) {
    await showView('ayarlar', {
      navBtn: document.querySelector('.nav-item[data-view="ayarlar"]'),
    });
    showToast('Başlamak için JWT token girin.', 'info', 5000);
    return;
  }

  const loggedIn = await refreshLoginState();
  await showView('web', { path: '' });
  if (!loggedIn) {
    const panelBtn = document.querySelector(
      '.nav-item[data-view="web"][title="Panel"]'
    );
    if (panelBtn) setActiveNav(panelBtn);
  }
});
