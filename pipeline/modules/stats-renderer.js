/**
 * pipeline/modules/stats-renderer.js  v1.0
 * Stats Tab — KPI cards, alert strip, timeline bifurcated (OB above / CBT below).
 *
 * Public API (all pure render or event-wire — no global state mutation):
 *   PipelineStats.render(games, year)   → injects HTML into #pl-stats-content
 *   PipelineStats.wireEvents()          → attaches hover-dialog + filter chips
 *
 * Design decisions:
 *   • Timeline uses CSS-grid (repeat(12,1fr)) — no canvas / D3 dependency
 *   • Each game is 1 row (swim-lane) in its section; same game can appear in BOTH
 *   • Month count badges computed from game data at render time
 *   • Hover dialog is a single singleton <div> repositioned by JS
 *   • Alert thresholds: ≤7d → urgent, 8–14d → warning, 15–30d → info
 */
const PipelineStats = (() => {

  /* ─── helpers ─────────────────────────────────────────────────────────── */
  const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  function _parseDate(iso) {
    if (!iso || iso === 'TBU' || iso === 'No CBT' || iso === '-') return null;
    const d = new Date(iso);
    return isNaN(d) ? null : d;
  }

  function _fmtDateVN(iso) {
    const d = _parseDate(iso);
    if (!d) return iso || '—';
    return d.toLocaleDateString('vi-VN', { day:'2-digit', month:'short', year:'numeric' });
  }

  function _daysFromNow(iso) {
    const d = _parseDate(iso);
    if (!d) return null;
    const today = new Date(); today.setHours(0,0,0,0);
    return Math.round((d - today) / 86400000);
  }

  function _alertClass(days) {
    if (days === null) return '';
    if (days >= 0 && days <= 7)  return 'alert-7';
    if (days > 7  && days <= 14) return 'alert-14';
    return '';
  }

  /* game has valid CBT? */
  function _hasCbt(g) {
    return !!(g.cbtFrom && g.cbtFrom !== 'No CBT' && g.cbtFrom !== 'TBU');
  }
  /* game has valid OB? */
  function _hasOb(g) {
    return !!(g.obDate && g.obDate !== 'TBU' && g.obDate !== '-');
  }

  /* ─── date → column position helpers ─────────────────────────────────── */
  // Returns { col (1-12), pct (0-100) } for a given ISO date in a given year
  function _dateToPos(iso, year) {
    const d = _parseDate(iso);
    if (!d || d.getFullYear() !== year) return null;
    const col = d.getMonth(); // 0-indexed
    const daysInMonth = new Date(year, col + 1, 0).getDate();
    const pct = ((d.getDate() - 1) / daysInMonth) * 100;
    return { col, pct };
  }

  /* ─── month count computation ─────────────────────────────────────────── */
  function _computeMonthCounts(obGames, cbtGames, year) {
    // 12 slots: ob counts + cbt counts
    const ob  = Array(12).fill(0);
    const cbt = Array(12).fill(0);

    obGames.forEach(g => {
      const d = _parseDate(g.obDate);
      if (d && d.getFullYear() === year) ob[d.getMonth()]++;
    });

    cbtGames.forEach(g => {
      // CBT can span months — count any month touched by cbtFrom..cbtTo
      const from = _parseDate(g.cbtFrom);
      if (!from || from.getFullYear() < year - 1) return;
      const to = _parseDate(g.cbtTo) || from;
      for (let m = 0; m < 12; m++) {
        const mStart = new Date(year, m, 1);
        const mEnd   = new Date(year, m + 1, 0);
        if (from <= mEnd && to >= mStart) cbt[m]++;
      }
    });

    return { ob, cbt };
  }

  /* ─── KPI cards ───────────────────────────────────────────────────────── */
  function _renderKPICards(obGames, cbtGames) {
    const today = new Date(); today.setHours(0,0,0,0);
    const curMonth = today.getMonth();
    const curYear  = today.getFullYear();

    const urgent = [...obGames, ...cbtGames].filter(g => {
      const d1 = _daysFromNow(g.obDate);
      const d2 = _daysFromNow(g.cbtFrom);
      return (d1 !== null && d1 >= 0 && d1 <= 7) || (d2 !== null && d2 >= 0 && d2 <= 7);
    });
    // dedupe by name
    const urgentUniq = [...new Map(urgent.map(g => [g.name, g])).values()];

    const thisMonthEvents = [...obGames, ...cbtGames].filter(g => {
      const d1 = _parseDate(g.obDate);
      const d2 = _parseDate(g.cbtFrom);
      return (d1 && d1.getMonth() === curMonth && d1.getFullYear() === curYear) ||
             (d2 && d2.getMonth() === curMonth && d2.getFullYear() === curYear);
    });
    const thisMonthUniq = [...new Map(thisMonthEvents.map(g => [g.name, g])).values()];

    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    return `<div class="pls-kpi-row">
      <div class="pls-kpi ob">
        <div class="pls-kpi-label">🚀 Total OB Launch</div>
        <div class="pls-kpi-value">${obGames.length}</div>
        <div class="pls-kpi-sub">games có lịch OB</div>
      </div>
      <div class="pls-kpi cbt">
        <div class="pls-kpi-label">🧪 Total CBT / AT</div>
        <div class="pls-kpi-value">${cbtGames.length}</div>
        <div class="pls-kpi-sub">games có lịch CBT</div>
      </div>
      <div class="pls-kpi alert${urgentUniq.length > 0 ? ' has-alert' : ''}">
        <div class="pls-kpi-label">🔴 Sắp xảy ra (≤7 ngày)</div>
        <div class="pls-kpi-value">${urgentUniq.length}</div>
        <div class="pls-kpi-sub">cần chú ý ngay</div>
      </div>
      <div class="pls-kpi month">
        <div class="pls-kpi-label">📅 Tháng này (${months[curMonth]})</div>
        <div class="pls-kpi-value">${thisMonthUniq.length}</div>
        <div class="pls-kpi-sub">sự kiện CBT/OB</div>
      </div>
    </div>`;
  }

  /* ─── alert strip ─────────────────────────────────────────────────────── */
  function _renderAlertStrip(games) {
    const alerts = { urgent:[], warning:[], info:[] };

    games.forEach(g => {
      const checkDate = (dateIso, type) => {
        const d = _daysFromNow(dateIso);
        if (d === null || d < 0) return;
        const event = { game: g, type, dateIso, days: d };
        if (d <= 7)        alerts.urgent.push(event);
        else if (d <= 14)  alerts.warning.push(event);
        else if (d <= 30)  alerts.info.push(event);
      };
      if (_hasOb(g))  checkDate(g.obDate,   'OB');
      if (_hasCbt(g)) checkDate(g.cbtFrom,  'CBT');
    });

    // Sort each group by days ascending
    ['urgent','warning','info'].forEach(k =>
      alerts[k].sort((a,b) => a.days - b.days)
    );

    const renderCard = (type, icon, title, items, cssClass) => {
      if (items.length === 0) return '';
      const rows = items.slice(0, 5).map(ev => `
        <div class="pls-alert-item">
          <span class="pls-alert-dot"></span>
          <span class="pls-alert-game">${esc(ev.game.name)}</span>
          <span class="pls-alert-evtype">${ev.type}</span>
          <span class="pls-alert-days">${ev.days === 0 ? 'Hôm nay!' : ev.days + ' ngày'}</span>
        </div>`).join('');
      const more = items.length > 5 ? `<div class="pls-alert-more">+${items.length - 5} more…</div>` : '';
      return `<div class="pls-alert-card ${cssClass}">
        <div class="pls-alert-icon">${icon}</div>
        <div class="pls-alert-body">
          <div class="pls-alert-title">${title}</div>
          <div class="pls-alert-items">${rows}${more}</div>
        </div>
      </div>`;
    };

    const hasAny = alerts.urgent.length + alerts.warning.length + alerts.info.length > 0;
    if (!hasAny) return `<div class="pls-alert-strip pls-alert-empty">
      <span style="font-size:18px">✅</span> Không có sự kiện CBT/OB nào trong 30 ngày tới.
    </div>`;

    return `<div class="pls-alert-strip">
      ${renderCard('urgent','🚨','⚡ Urgent — trong 7 ngày', alerts.urgent, 'urgent')}
      ${renderCard('warning','⚠️','Sắp tới — 8–14 ngày', alerts.warning, 'warning')}
      ${renderCard('info','📢','Upcoming — 15–30 ngày', alerts.info, 'info')}
    </div>`;
  }

  /* ─── filter chips ────────────────────────────────────────────────────── */
  function _renderFilterRow() {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const monthChips = months.map((m, i) =>
      `<button class="pls-mchip" data-month="${i}">${m}</button>`
    ).join('');

    return `<div class="pls-filter-row" id="pls-filter-row">
      <span class="pls-filter-lbl">Lọc:</span>
      <div class="pls-chips">
        <button class="pls-qchip active" data-q="-1" id="pls-q-all">Cả năm</button>
      </div>
      <div class="pls-chips-div"></div>
      <div class="pls-chips">
        <button class="pls-qchip" data-q="0">Q1 (Jan–Mar)</button>
        <button class="pls-qchip" data-q="1">Q2 (Apr–Jun)</button>
        <button class="pls-qchip" data-q="2">Q3 (Jul–Sep)</button>
        <button class="pls-qchip" data-q="3">Q4 (Oct–Dec)</button>
      </div>
      <div class="pls-chips-div"></div>
      <div class="pls-chips" id="pls-month-chips">${monthChips}</div>
    </div>`;
  }

  /* ─── timeline ────────────────────────────────────────────────────────── */
  function _renderTimeline(obGames, cbtGames, year) {
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const today  = new Date();
    const curMonth = today.getMonth();
    const curYear  = today.getFullYear();

    const counts = _computeMonthCounts(obGames, cbtGames, year);

    /* month header with count badges */
    const monthCols = MONTHS.map((m, i) => {
      const obCnt  = counts.ob[i];
      const cbtCnt = counts.cbt[i];
      const isCur  = (i === curMonth && year === curYear);
      const hasEvents = obCnt > 0 || cbtCnt > 0;
      const badgeOb  = obCnt  > 0 ? `<span class="pls-mc-ob">${obCnt} OB</span>`  : `<span class="pls-mc-empty">—</span>`;
      const badgeCbt = cbtCnt > 0 ? `<span class="pls-mc-cbt">${cbtCnt} CBT</span>` : `<span class="pls-mc-empty">—</span>`;
      return `<div class="pls-month-col${isCur ? ' current' : ''}${hasEvents ? ' has-events' : ''}" data-month="${i}">
        <div class="pls-month-name">${m}${isCur ? ' ↑' : ''}</div>
        <div class="pls-month-badge${hasEvents ? '' : ' empty'}">${badgeOb}<span class="pls-mc-sep">·</span>${badgeCbt}</div>
      </div>`;
    }).join('');

    /* OB swim lanes */
    const obRows = obGames.map(g => _renderObRow(g, year, MONTHS.length)).join('');

    /* CBT swim lanes */
    const cbtRows = cbtGames.map(g => _renderCbtRow(g, year, MONTHS.length)).join('');

    return `<div class="pls-timeline" id="pls-timeline">
      <div class="pls-tl-header">
        <div class="pls-tl-title">
          📅 Timeline CBT / OB
          <span class="pls-tl-year">${year}</span>
          <span class="pls-tl-subtitle">— 12 tháng</span>
        </div>
        <div class="pls-tl-legend">
          <span class="pls-leg"><span class="pls-leg-dot ob"></span>OB Launch</span>
          <span class="pls-leg"><span class="pls-leg-dot cbt"></span>CBT / AT</span>
          <span class="pls-leg"><span class="pls-leg-dot a7"></span>≤7 ngày</span>
          <span class="pls-leg"><span class="pls-leg-dot a14"></span>≤14 ngày</span>
        </div>
      </div>

      <div class="pls-tl-body">
        <!-- Month header row -->
        <div class="pls-tl-months" id="pls-tl-months">
          ${monthCols}
        </div>

        <!-- OB section -->
        <div class="pls-tl-section ob">
          <div class="pls-tl-section-label ob">🚀 OB LAUNCH SCHEDULE</div>
          ${obRows || '<div class="pls-tl-empty">Không có game OB nào trong năm này.</div>'}
        </div>

        <!-- Center divider -->
        <div class="pls-tl-divider">
          <span>← OB Launch (trên)</span>
          <span>CBT / AT Stage (dưới) →</span>
        </div>

        <!-- CBT section -->
        <div class="pls-tl-section cbt">
          <div class="pls-tl-section-label cbt">🧪 CBT / AT STAGE SCHEDULE</div>
          ${cbtRows || '<div class="pls-tl-empty">Không có game CBT nào trong năm này.</div>'}
        </div>
      </div>
    </div>`;
  }

  function _renderObRow(g, year, numCols) {
    const pos = _dateToPos(g.obDate, year);
    if (!pos) return '';  // OB not in this year

    const days    = _daysFromNow(g.obDate);
    const aClass  = _alertClass(days);
    const cdLabel = days !== null
      ? (days === 0 ? 'Hôm nay!' : days < 0 ? `${Math.abs(days)}d trước` : `${days}d`)
      : '';

    // Pill bar: starts at left=pct% of column, spans rest of column + overflows right
    // The pill shows the game name + countdown inside it
    const barContent = cdLabel
      ? `${esc(g.name)}<span class="pls-ob-pill-cd ${aClass}">${cdLabel}</span>`
      : esc(g.name);

    const cells = Array.from({length: numCols}, (_, i) => {
      if (i !== pos.col) return `<div class="pls-tl-cell"></div>`;
      return `<div class="pls-tl-cell">
        <div class="pls-ob-pill ${aClass}"
          style="left:${pos.pct.toFixed(1)}%"
          data-game="${_gameDataAttr(g, 'ob')}"
          title="${esc(g.name)}">${barContent}</div>
      </div>`;
    }).join('');

    return `<div class="pls-tl-row ob-row">${cells}</div>`;
  }

  function _renderCbtRow(g, year, numCols) {
    const fromPos = _dateToPos(g.cbtFrom, year);
    if (!fromPos) return '';

    const cbtFrom = _parseDate(g.cbtFrom);
    const cbtTo   = _parseDate(g.cbtTo) || cbtFrom;

    const days    = _daysFromNow(g.cbtFrom);
    const aClass  = _alertClass(days);

    // Countdown label: days until CBT starts
    const cdLabel = days !== null
      ? (days === 0 ? 'Hôm nay!' : days < 0 ? `${Math.abs(days)}d trước` : `${days}d`)
      : '';

    // Pill content — same pattern as OB pill
    const pillContent = cdLabel
      ? `${esc(g.name)}<span class="pls-cbt-pill-cd ${aClass}">${cdLabel}</span>`
      : esc(g.name);

    // Find start cell for the pill; pill spans visually from fromPos.col (overflow:visible)
    // We render the pill ONCE in the fromPos cell, let it overflow right visually
    // Cells that are purely continuation (after fromPos) get a continuation bar segment
    const cells = Array.from({length: numCols}, (_, i) => {
      const mStart = new Date(year, i, 1);
      const mEnd   = new Date(year, i + 1, 0);

      if (!cbtFrom || cbtFrom > mEnd || cbtTo < mStart) {
        return `<div class="pls-tl-cell"></div>`;
      }

      const daysInMonth = mEnd.getDate();
      const startDay    = cbtFrom > mStart ? cbtFrom.getDate() : 1;
      const endDay      = cbtTo   < mEnd   ? cbtTo.getDate()   : daysInMonth;
      const leftPct     = ((startDay - 1) / daysInMonth) * 100;
      const widthPct    = ((endDay - startDay + 1) / daysInMonth) * 100;
      const isFirst     = (i === fromPos.col);

      if (isFirst) {
        // First cell: pill with name + countdown (overflows right into adjacent cells)
        return `<div class="pls-tl-cell">
          <div class="pls-cbt-pill ${aClass}"
            style="left:${leftPct.toFixed(1)}%"
            data-game="${_gameDataAttr(g, 'cbt')}"
            title="${esc(g.name)}">${pillContent}</div>
        </div>`;
      } else {
        // Continuation cells: faint bar segment (no text, just color fill)
        return `<div class="pls-tl-cell">
          <div class="pls-cbt-cont ${aClass}"
            style="left:${leftPct.toFixed(1)}%;width:${Math.min(widthPct, 100).toFixed(1)}%"></div>
        </div>`;
      }
    }).join('');

    return `<div class="pls-tl-row">${cells}</div>`;
  }

  function _gameDataAttr(g, type) {
    // Use double-quote HTML attribute — escape " as &quot; so getAttribute() returns valid JSON
    const safe = obj => JSON.stringify(obj).replace(/"/g, '&quot;');
    return safe({
      name:     g.name     || '',
      alias:    g.alias    || '',
      faCode:   g.faCode   || '',
      type,
      cbtFrom:  g.cbtFrom  || '',
      cbtTo:    g.cbtTo    || '',
      obDate:   g.obDate   || '',
      markets:  (g.markets || []).join(','),
      status:   g.status   || '',
      owner:    g.owner    || '',
    });
  }

  /* ─── hover dialog (singleton) ────────────────────────────────────────── */
  let _dialogEl   = null;
  let _hideTimer  = null;

  function _ensureDialog() {
    if (_dialogEl) return _dialogEl;
    _dialogEl = document.createElement('div');
    _dialogEl.id = 'pls-hover-dialog';
    _dialogEl.className = 'pls-hover-dialog';
    _dialogEl.innerHTML = `
      <div class="pls-hd-card">
        <div class="pls-hd-top" id="pls-hd-top"></div>
        <div class="pls-hd-body">
          <div class="pls-hd-name" id="pls-hd-name"></div>
          <div class="pls-hd-alias" id="pls-hd-alias"></div>
          <div class="pls-hd-dates">
            <div class="pls-hd-date-row">
              <span class="pls-hd-badge cbt">CBT</span>
              <span class="pls-hd-dval" id="pls-hd-cbt-val"></span>
              <span class="pls-hd-cd"   id="pls-hd-cbt-cd"></span>
            </div>
            <div class="pls-hd-date-row">
              <span class="pls-hd-badge ob">OB</span>
              <span class="pls-hd-dval" id="pls-hd-ob-val"></span>
              <span class="pls-hd-cd"   id="pls-hd-ob-cd"></span>
            </div>
          </div>
          <div class="pls-hd-div"></div>
          <div class="pls-hd-meta">
            <div class="pls-hd-markets" id="pls-hd-markets"></div>
            <div class="pls-hd-status" id="pls-hd-status"></div>
          </div>
          <div class="pls-hd-owner" id="pls-hd-owner"></div>
        </div>
        <div class="pls-hd-arrow" id="pls-hd-arrow"></div>
      </div>`;
    document.body.appendChild(_dialogEl);

    _dialogEl.addEventListener('mouseenter', () => clearTimeout(_hideTimer));
    _dialogEl.addEventListener('mouseleave', _scheduleHide);
    return _dialogEl;
  }

  function _showDialog(el) {
    clearTimeout(_hideTimer);
    const dialog = _ensureDialog();
    const raw = el.getAttribute('data-game');
    if (!raw) return;
    let g;
    try { g = JSON.parse(raw); } catch(_) { return; }

    // Populate content
    document.getElementById('pls-hd-name').textContent  = g.name;
    document.getElementById('pls-hd-alias').textContent = g.alias || g.faCode || '';

    // CBT date
    const cbtVal = document.getElementById('pls-hd-cbt-val');
    const cbtCd  = document.getElementById('pls-hd-cbt-cd');
    if (!g.cbtFrom || g.cbtFrom === '') {
      cbtVal.textContent = '—'; cbtVal.className = 'pls-hd-dval tbu';
      cbtCd.textContent = ''; cbtCd.className = 'pls-hd-cd';
    } else if (g.cbtFrom === 'No CBT') {
      cbtVal.textContent = 'No CBT'; cbtVal.className = 'pls-hd-dval tbu';
      cbtCd.textContent = ''; cbtCd.className = 'pls-hd-cd';
    } else if (g.cbtFrom === 'TBU') {
      cbtVal.textContent = 'TBU'; cbtVal.className = 'pls-hd-dval tbu';
      cbtCd.textContent = ''; cbtCd.className = 'pls-hd-cd';
    } else {
      const range = _fmtDateVN(g.cbtFrom) + (g.cbtTo ? ' → ' + _fmtDateVN(g.cbtTo) : '');
      cbtVal.textContent = range; cbtVal.className = 'pls-hd-dval';
      _setCd(cbtCd, g.cbtFrom);
    }

    // OB date
    const obVal = document.getElementById('pls-hd-ob-val');
    const obCd  = document.getElementById('pls-hd-ob-cd');
    if (!g.obDate || g.obDate === '' || g.obDate === 'TBU') {
      obVal.textContent = g.obDate || '—'; obVal.className = 'pls-hd-dval tbu';
      obCd.textContent = ''; obCd.className = 'pls-hd-cd';
    } else {
      obVal.textContent = _fmtDateVN(g.obDate); obVal.className = 'pls-hd-dval';
      _setCd(obCd, g.obDate);
    }

    // Markets
    const mktsEl = document.getElementById('pls-hd-markets');
    mktsEl.innerHTML = (g.markets || '').split(',').filter(Boolean)
      .map(m => `<span class="pls-hd-mkt">${esc(m.trim())}</span>`).join('');

    // Status
    const statEl = document.getElementById('pls-hd-status');
    statEl.textContent = g.status || '';
    statEl.className = 'pls-hd-status ' + (g.status === 'Released' ? 'rel' : 'on');

    // Owner
    document.getElementById('pls-hd-owner').textContent = g.owner ? '👤 ' + g.owner : '';

    // Top bar color by type + alert
    const days   = g.type === 'ob' ? _daysFromNow(g.obDate) : _daysFromNow(g.cbtFrom);
    const aClass = _alertClass(days);
    const topEl  = document.getElementById('pls-hd-top');
    topEl.className = `pls-hd-top type-${g.type}${aClass ? ' ' + aClass : ''}`;

    // Position dialog
    _positionDialog(dialog, el);
    dialog.style.display = 'block';
    requestAnimationFrame(() => dialog.classList.add('visible'));
  }

  function _setCd(el, iso) {
    const d = _daysFromNow(iso);
    if (d === null) { el.textContent = ''; el.className = 'pls-hd-cd'; return; }
    if (d < 0)  { el.textContent = `${Math.abs(d)}d trước`; el.className = 'pls-hd-cd past'; return; }
    if (d === 0){ el.textContent = 'Hôm nay!';              el.className = 'pls-hd-cd urgent'; return; }
    if (d <= 7) { el.textContent = `${d} ngày nữa`;         el.className = 'pls-hd-cd urgent'; return; }
    if (d <= 14){ el.textContent = `${d} ngày nữa`;         el.className = 'pls-hd-cd warning'; return; }
    el.textContent = `${d} ngày nữa`; el.className = 'pls-hd-cd normal';
  }

  function _positionDialog(dialog, el) {
    const rect   = el.getBoundingClientRect();
    const dW     = 280;
    const margin = 8;
    const vp     = { w: window.innerWidth, h: window.innerHeight };

    let left  = rect.left + rect.width / 2 - 20;
    let top;
    let arrowClass;

    if (rect.bottom + 16 + 220 < vp.h) {
      top = rect.bottom + 10;
      arrowClass = 'up';
    } else {
      top = rect.top - 10 - 220;
      arrowClass = 'down';
    }

    if (left + dW > vp.w - margin) left = vp.w - dW - margin;
    if (left < margin) left = margin;

    dialog.style.left = left + 'px';
    dialog.style.top  = top  + 'px';

    const arrowEl = document.getElementById('pls-hd-arrow');
    if (arrowEl) {
      const arrowLeft = Math.max(12, Math.min(rect.left + rect.width/2 - left - 7, dW - 28));
      arrowEl.className = 'pls-hd-arrow ' + arrowClass;
      arrowEl.style.left = arrowLeft + 'px';
    }
  }

  function _scheduleHide() {
    _hideTimer = setTimeout(() => {
      if (!_dialogEl) return;
      _dialogEl.classList.remove('visible');
      setTimeout(() => {
        if (_dialogEl && !_dialogEl.classList.contains('visible')) {
          _dialogEl.style.display = 'none';
        }
      }, 160);
    }, 100);
  }

  /* ─── event wiring ────────────────────────────────────────────────────── */
  function wireEvents() {
    // Hover on ob-dots, ob-labels, and cbt-bars
    document.querySelectorAll(
      '#pl-stats-content .pls-ob-pill[data-game], ' +
      '#pl-stats-content .pls-cbt-pill[data-game]'
    ).forEach(el => {
        el.addEventListener('mouseenter', function() { _showDialog(this); });
        el.addEventListener('mouseleave', _scheduleHide);
      });

    // Quarter chip clicks
    document.querySelectorAll('.pls-qchip').forEach(chip => {
      chip.addEventListener('click', function() {
        const q = parseInt(this.dataset.q);
        // Deactivate all q-chips and set "Cả năm" state
        document.querySelectorAll('.pls-qchip').forEach(c => c.classList.remove('active'));
        document.querySelectorAll('.pls-mchip').forEach(c => {
          c.classList.remove('active');
          c.style.cssText = '';
        });

        if (q === -1) {
          // "Cả năm" — remove all highlights
          this.classList.add('active');
          _highlightMonths([]);
        } else {
          this.classList.add('active');
          const months = [q*3, q*3+1, q*3+2];
          months.forEach(m => {
            const chip = document.querySelector(`.pls-mchip[data-month="${m}"]`);
            if (chip) chip.classList.add('active');
          });
          _highlightMonths(months);
        }
      });
    });

    // Month chip clicks
    document.querySelectorAll('.pls-mchip').forEach(chip => {
      chip.addEventListener('click', function() {
        // Deactivate "Cả năm" and all q-chips
        document.querySelectorAll('.pls-qchip').forEach(c => c.classList.remove('active'));
        this.classList.toggle('active');
        const active = [...document.querySelectorAll('.pls-mchip.active')]
          .map(c => parseInt(c.dataset.month));
        if (active.length === 0) {
          document.querySelector('.pls-qchip[data-q="-1"]')?.classList.add('active');
          _highlightMonths([]);
        } else {
          _highlightMonths(active);
        }
      });
    });
  }

  function _highlightMonths(activeMonths) {
    // Highlight column headers
    document.querySelectorAll('.pls-month-col').forEach(col => {
      const m = parseInt(col.dataset.month);
      col.classList.toggle('highlighted', activeMonths.length === 0 || activeMonths.includes(m));
      col.classList.toggle('dimmed',      activeMonths.length > 0 && !activeMonths.includes(m));
    });
    // Dim timeline cells in non-active months
    document.querySelectorAll('.pls-tl-row').forEach(row => {
      const cells = row.querySelectorAll('.pls-tl-cell');
      cells.forEach((cell, i) => {
        if (activeMonths.length === 0) {
          cell.classList.remove('dimmed');
        } else {
          cell.classList.toggle('dimmed', !activeMonths.includes(i));
        }
      });
    });
  }

  /* ─── main render ─────────────────────────────────────────────────────── */
  function render(games, year) {
    const container = document.getElementById('pl-stats-content');
    if (!container) return;

    year = year || new Date().getFullYear();

    // Separate OB and CBT game lists (same game can appear in both)
    const obGames  = games.filter(g => _hasOb(g) && _parseDate(g.obDate)?.getFullYear() === year);
    const cbtGames = games.filter(g => _hasCbt(g));

    // Sort: urgent first, then by date
    const sortByDate = (a, b, getDate) => {
      const da = _parseDate(getDate(a));
      const db = _parseDate(getDate(b));
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return da - db;
    };
    obGames.sort((a,b)  => sortByDate(a, b, g => g.obDate));
    cbtGames.sort((a,b) => sortByDate(a, b, g => g.cbtFrom));

    container.innerHTML = `
      ${_renderKPICards(obGames, cbtGames)}
      ${_renderAlertStrip(games)}
      ${_renderFilterRow()}
      ${_renderTimeline(obGames, cbtGames, year)}
    `;

    wireEvents();
  }

  return { render, wireEvents };
})();
