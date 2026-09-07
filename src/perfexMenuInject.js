/**
 * Perfex admin kenar çubuğuna Desktop Teklif menüsü basar.
 * Haberler / newsfeed gizlenir; tema PR #12 Yeni teklif, Operasyon ve
 * Ayarlar satırları gizlenir (Operasyon + Ayarlar Electron başlık çubuğunda).
 *
 * CARD_VERSION: mevcut #desktop-teklif-perfex-menu (eski Operasyon linki /
 * staff / Yeni teklif) her inject ve MutationObserver turunda yeniden yazılır.
 */

const CARD_VERSION = 'title-ops-1';

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildPerfexMenuPayload({
  userName,
  userRole,
  avatar,
  hasAuth,
  licensed,
  licenseLabel,
  createBusy,
  canCreate,
  tasks,
  history,
} = {}) {
  return {
    userName: userName || 'Kullanıcı',
    userRole: userRole || '',
    avatar: avatar || '?',
    hasAuth: !!hasAuth,
    licensed: !!licensed,
    licenseLabel: licenseLabel || '',
    createBusy: !!createBusy,
    canCreate: !!canCreate,
    tasks: Array.isArray(tasks) ? tasks : [],
    history: Array.isArray(history) ? history.slice(0, 8) : [],
  };
}

