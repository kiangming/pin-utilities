/**
 * pipeline/pipeline.js  v4.0
 * Main panel controller — backend edition.
 *
 * Thay đổi so với v3.0:
 *  - Xóa PipelineAuth, SheetsFetcher (backend đảm nhận)
 *  - Xóa handleSignIn(), closeLoginOverlay(), _showLoginOverlay()
 *  - fetchData() gọi ApiClient.get('/api/sheets/all?sheetUrl=...')
 *  - boot() đơn giản hơn: không load config JSON, không init auth
 */
const PipelinePanel = (() => {
  let _activeTab    = 'release2026';
  let _statusFilter = 'all';
  let _fetching     = false;
  let _dateFrom     = null;
  let _dateTo       = null;
  let _activeView   = 'detail';

  /* ── boot ──────────────────────────────────────────────────────────────── */
  function boot() {
    PipelineDataStore.init();

    const stored = PipelineDataStore.get('sheetUrl');
    const urlEl  = document.getElementById('pl-sheet-url');
    if (urlEl && stored) urlEl.value = stored;

    if (PipelineDataStore.hasData()) {
      _setFetchedLabel(PipelineDataStore.get('fetchedAt'));
      _render();
    } else {
      _loadDemoData();
    }
  }

  /* ── fetch ─────────────────────────────────────────────────────────────── */
  async function fetchData() {
    if (_fetching) return;
    const urlEl = document.getElementById('pl-sheet-url');
    const url   = urlEl?.value?.trim();
    if (!url) { _showStatus('error', '⚠️ Nhập URL Google Sheet trước khi Fetch.'); return; }

    _fetching = true;
    _hideStatus();
    _setLoading(true, 'Đang tải dữ liệu…');

    try {
      const data = await ApiClient.get(`/api/sheets/all?sheetUrl=${encodeURIComponent(url)}`);
      PipelineDataStore.write(data);
      _setFetchedLabel(data.fetchedAt);
      _render();
      const n = (data.release2026?.length || 0) + (data.release2025?.length || 0);
      _showStatus('ok', `✅ Tải thành công ${n} game — ${_fmtTime(data.fetchedAt)}`);
    } catch (e) {
      _showStatus('error', '⚠️ Fetch lỗi: ' + e.message);
    } finally {
      _fetching = false;
      _setLoading(false);
    }
  }

  function _setLoading(on, msg) {
    const overlay  = document.getElementById('pl-loading-overlay');
    const msgEl    = document.getElementById('pl-loading-msg');
    const fetchBtn = document.getElementById('pl-fetch-btn');
    const urlEl    = document.getElementById('pl-sheet-url');
    if (overlay)  overlay.style.display = on ? 'flex' : 'none';
    if (msgEl && msg) msgEl.textContent = msg;
    if (fetchBtn) fetchBtn.disabled = on;
    if (urlEl)    urlEl.disabled    = on;
  }

  /* ── status bar ────────────────────────────────────────────────────────── */
  function _showStatus(type, msg) {
    const el = document.getElementById('pl-status-bar');
    if (!el) return;
    el.className  = 'pl-status-bar ' + (type === 'ok' ? 'pl-status-ok' : 'pl-status-err');
    el.textContent = msg;
    el.style.display = 'flex';
    if (type === 'ok') setTimeout(() => { if (el) el.style.display = 'none'; }, 5000);
  }

  function _hideStatus() {
    const el = document.getElementById('pl-status-bar');
    if (el) el.style.display = 'none';
  }

  function _setFetchedLabel(iso) {
    const el = document.getElementById('pl-fetched-lbl');
    if (!el) return;
    el.textContent = iso ? 'Cập nhật lúc: ' + new Date(iso).toLocaleString('vi-VN') : '';
  }

  function _fmtTime(iso) {
    try { return new Date(iso).toLocaleTimeString('vi-VN'); } catch (_) { return ''; }
  }

  /* ── tab / status filter ───────────────────────────────────────────────── */
  function switchTab(tab) {
    _activeTab = tab;
    document.querySelectorAll('.pl-tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('pl-tab-' + tab)?.classList.add('active');
    _render();
  }

  function setStatusFilter(val) {
    _statusFilter = val;
    document.querySelectorAll('.pl-fb').forEach(b => b.classList.remove('active'));
    document.getElementById('pl-fb-' + val)?.classList.add('active');
    _render();
  }

  function applyFilters() { _render(); }

  /* ── view switch (v3.0) ────────────────────────────────────────────────── */
  function switchView(view) {
    _activeView = view;
    document.querySelectorAll('.pl-vtab').forEach(b => b.classList.remove('active'));
    document.getElementById('pl-vtab-' + view)?.classList.add('active');

    const statsEl  = document.getElementById('pl-stats-content');
    const detailEl = document.getElementById('pl-detail-content');
    if (view === 'stats') {
      statsEl?.classList.add('active');
      detailEl?.classList.remove('active');
    } else {
      statsEl?.classList.remove('active');
      detailEl?.classList.add('active');
    }
    _render();
  }

  /* ── date range filter (v2.0) ──────────────────────────────────────────── */
  function setDateFilter() {
    const f = document.getElementById('pl-date-from')?.value || null;
    const t = document.getElementById('pl-date-to')?.value   || null;
    if (f && t && f > t) { _showDateWarning(); return; }
    _hideDateWarning();
    _dateFrom = f;
    _dateTo   = t;
    _updateClearBtn();
    _render();
  }

  function clearDateFilter() {
    _dateFrom = null;
    _dateTo   = null;
    const fEl = document.getElementById('pl-date-from');
    const tEl = document.getElementById('pl-date-to');
    if (fEl) fEl.value = '';
    if (tEl) tEl.value = '';
    _hideDateWarning();
    _updateClearBtn();
    _render();
  }

  function _updateClearBtn() {
    const btn = document.getElementById('pl-clear-date');
    if (btn) btn.style.display = (_dateFrom || _dateTo) ? 'inline-flex' : 'none';
  }

  function _showDateWarning() {
    const el = document.getElementById('pl-date-warn');
    if (el) el.style.display = 'flex';
  }

  function _hideDateWarning() {
    const el = document.getElementById('pl-date-warn');
    if (el) el.style.display = 'none';
  }

  /* ── render ────────────────────────────────────────────────────────────── */
  function _render() {
    if (_activeView === 'stats') {
      const year = _activeTab.includes('2025') ? 2025 : 2026;
      const data = PipelineDataStore.get(_activeTab) || [];
      if (typeof PipelineStats !== 'undefined') PipelineStats.render(data, year);
      return;
    }

    const content = document.getElementById('pl-content');
    if (!content) return;

    let data = PipelineDataStore.get(_activeTab) || [];
    const isClose = _activeTab.startsWith('close');

    if (!isClose) {
      const owners  = [...new Set(data.map(g => g.owner).filter(Boolean))].sort();
      const markets = [...new Set(data.flatMap(g => g.markets || []).filter(Boolean))].sort();

      const ownerEl = document.getElementById('pl-owner-sel');
      const mktEl   = document.getElementById('pl-mkt-sel');
      const curO = ownerEl?.value || '';
      const curM = mktEl?.value   || '';

      if (ownerEl) ownerEl.innerHTML = `<option value="">All Owners</option>` +
        owners.map(o => `<option value="${PipelineRenderer.esc(o)}"${o === curO ? ' selected' : ''}>${PipelineRenderer.esc(o)}</option>`).join('');
      if (mktEl) mktEl.innerHTML = `<option value="">All Markets</option>` +
        markets.map(m => `<option value="${PipelineRenderer.esc(m)}"${m === curM ? ' selected' : ''}>${PipelineRenderer.esc(m)}</option>`).join('');

      const search = (document.getElementById('pl-search')?.value || '').toLowerCase();
      const ownerF = ownerEl?.value || '';
      const mktF   = mktEl?.value   || '';

      if (search)            data = data.filter(g => g.name.toLowerCase().includes(search) || (g.alias || '').toLowerCase().includes(search) || (g.faCode || '').toLowerCase().includes(search));
      if (ownerF)            data = data.filter(g => g.owner === ownerF);
      if (mktF)              data = data.filter(g => (g.markets || []).includes(mktF));
      if (_statusFilter !== 'all') data = data.filter(g => g.status === _statusFilter);
    }

    const countEl = document.getElementById('pl-count');
    if (countEl) countEl.textContent = `${data.length} games`;

    content.innerHTML = isClose
      ? PipelineRenderer.renderClose(data)
      : PipelineRenderer.renderRelease(data, _dateFrom, _dateTo);
  }

  /* ── card expand ───────────────────────────────────────────────────────── */
  function toggleDetail(uid, card) {
    const el  = document.getElementById(uid);
    if (!el)  return;
    const was = el.classList.contains('pl-detail-open');
    document.querySelectorAll('.pl-detail.pl-detail-open').forEach(d => {
      d.classList.remove('pl-detail-open');
      d.closest('.pl-card')?.classList.remove('pl-expanded');
    });
    if (!was) {
      el.classList.add('pl-detail-open');
      card.classList.add('pl-expanded');
    }
  }

  /* ── demo data ─────────────────────────────────────────────────────────── */
  function _loadDemoData() {
    const d = (y, m, day) => new Date(y, m - 1, day).toISOString().slice(0, 10);
    PipelineDataStore.write({
      fetchedAt: new Date().toISOString(),
      sheetUrl: '(demo)',
      release2026: [
        { name:'Võ Lâm Truyền Kỳ EVO', faCode:'A88', alias:'JXE', owner:'GS1', ranking:'A',
          status:'On Process', cbtFrom:d(2026,3,26), cbtTo:d(2026,4,2), cbtPlatform:'TBU',
          obDate:d(2026,6,1), obPlatform:'Mobile (AOS, IOS), PC', markets:['VN'], kickstart:null, note:'' },
        { name:'Total Football', faCode:'A86-A90', alias:'TF_VN/TH/ID', owner:'GS2', ranking:'SSS',
          status:'On Process', cbtFrom:d(2026,3,16), cbtTo:d(2026,3,22), cbtPlatform:'IOS, AOS',
          obDate:d(2026,5,26), obPlatform:'AOS, IOS', markets:['VN','TH','ID','SEA'], kickstart:null, note:'' },
        { name:'Lineage W', faCode:'C08/JV2', alias:'LW', owner:'NCV', ranking:'S',
          status:'On Process', cbtFrom:'TBU', cbtTo:'TBU', cbtPlatform:'TBU',
          obDate:d(2026,5,27), obPlatform:'Mobile + PC', markets:['TH','VN','ID','PH','SG','MY'], kickstart:null, note:'' },
        { name:'CookieRun OvenSmash', faCode:'A24-29', alias:'COS', owner:'GSSEA', ranking:'SS',
          status:'On Process', cbtFrom:null, cbtTo:null, cbtPlatform:null,
          obDate:d(2026,4,23), obPlatform:'Mobile', markets:['VN','TH','PH','ID','SGMY'], kickstart:null, note:'' },
        { name:'Light and Night', faCode:'A78-A83', alias:'LAN', owner:'GSDR', ranking:'A',
          status:'On Process', cbtFrom:d(2026,4,15), cbtTo:d(2026,4,21), cbtPlatform:'Mobile',
          obDate:d(2026,6,16), obPlatform:'Mobile (AOS, IOS)', markets:['VN','TH','SM','PH','ID'], kickstart:null, note:'' },
        { name:'Mayor Tycoon', faCode:'A53', alias:'Mayor Tycoon', owner:'GDO', ranking:'',
          status:'Pending', cbtFrom:'TBU', cbtTo:'TBU', cbtPlatform:'TBU',
          obDate:'TBU', obPlatform:'TBU', markets:['Global'], kickstart:null, note:'' },
      ],
      release2025: [
        { name:'Lineage 2 Mobile', faCode:'A22', alias:'L2M_VN', owner:'TSN', ranking:'',
          status:'Released', cbtFrom:d(2025,4,20), cbtTo:null, cbtPlatform:'Mobile; PC',
          obDate:d(2025,5,20), obPlatform:'Mobile; PC', markets:['VN','TH','PH','ID','SGMY'], kickstart:null, note:'' },
      ],
      close2026: [
        { faCode:'275', alias:'OMG2_Thai', name:'OMG2 Thai', markets:['TH'],
          productType:'Mobile', status:'Closed', owner:'TSN', closeDate:d(2026,1,13) },
      ],
      close2025: [],
    });
    const lbl = document.getElementById('pl-fetched-lbl');
    if (lbl) lbl.textContent = '⚠️ Demo data — nhập URL Google Sheet và nhấn Fetch để tải dữ liệu thật';
    _render();
  }

  return {
    boot, fetchData, switchTab, setStatusFilter, applyFilters,
    setDateFilter, clearDateFilter, switchView, toggleDetail,
  };
})();
