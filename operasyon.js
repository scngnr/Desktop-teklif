/**
 * Native Operasyon paneli — JWT REST.
 * Liste: api/v1/mrp/operations/proposals (yoksa 404 metni).
 * Taskbar/WO fallback: api/v1/mrp/work_orders.
 */
(function () {
  const LIMIT = 50;
  let status = 'open';
  let scope = 'outstanding';
  let query = '';
  let offset = 0;
  let selectedId = null;
  let pollTimer = null;
  let lastMsgId = 0;
  let needSettingsHandler = null;

  function el(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtDate(raw) {
    if (!raw) return '—';
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return String(raw);
    return d.toLocaleString('tr-TR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function toast(msg, kind) {
    if (typeof window.showToast === 'function') window.showToast(msg, kind || 'err');
  }

  async function apiGet(path) {
    if (!window.teklifApp || !window.teklifApp.apiRequest) {
      return { ok: false, status: 0, error: 'apiRequest yok' };
    }
    return window.teklifApp.apiRequest('GET', path);
  }

  function queryString(params) {
    const u = new URLSearchParams();
    Object.keys(params || {}).forEach((k) => {
      const v = params[k];
      if (v == null || v === '') return;
      u.set(k, String(v));
    });
    const s = u.toString();
    return s ? '?' + s : '';
  }

  function explainError(result) {
    if (!result) return 'İstek başarısız.';
    if (result.status === 404) {
      return 'Üretim / operasyon ucu yok (modül kapalı veya eski API).';
    }
    if (result.status === 401 || result.status === 403) {
      return 'Yetki yok veya JWT geçersiz.';
    }
    return result.error || result.text || ('HTTP ' + result.status);
  }

  function stopPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function setChips(container, value) {
    if (!container) return;
    container.querySelectorAll('[data-value]').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-value') === value);
    });
  }

  function renderMetrics(health) {
    const host = el('opsMetrics');
    if (!host) return;
    const ops = (health && (health.ops || health)) || {};
    const cards = [
      { key: 'open', label: 'Açık', value: ops.open ?? ops.open_count ?? '—' },
      { key: 'accepted', label: 'Kabul', value: ops.accepted ?? ops.accepted_count ?? '—' },
      { key: 'overdue', label: 'Geciken', value: ops.overdue ?? ops.overdue_count ?? '—' },
    ];
    host.innerHTML = cards
      .map(
        (c) =>
          '<button type="button" class="ops-metric" data-metric="' +
          escapeHtml(c.key) +
          '"><span>' +
          escapeHtml(c.label) +
          '</span><strong>' +
          escapeHtml(c.value) +
          '</strong></button>'
      )
      .join('');
  }

  function badgesHtml(item) {
    const bits = [];
    if (item.status) bits.push('<span class="ops-badge">' + escapeHtml(item.status) + '</span>');
    if (item.priority) bits.push('<span class="ops-badge">' + escapeHtml(item.priority) + '</span>');
    return bits.join(' ');
  }

  function renderList(items, total) {
    const body = el('opsTableBody');
    const foot = el('opsListFoot');
    if (!body) return;
    const rows = Array.isArray(items) ? items : [];
    if (rows.length === 0) {
      body.innerHTML =
        '<tr><td colspan="4" class="ops-empty">Kayıt yok</td></tr>';
    } else {
      body.innerHTML = rows
        .map((item) => {
          const id = item.id || item.proposal_id || '';
          return (
            '<tr data-id="' +
            escapeHtml(id) +
            '">' +
            '<td>' +
            escapeHtml(item.number || item.proposal_number || id) +
            '</td>' +
            '<td>' +
            escapeHtml(item.customer || item.company || item.subject || '—') +
            '</td>' +
            '<td>' +
            badgesHtml(item) +
            '</td>' +
            '<td>' +
            escapeHtml(fmtDate(item.date || item.updated_at || item.created_at)) +
            '</td>' +
            '</tr>'
          );
        })
        .join('');
    }
    if (foot) {
      foot.textContent = total != null ? total + ' kayıt' : '';
    }
  }

  function woStatus(wo) {
    return String(wo.status || wo.wo_status || '').toLowerCase();
  }

  function materialsHtml(detail) {
    const mats = detail.materials || detail.items || [];
    if (!Array.isArray(mats) || mats.length === 0) return '<p class="ops-empty">Malzeme yok</p>';
    return (
      '<ul class="ops-materials">' +
      mats
        .map(
          (m) =>
            '<li>' +
            escapeHtml(m.description || m.name || m.code || '—') +
            (m.qty != null ? ' × ' + escapeHtml(m.qty) : '') +
            '</li>'
        )
        .join('') +
      '</ul>'
    );
  }

  function woTable(detail) {
    const wos = detail.work_orders || detail.wos || [];
    if (!Array.isArray(wos) || wos.length === 0) return '<p class="ops-empty">İş emri yok</p>';
    return (
      '<table class="ops-mini"><thead><tr><th>İş emri</th><th>Durum</th></tr></thead><tbody>' +
      wos
        .map(
          (w) =>
            '<tr><td>' +
            escapeHtml(w.number || w.id || '—') +
            '</td><td>' +
            escapeHtml(w.status || '—') +
            '</td></tr>'
        )
        .join('') +
      '</tbody></table>'
    );
  }

  function renderDetail(detail) {
    const pane = el('opsDetailPane');
    if (!pane || !detail) return;
    const id = detail.id || selectedId;
    pane.innerHTML =
      '<div class="ops-detail-head">' +
      '<h2>' +
      escapeHtml(detail.number || detail.proposal_number || ('#' + id)) +
      '</h2>' +
      '<p>' +
      escapeHtml(detail.customer || detail.company || detail.subject || '') +
      '</p>' +
      '</div>' +
      '<div class="ops-detail-actions">' +
      '<button type="button" data-web="proposal">Teklif</button>' +
      '<button type="button" data-web="order">Üretim</button>' +
      '<button type="button" data-web="chat">Sohbet</button>' +
      '</div>' +
      '<h3>Malzemeler</h3>' +
      materialsHtml(detail) +
      '<h3>İş emirleri</h3>' +
      woTable(detail) +
      '<h3>Mesajlar</h3>' +
      '<div id="opsMessages" class="ops-messages"></div>';
  }

  function renderMessages(messages) {
    const host = el('opsMessages');
    if (!host) return;
    const list = Array.isArray(messages) ? messages : [];
    if (list.length === 0) {
      host.innerHTML = '<p class="ops-empty">Mesaj yok</p>';
      return;
    }
    host.innerHTML = list
      .map(
        (m) =>
          '<div class="ops-msg"><strong>' +
          escapeHtml(m.user || m.staff || '—') +
          '</strong> <span>' +
          escapeHtml(fmtDate(m.created_at || m.date)) +
          '</span><p>' +
          escapeHtml(m.message || m.body || '') +
          '</p></div>'
      )
      .join('');
  }

  async function loadMessages() {
    if (!selectedId) return;
    const qs = queryString({ after_id: lastMsgId || undefined, limit: 50 });
    const result = await apiGet(
      'api/v1/mrp/operations/proposals/' + encodeURIComponent(selectedId) + '/messages' + qs
    );
    if (!result.ok) return;
    const json = result.json || {};
    const items = json.items || json.data || json.messages || [];
    items.forEach((m) => {
      const id = Number(m.id || 0);
      if (id > lastMsgId) lastMsgId = id;
    });
    renderMessages(items);
  }

  function startPoll() {
    stopPoll();
    pollTimer = setInterval(loadMessages, 15000);
  }

  async function loadHistory() {
    if (!window.teklifApp || !window.teklifApp.listHistory) return [];
    const result = await window.teklifApp.listHistory();
    return (result && result.items) || [];
  }

  async function loadWorkOrdersFallback() {
    const result = await apiGet('api/v1/mrp/work_orders?limit=500');
    if (!result.ok) return { items: [], error: explainError(result) };
    const json = result.json || {};
    const raw = json.data || json.items || json.work_orders || [];
    const items = (Array.isArray(raw) ? raw : []).map((w) => ({
      id: w.id,
      number: w.number || w.wo_number || w.id,
      customer: w.product || w.description || 'İş emri',
      status: w.status,
      date: w.date_created || w.updated_at,
    }));
    return { items, total: items.length, fallback: true };
  }

  async function loadList() {
    const title = el('opsSubtitle');
    if (title) title.textContent = 'Yükleniyor…';

    const healthRes = await apiGet('api/v1/mrp/health');
    renderMetrics(healthRes.ok ? healthRes.json : null);

    const ids = [];
    if (scope === 'ids') {
      const hist = await loadHistory();
      hist.forEach((h) => {
        if (h.proposalId) ids.push(h.proposalId);
      });
      if (ids.length === 0) {
        renderList([], 0);
        if (title) title.textContent = 'Yerel teklif geçmişi boş';
        return;
      }
    }

    const qs = queryString({
      status: status === 'all' ? '' : status,
      scope,
      q: query,
      limit: LIMIT,
      offset,
      ids: ids.join(','),
    });
    const result = await apiGet('api/v1/mrp/operations/proposals' + qs);
    if (!result.ok) {
      if (
        (result.status === 401 || result.status === 403) &&
        typeof needSettingsHandler === 'function'
      ) {
        needSettingsHandler();
      }
      const fallback = await loadWorkOrdersFallback();
      if (fallback.items && fallback.items.length) {
        renderList(fallback.items, fallback.total);
        if (title) title.textContent = 'İş emirleri (operasyon ucu yok)';
        toast(explainError(result), 'warn');
        return;
      }
      renderList([], 0);
      if (title) title.textContent = explainError(result);
      toast(explainError(result), 'err');
      return;
    }
    const json = result.json || {};
    const items = json.items || json.data || [];
    const total = json.total != null ? json.total : items.length;
    renderList(items, total);
    if (json.health) renderMetrics({ ops: json.health });
    if (title) title.textContent = total + ' operasyon kaydı';
  }

  async function openDetail(id) {
    selectedId = id;
    lastMsgId = 0;
    el('opsListPane').hidden = true;
    el('opsDetailPane').hidden = false;
    el('opsBtnBack').hidden = false;
    const result = await apiGet(
      'api/v1/mrp/operations/proposals/' + encodeURIComponent(id)
    );
    if (!result.ok) {
      el('opsDetailPane').innerHTML =
        '<p class="ops-empty">' + escapeHtml(explainError(result)) + '</p>';
      toast(explainError(result), 'err');
      return;
    }
    renderDetail(result.json && (result.json.data || result.json.item || result.json));
    await loadMessages();
    startPoll();
  }

  function openWeb(kind) {
    if (!window.OperasyonView.openWebPath || !selectedId) return;
    if (kind === 'proposal') {
      window.OperasyonView.openWebPath('proposals/list_proposals/' + selectedId);
    } else if (kind === 'order') {
      window.OperasyonView.openWebPath(
        'manufacturing/order_summary?src=proposal&ref=' + selectedId
      );
    } else if (kind === 'chat') {
      window.OperasyonView.openWebPath('prchat/Prchat_Controller/chat_full_view?tab=groups');
    } else if (kind === 'health') {
      window.OperasyonView.openWebPath('manufacturing/ops_health');
    }
  }

  function bind() {
    const search = el('opsSearch');
    if (search && !search.dataset.bound) {
      search.dataset.bound = '1';
      let t = null;
      search.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => {
          query = search.value.trim();
          offset = 0;
          loadList();
        }, 280);
      });
    }
    const refresh = el('opsBtnRefresh');
    if (refresh && !refresh.dataset.bound) {
      refresh.dataset.bound = '1';
      refresh.addEventListener('click', () => loadList());
    }
    const back = el('opsBtnBack');
    if (back && !back.dataset.bound) {
      back.dataset.bound = '1';
      back.addEventListener('click', () => {
        stopPoll();
        selectedId = null;
        el('opsDetailPane').hidden = true;
        el('opsListPane').hidden = false;
        back.hidden = true;
      });
    }
    const statusChips = el('opsStatusChips');
    if (statusChips && !statusChips.dataset.bound) {
      statusChips.dataset.bound = '1';
      statusChips.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-value]');
        if (!btn) return;
        status = btn.getAttribute('data-value');
        setChips(statusChips, status);
        offset = 0;
        loadList();
      });
    }
    const scopeChips = el('opsScopeChips');
    if (scopeChips && !scopeChips.dataset.bound) {
      scopeChips.dataset.bound = '1';
      scopeChips.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-value]');
        if (!btn) return;
        scope = btn.getAttribute('data-value');
        setChips(scopeChips, scope);
        offset = 0;
        loadList();
      });
    }
    const table = el('opsTable');
    if (table && !table.dataset.bound) {
      table.dataset.bound = '1';
      table.addEventListener('click', (e) => {
        const row = e.target.closest('tr[data-id]');
        if (!row) return;
        openDetail(row.getAttribute('data-id'));
      });
    }
    const metrics = el('opsMetrics');
    if (metrics && !metrics.dataset.bound) {
      metrics.dataset.bound = '1';
      metrics.addEventListener('click', (e) => {
        if (!e.target.closest('.ops-metric')) return;
        openWeb('health');
      });
    }
    const detail = el('opsDetailPane');
    if (detail && !detail.dataset.bound) {
      detail.dataset.bound = '1';
      detail.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-web]');
        if (!btn) return;
        openWeb(btn.getAttribute('data-web'));
      });
    }
  }

  window.OperasyonView = {
    async show() {
      bind();
      setChips(el('opsStatusChips'), status);
      setChips(el('opsScopeChips'), scope);
      el('opsListPane').hidden = false;
      el('opsDetailPane').hidden = true;
      if (el('opsBtnBack')) el('opsBtnBack').hidden = true;
      await loadHistory();
      await loadList();
    },
    hide() {
      stopPoll();
    },
    openWebPath: null,
    onNeedSettings(fn) {
      needSettingsHandler = fn;
    },
  };
})();
