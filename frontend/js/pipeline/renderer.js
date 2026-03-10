/**
 * pipeline/modules/renderer.js  v2.0
 * Pure render functions — no side-effects, no DOM reads.
 *
 * v2.0 changes (per PRD):
 *  • Removed deduplication Set → one game can appear in BOTH CBT and OB groups
 *  • renderRelease(data, dateFrom, dateTo) — date params for range filter
 *  • _hasCbt / _hasOb / _cbtOverlaps / _obInRange helpers (FR-08/09/10)
 *  • When date filter active → only CBT + OB groups rendered (FR-12)
 */
const PipelineRenderer = (() => {

  const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  function fmtDate(d) {
    if (!d || d === 'TBU' || d === 'No CBT') return esc(d) || '—';
    const dt = new Date(d);
    return isNaN(dt) ? esc(d) : dt.toLocaleDateString('vi-VN', { day:'2-digit', month:'short', year:'numeric' });
  }

  function _countdown(iso) {
    if (!iso || iso === 'TBU' || iso === 'No CBT') return null;
    const dt = new Date(iso); if (isNaN(dt)) return null;
    const today = new Date(); today.setHours(0,0,0,0);
    const diff = Math.round((dt - today) / 86400000);
    if (diff < 0)   return { label:`${Math.abs(diff)}d ago`, cls:'pl-cd-past'  };
    if (diff === 0) return { label:'Today!',                  cls:'pl-cd-today' };
    if (diff <= 14) return { label:`${diff}d`,                cls:'pl-cd-soon'  };
    return              { label:`${diff}d`,                   cls:'pl-cd-normal'};
  }

  /* ── date-filter helpers ─────────────────────────────────────────────────── */
  function _hasCbt(g) {
    return !!(g.cbtFrom && g.cbtFrom !== 'No CBT' && g.cbtFrom !== 'TBU');
  }
  function _hasOb(g) {
    return !!(g.obDate && g.obDate !== 'TBU' && g.obDate !== '-');
  }
  function _cbtOverlaps(g, f, t) {
    if (!f && !t) return true;
    const from  = f ? new Date(f) : null;
    const to    = t ? new Date(t) : null;
    const start = new Date(g.cbtFrom);
    const end   = (g.cbtTo && g.cbtTo !== 'TBU') ? new Date(g.cbtTo) : null;
    if (to   && start > to)            return false;
    if (from && end   && end < from)   return false;
    if (from && !end  && start < from) return false;
    return true;
  }
  function _obInRange(g, f, t) {
    if (!f && !t) return true;
    const ob   = new Date(g.obDate);
    const from = f ? new Date(f) : null;
    const to   = t ? new Date(t) : null;
    if (from && ob < from) return false;
    if (to   && ob > to)   return false;
    return true;
  }

  /* ── badge helpers ───────────────────────────────────────────────────────── */
  function _rankBadge(r) {
    if (!r) return '';
    const m = { SSS:'pl-rank-sss', SS:'pl-rank-ss', S:'pl-rank-s',
                A:'pl-rank-a', B:'pl-rank-b', C:'pl-rank-c' };
    return `<span class="pl-rank-badge ${m[r]||'pl-rank-def'}">${r}</span>`;
  }

  function statusBadge(s) {
    const m = { 'Released':'pl-st-released','On Process':'pl-st-on',
      'Terminated':'pl-st-term','Cancelled':'pl-st-term',
      'Pending':'pl-st-pending','Updating':'pl-st-upd',
      'Closed':'pl-st-term','Closing':'pl-st-term' };
    return `<span class="pl-status-badge ${m[s]||'pl-st-on'}">${esc(s||'On Process')}</span>`;
  }

  function _mktPills(markets) {
    if (!markets?.length) return `<span class="pl-tbu">TBU</span>`;
    return `<div class="pl-mkt-pills">${markets.map(m=>`<span class="pl-mkt-pill">${esc(m)}</span>`).join('')}</div>`;
  }

  function _cbtCell(g) {
    if (!g.cbtFrom)             return `<span class="pl-tbu">—</span>`;
    if (g.cbtFrom === 'No CBT') return `<span class="pl-no-cbt">No CBT</span>`;
    if (g.cbtFrom === 'TBU')    return `<div class="pl-date-blk"><div class="pl-date-lbl">CBT</div><div class="pl-date-val pl-tbu">TBU</div></div>`;
    const cd  = _countdown(g.cbtFrom);
    const end = !g.cbtTo ? '' : (g.cbtTo === 'TBU' ? 'TBU' : fmtDate(g.cbtTo));
    return `<div class="pl-date-blk">
      <div class="pl-date-lbl">CBT</div>
      <div class="pl-date-val pl-date-cbt">${fmtDate(g.cbtFrom)}</div>
      ${end ? `<div class="pl-date-rng">→ ${esc(end)}</div>` : ''}
      ${cd  ? `<span class="pl-cd ${cd.cls}">${cd.label}</span>` : ''}
    </div>`;
  }

  function _obCell(g) {
    if (!g.obDate || g.obDate==='-') return `<span class="pl-tbu">—</span>`;
    if (g.obDate === 'TBU')          return `<div class="pl-date-blk"><div class="pl-date-lbl">OB</div><div class="pl-date-val pl-tbu">TBU</div></div>`;
    const cd = _countdown(g.obDate);
    return `<div class="pl-date-blk">
      <div class="pl-date-lbl">OB</div>
      <div class="pl-date-val pl-date-ob">${fmtDate(g.obDate)}</div>
      ${cd ? `<span class="pl-cd ${cd.cls}">${cd.label}</span>` : ''}
    </div>`;
  }

  function _detail(g, uid) {
    const chips = str => {
      if (!str || str === 'TBU') return `<span class="pl-tbu">${esc(str||'—')}</span>`;
      return str.split(/[,;()\n]/).map(s=>s.trim()).filter(s=>s.length>1&&s.length<40)
        .map(s=>`<span class="pl-chip">${esc(s)}</span>`).join('');
    };
    let tl = '';
    if (_hasCbt(g)) {
      tl = `<div class="pl-tl-row">
        <div class="pl-tl-dot pl-tl-cbt"></div>
        <div class="pl-tl-bar"></div>
        <div class="pl-tl-dot pl-tl-ob"></div>
      </div>
      <div class="pl-tl-labs">
        <span>CBT: ${fmtDate(g.cbtFrom)}</span>
        <span>→ ${g.cbtTo ? fmtDate(g.cbtTo) : '?'}</span>
        <span style="color:var(--accent)">OB: ${fmtDate(g.obDate)}</span>
      </div>`;
    } else if (g.cbtFrom === 'No CBT') {
      tl = `<div class="pl-tl-row"><div class="pl-tl-dot pl-tl-ob"></div><div class="pl-tl-bar"></div></div>
            <div class="pl-tl-labs"><span>No CBT → OB: ${fmtDate(g.obDate)}</span></div>`;
    }
    return `<div class="pl-detail" id="${uid}">
      <div class="pl-detail-col">
        <div class="pl-dl">Timeline</div>
        ${tl || `<span class="pl-tbu">TBU</span>`}
        <div class="pl-dl" style="margin-top:10px">CBT Platform</div>
        <div class="pl-chips">${chips(g.cbtPlatform)}</div>
        <div class="pl-dl" style="margin-top:6px">OB Platform</div>
        <div class="pl-chips">${chips(g.obPlatform)}</div>
      </div>
      <div class="pl-detail-col">
        <div class="pl-dl">FA Code</div><div class="pl-dmono">${esc(g.faCode||'—')}</div>
        <div class="pl-dl" style="margin-top:8px">Alias</div><div class="pl-dmono">${esc(g.alias||'—')}</div>
        <div class="pl-dl" style="margin-top:8px">Markets</div>${_mktPills(g.markets)}
        ${g.kickstart?`<div class="pl-dl" style="margin-top:8px">Kick-start</div><div class="pl-dmono">${fmtDate(g.kickstart)}</div>`:''}
      </div>
      <div class="pl-detail-col">
        <div class="pl-dl">Notes</div>
        ${g.note?`<div class="pl-note">${esc(g.note)}</div>`:`<span class="pl-tbu">—</span>`}
      </div>
    </div>`;
  }

  function _card(g, idx) {
    const uid = `pl_d_${idx}_${g.name.replace(/\W/g,'_').slice(0,16)}`;
    return `<div class="pl-card" style="animation-delay:${Math.min(idx*0.03,0.45)}s"
        onclick="PipelinePanel.toggleDetail('${uid}',this)">
      <div class="pl-card-row">
        <div class="pl-name-col">
          <div class="pl-name-row">${_rankBadge(g.ranking)}<div class="pl-gname">${esc(g.name)}</div></div>
          <div class="pl-galias">${esc(g.alias||g.faCode||'')}</div>
          ${g.owner?`<div class="pl-gowner">👤 ${esc(g.owner)}</div>`:''}
        </div>
        <div>${_cbtCell(g)}</div>
        <div>${_obCell(g)}</div>
        <div>${_mktPills(g.markets)}</div>
        <div>${statusBadge(g.status)}</div>
      </div>
      ${_detail(g,uid)}
    </div>`;
  }

  function _secHdr(label, icon, cls, n) {
    return `<div class="pl-sec-hdr">
      <span class="pl-sec-label ${cls}">${icon} ${esc(label)}</span>
      <div class="pl-sec-line"></div>
      <span class="pl-sec-count">${n} product${n!==1?'s':''}</span>
    </div>`;
  }

  /* ── renderRelease v2.0 ───────────────────────────────────────────────────
     dateFrom / dateTo: ISO "YYYY-MM-DD" strings or null                     */
  function renderRelease(data, dateFrom = null, dateTo = null) {
    if (!data?.length) return _empty('No games found','Adjust filters or fetch fresh data.');

    const isDateFiltered = !!(dateFrom || dateTo);

    // v2.0: NO deduplication Set — each group is evaluated independently (FR-02)
    const cbtItems = data.filter(g => _hasCbt(g) && _cbtOverlaps(g, dateFrom, dateTo));
    const obItems  = data.filter(g => _hasOb(g)  && _obInRange(g,  dateFrom, dateTo));

    // Extra groups only visible when date filter is OFF (FR-12)
    const noCbtItems = !isDateFiltered
      ? data.filter(g => g.cbtFrom==='No CBT' && _hasOb(g) && ['On Process','Released'].includes(g.status))
      : [];
    const releasedItems = !isDateFiltered
      ? data.filter(g => !_hasCbt(g) && !_hasOb(g) && g.status==='Released')
      : [];
    const pendingItems = !isDateFiltered
      ? data.filter(g => g.status==='Pending' || (g.obDate==='TBU' && !_hasCbt(g) && g.status==='On Process'))
      : [];
    const termItems = !isDateFiltered
      ? data.filter(g => ['Terminated','Cancelled','Closed'].includes(g.status) && !_hasCbt(g) && !_hasOb(g))
      : [];

    let h = `<div class="pl-col-hdrs">
      <span>Game / Product</span><span>CBT / AT</span>
      <span>OB Date</span><span>Markets</span><span>Status</span>
    </div>`;

    if (isDateFiltered) {
      const from = dateFrom ? new Date(dateFrom).toLocaleDateString('vi-VN') : '…';
      const to   = dateTo   ? new Date(dateTo  ).toLocaleDateString('vi-VN') : '…';
      h += `<div class="pl-date-active-banner">
        <span>📅 Lọc thời gian: <strong>${from}</strong> — <strong>${to}</strong></span>
        <span class="pl-banner-note">Chỉ hiển thị CBT / OB trong khoảng này</span>
      </div>`;
    }

    if (cbtItems.length) {
      h += _secHdr('CBT / AT Stage','🧪','pl-sec-cbt',cbtItems.length);
      h += `<div class="pl-grid">${cbtItems.map((g,i)=>_card(g,i)).join('')}</div>`;
    }
    if (obItems.length) {
      h += _secHdr('OB Launch','🚀','pl-sec-ob',obItems.length);
      h += `<div class="pl-grid">${obItems.map((g,i)=>_card(g,i)).join('')}</div>`;
    }

    if (!isDateFiltered) {
      if (noCbtItems.length) {
        h += _secHdr('No CBT → Straight to OB','⚡','pl-sec-nocbt',noCbtItems.length);
        h += `<div class="pl-grid">${noCbtItems.map((g,i)=>_card(g,i)).join('')}</div>`;
      }
      if (releasedItems.length) {
        h += _secHdr('Released','✅','pl-sec-rel',releasedItems.length);
        h += `<div class="pl-grid">${releasedItems.map((g,i)=>_card(g,i)).join('')}</div>`;
      }
      if (pendingItems.length) {
        h += _secHdr('Pending / TBU','⏳','pl-sec-pend',pendingItems.length);
        h += `<div class="pl-grid">${pendingItems.map((g,i)=>_card(g,i)).join('')}</div>`;
      }
      if (termItems.length) {
        h += _secHdr('Terminated','❌','pl-sec-term',termItems.length);
        h += `<div class="pl-grid">${termItems.map((g,i)=>_card(g,i)).join('')}</div>`;
      }
    }

    if (isDateFiltered && !cbtItems.length && !obItems.length) {
      h += _empty(
        'Không có sản phẩm trong khoảng thời gian này',
        'Thử điều chỉnh date range hoặc nhấn ✕ Clear.'
      );
    }

    return h;
  }

  function renderClose(data) {
    if (!data?.length) return _empty('No closed games found','');
    const rows = data.map(g=>`<tr class="pl-tr-close">
      <td class="pl-td-name">${esc(g.name)}</td>
      <td class="pl-td-mono">${esc(g.faCode||'')}</td>
      <td class="pl-td-mono pl-dim">${esc(g.alias||'')}</td>
      <td>${_mktPills(g.markets)}</td>
      <td class="pl-dim">${esc(g.productType||'')}</td>
      <td>${statusBadge(g.status)}</td>
      <td class="pl-dim">${esc(g.owner||'')}</td>
      <td class="pl-td-mono">${g.closeDate?fmtDate(g.closeDate):'—'}</td>
    </tr>`).join('');
    return `<div class="pl-tbl-wrap"><table class="pl-close-tbl">
      <thead><tr class="pl-thead">
        <th>Product</th><th>FA Code</th><th>Alias</th>
        <th>Market</th><th>Type</th><th>Status</th>
        <th>Owner</th><th>Close Date</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  }

  function _empty(t,s) {
    return `<div class="pl-empty">
      <div class="pl-empty-icon">🔍</div>
      <div class="pl-empty-t">${esc(t)}</div>
      <div class="pl-empty-s">${esc(s)}</div>
    </div>`;
  }

  return { renderRelease, renderClose, statusBadge, esc, fmtDate };
})();
