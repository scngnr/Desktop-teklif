const confirmModal = document.getElementById('confirmModal');
const toastHost = document.getElementById('toastHost');
const customerSearch = document.getElementById('customerSearch');
const selectCustomer = document.getElementById('selectCustomer');
const selectContact = document.getElementById('selectContact');
const folderNamePreview = document.getElementById('folderNamePreview');
const inputProjectName = document.getElementById('inputProjectName');
const btnConfirmCancel = document.getElementById('btnConfirmCancel');
const btnConfirmOk = document.getElementById('btnConfirmOk');

let toastTimer = null;
let companiesCache = [];
let customersLoading = false;
let creatingTeklif = false;

function showToast(message, kind = 'info', durationMs = 4200, action = null) {
  const text = String(message || '').trim();
  if (!text) return;

  toastHost.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'toast toast-' + kind;
  el.innerHTML =
    '<div class="toast-body"></div>' +
    (action && action.label
      ? '<button type="button" class="toast-action"></button>'
      : '') +
    '<button type="button" class="toast-close" aria-label="Kapat">×</button>';
  el.querySelector('.toast-body').textContent = text;
  const actionBtn = el.querySelector('.toast-action');
  if (actionBtn && action) {
    actionBtn.textContent = action.label;
    actionBtn.addEventListener('click', () => {
      if (typeof action.onClick === 'function') action.onClick();
    });
  }
  el.querySelector('.toast-close').addEventListener('click', () => {
    el.classList.add('hide');
  });
  toastHost.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.add('hide');
  }, durationMs);
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

function buildNamePreviewParts() {
  const company = getSelectedCompany();
  const project = String(inputProjectName.value || '').trim();
  const parts = ['teklif-no'];
  if (company) parts.push(company.company);
  if (project) parts.push(project);
  return parts.join(' - ');
}

function updateFolderPreview() {
  folderNamePreview.textContent = 'Klasör / Excel: ' + buildNamePreviewParts();
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
    const result = await window.teklifModal.listCustomers();
    if (!result.ok) {
      companiesCache = [];
      fillCustomerSelect();
      showToast('Müşteri listesi: ' + (result.error || 'hata'), 'err', 5000);
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

function getCreatePayload() {
  const company = getSelectedCompany();
  const contact = getSelectedContact();
  const projectName = String(inputProjectName.value || '').trim();
  const payload = {};
  if (projectName) payload.projectName = projectName;
  if (!company) return payload;
  payload.relId = company.userid;
  payload.customerName = company.company;
  payload.contactName = contact ? contact.fullName : company.company;
  payload.contactEmail =
    contact && contact.email && contact.email !== '-'
      ? contact.email
      : '';
  return payload;
}

function setBusy(busy) {
  creatingTeklif = busy;
  btnConfirmOk.disabled = busy;
  btnConfirmCancel.disabled = busy;
  btnConfirmOk.textContent = busy ? 'Oluşturuluyor…' : 'Oluştur';
}

async function createTeklifAction(payload = {}) {
  if (creatingTeklif) return;

  const cfg = await window.teklifModal.getConfig();
  if (!cfg || !cfg.hasAuthToken) {
    showToast('Önce Ayarlar’dan JWT token girin.', 'err');
    return;
  }

  const license = await window.teklifModal.checkLicense();
  if (!license || !license.licensed) {
    showToast(
      'Lisans aktif değil. Teklif butonu yalnızca lisanslı cihazda açılır.',
      'err',
      6500
    );
    return;
  }

  setBusy(true);
  showToast('API kaydı ve klasör oluşturuluyor…', 'info', 6000);

  try {
    const result = await window.teklifModal.createTeklif(payload);
    if (!result.ok) {
      showToast('Hata: ' + result.error, 'err', 6500);
      return;
    }

    const destPath = result.destPath;
    window.teklifModal.notifyCreated();
    showToast(
      'Başarılı — ' +
        result.teklifName +
        (result.proposalId ? ' (id: ' + result.proposalId + ')' : ''),
      'ok',
      5000,
      destPath
        ? {
            label: 'Klasörü Aç',
            onClick: () => window.teklifModal.openPath(destPath),
          }
        : null
    );
    setTimeout(() => window.teklifModal.close(), 1600);
  } catch (err) {
    showToast('Beklenmeyen hata: ' + (err.message || err), 'err', 6500);
  } finally {
    setBusy(false);
  }
}

function closeModal() {
  window.teklifModal.close();
}

customerSearch.addEventListener('input', () => {
  fillCustomerSelect(customerSearch.value);
});

selectCustomer.addEventListener('change', () => {
  fillContactSelect(getSelectedCompany());
  updateFolderPreview();
});

selectContact.addEventListener('change', updateFolderPreview);
inputProjectName.addEventListener('input', updateFolderPreview);

btnConfirmCancel.addEventListener('click', () => closeModal());
btnConfirmOk.addEventListener('click', () => {
  createTeklifAction(getCreatePayload());
});

confirmModal.addEventListener('click', (e) => {
  if (e.target === confirmModal && !creatingTeklif) closeModal();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !creatingTeklif) closeModal();
});

customerSearch.value = '';
inputProjectName.value = '';
loadCustomersForModal().then(() => {
  updateFolderPreview();
  customerSearch.focus();
});
