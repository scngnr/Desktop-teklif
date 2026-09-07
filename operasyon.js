/**
 * Native Operasyon konsolu — JWT REST.
 * İstekler teklifApp.apiRequest (src/mrpApi.js) ile gider; kök ayarlardaki
 * Base URL / Giriş URL’den türetilir (host sabitlenmez).
 * Liste: GET api/teklif (yoksa GET api/proposals).
 * Detay: GET api/teklif/{id} veya GET api/proposals/{id}.
 * MO / WO / sevkiyat: api/mrp/manufacturing_orders, work_orders, external_shipments.
 * Satırlar: teklif kalemleri + api/product + api/bom.
 * Maliyet: ayrı maliyet ucu yok; satır / ürün / BOM alanlarından defter (uydurma toplam yok).
 */
(function () {
  const LIMIT = 50;
  const TABS = [
    { id: 'mo', label: "MO'lar" },
    { id: 'purchased', label: 'Satın alınan ürünler' },
    { id: 'shipments', label: 'Sevkiyatlar' },
    { id: 'cost', label: 'En son maliyet hesabı' },
  ];

  let status = 'accepted';
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
      'manufacturing_orders',
      'work_orders',
      'work_centers',
      'shipments',
      'external_shipments',
      'materials',
      'products',
      'purchases',
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
      obj.proposal_number
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

  function statusLabel(raw) {
    const s = String(raw == null ? '' : raw).toLowerCase();
    if (s === '6' || /accept|kabul|approved/.test(s)) return 'Kabul edilmiş';
    if (s === '3' || s === 'open' || s === 'açık' || s === 'acik') return 'Açık';
    if (s === '1' || s === 'draft') return 'Taslak';
    if (s === '2' || s === 'sent') return 'Gönderildi';
    if (s === '4' || /revis/.test(s)) return 'Revize';
    if (s === '5' || /declin|red/.test(s)) return 'Reddedildi';
    return raw ? String(raw) : '—';
  }

  function isAccepted(item) {
    const s = String(
      (item && (item.status || item.status_name || item.proposal_status || item.state)) || ''
    ).toLowerCase();
    if (s === '6' || /accept|kabul|approved/.test(s)) return true;
    if (Number(item && item.status) === 6) return true;
    return false;
  }

  function isOpenStatus(item) {
    const s = String(
      (item && (item.status || item.status_name || item.proposal_status || item.state)) || ''
    ).toLowerCase();
    if (s === '3' || s === 'open' || s === 'açık' || s === 'acik' || s === 'outstanding') return true;
    if (Number(item && item.status) === 3) return true;
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

  function itemCustomer(item) {
    if (!item) return '—';
    return (
      item.customer ||
      item.company ||
      item.client ||
      item.proposal_to ||
      item.client_company ||
      item.rel_name ||
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
        key: 'accepted',
        label: 'Kabul edilmiş',
        value: ops.accepted ?? ops.accepted_count ?? extra.accepted ?? '—',
      },
      {
        key: 'open',
        label: 'Açık',
        value: ops.open ?? ops.open_count ?? extra.open ?? '—',
      },
      {
        key: 'overdue',
        label: 'Geciken',
        value: ops.overdue ?? ops.overdue_count ?? extra.overdue ?? '—',
      },
      {
        key: 'mo',
        label: "MO'lar",
        value: ops.manufacturing_orders ?? ops.mo_count ?? extra.mo ?? '—',
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
            ? 'Açık teklif yok'
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
          const tone = accepted ? 'ok' : isOpenStatus(item) ? 'open' : 'muted';
          const subject = item.subject && itemCustomer(item) !== item.subject ? item.subject : item.priority || 'Teklif çalışma alanı';
          return (
            '<article class="ops-card" data-id="' +
            escapeHtml(id) +
            '" role="button" tabindex="0">' +
            '<div class="ops-card-top">' +
            '<span class="ops-badge ops-badge-' +
            tone +
            '">' +
            escapeHtml(statusLabel(item.status || item.status_name)) +
            '</span>' +
            '<time>' +
            escapeHtml(fmtDate(item.date || item.updated_at || item.created_at || item.datecreated || item.acceptance_date)) +
            '</time>' +
            '</div>' +
            '<h3>' +
            escapeHtml(itemNumber(item)) +
            '</h3>' +
            '<p class="ops-card-cust">' +
            escapeHtml(itemCustomer(item)) +
            '</p>' +
            '<div class="ops-card-foot">' +
            '<span>' +
            escapeHtml(subject) +
            '</span>' +
            '<span class="ops-card-go">Detay →</span>' +
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
    return items.filter((item) => (status === 'accepted' ? isAccepted(item) : isOpenStatus(item)));
  }

  function matchesQuery(item, q) {
    if (!q) return true;
    const blob = [
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
        status === 'accepted' ? 'Kabul edilmiş teklifler' : status === 'open' ? 'Açık teklifler' : 'Tüm teklifler';
    }
    if (sub) {
      const host = cachedBaseUrl ? ' · ' + cachedBaseUrl : '';
      sub.textContent = (text || 'Üretim, satınalma, sevkiyat ve maliyet') + host;
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

  async function fetchTeklifList() {
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

    if (teklif && teklif.ok && teklif.json != null) {
      return { ok: true, result: teklif, items: unwrapRecords(teklif.json), source: 'teklif', path: 'api/teklif' };
    }

    const failed = proposals && proposals.status && proposals.status !== 404 ? proposals : teklif;
    return { ok: false, result: failed || teklif || proposals, items: [], source: 'teklif' };
  }

  async function searchTeklif(keyword) {
    const q = String(keyword || '').trim();
    if (!q) return { ok: false, items: [], source: 'search' };
    const encoded = encodeURIComponent(q);
    return probeCollection(['api/proposals/search/' + encoded, 'api/teklif/search/' + encoded]);
  }

  async function fetchTeklifDetail(id) {
    const sid = encodeURIComponent(id);
    const paths = ['api/teklif/' + sid, 'api/proposals/' + sid, 'api/teklif' + queryString({ id: id })];
    let last = null;
    for (let i = 0; i < paths.length; i++) {
      const result = await apiGet(paths[i]);
      last = result;
      if (result && (result.status === 401 || result.status === 403)) {
        return { ok: false, result, detail: null, path: paths[i] };
      }
      if (result && result.ok && result.json != null) {
        const detail = unwrapOne(result.json, id);
        if (detail) return { ok: true, result, detail, path: paths[i] };
      }
    }
    return { ok: false, result: last, detail: null, path: paths[0] };
  }

  function lineItemsFrom(detail) {
    if (!detail || typeof detail !== 'object') return [];
    const bags = [detail.items, detail.newitems, detail.line_items, detail.lines, detail.products, detail.materials];
    for (let i = 0; i < bags.length; i++) {
      if (Array.isArray(bags[i]) && bags[i].length) return bags[i];
    }
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

  async function loadRelatedForProposal(id, detail) {
    const hint = detail || selectedItem || { id: id };
    const [moProbe, woProbe, shipProbe, productProbe, bomProbe] = await Promise.all([
      probeCollection(['api/mrp/manufacturing_orders']),
      probeCollection(['api/mrp/work_orders']),
      probeCollection(['api/mrp/external_shipments']),
      probeCollection(['api/product']),
      probeCollection(['api/bom']),
    ]);

    const extraIds = new Set();
    const mosAll = moProbe.items || [];
    const wosAll = woProbe.items || [];
    const mos = filterRelated(mosAll, id, hint);
    const wos = filterRelated(wosAll, id, hint);
    mos.forEach((m) => extraIds.add('mo:' + itemId(m)));
    wos.forEach((w) => extraIds.add('wo:' + itemId(w)));
    const ships = filterRelated(shipProbe.items || [], id, hint, extraIds);
    const extItems = (wos || []).filter(isExternalWo);

    return {
      mo: moProbe,
      mos,
      mosAll,
      wo: woProbe,
      wos,
      wosAll,
      ext: { ok: woProbe.ok, result: woProbe.result, path: woProbe.path },
      extItems,
      ship: shipProbe,
      ships,
      products: productProbe.items || [],
      product: productProbe,
      boms: bomProbe.items || [],
      bom: bomProbe,
      lines: lineItemsFrom(detail),
    };
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

  function purchasedRows(rel, detail) {
    const products = rel.products || [];
    const boms = rel.boms || [];
    const lines = (rel.lines && rel.lines.length ? rel.lines : lineItemsFrom(detail)) || [];
    const rows = [];

    lines.forEach((line) => {
      const en = enrichLine(line, products, boms);
      const name =
        line.description ||
        line.name ||
        line.product ||
        (en.product && (en.product.description || en.product.name || en.product.code)) ||
        itemNumber(line);
      const vendor =
        line.vendor ||
        line.supplier ||
        line.company ||
        (en.product && (en.product.vendor || en.product.supplier || en.product.company)) ||
        '—';
      const qty = line.qty != null ? line.qty : line.quantity != null ? line.quantity : '—';
      const unit = line.unit || line.unite || (en.product && en.product.unit) || '';
      const price = numField(line, ['rate', 'price', 'unit_price', 'cost']) ??
        numField(en.product, ['purchase_price', 'rate', 'price', 'cost', 'unit_cost']);
      const kind = en.bom ? 'BOM / üretim' : 'Teklif satırı';
      rows.push({ name, vendor, qty, unit, price, kind });
    });

    (rel.extItems || []).forEach((w) => {
      rows.push({
        name: w.product || w.description || w.name || itemNumber(w),
        vendor: w.vendor || w.supplier || w.company || '—',
        qty: w.qty != null ? w.qty : w.quantity != null ? w.quantity : '—',
        unit: w.unit || '',
        price: numField(w, ['rate', 'price', 'cost']),
        kind: 'Dış iş emri',
      });
    });

    (rel.boms || []).forEach((bom) => {
      const bomLines = Array.isArray(bom.lines) ? bom.lines : Array.isArray(bom.items) ? bom.items : [];
      const linked = lines.some((line) => {
        const pid = String(line.product_id || line.itemid || line.item_id || '');
        return pid && (String(bom.product_id) === pid || String(bom.id) === pid);
      });
      if (!linked) return;
      bomLines.forEach((bl) => {
        rows.push({
          name: bl.description || bl.name || bl.product || itemNumber(bl),
          vendor: bl.vendor || bl.supplier || '—',
          qty: bl.product_qty != null ? bl.product_qty : bl.qty != null ? bl.qty : '—',
          unit: bl.unit || '',
          price: numField(bl, ['rate', 'price', 'cost']),
          kind: 'BOM kalemi',
        });
      });
    });

    return rows;
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

  function renderPurchasedPanel(rel, detail) {
    const merged = purchasedRows(rel, detail);
    if (!merged.length && !rel.product.ok && !rel.wo.ok && !(rel.lines && rel.lines.length) && !lineItemsFrom(detail).length) {
      return sectionUnavailable(
        'Satın alınan ürünler yüklenemedi',
        (rel.product && rel.product.result) || (rel.wo && rel.wo.result)
      );
    }
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
      'Teklif satırı, ürün/BOM eşlemesi veya dış iş emri dönmedi. Sahte kalem üretilmez.'
    );
  }

  function renderShipmentsPanel(rel) {
    const list = rel.ships || [];
    const woRows = (rel.wos || []).map((w) => [
      escapeHtml(itemNumber(w)),
      escapeHtml(w.destination || w.address || w.product || w.description || '—'),
      escapeHtml(statusLabel(w.status || w.state) + (isExternalWo(w) ? ' · dış operasyon' : '')),
      escapeHtml(w.carrier || w.method || 'İş emri'),
      escapeHtml(fmtDate(w.date || w.date_created || w.updated_at)),
    ]);
    if (!rel.ship.ok && list.length === 0 && !rel.wo.ok && !woRows.length) {
      return sectionUnavailable('Sevkiyatlar yüklenemedi', rel.ship.result || (rel.wo && rel.wo.result));
    }
    const rows = list.map((s) => [
      escapeHtml(itemNumber(s)),
      escapeHtml(s.destination || s.address || s.customer || s.to || '—'),
      escapeHtml(statusLabel(s.status || s.state)),
      escapeHtml(s.carrier || s.method || '—'),
      escapeHtml(fmtDate(s.date || s.shipped_at || s.updated_at || s.created_at)),
    ]);
    return (
      tableHtml(
        ['Sevkiyat', 'Hedef', 'Durum', 'Taşıma', 'Tarih'],
        rows,
        'Sevkiyat kaydı yok',
        'external_shipments bu teklif için boş döndü veya henüz sevk yok.'
      ) +
      (woRows.length
        ? '<h3 class="ops-msg-title">İş emirleri</h3>' +
          tableHtml(['İş emri', 'Hedef / ürün', 'Durum', 'Kaynak', 'Tarih'], woRows, 'İş emri yok', '')
        : '')
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
    const id = (detail && (detail.id || detail.proposal_id || detail.teklif_id)) || selectedId;
    const number = itemNumber(detail || selectedItem || { id: id });
    const customer = itemCustomer(detail || selectedItem || {});
    const st = (detail && (detail.status || detail.status_name)) || (selectedItem && selectedItem.status);
    const moCount = (rel.mos && rel.mos.length) || 0;
    const buyCount = purchasedRows(rel, detail).length;
    const shipCount = (rel.ships && rel.ships.length) || 0;
    const cost = costFromAvailable(rel, detail);

    const tabs = TABS.map(
      (t) =>
        '<button type="button" class="ops-tab' +
        (detailTab === t.id ? ' active' : '') +
        '" data-tab="' +
        t.id +
        '">' +
        escapeHtml(t.label) +
        '</button>'
    ).join('');

    const panels = {
      mo: renderMoPanel(rel),
      purchased: renderPurchasedPanel(rel, detail),
      shipments: renderShipmentsPanel(rel, detail),
      cost: renderCostPanel(rel, detail),
    };

    return (
      '<div class="ops-ws-head">' +
      '<div>' +
      '<p class="ops-kicker">' +
      escapeHtml(statusLabel(st)) +
      ' · çalışma alanı</p>' +
      '<h2>' +
      escapeHtml(number) +
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
      '<div class="ops-metric"><span>MO</span><strong>' +
      escapeHtml(rel.mo.ok || moCount ? String(moCount) : '—') +
      '</strong></div>' +
      '<div class="ops-metric"><span>Satınalma</span><strong>' +
      escapeHtml(buyCount ? String(buyCount) : '—') +
      '</strong></div>' +
      '<div class="ops-metric"><span>Sevkiyat</span><strong>' +
      escapeHtml(rel.ship.ok || shipCount ? String(shipCount) : '—') +
      '</strong></div>' +
      '<div class="ops-metric"><span>Son maliyet</span><strong>' +
      (cost && cost.total != null ? fmtMoney(cost.total) : '—') +
      '</strong></div>' +
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
      '<p class="ops-cost-note">Mesaj API’si bu sözleşmede yok. Perfex sohbeti için Sohbet düğmesini kullanın.</p>'
    );
  }

  async function loadList() {
    await refreshBaseUrl();
    setListTitle('Yükleniyor…');
    const body = el('opsListBody');
    if (body) body.innerHTML = skeletonCards(6);
    setBanner('');

    const ids = [];
    if (scope === 'ids') {
      const hist = await loadHistory();
      hist.forEach((h) => {
        if (h.proposalId) ids.push(String(h.proposalId));
      });
      if (ids.length === 0) {
        lastListItems = [];
        renderMetrics(null, { accepted: 0, open: 0, overdue: 0, mo: '—' });
        renderList([], 0, { emptyHint: 'Yerel teklif geçmişi boş.', source: listSource });
        setListTitle('Yerel teklif geçmişi boş');
        return;
      }
    }

    const [listRes, moRes] = await Promise.all([
      fetchTeklifList(),
      apiGet('api/mrp/manufacturing_orders'),
    ]);

    if (!listRes.ok) {
      if (
        (listRes.result && (listRes.result.status === 401 || listRes.result.status === 403)) &&
        typeof needSettingsHandler === 'function'
      ) {
        needSettingsHandler();
      }
      const msg = explainError(listRes.result);
      setBanner(msg + ' Liste api/teklif ve api/proposals üzerinden denenir; uydurma kayıt yok.', 'warn');
      renderMetrics(null, { accepted: '—', open: '—', overdue: '—', mo: '—' });
      lastListItems = [];
      renderList([], 0, { emptyHint: msg, source: listRes.source });
      setListTitle(msg);
      toast(msg, 'err');
      return;
    }

    listSource = listRes.source || 'teklif';
    let items = listRes.items || [];
    lastListItems = items.slice();

    const metrics = {
      accepted: items.filter(isAccepted).length,
      open: items.filter(isOpenStatus).length,
      overdue: items.filter(isOverdue).length,
      mo: moRes && moRes.ok ? unwrapRecords(moRes.json).length : '—',
    };
    renderMetrics(null, metrics);

    if (scope === 'ids') {
      const idSet = new Set(ids);
      items = items.filter((item) => idSet.has(String(itemId(item))));
    }

    const q = String(query || '').trim().toLowerCase();
    let searchSource = listSource;
    if (q) {
      const remote = await searchTeklif(query);
      if (remote.ok && remote.items && remote.items.length) {
        items = remote.items;
        searchSource = 'search';
      } else {
        items = items.filter((item) => matchesQuery(item, q));
      }
    }

    if (status !== 'all') {
      items = filterByStatus(items);
    }

    const sliced = items.slice(offset, offset + LIMIT);
    const total = items.length;
    renderList(sliced, total, { source: searchSource });
    setListTitle(total + ' kayıt · tıklayınca MO / satınalma / sevkiyat / maliyet');
  }

  async function openDetail(id) {
    selectedId = id;
    detailTab = 'mo';
    el('opsListPane').hidden = true;
    el('opsDetailPane').hidden = false;
    el('opsBtnBack').hidden = false;
    if (el('opsMetrics')) el('opsMetrics').hidden = true;
    setListTitle('Teklif çalışma alanı');
    if (el('opsSubtitle')) {
      el('opsSubtitle').textContent =
        'MO, satınalma, sevkiyat ve maliyet' + (cachedBaseUrl ? ' · ' + cachedBaseUrl : '');
    }
    el('opsDetailPane').innerHTML =
      '<div class="ops-state ops-state-loading">Çalışma alanı yükleniyor…</div>';

    const fromList = (lastListItems || []).find((row) => String(itemId(row)) === String(id));
    const detailRes = await fetchTeklifDetail(id);
    let detail = detailRes.detail || fromList || selectedItem || { id: id };
    if (detailRes.ok && detailRes.detail) detail = detailRes.detail;

    const rel = await loadRelatedForProposal(id, detail);
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
        ' Liste kaydı ve MRP uçları (MO, WO, sevkiyat, ürün, BOM) ile doldurulur.';
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
        if (metric === 'accepted' || metric === 'open') {
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
      status = status || 'accepted';
      setChips(el('opsStatusChips'), status);
      setChips(el('opsScopeChips'), scope);
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