function buildPerfexMenuInjectScript(payload) {
  const json = JSON.stringify(payload || {});
  const version = JSON.stringify(CARD_VERSION);
  return `(() => {
    const payload = ${json};
    const MENU_ID = 'desktop-teklif-perfex-menu';
    const STYLE_ID = 'desktop-teklif-perfex-style';
    const CARD_VERSION = ${version};

    const hideSelectors = [
      'li.menu-item-newsfeed',
      'li.menu-item-news',
      'a[href*="newsfeed"]',
      'a[href*="/news"]',
      '[id*="newsfeed"]',
      '[class*="newsfeed"]',
      '.widget-newsfeed',
      'li.menu-item-dt-ayarlar',
      'li.menu-item-desktop-ayarlar',
      'li.menu-item-desktop_teklif_ayarlar',
      'li.menu-item-desktop_teklif_yeni',
      'li.menu-item-desktop_teklif_operasyon',
      'a[href^="desktop-teklif://ayarlar"]',
      'a[href^="desktop-teklif://yeni"]',
      'a[href^="desktop-teklif://operasyon"]',
      'a[data-desktop-action="ayarlar"]',
      'a[data-desktop-action="yeni"]',
      'a[data-desktop-action="yeni-teklif"]',
      'a[data-desktop-action="operasyon"]',
      '#dt-teklif-btn',
    ];

    function textLooksNews(el) {
      const t = String((el && el.textContent) || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      if (!t) return false;
      return (
        t.indexOf('haberler') !== -1 ||
        t.indexOf('sizin için haberler') !== -1 ||
        t.indexOf('newsfeed') !== -1 ||
        t.indexOf('news and interests') !== -1
      );
    }

    function hrefLooksDesktop(href) {
      return /desktop-teklif|dt-ayarlar|dt_ayarlar|dt-yeni|dt-operasyon|mrp_theme\\/desktop/i.test(String(href || ''));
    }

    function hideNewsAndDuplicateSettings() {
      hideSelectors.forEach((sel) => {
        document.querySelectorAll(sel).forEach((el) => {
          if (el.closest && el.closest('#' + MENU_ID)) return;
          if (el.closest && el.closest('#titlebar, .window-controls, #btnTitleOperasyon')) return;
          el.style.setProperty('display', 'none', 'important');
        });
      });
      document.querySelectorAll('#side-menu li, aside#menu li, ul.nav li').forEach((li) => {
        if (li.id === MENU_ID || (li.closest && li.closest('#' + MENU_ID))) return;
        if (textLooksNews(li)) li.style.setProperty('display', 'none', 'important');
        const label = String((li.textContent || '')).replace(/\\s+/g, ' ').trim().toLowerCase();
        const href = ((li.querySelector && li.querySelector('a')) || li).getAttribute
          ? ((li.querySelector('a') || li).getAttribute('href') || '')
          : '';
        const actionEl = li.querySelector && li.querySelector('[data-desktop-action]');
        const action = actionEl && actionEl.getAttribute
          ? (actionEl.getAttribute('data-desktop-action') || '')
          : '';
        const isDesktopRow = hrefLooksDesktop(href) || /^(yeni|yeni-teklif|ayarlar|operasyon)$/i.test(action);
        if (label === 'ayarlar' || label === 'settings') {
          if (isDesktopRow) li.style.setProperty('display', 'none', 'important');
        }
        if (label === 'yeni teklif' || label.indexOf('yeni teklif') === 0) {
          li.style.setProperty('display', 'none', 'important');
        }
        if (label === 'operasyon' && isDesktopRow) {
          li.style.setProperty('display', 'none', 'important');
        }
      });
    }

    function ensureStyle() {
      let style = document.getElementById(STYLE_ID);
      if (!style) {
        style = document.createElement('style');
        style.id = STYLE_ID;
        document.head.appendChild(style);
      }
      style.textContent = [
        '#' + MENU_ID + '{list-style:none;margin:8px 10px 14px;padding:0;}',
        '#' + MENU_ID + ' .dt-card{background:rgba(31,111,235,.12);border:1px solid rgba(31,111,235,.28);border-radius:10px;padding:10px 12px;color:#e8eef6;}',
        '#' + MENU_ID + ' .dt-role{font-size:11px;opacity:.75;margin:0 2px 8px;}',
        '#' + MENU_ID + ' .dt-section{margin:10px 2px 4px;font-size:10px;letter-spacing:.08em;text-transform:uppercase;opacity:.7;}',
        '#' + MENU_ID + ' a.dt-link{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;color:#e8eef6;text-decoration:none;font-size:13px;}',
        '#' + MENU_ID + ' a.dt-link:hover{background:rgba(255,255,255,.06);}',
        '#' + MENU_ID + ' a.dt-warn{color:#f85149;}',
        '#' + MENU_ID + ' .dt-empty{font-size:12px;opacity:.65;padding:4px 10px;}',
      ].join('');
    }

    function menuParent() {
      return (
        document.getElementById('side-menu') ||
        document.querySelector('aside#menu ul.nav') ||
        document.querySelector('#menu ul') ||
        document.querySelector('.sidebar ul.nav') ||
        document.querySelector('ul.metis-menu')
      );
    }

    function esc(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function cardHtml() {
      const tasksHtml = (payload.tasks || [])
        .filter((t) => {
          const action = String(t.action || '');
          return action !== 'yeni' && action !== 'yeni-teklif' && action !== 'operasyon';
        })
        .map((t) => {
          const cls = t.tone === 'err' ? 'dt-link dt-warn' : 'dt-link';
          const action = esc(String(t.action || ''));
          const extra = esc(String(t.extra != null ? t.extra : ''));
          return '<a class="' + cls + '" href="#" data-desktop-action="' + action + '" data-desktop-extra="' + extra + '">' + esc(t.label || '') + '</a>';
        }).join('');

      const historyHtml = (payload.history || []).length
        ? payload.history.map((h) => (
          '<a class="dt-link" href="#" data-desktop-action="open-path" data-desktop-extra="' +
          esc(h.path || '') + '">' + esc(h.name || '—') + '</a>'
        )).join('')
        : '<p class="dt-empty">Henüz teklif yok</p>';

      return (
        '<div class="dt-card" data-dt-card="' + esc(CARD_VERSION) + '">' +
          (payload.licenseLabel ? '<div class="dt-role">' + esc(payload.licenseLabel) + '</div>' : '') +
          tasksHtml +
          '<p class="dt-section">Son teklifler</p>' +
          historyHtml +
        '</div>'
      );
    }

    function menuNeedsPaint(root) {
      if (!root) return true;
      if (root.getAttribute('data-dt-card') !== CARD_VERSION) return true;
      const html = String(root.innerHTML || '');
      if (root.querySelector('a[data-desktop-action="operasyon"], a.dt-ops')) return true;
      if (root.querySelector('[class*="dt-user"], [class*="dt-avatar"], #dt-teklif-btn')) return true;
      if (html.indexOf('dt-user') !== -1 || html.indexOf('dt-avatar') !== -1) return true;
      if (/yap[\\u0131i]lacaklar/i.test(html)) return true;
      if (/yeni teklif olu/i.test(html)) return true;
      return false;
    }

    function render() {
      if (window.__dtPerfexPainting) return !!document.getElementById(MENU_ID);
      window.__dtPerfexPainting = true;
      try {
        ensureStyle();
        hideNewsAndDuplicateSettings();
        const parent = menuParent();
        if (!parent) return false;

        let root = document.getElementById(MENU_ID);
        if (!root) {
          root = document.createElement('li');
          root.id = MENU_ID;
          parent.insertBefore(root, parent.firstChild);
        } else if (root.parentNode !== parent) {
          parent.insertBefore(root, parent.firstChild);
        } else if (parent.firstChild !== root) {
          parent.insertBefore(root, parent.firstChild);
        }

        root.setAttribute('data-dt-card', CARD_VERSION);
        root.innerHTML = cardHtml();
        hideNewsAndDuplicateSettings();
        return true;
      } finally {
        window.__dtPerfexPainting = false;
      }
    }

    const painted = render();
    if (window.__dtPerfexObs && window.__dtPerfexObs.disconnect) {
      try { window.__dtPerfexObs.disconnect(); } catch (e) {}
    }
    window.__dtPerfexObs = new MutationObserver(() => {
      if (window.__dtPerfexPainting) return;
      hideNewsAndDuplicateSettings();
      const parent = menuParent();
      if (!parent) return;
      const root = document.getElementById(MENU_ID);
      if (!root || root.parentNode !== parent || menuNeedsPaint(root)) render();
    });
    window.__dtPerfexObs.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
    });
    return painted;
  })();`;
}

