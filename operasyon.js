/**
 * Native Operasyon konsolu — JWT REST.
 * İstekler teklifApp.apiRequest (src/mrpApi.js) ile gider; kök ayarlardaki
 * Base URL / Giriş URL’den türetilir (host sabitlenmez).
 * Birincil liste: GET api/v1/sales_lifecycle?source=proposal (sayfalı, tüm teklifler).
 * Birincil detay: GET api/v1/sales_lifecycle/proposal/{id} (tüm bölümler).
 * Yedek: api/teklif, api/proposals ve MRP uçları. Sahte kayıt yok.
 * Filtre: Tümü / Açık işler / Kabul edilmiş + arama.
 * Kabul: yalnız data.accepted === true (MO/sevk var diye kabul sayılmaz).
 * Açık: status === 1. Başlık: data.title veya company / customer_name (customer obje).
 * KPI: data.counts.shipments / mos / purchased. İlk sekme: data.default_tab.
 * Sevk: data.shipments[] veya data.sections.shipments.rows[].
 * data.items teklif kalemidir, satınalma değil; purchased gerçek PR/PO.
 */
(function () {
  const LIMIT = 50;
  const LIFE_PAGE = 100;
  const LIFE_MAX_PAGES = 50;
  const TABS = [
    { id: 'purchased', label: 'Satınalma' },
    { id: 'shipments', label: 'Sevkiyatlar' },
    { id: 'mo', label: "MO'lar" },
    { id: 'items', label: 'Teklif kalemleri' },
    { id: 'warehouse', label: 'Depodan alınan' },
    { id: 'quality', label: 'Kalite' },
  ];

  let status = 'all';
  let scope = 'outstanding';
  let query = '';
  let offset = 0;
  let selectedId = null;
  let selectedItem = null;
  let detailTab = 'mo';
  let pollTimer = null;
  let needSettingsHandler = null;
  let listSource = 'teklif';
  let cachedBaseUrl = '';
  let lastListItems = [];

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
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function fmtMoney(raw) {
    if (raw == null || raw === '') return '—';
    const n = Number(String(raw).replace(',', '.'));
    if (!Number.isFinite(n)) return escapeHtml(raw);
    return n.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

  async function refreshBaseUrl() {
    cachedBaseUrl = '';
    if (!window.teklifApp || !window.teklifApp.getConfig) return '';
    try {
      const cfg = await window.teklifApp.getConfig();
      cachedBaseUrl = String((cfg && (cfg.apiRoot || cfg.baseUrl)) || '').replace(/\/+$/, '');
    } catch {
      cachedBaseUrl = '';
    }
    return cachedBaseUrl;
  }

  function explainError(result) {
    if (!result) return 'İstek başarısız.';
    if (result.status === 404) {
      return 'İstenen API ucu yok (modül kapalı veya yol tanınmıyor).';
    }
    if (result.status === 401 || result.status === 403) {
      return 'Yetki yok veya JWT geçersiz.';
    }
    return result.error || result.text || ('HTTP ' + result.status);
  }

  function asArray(json) {
    if (!json) return [];
    if (Array.isArray(json)) return json;
    const keys = [
      'items',
      'data',
      'records',
      'results',
      'proposals',
      'teklif',
      'teklifs',
      'quotes',
      'sales_lifecycle',
      'lifecycle',
      'manufacturing_orders',
      'work_orders',
      'work_centers',
      'shipments',
      'external_shipments',
      'materials',
      'products',
      'purchases',
      'purchased',
      'warehouse',
      'warehouse_picks',
      'quality',
      'quality_ops',
      'open_jobs',
      'boms',
      'bom',
      'lines',
      'newitems',
    ];
    for (let i = 0; i < keys.length; i++) {
      const v = json[keys[i]];
      if (Array.isArray(v)) return v;
    }
    if (json.data && typeof json.data === 'object') return asArray(json.data);
    return [];
  }

  function isRecord(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    if (obj.status === false) return false;
    return !!(
      obj.id ||
      obj.proposal_id ||
      obj.teklif_id ||
      obj.subject ||
      obj.number ||
      obj.proposal_number ||
      obj.title ||
      obj.customer_name ||
      obj.accepted === true ||
      obj.accepted === false
    );
  }

  function unwrapRecords(json) {
    if (!json) return [];
    if (Array.isArray(json)) return json.filter((row) => row && typeof row === 'object');
    if (typeof json !== 'object') return [];
    if (json.status === false) return [];
    // Tekil teklif {data:{id, items:[...]}} satır dizisi sanılmasın.
    if (Array.isArray(json.data)) return json.data.filter((row) => row && typeof row === 'object');
    if (json.data && isRecord(json.data)) return [json.data];
    if (isRecord(json)) return [json];
    return asArray(json).filter((row) => row && typeof row === 'object');
  }

  function unwrapOne(json, id) {
    const rows = unwrapRecords(json);
    if (!rows.length) return null;
    if (id == null || id === '') return rows[0];
    const sid = String(id);
    const hit = rows.find((row) => String(itemId(row)) === sid);
    return hit || (rows.length === 1 ? rows[0] : null);
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

  function statusLabel(itemOrRaw) {
    if (itemOrRaw && typeof itemOrRaw === 'object') {
      if (isAccepted(itemOrRaw)) return 'Kabul edilmiş';
      if (isOpenStatus(itemOrRaw)) return 'Açık';
      const raw = itemOrRaw.status_key || itemOrRaw.status_name || itemOrRaw.status;
      if (raw && typeof raw === 'object') return statusLabel(raw.name || raw.label || raw.key || '');
      return raw != null && raw !== '' ? String(raw) : '—';
    }
    const s = String(itemOrRaw == null ? '' : itemOrRaw).toLowerCase();
    if (s === '1') return 'Açık';
    if (s === 'draft') return 'Taslak';
    if (s === '2' || s === 'sent') return 'Gönderildi';
    if (s === '4' || /revis/.test(s)) return 'Revize';
    if (s === '5' || /declin|red/.test(s)) return 'Reddedildi';
    return itemOrRaw ? String(itemOrRaw) : '—';
  }

  function isAccepted(item) {
    if (!item || typeof item !== 'object') return false;
    const root = lifecycleRecord(item) || item;
    return root.accepted === true;
  }

  function isOpenStatus(item) {
    if (!item || typeof item !== 'object') return false;
    const root = lifecycleRecord(item) || item;
    if (root.accepted === true) return false;
    return Number(root.status) === 1 || String(root.status) === '1';
  }

  function teklifSortId(item) {
    const raw = item && (item.id != null && item.id !== '' ? item.id : item.proposal_id || item.teklif_id);
    if (raw == null || raw === '') return Number.NEGATIVE_INFINITY;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
    const m = String(raw).match(/(\d+)\s*$/);
    return m ? Number(m[1]) : Number.NEGATIVE_INFINITY;
  }

  function sortTeklifIdDesc(items) {
    return (items || []).slice().sort((a, b) => {
      const diff = teklifSortId(b) - teklifSortId(a);
      if (diff) return diff;
      return String(itemId(b)).localeCompare(String(itemId(a)), undefined, { numeric: true, sensitivity: 'base' });
    });
  }

  function productionStatusText(row) {
    if (!row || typeof row !== 'object') return '';
    let v =
      row.status ??
      row.state ??
      row.mo_status ??
      row.order_status ??
      row.status_name ??
      row.wo_status ??
      row.manufacturing_status ??
      row.production_status;
    if (v && typeof v === 'object') {
      v = v.name || v.label || v.status || v.state || v.code || '';
    }
    return String(v == null ? '' : v)
      .toLowerCase()
      .trim();
  }

  function isClosedProductionStatus(row) {
    if (!row || typeof row !== 'object') return true;
    if (row.cancelled === true || row.canceled === true || row.cancelled === 1 || row.canceled === 1) return true;
    if (row.done === true || row.done === 1 || row.done === '1') return true;
    const s = productionStatusText(row);
    if (!s) {
      return !!(row.date_finished || row.date_done || row.finished_at || row.completed_at);
    }
    if (/cancel|cancelled|canceled|iptal/.test(s)) return true;
    if (/incomplete|unfinished|in[\s_-]*progress/.test(s)) return false;
    if (/^(done|complete|completed|finished|closed|tamam|tamamland[iı]|kapat|kapatild[iı])$/.test(s)) return true;
    if (/\b(done|completed|finished|closed)\b/.test(s)) return true;
    const n = Number(s);
    if (s === '4' || s === '5' || n === 4 || n === 5) return true;
    return false;
  }

  function isOpenProductionStatus(row) {
    return Boolean(row) && !isClosedProductionStatus(row);
  }

  function collectOpenTeklifIds(items, moRows, woRows) {
    const ids = new Set();
    const openMos = (moRows || []).filter(isOpenProductionStatus);
    const openWos = (woRows || []).filter(isOpenProductionStatus);
    (items || []).forEach((item) => {
      const id = itemId(item);
      if (!id) return;
      if (hasLifecycleOpenJob(item)) {
        ids.add(String(id));
        return;
      }
      const hitMo = openMos.some((row) => matchesProposal(row, id, item));
      const hitWo = !hitMo && openWos.some((row) => matchesProposal(row, id, item));
      if (hitMo || hitWo) ids.add(String(id));
    });
    return ids;
  }

  function lifecycleRecord(json) {
    if (!json || typeof json !== 'object' || Array.isArray(json)) return json;
    const data = json.data;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      if (
        data.title ||
        data.company ||
        data.customer_name ||
        data.accepted === true ||
        data.accepted === false ||
        data.counts ||
        data.shipments ||
        data.sections ||
        data.purchased ||
        data.items ||
        data.default_tab ||
        data.id
      ) {
        return data;
      }
    }
    return json;
  }

  function displayText(value) {
    if (value == null || value === '') return '';
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'boolean') return '';
    if (typeof value === 'string') {
      const t = value.trim();
      if (!t || t === '[object Object]') return '';
      return t;
    }
    if (typeof value === 'object') {
      return (
        displayText(value.customer_name) ||
        displayText(value.company) ||
        displayText(value.name) ||
        displayText(value.title) ||
        displayText(value.full_name) ||
        displayText(value.proposal_to) ||
        displayText(value.label)
      );
    }
    return '';
  }

  function firstArray(obj, names) {
    if (!obj || typeof obj !== 'object') return [];
    for (let i = 0; i < names.length; i++) {
      const v = obj[names[i]];
      if (Array.isArray(v) && v.length) return v;
      if (v && typeof v === 'object') {
        if (Array.isArray(v.items) && v.items.length) return v.items;
        if (Array.isArray(v.data) && v.data.length) return v.data;
        if (Array.isArray(v.records) && v.records.length) return v.records;
      }
    }
    return [];
  }

  function lifecycleRoots(json) {
    if (!json || typeof json !== 'object') return [];
    const bags = [json];
    ['data', 'record', 'lifecycle', 'sections', 'payload', 'result', 'proposal'].forEach((k) => {
      if (json[k] && typeof json[k] === 'object' && !Array.isArray(json[k])) bags.push(json[k]);
    });
    if (json.data && typeof json.data === 'object' && !Array.isArray(json.data)) {
      ['record', 'lifecycle', 'sections', 'proposal'].forEach((k) => {
        if (json.data[k] && typeof json.data[k] === 'object' && !Array.isArray(json.data[k])) {
          bags.push(json.data[k]);
        }
      });
    }
    return bags;
  }

  function pickSection(json, names) {
    const root = lifecycleRecord(json) || json;
    for (let i = 0; i < names.length; i++) {
      const found = sectionRows(root, names[i]);
      if (found.length) return found;
    }
    return [];
  }

  function sectionRows(json, name) {
    if (!json || typeof json !== 'object' || !name) return [];
    const root = lifecycleRecord(json) || json;
    const bags = [root];
    if (root.sections && typeof root.sections === 'object') bags.push(root.sections);
    if (json && json !== root) bags.push(json);
    for (let b = 0; b < bags.length; b++) {
      const bag = bags[b];
      if (!bag || typeof bag !== 'object') continue;
      const v = bag[name];
      if (Array.isArray(v) && v.length) return v;
      if (v && typeof v === 'object') {
        if (Array.isArray(v.rows) && v.rows.length) return v.rows;
        if (Array.isArray(v.items) && v.items.length) return v.items;
        if (Array.isArray(v.data) && v.data.length) return v.data;
      }
    }
    return [];
  }

  function hasLifecycleOpenJob(item) {
    if (!item || typeof item !== 'object') return false;
    if (
      item.open_job === true ||
      item.has_open_job === true ||
      item.has_open_mo === true ||
      item.open === true ||
      item.is_open === true
    ) {
      return true;
    }
    const n =
      item.open_jobs_count ??
      item.open_job_count ??
      item.open_mo_count ??
      item.open_count;
    if (n != null && Number(n) > 0) return true;
    const jobs = pickSection(item, [
      'open_jobs',
      'open_mos',
      'open_work_orders',
      'manufacturing_orders',
      'work_orders',
    ]);
    if (jobs.some(isOpenProductionStatus)) return true;
    return false;
  }

  function isOverdue(item) {
    const till = item && (item.open_till || item.date_end || item.due_date);
    if (!till) return false;
    const d = new Date(till);
    if (Number.isNaN(d.getTime())) return false;
    if (isAccepted(item)) return false;
    const end = new Date(d);
    end.setHours(23, 59, 59, 999);
    return end.getTime() < Date.now();
  }

  function itemId(item) {
    if (!item) return '';
    return String(
      item.id || item.proposal_id || item.teklif_id || item.manufacturing_id || item.wo_id || item.shipment_id || ''
    );
  }

  function itemNumber(item) {
    if (!item) return '—';
    return (
      item.number ||
      item.proposal_number ||
      item.formatted_number ||
      item.teklif_no ||
      item.mo_number ||
      item.wo_number ||
      item.shipment_number ||
      item.code ||
      item.subject ||
      ('#' + (itemId(item) || '—'))
    );
  }

  function itemTitle(item) {
    const root = lifecycleRecord(item) || item || {};
    return (
      displayText(root.title) ||
      displayText(root.company) ||
      displayText(root.customer_name) ||
      displayText(root.customer) ||
      itemNumber(root)
    );
  }

  function itemCustomer(item) {
    if (!item) return '—';
    const root = lifecycleRecord(item) || item;
    return (
      displayText(root.customer_name) ||
      displayText(root.company) ||
      displayText(root.customer) ||
      displayText(root.client) ||
      displayText(root.proposal_to) ||
      displayText(root.client_company) ||
      displayText(root.rel_name) ||
      '—'
    );
  }

  function hasRelationField(row) {
    if (!row || typeof row !== 'object') return false;
    const keys = [
      'proposal_id',
      'proposalId',
      'rel_id',
      'source_id',
      'origin_id',
      'teklif_id',
      'parent_id',
      'origin',
      'reference',
      'proposal_number',
      'teklif_no',
    ];
    return keys.some((k) => row[k] != null && String(row[k]).trim() !== '');
  }

  function matchesProposal(row, id, hint) {
    if (!row || id == null || id === '') return false;
    const sid = String(id);
    const keys = [
      'proposal_id',
      'proposalId',
      'rel_id',
      'source_id',
      'origin_id',
      'teklif_id',
      'parent_id',
    ];
    for (let i = 0; i < keys.length; i++) {
      if (row[keys[i]] != null && String(row[keys[i]]) === sid) return true;
    }
    const number = hint ? String(itemNumber(hint)) : '';
    const refs = [row.origin, row.reference, row.proposal_number, row.teklif_no, row.source];
    for (let i = 0; i < refs.length; i++) {
      if (refs[i] == null || refs[i] === '') continue;
      const s = String(refs[i]);
      if (s === sid) return true;
      if (number && number !== '—' && (s === number || s.indexOf(number) !== -1)) return true;
    }
    return false;
  }

  function filterRelated(rows, id, hint, extraIds) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return [];
    const extras = extraIds || new Set();
    const related = list.filter((row) => {
      if (matchesProposal(row, id, hint)) return true;
      const wo = row.work_order_id || row.wo_id || row.workorder_id;
      const mo = row.manufacturing_id || row.mo_id || row.manufacturing_order_id;
      if (wo != null && extras.has('wo:' + String(wo))) return true;
      if (mo != null && extras.has('mo:' + String(mo))) return true;
      return false;
    });
    if (list.some(hasRelationField) || extras.size) return related;
    return [];
  }

  function setBanner(text, kind) {
    const banner = el('opsBanner');
    if (!banner) return;
    if (!text) {
      banner.hidden = true;
      banner.textContent = '';
      banner.className = 'ops-banner';
      return;
    }
    banner.hidden = false;
    banner.className = 'ops-banner ops-banner-' + (kind || 'info');
    banner.textContent = text;
  }

  function stateHtml(kind, title, body) {
    return (
      '<div class="ops-state ops-state-' +
      escapeHtml(kind) +
      '">' +
      '<strong>' +
      escapeHtml(title) +
      '</strong>' +
      (body ? '<p>' + escapeHtml(body) + '</p>' : '') +
      '</div>'
    );
  }

  function skeletonCards(n) {
    let html = '';
    for (let i = 0; i < n; i++) html += '<div class="ops-card ops-card-skel"></div>';
    return html;
  }

  function renderMetrics(health, extras) {
    const host = el('opsMetrics');
    if (!host) return;
    const ops = (health && (health.ops || health.metrics || health)) || {};
    const extra = extras || {};
    const cards = [
      {
        key: 'all',
        label: 'Tümü',
        value: extra.total ?? ops.total ?? ops.count ?? '—',
      },
      {
        key: 'open',
        label: 'Açık işler',
        value: ops.open ?? ops.open_count ?? extra.open ?? '—',
      },
      {
        key: 'accepted',
        label: 'Kabul edilmiş',
        value: ops.accepted ?? ops.accepted_count ?? extra.accepted ?? '—',
      },
      {
        key: 'overdue',
        label: 'Geciken',
        value: ops.overdue ?? ops.overdue_count ?? extra.overdue ?? '—',
      },
    ];
    host.innerHTML = cards
      .map(
        (c) =>
          '<button type="button" class="ops-metric' +
          (c.key === status ? ' is-focus' : '') +
          '" data-metric="' +
          escapeHtml(c.key) +
          '"><span>' +
          escapeHtml(c.label) +
          '</span><strong>' +
          escapeHtml(c.value) +
          '</strong></button>'
      )
      .join('');
  }

  function sourceLabel(source) {
    if (source === 'sales_lifecycle') return ' · kaynak: api/v1/sales_lifecycle';
    if (source === 'teklif') return ' · kaynak: api/teklif';
    if (source === 'proposals') return ' · kaynak: api/proposals';
    if (source === 'search') return ' · kaynak: arama';
    return '';
  }

  function renderList(items, total, meta) {
    const body = el('opsListBody');
    const foot = el('opsListFoot');
    if (!body) return;
    const rows = Array.isArray(items) ? items : [];
    const info = meta || {};
    if (rows.length === 0) {
      const emptyTitle =
        status === 'accepted'
          ? 'Kabul edilmiş teklif yok'
          : status === 'open'
            ? 'Açık işi olan teklif yok'
            : 'Kayıt yok';
      const emptyBody = info.emptyHint
        ? info.emptyHint
        : 'Filtreleri değiştirin veya API uçları hazır olduğunda kayıtlar burada görünür.';
      body.innerHTML = stateHtml('empty', emptyTitle, emptyBody);
    } else {
      body.innerHTML = rows
        .map((item) => {
          const id = itemId(item);
          const accepted = isAccepted(item);
          const openJob = isOpenStatus(item);
          const tone = accepted ? 'ok' : openJob ? 'open' : 'muted';
          const heading = itemTitle(item);
          const customer = itemCustomer(item);
          const subject = heading !== customer && customer !== '—' ? customer : itemNumber(item);
          const flags =
            (accepted ? '<span class="ops-flag ops-flag-ok">Kabul</span>' : '') +
            (openJob ? '<span class="ops-flag ops-flag-open">Açık</span>' : '');
          return (
            '<article class="ops-card" data-id="' +
            escapeHtml(id) +
            '" role="button" tabindex="0">' +
            '<div class="ops-card-top">' +
            '<span class="ops-badge ops-badge-' +
            tone +
            '">' +
            escapeHtml(statusLabel(item)) +
            '</span>' +
            '<time>' +
            escapeHtml(fmtDate(item.date || item.updated_at || item.created_at || item.datecreated || item.acceptance_date)) +
            '</time>' +
            '</div>' +
            '<h3>' +
            escapeHtml(heading) +
            '</h3>' +
            '<p class="ops-card-cust">' +
            escapeHtml(customer) +
            '</p>' +
            '<div class="ops-card-foot">' +
            '<span>' +
            escapeHtml(subject) +
            '</span>' +
            '<span class="ops-card-flags">' +
            flags +
            '<span class="ops-card-go">Detay →</span>' +
            '</span>' +
            '</div>' +
            '</article>'
          );
        })
        .join('');
    }
    if (foot) {
      const host = cachedBaseUrl ? ' · ' + cachedBaseUrl : '';
      foot.textContent = (total != null ? total + ' kayıt' : '') + sourceLabel(info.source) + host;
    }
  }

  function numField(obj, keys) {
    if (!obj) return null;
    for (let i = 0; i < keys.length; i++) {
      const v = obj[keys[i]];
      if (v == null || v === '') continue;
      const n = Number(String(v).replace(',', '.'));
      if (Number.isFinite(n)) return n;
    }
    return null;
  }

  function pickCost(json) {
    if (!json || typeof json !== 'object') return null;
    const src = json.cost || json.costing || json.latest_cost || json.last_cost || json;
    if (!src || typeof src !== 'object') return null;
    const fields = {
      material: src.material ?? src.materials ?? src.malzeme ?? src.material_cost,
      labor: src.labor ?? src.labour ?? src.iscilik ?? src.labor_cost,
      purchase: src.purchase ?? src.external ?? src.buy ?? src.purchase_cost,
      shipping: src.shipping ?? src.freight ?? src.sevkiyat ?? src.shipping_cost,
      overhead: src.overhead ?? src.general ?? src.overhead_cost,
      total: src.total ?? src.grand_total ?? src.amount ?? src.cost_total,
      updated: src.updated_at ?? src.date ?? src.calculated_at ?? json.updated_at,
    };
    const has = ['material', 'labor', 'purchase', 'shipping', 'overhead', 'total'].some(
      (k) => fields[k] != null && fields[k] !== ''
    );
    return has ? fields : null;
  }

  function tableHtml(headers, rows, emptyTitle, emptyBody) {
    if (!rows || rows.length === 0) {
      return stateHtml('empty', emptyTitle, emptyBody);
    }
    return (
      '<div class="ops-table-wrap">' +
      '<table class="ops-table ops-mini"><thead><tr>' +
      headers.map((h) => '<th>' + escapeHtml(h) + '</th>').join('') +
      '</tr></thead><tbody>' +
      rows
        .map(
          (cols) =>
            '<tr>' +
            cols.map((c) => '<td>' + c + '</td>').join('') +
            '</tr>'
        )
        .join('') +
      '</tbody></table></div>'
    );
  }

  function sectionUnavailable(title, result) {
    const code = result && result.status ? 'HTTP ' + result.status : 'yanıt yok';
    return stateHtml(
      'unavailable',
      title,
      explainError(result) + ' (' + code + '). Bu bölüm API hazır olunca dolar; sahte veri gösterilmez.'
    );
  }

  async function loadHistory() {
    if (!window.teklifApp || !window.teklifApp.listHistory) return [];
    const result = await window.teklifApp.listHistory();
    return (result && result.items) || [];
  }

  function filterByStatus(items) {
    if (status === 'all') return items;
    if (status === 'accepted') return items.filter(isAccepted);
    if (status === 'open') return items.filter(isOpenStatus);
    return items;
  }

  function matchesQuery(item, q) {
    if (!q) return true;
    const blob = [
      itemTitle(item),
      itemNumber(item),
      itemCustomer(item),
      item.subject,
      item.email,
      itemId(item),
    ]
      .join(' ')
      .toLowerCase();
    return blob.indexOf(q) !== -1;
  }

  function setListTitle(text) {
    const title = el('opsTitle');
    const sub = el('opsSubtitle');
    if (title) {
      title.textContent =
        status === 'accepted'
          ? 'Kabul edilmiş teklifler'
          : status === 'open'
            ? 'Açık işler'
            : 'Tüm teklifler';
    }
    if (sub) {
      const host = cachedBaseUrl ? ' · ' + cachedBaseUrl : '';
      sub.textContent = (text || 'Açık işler, kabul edilmiş operasyonlar · satınalma, depo, sevkiyat, kalite') + host;
    }
  }

  async function probeCollection(paths) {
    let last = null;
    for (let i = 0; i < paths.length; i++) {
      const result = await apiGet(paths[i]);
      last = result;
      if (result && result.ok && result.json != null) {
        return { ok: true, result, items: unwrapRecords(result.json), path: paths[i] };
      }
      if (result && result.status !== 404) {
        return { ok: false, result, items: [], path: paths[i] };
      }
    }
    return { ok: false, result: last, items: [], path: paths[paths.length - 1] };
  }

  function unwrapLifecycleList(json) {
    if (!json) return [];
    const fromKnown = pickSection(json, [
      'proposals',
      'sales_lifecycle',
      'lifecycle',
      'items',
      'data',
      'records',
      'results',
      'teklif',
    ]);
    if (fromKnown.length) return fromKnown.filter((row) => row && typeof row === 'object');
    return unwrapRecords(json);
  }

  function flattenLifecycleItem(row) {
    if (!row || typeof row !== 'object') return row;
    const rec = lifecycleRecord(row) || row;
    const nested =
      rec.proposal && typeof rec.proposal === 'object' && !Array.isArray(rec.proposal) ? rec.proposal : null;
    if (!nested) return rec;
    return Object.assign({}, nested, rec, {
      id: rec.id || nested.id || nested.proposal_id,
      status: rec.status != null && rec.status !== '' ? rec.status : nested.status,
      accepted: rec.accepted === true ? true : nested.accepted === true ? true : rec.accepted,
      title: rec.title || nested.title,
      company: rec.company != null ? rec.company : nested.company,
      customer_name: rec.customer_name || nested.customer_name,
    });
  }

  function lifecycleTotal(json, pageLen) {
    if (!json || typeof json !== 'object') return pageLen;
    const t =
      json.total ??
      json.count ??
      json.recordsTotal ??
      json.total_count ??
      (json.data && typeof json.data === 'object' && !Array.isArray(json.data)
        ? json.data.total ?? json.data.count
        : null);
    const n = Number(t);
    return Number.isFinite(n) ? n : pageLen;
  }

  async function fetchAllLifecycleProposals() {
    let offset = 0;
    let all = [];
    let last = null;
    let pages = 0;
    let path = 'api/v1/sales_lifecycle';
    while (pages < LIFE_MAX_PAGES) {
      path = 'api/v1/sales_lifecycle' + queryString({ source: 'proposal', limit: LIFE_PAGE, offset: offset });
      const result = await apiGet(path);
      last = result;
      if (result && (result.status === 401 || result.status === 403)) {
        return { ok: false, result, items: [], source: 'sales_lifecycle', path: path };
      }
      if (!result || !result.ok) {
        if (offset === 0 && result && result.status === 404) {
          const alt = await apiGet('api/v1/sales_lifecycle/proposal');
          if (alt && alt.ok && alt.json != null) {
            return {
              ok: true,
              result: alt,
              items: unwrapLifecycleList(alt.json).map(flattenLifecycleItem),
              source: 'sales_lifecycle',
              path: 'api/v1/sales_lifecycle/proposal',
            };
          }
        }
        if (offset === 0) return { ok: false, result, items: [], source: 'sales_lifecycle', path: path };
        break;
      }
      const page = unwrapLifecycleList(result.json).map(flattenLifecycleItem);
      all = all.concat(page);
      const total = lifecycleTotal(result.json, all.length);
      pages += 1;
      if (!page.length || page.length < LIFE_PAGE || all.length >= total) break;
      offset += LIFE_PAGE;
    }
    return { ok: true, result: last, items: all, source: 'sales_lifecycle', path: path };
  }

  async function fetchLifecycleDetail(id) {
    const sid = encodeURIComponent(id);
    const paths = [
      'api/v1/sales_lifecycle/proposal/' + sid,
      'api/v1/sales_lifecycle/' + sid,
      'api/v1/sales_lifecycle' + queryString({ source: 'proposal', id: id }),
    ];
    let last = null;
    for (let i = 0; i < paths.length; i++) {
      const result = await apiGet(paths[i]);
      last = result;
      if (result && (result.status === 401 || result.status === 403)) {
        return { ok: false, result, detail: null, json: null, path: paths[i] };
      }
      if (result && result.ok && result.json != null) {
        const json = result.json;
        const detail = lifecycleRecord(json) || unwrapOne(json, id) || json;
        return { ok: true, result, detail: detail, json: json, path: paths[i] };
      }
    }
    return { ok: false, result: last, detail: null, json: null, path: paths[0] };
  }

  async function fetchTeklifList() {
    const life = await fetchAllLifecycleProposals();
    if (life && (life.result && (life.result.status === 401 || life.result.status === 403))) {
      return life;
    }
    if (life && life.ok && life.items && life.items.length) {
      return life;
    }

    const teklif = await apiGet('api/teklif');
    if (teklif && (teklif.status === 401 || teklif.status === 403)) {
      return { ok: false, result: teklif, items: [], source: 'teklif', path: 'api/teklif' };
    }
    if (teklif && teklif.ok && teklif.json != null) {
      const items = unwrapRecords(teklif.json);
      if (items.length) {
        return { ok: true, result: teklif, items, source: 'teklif', path: 'api/teklif' };
      }
    }

    const proposals = await apiGet('api/proposals');
    if (proposals && (proposals.status === 401 || proposals.status === 403)) {
      return { ok: false, result: proposals, items: [], source: 'proposals', path: 'api/proposals' };
    }
    if (proposals && proposals.ok && proposals.json != null) {
      return {
        ok: true,
        result: proposals,
        items: unwrapRecords(proposals.json),
        source: 'proposals',
        path: 'api/proposals',
      };
    }

    if (life && life.ok && life.json == null && life.items) {
      return life;
    }
    if (teklif && teklif.ok && teklif.json != null) {
      return { ok: true, result: teklif, items: unwrapRecords(teklif.json), source: 'teklif', path: 'api/teklif' };
    }
    if (life && life.ok) {
      return life;
    }

    const failed =
      (proposals && proposals.status && proposals.status !== 404 ? proposals : null) ||
      (teklif && teklif.status && teklif.status !== 404 ? teklif : null) ||
      (life && life.result) ||
      teklif;
    return { ok: false, result: failed, items: [], source: (life && life.source) || 'sales_lifecycle' };
  }

  async function searchTeklif(keyword) {
    const q = String(keyword || '').trim();
    if (!q) return { ok: false, items: [], source: 'search' };
    const encoded = encodeURIComponent(q);
    return probeCollection(['api/proposals/search/' + encoded, 'api/teklif/search/' + encoded]);
  }

  async function fetchTeklifDetail(id) {
    const life = await fetchLifecycleDetail(id);
    if (life && life.ok && life.detail) {
      return life;
    }
    if (life && life.result && (life.result.status === 401 || life.result.status === 403)) {
      return life;
    }
    const sid = encodeURIComponent(id);
    const paths = ['api/teklif/' + sid, 'api/proposals/' + sid, 'api/teklif' + queryString({ id: id })];
    let last = life && life.result ? life.result : null;
    for (let i = 0; i < paths.length; i++) {
      const result = await apiGet(paths[i]);
      last = result;
      if (result && (result.status === 401 || result.status === 403)) {
        return { ok: false, result, detail: null, json: null, path: paths[i] };
      }
      if (result && result.ok && result.json != null) {
        const rec = lifecycleRecord(result.json) || unwrapOne(result.json, id);
        if (rec) return { ok: true, result, detail: rec, json: result.json, path: paths[i] };
      }
    }
    return { ok: false, result: last, detail: null, json: null, path: paths[0] };
  }

  function lineItemsFrom(detail) {
    const root = lifecycleRecord(detail) || detail;
    if (!root || typeof root !== 'object') return [];
    if (Array.isArray(root.items)) return root.items;
    return [];
  }

  function indexBy(rows, keys) {
    const map = new Map();
    (rows || []).forEach((row) => {
      keys.forEach((k) => {
        const v = row && row[k];
        if (v != null && v !== '') map.set(String(v), row);
      });
    });
    return map;
  }

  function isExternalWo(row) {
    if (!row) return false;
    const v = row.external || row.is_external || row.work_order_external || row.dış || row.dis;
    if (v === true || v === 1 || v === '1') return true;
    const s = String(v || '').toLowerCase();
    return s === 'yes' || s === 'true' || s === 'external';
  }

  async function loadRelatedForProposal(id, detail, lifeJson) {
    const hint = detail || selectedItem || { id: id };
    const root = lifecycleRecord(lifeJson || detail) || detail || {};
    const hasLifecycle = !!(
      root &&
      (root.accepted === true ||
        root.accepted === false ||
        root.counts ||
        root.sections ||
        root.shipments ||
        root.purchased ||
        root.default_tab ||
        root.title)
    );

    const lifePurchases = sectionRows(root, 'purchased');
    const lifeWarehouse = pickSection(root, ['warehouse', 'warehouse_picks', 'depo']);
    const lifeShips = sectionRows(root, 'shipments');
    const lifeQuality = pickSection(root, ['quality', 'quality_ops', 'qc', 'kalite']);
    const lifeMos = pickSection(root, ['mos', 'manufacturing_orders']);
    const lifeItems = Array.isArray(root.items) ? root.items : [];

    if (hasLifecycle) {
      return {
        fromLifecycle: true,
        mo: { ok: true, result: null, path: 'api/v1/sales_lifecycle' },
        mos: lifeMos,
        mosAll: lifeMos,
        wo: { ok: true, result: null, path: '' },
        wos: [],
        wosAll: [],
        ext: { ok: true, result: null, path: '' },
        extItems: [],
        ship: { ok: true, result: null, path: 'api/v1/sales_lifecycle' },
        ships: lifeShips,
        warehouse: lifeWarehouse,
        quality: lifeQuality,
        lifePurchases: lifePurchases,
        products: [],
        product: { ok: true, result: null },
        boms: [],
        bom: { ok: true, result: null },
        lines: lifeItems,
        counts: root.counts && typeof root.counts === 'object' ? root.counts : {},
        defaultTab: root.default_tab,
        lifeJson: root,
      };
    }

    const [moProbe, woProbe, shipProbe] = await Promise.all([
      probeCollection(['api/mrp/manufacturing_orders']),
      probeCollection(['api/mrp/work_orders']),
      probeCollection(['api/mrp/external_shipments']),
    ]);

    const mos = filterRelated(moProbe.items || [], id, hint);
    const wos = filterRelated(woProbe.items || [], id, hint);
    const extraIds = new Set();
    mos.forEach((m) => extraIds.add('mo:' + itemId(m)));
    wos.forEach((w) => extraIds.add('wo:' + itemId(w)));
    const ships = filterRelated(shipProbe.items || [], id, hint, extraIds);

    return {
      fromLifecycle: false,
      mo: moProbe,
      mos,
      mosAll: moProbe.items || [],
      wo: woProbe,
      wos,
      wosAll: woProbe.items || [],
      ext: { ok: woProbe.ok, result: woProbe.result, path: woProbe.path },
      extItems: [],
      ship: shipProbe,
      ships,
      warehouse: [],
      quality: [],
      lifePurchases: [],
      products: [],
      product: { ok: false, result: null },
      boms: [],
      bom: { ok: false, result: null },
      lines: lineItemsFrom(detail),
      counts: {},
      defaultTab: '',
      lifeJson: root,
    };
  }

  function mergeRows(primary, secondary) {
    const out = [];
    const seen = new Set();
    (primary || []).concat(secondary || []).forEach((row) => {
      if (!row || typeof row !== 'object') return;
      const k = itemId(row) || JSON.stringify(row).slice(0, 120);
      if (seen.has(k)) return;
      seen.add(k);
      out.push(row);
    });
    return out;
  }

  function enrichLine(line, products, boms) {
    const byProduct = indexBy(products, ['id', 'product_id', 'item_id', 'code']);
    const byBomProduct = indexBy(boms, ['product_id', 'finished_product_id', 'id']);
    const pid = String(
      line.product_id || line.itemid || line.item_id || line.rel_id || line.stock_id || ''
    );
    const code = String(line.code || line.sku || '');
    const product = (pid && byProduct.get(pid)) || (code && byProduct.get(code)) || null;
    const bom =
      (pid && byBomProduct.get(pid)) ||
      (product && byBomProduct.get(String(product.id || product.product_id || ''))) ||
      null;
    return { line, product, bom };
  }

  function catalogRow(row, kind) {
    return {
      name:
        displayText(row.product) ||
        displayText(row.description) ||
        displayText(row.name) ||
        displayText(row.item) ||
        displayText(row.product_name) ||
        itemNumber(row),
      vendor:
        displayText(row.vendor) ||
        displayText(row.supplier) ||
        displayText(row.company) ||
        displayText(row.warehouse) ||
        displayText(row.warehouse_name) ||
        displayText(row.location) ||
        '—',
      qty:
        row.qty != null
          ? row.qty
          : row.quantity != null
            ? row.quantity
            : row.picked_qty != null
              ? row.picked_qty
              : row.qty_picked != null
                ? row.qty_picked
                : '—',
      unit: displayText(row.unit) || displayText(row.uom) || displayText(row.unite) || '',
      price: numField(row, ['rate', 'price', 'unit_price', 'cost', 'amount']),
      kind: kind,
      status: displayText(row.status_key) || displayText(row.status) || displayText(row.state) || '',
      date: row.date || row.picked_at || row.shipped_at || row.inspected_at || row.created_at || row.updated_at,
      extra: displayText(row.lot) || displayText(row.serial) || displayText(row.notes) || '',
    };
  }

  function purchasedRows(rel) {
    return (rel.lifePurchases || []).map((row) => catalogRow(row, 'PR/PO'));
  }

  function warehouseRows(rel) {
    return (rel.warehouse || []).map((row) => catalogRow(row, 'Depo'));
  }

  function qualityRows(rel) {
    return (rel.quality || []).map((row) => catalogRow(row, 'Kalite'));
  }

  function lifecycleCounts(detail, rel) {
    const root = lifecycleRecord(detail) || detail || {};
    const c = (rel && rel.counts) || root.counts;
    if (!c || typeof c !== 'object') {
      return { shipments: '—', mos: '—', purchased: '—' };
    }
    return {
      shipments: c.shipments != null ? c.shipments : '—',
      mos: c.mos != null ? c.mos : '—',
      purchased: c.purchased != null ? c.purchased : '—',
    };
  }

  function countNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function normalizeTab(raw) {
    const s = String(raw || '').toLowerCase().trim();
    if (!s) return '';
    if (s === 'shipments' || s === 'shipment' || s === 'sevkiyat' || s === 'sevkiyatlar') return 'shipments';
    if (s === 'purchased' || s === 'purchase' || s === 'satinalma' || s === 'satınalma') return 'purchased';
    if (s === 'mo' || s === 'mos' || s === 'manufacturing') return 'mo';
    if (s === 'items' || s === 'kalem' || s === 'kalemler') return 'items';
    if (s === 'warehouse' || s === 'depo') return 'warehouse';
    if (s === 'quality' || s === 'kalite' || s === 'qc') return 'quality';
    return s;
  }

  function pickDefaultTab(detail, rel) {
    const root = lifecycleRecord(detail) || detail || {};
    const requested = normalizeTab(root.default_tab || (rel && rel.defaultTab));
    const ids = TABS.map((t) => t.id);
    if (requested && ids.indexOf(requested) !== -1) return requested;
    const counts = lifecycleCounts(detail, rel);
    const purchasedN = countNumber(counts.purchased);
    const ships = (rel && rel.ships) || [];
    if (purchasedN === 0 && ships.length) return 'shipments';
    return 'purchased';
  }

  function shippedLabel(raw) {
    if (raw === true || raw === 1 || raw === '1') return 'Evet';
    if (raw === false || raw === 0 || raw === '0') return 'Hayır';
    if (raw == null || raw === '') return '—';
    const asDate = fmtDate(raw);
    if (asDate !== String(raw)) return asDate;
    return displayText(raw) || String(raw);
  }

  function costFromAvailable(rel, detail) {
    const fromApi = pickCost(detail);
    const lines = (rel.lines && rel.lines.length ? rel.lines : lineItemsFrom(detail)) || [];
    let material = null;
    let purchase = null;
    let lineSum = 0;
    let lineHas = false;

    lines.forEach((line) => {
      const qty = numField(line, ['qty', 'quantity']) ?? 1;
      const rate = numField(line, ['rate', 'price', 'unit_price', 'cost']);
      const amount = numField(line, ['amount', 'total', 'line_total']);
      const value = amount != null ? amount : rate != null ? qty * rate : null;
      if (value != null) {
        lineHas = true;
        lineSum += value;
      }
    });

    if (lineHas) material = lineSum;

    let purchaseSum = 0;
    let purchaseHas = false;
    (rel.extItems || []).forEach((w) => {
      const value = numField(w, ['cost', 'price', 'rate', 'amount', 'total']);
      if (value != null) {
        purchaseHas = true;
        purchaseSum += value;
      }
    });
    if (purchaseHas) purchase = purchaseSum;

    const teklifTotal = numField(detail, ['total', 'grand_total', 'amount']);
    const teklifSub = numField(detail, ['subtotal']);

    const fields = {
      material: fromApi && fromApi.material != null ? fromApi.material : material,
      labor: fromApi ? fromApi.labor : null,
      purchase: fromApi && fromApi.purchase != null ? fromApi.purchase : purchase,
      shipping: fromApi ? fromApi.shipping : null,
      overhead: fromApi ? fromApi.overhead : null,
      total: fromApi && fromApi.total != null ? fromApi.total : teklifTotal,
      updated: (fromApi && fromApi.updated) || (detail && (detail.updated_at || detail.date)),
      subtotal: teklifSub,
    };

    const has = ['material', 'labor', 'purchase', 'shipping', 'overhead', 'total', 'subtotal'].some(
      (k) => fields[k] != null && fields[k] !== ''
    );
    return has ? fields : null;
  }

  function renderMoPanel(rel) {
    const hasMo = rel.mo.ok || (rel.mos && rel.mos.length);
    const hasWo = rel.wo.ok || (rel.wos && rel.wos.length);
    if (!hasMo && !hasWo) {
      return sectionUnavailable("MO'lar yüklenemedi", (rel.mo && rel.mo.result) || (rel.wo && rel.wo.result));
    }
    const moRows = (rel.mos || []).map((m) => [
      escapeHtml(itemNumber(m)),
      escapeHtml(m.product || m.description || m.name || '—'),
      escapeHtml(statusLabel(m.status || m.state)),
      escapeHtml(m.qty != null ? m.qty : m.quantity != null ? m.quantity : '—'),
      escapeHtml(fmtDate(m.date || m.date_start || m.updated_at || m.created_at)),
    ]);
    const woRows = (rel.wos || []).map((w) => [
      escapeHtml(itemNumber(w)),
      escapeHtml(w.product || w.description || w.name || '—'),
      escapeHtml(statusLabel(w.status || w.state) + (isExternalWo(w) ? ' · dış' : '')),
      escapeHtml(fmtDate(w.date || w.date_created || w.updated_at)),
    ]);
    const emptyMo =
      rel.mo.ok && (rel.mosAll || []).length && !(rel.mos || []).length
        ? 'MO listesi geldi; bu teklifle eşleşen proposal_id / rel_id kaydı yok.'
        : 'Kabul edilmiş teklif için manufacturing_orders kaydı bulunamadı.';
    return (
      tableHtml(['MO', 'Ürün', 'Durum', 'Miktar', 'Tarih'], moRows, 'Bu teklife bağlı üretim emri yok', emptyMo) +
      (rel.wo.ok || woRows.length
        ? '<h3 class="ops-msg-title">İş emirleri</h3>' +
          tableHtml(
            ['İş emri', 'Ürün', 'Durum', 'Tarih'],
            woRows,
            'Bu teklife bağlı iş emri yok',
            'work_orders listesi boş veya teklif ile ilişki alanı yok.'
          )
        : '')
    );
  }

  function renderPurchasedPanel(rel) {
    const merged = purchasedRows(rel);
    const rows = merged.map((m) => [
      escapeHtml(m.name),
      escapeHtml(m.vendor),
      escapeHtml(m.qty),
      escapeHtml(m.unit),
      fmtMoney(m.price),
      escapeHtml(m.kind),
    ]);
    return tableHtml(
      ['Ürün', 'Tedarikçi', 'Miktar', 'Birim', 'Birim fiyat', 'Kaynak'],
      rows,
      'Satın alınan ürün yok',
      'purchased gerçek PR/PO kaydıdır. Teklif kalemleri (items) satınalma değildir; boşsa uydurulmaz.'
    );
  }

  function renderWarehousePanel(rel) {
    const list = warehouseRows(rel);
    if (!list.length) {
      return stateHtml(
        'empty',
        'Depodan alınan ürün yok',
        'sales_lifecycle depo / pick bölümü bu teklif için boş döndü. Sahte stok hareketi gösterilmez.'
      );
    }
    const rows = list.map((m) => [
      escapeHtml(m.name),
      escapeHtml(m.vendor),
      escapeHtml(m.qty),
      escapeHtml(m.unit),
      escapeHtml(m.status || '—'),
      escapeHtml(fmtDate(m.date)),
    ]);
    return tableHtml(
      ['Ürün', 'Depo / lokasyon', 'Miktar', 'Birim', 'Durum', 'Tarih'],
      rows,
      'Depodan alınan ürün yok',
      ''
    );
  }

  function renderQualityPanel(rel) {
    const list = qualityRows(rel);
    if (!list.length) {
      return stateHtml(
        'empty',
        'Kalite operasyonu yok',
        'sales_lifecycle kalite / QC bölümü bu teklif için boş döndü. Sahte muayene kaydı gösterilmez.'
      );
    }
    const rows = list.map((m) => [
      escapeHtml(m.name),
      escapeHtml(m.status || '—'),
      escapeHtml(m.extra || '—'),
      escapeHtml(m.vendor),
      escapeHtml(fmtDate(m.date)),
    ]);
    return tableHtml(
      ['Operasyon / ürün', 'Sonuç', 'Not / lot', 'Sorumlu', 'Tarih'],
      rows,
      'Kalite operasyonu yok',
      ''
    );
  }

  function renderShipmentsPanel(rel) {
    const list = rel.ships || [];
    const rows = list.map((s) => [
      escapeHtml(displayText(s.product) || displayText(s.description) || itemNumber(s)),
      escapeHtml(s.qty != null ? s.qty : s.quantity != null ? s.quantity : '—'),
      escapeHtml(displayText(s.plate) || '—'),
      escapeHtml(displayText(s.waybill_no) || displayText(s.waybill) || '—'),
      escapeHtml(displayText(s.status_key) || statusLabel(s)),
      escapeHtml(shippedLabel(s.shipped)),
    ]);
    return tableHtml(
      ['Ürün', 'Miktar', 'Plaka', 'İrsaliye', 'Durum', 'Sevk'],
      rows,
      'Sevkiyat kaydı yok',
      'data.shipments veya data.sections.shipments.rows boş. Sahte sevk üretilmez.'
    );
  }

  function renderItemsPanel(rel, detail) {
    const lines = (rel.lines && rel.lines.length ? rel.lines : lineItemsFrom(detail)) || [];
    const rows = lines.map((line) => {
      const qty = line.qty != null ? line.qty : line.quantity != null ? line.quantity : '—';
      const rate = numField(line, ['rate', 'price', 'unit_price']);
      const amount = numField(line, ['amount', 'total', 'line_total']);
      return [
        escapeHtml(displayText(line.description) || displayText(line.name) || displayText(line.product) || itemNumber(line)),
        escapeHtml(qty),
        fmtMoney(rate),
        fmtMoney(amount),
      ];
    });
    return tableHtml(
      ['Açıklama', 'Miktar', 'Birim fiyat', 'Tutar'],
      rows,
      'Teklif kalemi yok',
      'data.items teklif kalemleridir; satınalma (purchased) değildir.'
    );
  }

  function renderCostPanel(rel, detail) {
    const cost = costFromAvailable(rel, detail);
    const note = cost
      ? 'Ayrı maliyet API’si yok. Değerler teklif satırları, ürün/BOM ve varsa teklif toplamından derlendi; eksik kalemler boş bırakılır.'
      : 'Maliyet kalemi yok. Teklif satırında fiyat ve ayrı bir maliyet ucu dönmedi; toplam uydurulmaz.';

    const rows = [
      ['Malzeme / teklif satırları', cost && cost.material],
      ['İşçilik', cost && cost.labor],
      ['Dış alım / satınalma', cost && cost.purchase],
      ['Sevkiyat', cost && cost.shipping],
      ['Genel gider', cost && cost.overhead],
      ['Teklif ara toplam', cost && cost.subtotal],
    ];
    const lineRows = ((rel.lines && rel.lines.length ? rel.lines : lineItemsFrom(detail)) || []).map((line) => {
      const qty = numField(line, ['qty', 'quantity']);
      const rate = numField(line, ['rate', 'price', 'unit_price', 'cost']);
      const amount = numField(line, ['amount', 'total', 'line_total']);
      const value = amount != null ? amount : qty != null && rate != null ? qty * rate : rate;
      return [
        escapeHtml(line.description || line.name || line.product || itemNumber(line)),
        escapeHtml(qty != null ? qty : '—'),
        fmtMoney(rate),
        fmtMoney(value),
      ];
    });
    return (
      '<div class="ops-cost">' +
      '<p class="ops-cost-note">' +
      escapeHtml(note) +
      (cost && cost.updated ? ' · ' + fmtDate(cost.updated) : '') +
      '</p>' +
      '<table class="ops-ledger"><tbody>' +
      rows
        .map(
          (r) =>
            '<tr><th>' +
            escapeHtml(r[0]) +
            '</th><td>' +
            fmtMoney(r[1]) +
            '</td></tr>'
        )
        .join('') +
      '<tr class="ops-ledger-total"><th>Toplam</th><td>' +
      fmtMoney(cost && cost.total) +
      '</td></tr>' +
      '</tbody></table>' +
      (lineRows.length
        ? '<h3 class="ops-msg-title">Teklif satırları</h3>' +
          tableHtml(['Açıklama', 'Miktar', 'Birim fiyat', 'Tutar'], lineRows, 'Satır yok', '')
        : '') +
      '</div>'
    );
  }

  function workspaceHtml(detail, rel) {
    const heading = itemTitle(detail || selectedItem || { id: selectedId });
    const customer = itemCustomer(detail || selectedItem || {});
    const counts = lifecycleCounts(detail, rel);
    const buyRows = purchasedRows(rel);
    const shipCount = (rel.ships && rel.ships.length) || 0;
    const moCount = (rel.mos && rel.mos.length) || 0;
    const itemCount = (rel.lines && rel.lines.length) || 0;
    const tabCounts = {
      purchased: countNumber(counts.purchased) || buyRows.length,
      warehouse: warehouseRows(rel).length,
      shipments: countNumber(counts.shipments) || shipCount,
      quality: qualityRows(rel).length,
      mo: countNumber(counts.mos) || moCount,
      items: itemCount,
    };

    const tabs = TABS.map(
      (t) =>
        '<button type="button" class="ops-tab' +
        (detailTab === t.id ? ' active' : '') +
        '" data-tab="' +
        t.id +
        '">' +
        escapeHtml(t.label) +
        '<span class="ops-tab-count">' +
        escapeHtml(String(tabCounts[t.id] != null ? tabCounts[t.id] : 0)) +
        '</span>' +
        '</button>'
    ).join('');

    const panels = {
      purchased: renderPurchasedPanel(rel),
      warehouse: renderWarehousePanel(rel),
      shipments: renderShipmentsPanel(rel),
      quality: renderQualityPanel(rel),
      mo: renderMoPanel(rel),
      items: renderItemsPanel(rel, detail),
    };

    const kpi = function (label, value) {
      return (
        '<div class="ops-metric"><span>' +
        escapeHtml(label) +
        '</span><strong>' +
        escapeHtml(value == null || value === '' ? '—' : String(value)) +
        '</strong></div>'
      );
    };

    return (
      '<div class="ops-ws-head">' +
      '<div>' +
      '<p class="ops-kicker">' +
      escapeHtml(statusLabel(detail || selectedItem)) +
      (isAccepted(detail || selectedItem) ? ' · kabul edilmiş iş' : isOpenStatus(detail || selectedItem) ? ' · açık iş' : ' · çalışma alanı') +
      '</p>' +
      '<h2>' +
      escapeHtml(heading) +
      '</h2>' +
      '<p class="ops-ws-cust">' +
      escapeHtml(customer) +
      '</p>' +
      '</div>' +
      '<div class="ops-detail-actions">' +
      '<button type="button" data-web="proposal">Teklif</button>' +
      '<button type="button" data-web="order">Üretim</button>' +
      '<button type="button" data-web="chat">Sohbet</button>' +
      '</div>' +
      '</div>' +
      '<div class="ops-ws-metrics">' +
      kpi('Sevkiyat', counts.shipments) +
      kpi('MO', counts.mos) +
      kpi('Satınalma', counts.purchased) +
      '</div>' +
      '<nav class="ops-tabs" id="opsTabs">' +
      tabs +
      '</nav>' +
      '<div class="ops-tab-panels">' +
      TABS.map(
        (t) =>
          '<section class="ops-tab-panel" data-panel="' +
          t.id +
          '"' +
          (detailTab === t.id ? '' : ' hidden') +
          '>' +
          panels[t.id] +
          '</section>'
      ).join('') +
      '</div>' +
      '<p class="ops-cost-note">Kabul yalnız accepted === true. items teklif kalemi, purchased PR/PO. Boş bölüm uydurulmaz.</p>'
    );
  }

  async function loadList() {
    await refreshBaseUrl();
    setListTitle('Yükleniyor…');
    const body = el('opsListBody');
    if (body) body.innerHTML = skeletonCards(6);
    setBanner('');

    const listRes = await fetchTeklifList();

    if (!listRes.ok) {
      if (
        (listRes.result && (listRes.result.status === 401 || listRes.result.status === 403)) &&
        typeof needSettingsHandler === 'function'
      ) {
        needSettingsHandler();
      }
      const msg = explainError(listRes.result);
      setBanner(
        msg +
          ' Liste GET api/v1/sales_lifecycle?source=proposal ile çekilir. Kabul yalnız accepted === true; açık status === 1. Uydurma kayıt yok.',
        'warn'
      );
      renderMetrics(null, { total: '—', accepted: '—', open: '—', overdue: '—' });
      lastListItems = [];
      renderList([], 0, { emptyHint: msg, source: listRes.source });
      setListTitle(msg);
      toast(msg, 'err');
      return;
    }

    listSource = listRes.source || 'sales_lifecycle';
    let items = (listRes.items || []).map(flattenLifecycleItem);
    lastListItems = items.slice();

    const metrics = {
      total: items.length,
      accepted: items.filter(isAccepted).length,
      open: items.filter(isOpenStatus).length,
      overdue: items.filter(isOverdue).length,
    };
    renderMetrics(null, metrics);

    const q = String(query || '').trim().toLowerCase();
    let searchSource = listSource;
    if (q) {
      const remote = await searchTeklif(query);
      if (remote.ok && remote.items && remote.items.length) {
        items = remote.items.map(flattenLifecycleItem);
        searchSource = 'search';
      } else {
        items = items.filter((item) => matchesQuery(item, q));
      }
    }

    items = filterByStatus(items);
    items = sortTeklifIdDesc(items);

    const sliced = items.slice(offset, offset + LIMIT);
    const total = items.length;
    const listMeta = { source: searchSource };
    if (status === 'open' && sliced.length === 0) {
      listMeta.emptyHint = 'status === 1 olan açık teklif yok. MO/sevk var diye açık veya kabul sayılmaz.';
    }
    if (status === 'accepted' && sliced.length === 0) {
      listMeta.emptyHint = 'accepted === true olan teklif yok. MO/sevk var diye kabul sayılmaz.';
    }
    renderList(sliced, total, listMeta);
    setListTitle(total + ' kayıt · tıklayınca satınalma / sevkiyat / MO');
  }

  async function openDetail(id) {
    selectedId = id;
    detailTab = 'purchased';
    el('opsListPane').hidden = true;
    el('opsDetailPane').hidden = false;
    el('opsBtnBack').hidden = false;
    if (el('opsMetrics')) el('opsMetrics').hidden = true;
    setListTitle('Teklif çalışma alanı');
    if (el('opsSubtitle')) {
      el('opsSubtitle').textContent =
        'Satınalma, sevkiyat ve MO' + (cachedBaseUrl ? ' · ' + cachedBaseUrl : '');
    }
    el('opsDetailPane').innerHTML =
      '<div class="ops-state ops-state-loading">Çalışma alanı yükleniyor…</div>';

    const fromList = (lastListItems || []).find((row) => String(itemId(row)) === String(id));
    const detailRes = await fetchTeklifDetail(id);
    let detail = detailRes.detail || fromList || selectedItem || { id: id };
    if (detailRes.ok && detailRes.detail) detail = lifecycleRecord(detailRes.detail) || detailRes.detail;

    const rel = await loadRelatedForProposal(id, detail, detailRes.json || detail);
    detailTab = pickDefaultTab(detail, rel);
    if (!detailRes.ok && detailRes.result && detailRes.result.status !== 404) {
      toast(explainError(detailRes.result), 'warn');
    }

    el('opsDetailPane').innerHTML = workspaceHtml(detail, rel);
    if (!detailRes.ok) {
      const host = el('opsDetailPane');
      const note = document.createElement('p');
      note.className = 'ops-banner ops-banner-warn';
      note.textContent =
        explainError(detailRes.result) +
        ' GET api/v1/sales_lifecycle/proposal/{id} okunamadı; sahte PR/PO veya sevk basılmaz.';
      if (host.firstChild) host.insertBefore(note, host.firstChild);
      else host.appendChild(note);
    }
  }

  function openWeb(kind) {
    if (!window.OperasyonView.openWebPath) return;
    if (kind === 'health') {
      window.OperasyonView.openWebPath('manufacturing/ops_health');
      return;
    }
    if (!selectedId) return;
    if (kind === 'proposal') {
      window.OperasyonView.openWebPath('proposals/list_proposals/' + selectedId);
    } else if (kind === 'order') {
      window.OperasyonView.openWebPath(
        'manufacturing/order_summary?src=proposal&ref=' + selectedId
      );
    } else if (kind === 'chat') {
      window.OperasyonView.openWebPath('prchat/Prchat_Controller/chat_full_view?tab=groups');
    }
  }

  function showListPane() {
    stopPoll();
    selectedId = null;
    selectedItem = null;
    if (el('opsDetailPane')) el('opsDetailPane').hidden = true;
    if (el('opsListPane')) el('opsListPane').hidden = false;
    if (el('opsBtnBack')) el('opsBtnBack').hidden = true;
    if (el('opsMetrics')) el('opsMetrics').hidden = false;
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
      refresh.addEventListener('click', () => {
        if (selectedId) openDetail(selectedId);
        else loadList();
      });
    }
    const back = el('opsBtnBack');
    if (back && !back.dataset.bound) {
      back.dataset.bound = '1';
      back.addEventListener('click', () => {
        showListPane();
        loadList();
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
    const list = el('opsListBody');
    if (list && !list.dataset.bound) {
      list.dataset.bound = '1';
      list.addEventListener('click', (e) => {
        const card = e.target.closest('[data-id]');
        if (!card) return;
        const id = card.getAttribute('data-id');
        selectedItem = (lastListItems || []).find((row) => String(itemId(row)) === String(id)) || {
          id: id,
          number: (card.querySelector('h3') && card.querySelector('h3').textContent) || id,
          customer: (card.querySelector('.ops-card-cust') && card.querySelector('.ops-card-cust').textContent) || '',
        };
        openDetail(id);
      });
      list.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const card = e.target.closest('[data-id]');
        if (!card) return;
        e.preventDefault();
        card.click();
      });
    }
    const metrics = el('opsMetrics');
    if (metrics && !metrics.dataset.bound) {
      metrics.dataset.bound = '1';
      metrics.addEventListener('click', (e) => {
        const btn = e.target.closest('.ops-metric');
        if (!btn) return;
        const metric = btn.getAttribute('data-metric');
        if (metric === 'accepted' || metric === 'open' || metric === 'all') {
          status = metric;
          setChips(el('opsStatusChips'), status);
          offset = 0;
          loadList();
        }
      });
    }
    const detail = el('opsDetailPane');
    if (detail && !detail.dataset.bound) {
      detail.dataset.bound = '1';
      detail.addEventListener('click', (e) => {
        const tab = e.target.closest('[data-tab]');
        if (tab) {
          detailTab = tab.getAttribute('data-tab');
          detail.querySelectorAll('.ops-tab').forEach((b) => {
            b.classList.toggle('active', b.getAttribute('data-tab') === detailTab);
          });
          detail.querySelectorAll('.ops-tab-panel').forEach((p) => {
            p.hidden = p.getAttribute('data-panel') !== detailTab;
          });
          return;
        }
        const webBtn = e.target.closest('[data-web]');
        if (!webBtn) return;
        openWeb(webBtn.getAttribute('data-web'));
      });
    }
  }

  window.OperasyonView = {
    async show() {
      bind();
      status = status || 'all';
      setChips(el('opsStatusChips'), status);
      if (el('opsScopeChips')) setChips(el('opsScopeChips'), scope);
      showListPane();
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
