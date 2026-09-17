/**
 * MRP (Perfex) webview guest preload — PR #12 masaüstü menü köprüsü.
 * Tema `window.desktopTeklif` veya desktop-teklif:// linkleri kullanabilir.
 */
const { contextBridge, ipcRenderer } = require('electron');

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

document.addEventListener(
  'click',
  (event) => {
    const el = event.target && event.target.closest
      ? event.target.closest('a, button, [data-desktop-action]')
      : null;
    if (!el) return;

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