module.exports = {
  CARD_VERSION,
  escapeHtml,
  buildPerfexMenuPayload,
  buildPerfexMenuInjectScript,
};

if (require.main === module) {
  const script = buildPerfexMenuInjectScript(
    buildPerfexMenuPayload({
      userName: 'Can',
      userRole: '@mrp',
      avatar: 'SE',
      tasks: [
        { label: 'JWT girin', action: 'open-settings', tone: 'err' },
        { label: 'Operasyon', action: 'operasyon' },
        { label: 'Yeni teklif oluşturabilirsiniz', action: 'yeni', tone: 'ok' },
      ],
      history: [{ name: 'T-1', path: '/tmp/x' }],
    })
  );
  const cardAt = script.indexOf('function cardHtml');
  const cardChunk = cardAt >= 0 ? script.slice(cardAt, cardAt + 2200) : '';
  const ok =
    script.includes('desktop-teklif-perfex-menu') &&
    script.includes('newsfeed') &&
    script.includes('menu-item-dt-ayarlar') &&
    script.includes('menu-item-desktop_teklif_yeni') &&
    script.includes('menu-item-desktop_teklif_operasyon') &&
    !script.includes('>Ayarlar<') &&
    script.includes('a[data-desktop-action="operasyon"]') &&
    !script.includes('dt-link dt-ops') &&
    !script.includes('>Operasyon<') &&
    script.includes('data-dt-card') &&
    script.includes('menuNeedsPaint') &&
    script.includes('innerHTML = cardHtml') &&
    script.includes('#dt-teklif-btn') &&
    !cardChunk.includes('class="dt-user"') &&
    !cardChunk.includes('class="dt-avatar"') &&
    !cardChunk.includes('Yapılacaklar') &&
    !cardChunk.includes('id="dt-teklif-btn"') &&
    !cardChunk.includes('>Yeni Teklif<') &&
    !cardChunk.includes('Yeni teklif oluşturabilirsiniz') &&
    !/if \(parent && !document\.getElementById\(MENU_ID\)\) render\(\)/.test(script);
  if (!ok) {
    console.error('FAIL inject script markers');
    process.exit(1);
  }
  console.log('perfexMenuInject self-check passed');
}
