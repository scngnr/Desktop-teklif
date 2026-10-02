/**
 * MRP (Perfex) webview guest preload — PR #12 masaüstü menü köprüsü.
 * Tema `window.desktopTeklif` veya desktop-teklif:// linkleri kullanabilir.
 */
const { contextBridge, ipcRenderer } = require('electron');
const {
  isMetalixSendLabel,
  moIdFromPageUrl,
  normalizeMetalixGroup,
} = require('./src/metalixOrd');

function sendAction(action, extra) {
  const slug = String(action || '').trim();
  if (!slug) return;
  ipcRenderer.sendToHost('desktop-action', slug, extra == null ? null : extra);
}

function sendNavigate(href) {
  ipcRenderer.sendToHost('desktop-navigate', String(href || ''));
}

const api = {
  isDesktop: true,
  uaToken: 'DesktopTeklif/1',
  yeniTeklif: () => sendAction('yeni'),
  operasyon: () => sendAction('operasyon'),
  openSettings: () => sendAction('ayarlar'),
  action: sendAction,
};

try {
  contextBridge.exposeInMainWorld('desktopTeklif', api);
} catch {
  window.desktopTeklif = api;
}

function hrefLooksDesktop(href) {
  const h = String(href || '');
  if (!h) return false;
  if (/^desktop-teklif:/i.test(h)) return true;
  if (/^teklif:/i.test(h)) return true;
  if (/desktop[-_]?action=/i.test(h)) return true;
  if (/[?&#]dt=/i.test(h)) return true;
  if (/\/(?:admin\/)?mrp_theme\/desktop\//i.test(h)) return true;
  if (/\/desktop[-_]teklif\//i.test(h)) return true;
  if (/\/dt\/(yeni|operasyon|ayarlar)/i.test(h)) return true;
  if (/dt-(yeni-teklif|operasyon|ayarlar|yeni)/i.test(h)) return true;
  return false;
}

function controlLabel(el) {
  return String(
    (el && (el.innerText || el.textContent || el.value || el.getAttribute('aria-label'))) || ''
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function metalixScope(el) {
  let node = el;
  for (let i = 0; i < 8 && node; i += 1) {
    if (node.querySelector && node.querySelector('input')) {
      const inputs = node.querySelectorAll('input');
      for (let n = 0; n < inputs.length; n += 1) {
        const value = String(inputs[n].value || '').trim();
        if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')) return node;
      }
    }
    node = node.parentElement;
  }
  return (el && el.closest && el.closest('form')) || document.body;
}

function metalixPayload(el) {
  const scope = metalixScope(el);
  let dir = '';
  const inputs = scope.querySelectorAll ? scope.querySelectorAll('input') : [];
  for (let i = 0; i < inputs.length; i += 1) {
    const value = String(inputs[i].value || '').trim();
    if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')) {
      dir = value;
      break;
    }
  }
  let group = '';
  const selects = scope.querySelectorAll ? scope.querySelectorAll('select') : [];
  for (let i = 0; i < selects.length; i += 1) {
    const sel = selects[i];
    const opt = sel.options && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null;
    const label = opt ? opt.textContent : '';
    const value = opt ? opt.value : sel.value;
    if (/grup|material|kal[ıi]nl/i.test(label + ' ' + (sel.name || '') + ' ' + (sel.id || '')) || /t[uü]m gruplar/i.test(label)) {
      group = normalizeMetalixGroup(value, label);
      break;
    }
  }
  if (!group && selects.length === 1) {
    const sel = selects[0];
    const opt = sel.options && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null;
    group = normalizeMetalixGroup(opt ? opt.value : sel.value, opt ? opt.textContent : '');
  }
  return {
    moId: moIdFromPageUrl(location.href),
    dir,
    group,
  };
}

document.addEventListener(
  'click',
  (event) => {
    const el = event.target && event.target.closest
      ? event.target.closest('a, button, [data-desktop-action]')
      : null;
    if (!el) return;

    if (isMetalixSendLabel(controlLabel(el))) {
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === 'function') {
        event.stopImmediatePropagation();
      }
      sendAction('metalix-send', JSON.stringify(metalixPayload(el)));
      return;
    }

    const dataAction = el.getAttribute && el.getAttribute('data-desktop-action');
    if (dataAction) {
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === 'function') {
        event.stopImmediatePropagation();
      }
      const extra = el.getAttribute('data-desktop-extra');
      sendAction(dataAction, extra);
      return;
    }

    const href = (el.getAttribute && (el.getAttribute('href') || el.getAttribute('data-href'))) || '';
    if (hrefLooksDesktop(href)) {
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === 'function') {
        event.stopImmediatePropagation();
      }
      sendNavigate(href);
    }
  },
  true
);
