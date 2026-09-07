/**
 * Native Operasyon konsolu — JWT REST.
 * Liste: api/v1/mrp/operations/proposals (404 ise açıklama + work_orders yedek).
 * Detay: MO, satınalma, sevkiyat, maliyet — yalnızca mevcut api/ uçları.
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
  let lastMsgId = 0;
  let needSettingsHandler = null;
  let warnedOps404 = false;
  let listSource = 'proposals';

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

  function asArray(json) {
    if (!json) return [];
    if (Array.isArray(json)) return json;
    const keys = [
      'items',
      'data',
      'records',
      'results',
      'proposals',
      'manufacturing_orders',
      'work_orders',
      'work_centers',
      'shipments',
      'external_shipments',
      'materials',
      'products',
      'purchases',
    ];
    for (let i = 0; i < keys.length; i++) {
      const v = json[keys[i]];
      if (Array.isArray(v)) return v;
    }
    if (json.data && typeof json.data === 'object') return asArray(json.data);
    return [];
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

  function itemId(item) {
    if (!item) return '';
    return String(
      item.id || item.proposal_id || item.manufacturing_id || item.wo_id || item.shipment_id || ''
    );
  }

  function itemNumber(item) {
    if (!item) return '—';
    return (
      item.number ||
      item.proposal_number ||
      item.mo_number ||
      item.wo_number ||
      item.shipment_number ||
      item.code ||
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
      item.subject ||
      item.product ||
      item.description ||
      '—'
    );
  }

  function matchesProposal(row, id) {
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
      'id',
    ];
    for (let i = 0; i < keys.length; i++) {
      if (row[keys[i]] != null && String(row[keys[i]]) === sid) return true;
    }
    const origin = String(row.origin || row.reference || row.proposal_number || row.number || '');
    if (origin && (origin === sid || origin.indexOf(sid) !== -1)) return true;
    return false;
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
            escapeHtml(fmtDate(item.date || item.updated_at || item.created_at || item.date_created)) +
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
            escapeHtml(item.subject && item.customer ? item.subject : item.priority || 'Teklif çalışma alanı') +
            '</span>' +
            '<span class="ops-card-go">Detay →</span>' +
            '</div>' +
            '</article>'
          );
        })
        .join('');
    }
    if (foot) {
      const src =
        info.source === 'work_orders'
          ? ' · kaynak: iş emirleri'
          : info.source === 'proposals'
            ? ' · kaynak: kabul edilmiş teklifler'
            : '';
      foot.textContent = (total != null ? total + ' kayıt' : '') + src;
    }
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
    const list = Array.isArray(items) ? items : [];
    list.forEach((m) => {
      const id = Number(m.id || 0);
      if (id > lastMsgId) lastMsgId = id;
    });
    renderMessages(list);
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
    if (!result.ok) return { items: [], error: explainError(result), result };
    const json = result.json || {};
    const raw = asArray(json);
    const items = raw.map((w) => ({
      id: w.id,
      number: w.number || w.wo_number || w.id,
      customer: w.product || w.description || w.customer || 'İş emri',
      status: w.status,
      date: w.date_created || w.updated_at,
      subject: 'İş emri (yedek liste)',
      _raw: w,
    }));
    return { items, total: items.length, fallback: true, source: 'work_orders' };
  }

  function filterByStatus(items) {
    if (status === 'all') return items;
    return items.filter((item) => (status === 'accepted' ? isAccepted(item) : isOpenStatus(item)));
  }

  function setListTitle(text) {
    const title = el('opsTitle');
    const sub = el('opsSubtitle');
    if (title) {
      title.textContent =
        status === 'accepted' ? 'Kabul edilmiş teklifler' : status === 'open' ? 'Açık teklifler' : 'Tüm teklifler';
    }
    if (sub) sub.textContent = text || 'Üretim, satınalma, sevkiyat ve maliyet';
  }

  async function probeCollection(paths) {
    let last = null;
    for (let i = 0; i < paths.length; i++) {
      const result = await apiGet(paths[i]);
      last = result;
      if (result && result.ok) {
        return { ok: true, result, items: asArray(result.json), path: paths[i] };
      }
      if (result && result.status !== 404) {
        return { ok: false, result, items: [], path: paths[i] };
      }
    }
    return { ok: false, result: last, items: [], path: paths[paths.length - 1] };
  }

  async function loadRelatedForProposal(id) {
    const sid = encodeURIComponent(id);
    const [moProbe, woProbe, extProbe, shipProbe, costProbe] = await Promise.all([
      probeCollection([
        'api/v1/mrp/manufacturing_orders?proposal_id=' + sid + '&limit=500',
        'api/v1/mrp/manufacturing_orders?rel_id=' + sid + '&limit=500',
        'api/v1/mrp/manufacturing_orders?limit=500',
      ]),
      probeCollection([
        'api/v1/mrp/work_orders?proposal_id=' + sid + '&limit=500',
        'api/v1/mrp/work_orders?limit=500',
      ]),
      probeCollection([
        'api/v1/mrp/work_order_external?proposal_id=' + sid + '&limit=500',
        'api/v1/mrp/work_order_external?limit=500',
      ]),
      probeCollection([
        'api/v1/mrp/external_shipments?proposal_id=' + sid + '&limit=500',
        'api/v1/mrp/external_shipments?limit=500',
      ]),
      probeCollection([
        'api/v1/mrp/operations/proposals/' + sid + '/cost',
        'api/v1/mrp/operations/proposals/' + sid + '/costing',
      ]),
    ]);

    let mos = moProbe.items || [];
    if (moProbe.ok && moProbe.path && moProbe.path.indexOf('proposal_id') === -1 && moProbe.path.indexOf('rel_id') === -1) {
      mos = mos.filter((row) => matchesProposal(row, id));
    }
    let wos = woProbe.items || [];
    if (woProbe.ok && woProbe.path && woProbe.path.indexOf('proposal_id') === -1) {
      wos = wos.filter((row) => matchesProposal(row, id));
    }
    let ext = extProbe.items || [];
    if (extProbe.ok && extProbe.path && extProbe.path.indexOf('proposal_id') === -1) {
      ext = ext.filter((row) => matchesProposal(row, id));
    }
    let ships = shipProbe.items || [];
    if (shipProbe.ok && shipProbe.path && shipProbe.path.indexOf('proposal_id') === -1) {
      ships = ships.filter((row) => matchesProposal(row, id));
    }

    return {
      mo: moProbe,
      mos,
      wo: woProbe,
      wos,
      ext: extProbe,
      extItems: ext,
      ship: shipProbe,
      ships,
      cost: costProbe,
    };
  }

  function purchasedFromDetail(detail) {
    const bags = [
      detail && detail.purchases,
      detail && detail.purchased,
      detail && detail.purchased_items,
      detail && detail.materials,
      detail && detail.items,
      detail && detail.products,
    ];
    for (let i = 0; i < bags.length; i++) {
      if (Array.isArray(bags[i]) && bags[i].length) return bags[i];
    }
    return [];
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
      escapeHtml(statusLabel(w.status || w.state)),
      escapeHtml(fmtDate(w.date || w.date_created || w.updated_at)),
    ]);
    return (
      tableHtml(
        ['MO', 'Ürün', 'Durum', 'Miktar', 'Tarih'],
        moRows,
        'Bu teklife bağlı üretim emri yok',
        'Kabul edilmiş teklif için manufacturing_orders kaydı bulunamadı.'
      ) +
      (woRows.length
        ? '<h3 class="ops-msg-title">İş emirleri</h3>' +
          tableHtml(
            ['İş emri', 'Ürün', 'Durum', 'Tarih'],
            woRows,
            'İş emri yok',
            ''
          )
        : '')
    );
  }

  function renderPurchasedPanel(rel, detail) {
    const fromDetail = purchasedFromDetail(detail || {});
    const fromExt = rel.extItems || [];
    const merged = fromDetail.concat(fromExt);
    if (!rel.ext.ok && fromDetail.length === 0 && fromExt.length === 0 && rel.ext.result && rel.ext.result.status === 404) {
      if (fromDetail.length === 0) {
        return sectionUnavailable('Satın alınan ürünler yüklenemedi', rel.ext.result);
      }
    }
    const rows = merged.map((m) => [
      escapeHtml(m.description || m.name || m.product || m.code || itemNumber(m)),
      escapeHtml(m.vendor || m.supplier || m.company || '—'),
      escapeHtml(m.qty != null ? m.qty : m.quantity != null ? m.quantity : '—'),
      escapeHtml(m.unit || m.unite || ''),
      fmtMoney(m.rate != null ? m.rate : m.price != null ? m.price : m.cost),
    ]);
    if (merged.length === 0 && rel.ext.ok) {
      return tableHtml(
        ['Ürün', 'Tedarikçi', 'Miktar', 'Birim', 'Birim fiyat'],
        [],
        'Satın alınan ürün yok',
        'Bu teklife bağlı dış alım / malzeme satırı dönmedi.'
      );
    }
    if (merged.length === 0) {
      return sectionUnavailable('Satın alınan ürünler yüklenemedi', rel.ext.result);
    }
    return tableHtml(
      ['Ürün', 'Tedarikçi', 'Miktar', 'Birim', 'Birim fiyat'],
      rows,
      'Satın alınan ürün yok',
      'Bu teklife bağlı dış alım / malzeme satırı dönmedi.'
    );
  }

  function renderShipmentsPanel(rel, detail) {
    const nested = (detail && (detail.shipments || detail.external_shipments)) || [];
    const list = (rel.ships && rel.ships.length ? rel.ships : nested) || [];
    if (!rel.ship.ok && list.length === 0) {
      return sectionUnavailable('Sevkiyatlar yüklenemedi', rel.ship.result);
    }
    const rows = list.map((s) => [
      escapeHtml(itemNumber(s)),
      escapeHtml(s.destination || s.address || s.customer || s.to || '—'),
      escapeHtml(statusLabel(s.status || s.state)),
      escapeHtml(s.carrier || s.method || '—'),
      escapeHtml(fmtDate(s.date || s.shipped_at || s.updated_at || s.created_at)),
    ]);
    return tableHtml(
      ['Sevkiyat', 'Hedef', 'Durum', 'Taşıma', 'Tarih'],
      rows,
      'Sevkiyat kaydı yok',
      'external_shipments bu teklif için boş döndü veya henüz sevk yok.'
    );
  }

  function renderCostPanel(rel, detail) {
    const fromDetail = pickCost(detail);
    const fromApi = rel.cost.ok ? pickCost(rel.cost.result && rel.cost.result.json) : null;
    const cost = fromApi || fromDetail;
    const note = !rel.cost.ok
      ? explainError(rel.cost.result) +
        ' Maliyet satırları yine de hazır; değerler API gelince dolar.'
      : cost
        ? 'En son dönen maliyet kalemleri.'
        : 'Maliyet ucu yanıt verdi ancak hesap satırı yok.';

    const rows = [
      ['Malzeme', cost && cost.material],
      ['İşçilik', cost && cost.labor],
      ['Dış alım / satınalma', cost && cost.purchase],
      ['Sevkiyat', cost && cost.shipping],
      ['Genel gider', cost && cost.overhead],
    ];
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
      '</tbody></table></div>'
    );
  }

  function workspaceHtml(detail, rel) {
    const id = (detail && (detail.id || detail.proposal_id)) || selectedId;
    const number = itemNumber(detail || selectedItem || { id: id });
    const customer = itemCustomer(detail || selectedItem || {});
    const st = (detail && (detail.status || detail.status_name)) || (selectedItem && selectedItem.status);
    const moCount = (rel.mos && rel.mos.length) || 0;
    const buyCount =
      purchasedFromDetail(detail || {}).length + ((rel.extItems && rel.extItems.length) || 0);
    const shipCount = (rel.ships && rel.ships.length) || 0;
    const cost = pickCost(detail) || (rel.cost.ok ? pickCost(rel.cost.result && rel.cost.result.json) : null);

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
      '<h3 class="ops-msg-title">Mesajlar</h3>' +
      '<div id="opsMessages" class="ops-messages"></div>'
    );
  }

  async function loadList() {
    setListTitle('Yükleniyor…');
    const body = el('opsListBody');
    if (body) body.innerHTML = skeletonCards(6);
    setBanner('');

    const healthRes = await apiGet('api/v1/mrp/health');
    renderMetrics(healthRes.ok ? healthRes.json : null);

    const ids = [];
    if (scope === 'ids') {
      const hist = await loadHistory();
      hist.forEach((h) => {
        if (h.proposalId) ids.push(h.proposalId);
      });
      if (ids.length === 0) {
        renderList([], 0, { emptyHint: 'Yerel teklif geçmişi boş.' });
        setListTitle('Yerel teklif geçmişi boş');
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
      listSource = fallback.source || 'work_orders';
      const msg = explainError(result);
      setBanner(msg + (fallback.items && fallback.items.length ? ' İş emirleri yedek listesi gösteriliyor.' : ''), 'warn');
      if (fallback.items && fallback.items.length) {
        let items = fallback.items;
        if (status !== 'all') {
          const filtered = filterByStatus(items);
          if (filtered.length) items = filtered;
        }
        renderList(items, items.length, { source: 'work_orders' });
        setListTitle('İş emirleri (operasyon ucu yok)');
        if (!warnedOps404) {
          toast(msg, 'warn');
          warnedOps404 = true;
        }
        return;
      }
      renderList([], 0, { emptyHint: msg });
      setListTitle(msg);
      toast(msg, 'err');
      return;
    }
    listSource = 'proposals';
    const json = result.json || {};
    let items = json.items || json.data || [];
    if (!Array.isArray(items)) items = asArray(json);
    if (status !== 'all') {
      const filtered = filterByStatus(items);
      if (filtered.length !== items.length) items = filtered;
    }
    const total = json.total != null ? json.total : items.length;
    renderList(items, total, { source: 'proposals' });
    if (json.health) renderMetrics({ ops: json.health });
    setListTitle(total + ' kayıt · tıklayınca MO / satınalma / sevkiyat / maliyet');
  }

  async function openDetail(id) {
    selectedId = id;
    lastMsgId = 0;
    detailTab = 'mo';
    el('opsListPane').hidden = true;
    el('opsDetailPane').hidden = false;
    el('opsBtnBack').hidden = false;
    if (el('opsMetrics')) el('opsMetrics').hidden = true;
    setListTitle('Teklif çalışma alanı');
    el('opsSubtitle').textContent = 'MO, satınalma, sevkiyat ve maliyet';
    el('opsDetailPane').innerHTML =
      '<div class="ops-state ops-state-loading">Çalışma alanı yükleniyor…</div>';

    const detailRes = await apiGet(
      'api/v1/mrp/operations/proposals/' + encodeURIComponent(id)
    );
    let detail = selectedItem || { id: id };
    if (detailRes.ok) {
      detail = (detailRes.json && (detailRes.json.data || detailRes.json.item || detailRes.json)) || detail;
    } else if (detailRes.status === 404) {
      el('opsDetailPane').innerHTML = '';
    }

    const rel = await loadRelatedForProposal(id);
    if (!detailRes.ok && detailRes.status !== 404) {
      toast(explainError(detailRes), 'warn');
    } else if (!detailRes.ok) {
      detail = Object.assign({ id: id }, selectedItem || {});
    }

    el('opsDetailPane').innerHTML = workspaceHtml(detail, rel);
    if (!detailRes.ok) {
      const host = el('opsDetailPane');
      const note = document.createElement('p');
      note.className = 'ops-banner ops-banner-warn';
      note.textContent =
        explainError(detailRes) + ' Bölümler bilinen MRP uçlarından (MO, WO, sevkiyat) doldurulur.';
      if (host.firstChild) host.insertBefore(note, host.firstChild);
      else host.appendChild(note);
    }
    await loadMessages();
    startPoll();
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
    } else if (kind === 'health') {
      window.OperasyonView.openWebPath('manufacturing/ops_health');
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
        selectedItem = {
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
