/**
 * MRP (Perfex) webview guest preload — PR #12 masaüstü menü köprüsü.
 * Tema `window.desktopTeklif` veya desktop-teklif:// linkleri kullanabilir.
 */
const { contextBridge, ipcRenderer } = require('electron');

function sendAction(action) {
  const slug = String(action || '').trim();
  if (!slug) return;
  ipcRenderer.sendToHost('desktop-action', slug);
}

function sendNavigate(href) {
  ipcRenderer.sendToHost('desktop-navigate', String(href || ''));
}

const api = {
  isDesktop: true,
  uaToken: 'DesktopTeklif/1',
  yeniTeklif: () => sendAction('yeni-teklif'),
  operasyon: () => sendAction('operasyon'),
  ayarlar: () => sendAction('ayarlar'),
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
  if (/desktop[-_]?action=/i.test(h)) return true;
  if (/[?&#]dt=/i.test(h)) return true;
  if (/\/desktop[-_]teklif\//i.test(h)) return true;
  if (/\/dt\/(yeni|operasyon|ayarlar)/i.test(h)) return true;
  if (/dt-(yeni-teklif|operasyon|ayarlar)/i.test(h)) return true;
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
      sendAction(dataAction);
      return;
    }

    const href = (el.getAttribute && (el.getAttribute('href') || el.getAttribute('data-href'))) || '';
    if (hrefLooksDesktop(href)) {
      event.preventDefault();
      event.stopPropagation();
      sendNavigate(href);
    }
  },
  true
);
