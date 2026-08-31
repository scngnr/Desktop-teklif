/**
 * Perfex admin kenar çubuğuna Desktop Teklif menüsü basar.
 * Haberler / newsfeed gizlenir; tema PR #12 Ayarlar satırı da gizlenir
 * (Ayarlar yalnızca Electron başlık çubuğunda).
 */

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
  return `(() => {
    const payload = ${json};
    const MENU_ID = 'desktop-teklif-perfex-menu';
    const STYLE_ID = 'desktop-teklif-perfex-style';

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
      'a[data-desktop-action="ayarlar"]',
      'a[data-desktop-action="yeni"]',
      'a[data-desktop-action="yeni-teklif"]',
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

    function hideNewsAndDuplicateSettings() {
      hideSelectors.forEach((sel) => {
        document.querySelectorAll(sel).forEach((el) => {
          if (el.closest && el.closest('#' + MENU_ID)) return;
          el.style.setProperty('display', 'none', 'important');
        });
      });
      document.querySelectorAll('#side-menu li, aside#menu li, ul.nav li').forEach((li) => {
        if (li.id === MENU_ID || (li.closest && li.closest('#' + MENU_ID))) return;
        if (textLooksNews(li)) li.style.setProperty('display', 'none', 'important');
        const label = String((li.textContent || '')).replace(/\\s+/g, ' ').trim().toLowerCase();
        if (label === 'ayarlar' || label === 'settings') {
          const href = ((li.querySelector && li.querySelector('a')) || li).getAttribute
            ? ((li.querySelector('a') || li).getAttribute('href') || '')
            : '';
          if (/desktop-teklif|dt-ayarlar|dt_ayarlar/i.test(href)) {
            li.style.setProperty('display', 'none', 'important');
          }
        }
      });
    }

    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = [
        '#' + MENU_ID + '{list-style:none;margin:8px 10px 14px;padding:0;}',
        '#' + MENU_ID + ' .dt-card{background:rgba(31,111,235,.12);border:1px solid rgba(31,111,235,.28);border-radius:10px;padding:10px 12px;color:#e8eef6;}',
        '#' + MENU_ID + ' .dt-role{font-size:11px;opacity:.75;margin:0 2px 8px;}',
        '#' + MENU_ID + ' .dt-section{margin:10px 2px 4px;font-size:10px;letter-spacing:.08em;text-transform:uppercase;opacity:.7;}',
        '#' + MENU_ID + ' a.dt-link{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;color:#e8eef6;text-decoration:none;font-size:13px;}',
        '#' + MENU_ID + ' a.dt-link:hover{background:rgba(255,255,255,.06);}',
        '#' + MENU_ID + ' a.dt-ops{font-weight:650;background:rgba(31,111,235,.22);}',
        '#' + MENU_ID + ' a.dt-warn{color:#f85149;}',
        '#' + MENU_ID + ' .dt-empty{font-size:12px;opacity:.65;padding:4px 10px;}',
      ].join('');
      document.head.appendChild(style);
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

    function render() {
      ensureStyle();
      hideNewsAndDuplicateSettings();
      const parent = menuParent();
      if (!parent) return;

      let root = document.getElementById(MENU_ID);
      if (!root) {
        root = document.createElement('li');
        root.id = MENU_ID;
        parent.insertBefore(root, parent.firstChild);
      }

      const tasksHtml = (payload.tasks || [])
        .filter((t) => {
          const action = String(t.action || '');
          return action !== 'yeni' && action !== 'yeni-teklif';
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

      root.innerHTML =
        '<div class="dt-card">' +
          (payload.licenseLabel ? '<div class="dt-role">' + esc(payload.licenseLabel) + '</div>' : '') +
          '<a class="dt-link dt-ops" href="#" data-desktop-action="operasyon">Operasyon</a>' +
          tasksHtml +
          '<p class="dt-section">Son teklifler</p>' +
          historyHtml +
        '</div>';
    }

    render();
    if (!window.__dtPerfexObs) {
      window.__dtPerfexObs = new MutationObserver(() => {
        hideNewsAndDuplicateSettings();
        const parent = menuParent();
        if (parent && !document.getElementById(MENU_ID)) render();
      });
      window.__dtPerfexObs.observe(document.body, { childList: true, subtree: true });
    }
    return true;
  })();`;
}

module.exports = {
  escapeHtml,
  buildPerfexMenuPayload,
  buildPerfexMenuInjectScript,
};

if (require.main === module) {
  const script = buildPerfexMenuInjectScript(
    buildPerfexMenuPayload({
      userName: 'Can',
      tasks: [{ label: 'JWT girin', action: 'open-settings', tone: 'err' }],
      history: [{ name: 'T-1', path: '/tmp/x' }],
    })
  );
  const ok =
    script.includes('desktop-teklif-perfex-menu') &&
    script.includes('newsfeed') &&
    script.includes('menu-item-dt-ayarlar') &&
    !script.includes('>Ayarlar<') &&
    script.includes('data-desktop-action="operasyon"') &&
    script.includes('>Operasyon<') &&
    !script.includes('dt-user') &&
    !script.includes('dt-avatar') &&
    !script.includes('Yapılacaklar') &&
    !script.includes('id="dt-teklif-btn"') &&
    !script.includes('>Yeni Teklif<') &&
    !script.includes('Yeni teklif');
  if (!ok) {
    console.error('FAIL inject script markers');
    process.exit(1);
  }
  console.log('perfexMenuInject self-check passed');
}
