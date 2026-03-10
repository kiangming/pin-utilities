/**
 * pipeline/modules/pipeline.js  v2.0
 * Main panel controller.
 *
 * v2.0 additions (per PRD):
 *  • _dateFrom / _dateTo state
 *  • setDateFilter() — reads date inputs, validates, triggers render
 *  • clearDateFilter() — resets date inputs + re-renders
 *  • _updateClearBtn() — show/hide clear button
 *  • _showDateWarning / _hideDateWarning (FR-07)
 *  • _render() now passes dateFrom/dateTo to renderRelease()
 *  • closeLoginOverlay() — public method for cancel / backdrop click
 */
const PipelinePanel = (() => {
  let _activeTab    = 'release2026';
  let _statusFilter = 'all';
  let _fetching     = false;
  let _dateFrom     = null;   // ISO "YYYY-MM-DD" or null
  let _dateTo       = null;
  let _activeView   = 'detail'; // 'stats' | 'detail'  (v3.0)

  /* ── boot ──────────────────────────────────────────────────────────────── */
  async function boot() {
    // Prefer inline config (works with file://), fallback to fetch (HTTP server)
    let authCfg, appCfg;
    if (window.PIPELINE_CONFIG?.googleAuth?.clientId) {
      authCfg = window.PIPELINE_CONFIG.googleAuth;
      appCfg  = window.PIPELINE_CONFIG.app || {};
    } else {
      try {
        [authCfg, appCfg] = await Promise.all([
          _loadJSON('pipeline/config/google-auth.json'),
          _loadJSON('pipeline/config/app-config.json'),
        ]);
      } catch (_) { authCfg = {}; appCfg = {}; }
    }

    await PipelineAuth.init(authCfg, _onReAuthNeeded);
    SheetsFetcher.init(appCfg, PipelineAuth);
    PipelineDataStore.init();

    const stored = PipelineDataStore.get('sheetUrl');
    const urlEl  = document.getElementById('pl-sheet-url');
    if (urlEl && (appCfg.sheetUrl || stored)) {
      urlEl.value = appCfg.sheetUrl || stored || '';
    }

    _updateAuthBtn();

    if (PipelineDataStore.hasData()) {
      _setFetchedLabel(PipelineDataStore.get('fetchedAt'));
      _render();
    } else {
      _loadDemoData();
    }
  }

  async function _loadJSON(path) {
    try { return await (await fetch(path + '?_=' + Date.now())).json(); }
    catch (_) { return {}; }
  }

  /* ── auth ──────────────────────────────────────────────────────────────── */
  function _onReAuthNeeded() {
    _showLoginOverlay('⚠️ Phiên đăng nhập hết hạn. Vui lòng đăng nhập lại.');
  }

  function _updateAuthBtn() {
    const btn = document.getElementById('pl-auth-btn');
    const lbl = document.getElementById('pl-auth-lbl');
    if (!btn || !lbl) return;
    if (PipelineAuth.isSignedIn()) {
      btn.classList.add('pl-connected');
      lbl.textContent = '● Đã kết nối';
    } else {
      btn.classList.remove('pl-connected');
      lbl.textContent = 'Sign in with Google';
    }
  }

  async function handleSignIn() {
    const errEl     = document.getElementById('pl-login-err');
    const signInBtn = document.getElementById('pl-btn-google-signin');
    if (errEl) errEl.style.display = 'none';
    if (signInBtn) {
      signInBtn.disabled = true;
      signInBtn.textContent = 'Đang đăng nhập…';
    }
    try {
      await PipelineAuth.signIn();
      _hideLoginOverlay();
      _updateAuthBtn();
    } catch (e) {
      if (errEl) { errEl.textContent = e.message; errEl.style.display = 'block'; }
    } finally {
      if (signInBtn) {
        signInBtn.disabled = false;
        signInBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
          <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
        </svg> Sign in with Google`;
      }
    }
  }

  function _showLoginOverlay(msg) {
    const el = document.getElementById('pl-login-overlay');
    if (el) el.style.display = 'flex';
    if (msg) {
      const errEl = document.getElementById('pl-login-err');
      if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
    }
  }

  function _hideLoginOverlay() {
    const el = document.getElementById('pl-login-overlay');
    if (el) el.style.display = 'none';
    const errEl = document.getElementById('pl-login-err');
    if (errEl) errEl.style.display = 'none';
  }

  function closeLoginOverlay() {
    _hideLoginOverlay();
    if (!PipelineDataStore.hasData()) _loadDemoData();
  }

  /* ── fetch ─────────────────────────────────────────────────────────────── */
  async function fetchData() {
    if (_fetching) return;
    const urlEl = document.getElementById('pl-sheet-url');
    const url   = urlEl?.value?.trim();
    if (!url) { _showStatus('error','⚠️ Nhập URL Google Sheet trước khi Fetch.'); return; }
    _fetching = true;
    _hideStatus();
    _setLoading(true,'Đang kết nối…');
    try {
      const data = await SheetsFetcher.fetchAll(url, ({ step, total, tab }) =>
        _setLoading(true, `Đang tải ${tab}… (${step}/${total})`)
      );
      PipelineDataStore.write(data);
      _setFetchedLabel(data.fetchedAt);
      _render();
      const n = (data.release2026?.length||0) + (data.release2025?.length||0);
      _showStatus('ok', `✅ Tải thành công ${n} game — ${_fmtTime(data.fetchedAt)}`);
    } catch (e) {
      if (e.message==='AUTH_EXPIRED' || e.message?.includes('Not signed in')) {
        _showLoginOverlay('⚠️ Cần đăng nhập Google để lấy dữ liệu.');
      } else {
        _showStatus('error','⚠️ Fetch lỗi: ' + e.message);
      }
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
    el.className = 'pl-status-bar ' + (type==='ok' ? 'pl-status-ok' : 'pl-status-err');
    el.textContent = msg;
    el.style.display = 'flex';
    if (type==='ok') setTimeout(()=>{ if(el) el.style.display='none'; }, 5000);
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
    try { return new Date(iso).toLocaleTimeString('vi-VN'); } catch(_) { return ''; }
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
    const ctrlEl   = document.getElementById('pl-controls-wrap'); // may be null

    if (view === 'stats') {
      if (statsEl)  statsEl.classList.add('active');
      if (detailEl) detailEl.classList.remove('active');
    } else {
      if (statsEl)  statsEl.classList.remove('active');
      if (detailEl) detailEl.classList.add('active');
    }
    _render();
  }

  /* ── date range filter (v2.0) ──────────────────────────────────────────── */
  function setDateFilter() {
    const f = document.getElementById('pl-date-from')?.value || null;
    const t = document.getElementById('pl-date-to')?.value   || null;

    // Validation FR-07: both present and invalid order
    if (f && t && f > t) {
      _showDateWarning();
      return;
    }
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
    if (!btn) return;
    btn.style.display = (_dateFrom || _dateTo) ? 'inline-flex' : 'none';
  }

  function _showDateWarning() {
    const el = document.getElementById('pl-date-warn');
    if (el) { el.style.display = 'flex'; }
  }
  function _hideDateWarning() {
    const el = document.getElementById('pl-date-warn');
    if (el) el.style.display = 'none';
  }

  /* ── render ────────────────────────────────────────────────────────────── */
  function _render() {
    // ── Stats view (v3.0) ────────────────────────────────────────────────
    if (_activeView === 'stats') {
      const year = _activeTab.includes('2025') ? 2025 : 2026;
      const data = PipelineDataStore.get(_activeTab) || [];
      if (typeof PipelineStats !== 'undefined') {
        PipelineStats.render(data, year);
      }
      return;
    }

    // ── Detail view (existing logic) ─────────────────────────────────────
    const content = document.getElementById('pl-content');
    if (!content) return;

    let data = PipelineDataStore.get(_activeTab) || [];
    const isClose = _activeTab.startsWith('close');

    if (!isClose) {
      // Populate owner + market dropdowns
      const all = PipelineDataStore.get(_activeTab) || [];
      const owners  = [...new Set(all.map(g=>g.owner).filter(Boolean))].sort();
      const markets = [...new Set(all.flatMap(g=>g.markets||[]).filter(Boolean))].sort();

      const ownerEl = document.getElementById('pl-owner-sel');
      const mktEl   = document.getElementById('pl-mkt-sel');
      const curO = ownerEl?.value || '';
      const curM = mktEl?.value   || '';

      if (ownerEl) ownerEl.innerHTML = `<option value="">All Owners</option>` +
        owners.map(o=>`<option value="${PipelineRenderer.esc(o)}"${o===curO?' selected':''}>${PipelineRenderer.esc(o)}</option>`).join('');
      if (mktEl)   mktEl.innerHTML   = `<option value="">All Markets</option>` +
        markets.map(m=>`<option value="${PipelineRenderer.esc(m)}"${m===curM?' selected':''}>${PipelineRenderer.esc(m)}</option>`).join('');

      // Apply search / owner / market / status filters
      const search = (document.getElementById('pl-search')?.value || '').toLowerCase();
      const ownerF = ownerEl?.value || '';
      const mktF   = mktEl?.value   || '';

      if (search)  data = data.filter(g =>
        g.name.toLowerCase().includes(search) ||
        (g.alias||'').toLowerCase().includes(search) ||
        (g.faCode||'').toLowerCase().includes(search)
      );
      if (ownerF)  data = data.filter(g => g.owner === ownerF);
      if (mktF)    data = data.filter(g => (g.markets||[]).includes(mktF));
      if (_statusFilter !== 'all') data = data.filter(g => g.status === _statusFilter);
    }

    const countEl = document.getElementById('pl-count');
    if (countEl) countEl.textContent = `${data.length} games`;

    // v2.0: pass date range to renderer
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
    const d = (y,m,day) => new Date(y,m-1,day).toISOString().slice(0,10);
    PipelineDataStore.write({
      fetchedAt: new Date().toISOString(),
      sheetUrl: '(demo)',
      release2026: [
        { name:'Võ Lâm Truyền Kỳ EVO', faCode:'A88', alias:'JXE', owner:'GS1', ranking:'A',
          status:'On Process', cbtFrom:d(2026,3,26), cbtTo:d(2026,4,2), cbtPlatform:'TBU',
          obDate:d(2026,6,1), obPlatform:'Mobile (AOS, IOS), PC', markets:['VN'],
          kickstart:null, note:'3 giai đoạn AT. AT3: có payment' },
        { name:'Total Football', faCode:'A86-A90', alias:'TF_VN/TH/ID', owner:'GS2', ranking:'SSS',
          status:'On Process', cbtFrom:d(2026,3,16), cbtTo:d(2026,3,22), cbtPlatform:'IOS, AOS',
          obDate:d(2026,5,26), obPlatform:'AOS, IOS', markets:['VN','TH','ID','SEA'],
          kickstart:null, note:'' },
        { name:'Lineage W', faCode:'C08/JV2', alias:'LW', owner:'NCV', ranking:'S',
          status:'On Process', cbtFrom:'TBU', cbtTo:'TBU', cbtPlatform:'TBU',
          obDate:d(2026,5,27), obPlatform:'Mobile + PC', markets:['TH','VN','ID','PH','SG','MY'],
          kickstart:null, note:'Tentative: May 2026' },
        { name:'CookieRun OvenSmash', faCode:'A24-29', alias:'COS', owner:'GSSEA', ranking:'SS',
          status:'On Process', cbtFrom:null, cbtTo:null, cbtPlatform:null,
          obDate:d(2026,4,23), obPlatform:'Mobile', markets:['VN','TH','PH','ID','SGMY'],
          kickstart:d(2025,1,13), note:'' },
        { name:'Light and Night', faCode:'A78-A83', alias:'LAN', owner:'GSDR', ranking:'A',
          status:'On Process', cbtFrom:d(2026,4,15), cbtTo:d(2026,4,21), cbtPlatform:'Mobile',
          obDate:d(2026,6,16), obPlatform:'Mobile (AOS, IOS)', markets:['VN','TH','SM','PH','ID'],
          kickstart:null, note:'' },
        { name:'Chosun 2M', faCode:'A75', alias:'CS2', owner:'GSTPE', ranking:'',
          status:'On Process', cbtFrom:d(2026,3,5), cbtTo:d(2026,3,9), cbtPlatform:'IOS, AOS',
          obDate:d(2026,4,17), obPlatform:'Mobile, PC', markets:['TW','HK','MC'],
          kickstart:null, note:'' },
        { name:'Tam Quốc Chiến Kỳ', faCode:'C12', alias:'TQCK', owner:'GS2', ranking:'',
          status:'On Process', cbtFrom:null, cbtTo:d(2026,7,6), cbtPlatform:null,
          obDate:d(2026,9,15), obPlatform:'Mobile (AOS, IOS)', markets:['VN'],
          kickstart:d(2026,3,2), note:'AT: 07/2026 | OB: 09/2026' },
        { name:'Ballistic Hero VNG', faCode:'C05', alias:'BH_VN', owner:'GSG', ranking:'C',
          status:'On Process', cbtFrom:'No CBT', cbtTo:null, cbtPlatform:'TBU',
          obDate:d(2026,4,9), obPlatform:'TBU', markets:['VN'],
          kickstart:null, note:'' },
        { name:'彈彈英雄', faCode:'C06/C07', alias:'BH_ID/TW', owner:'GSG', ranking:'B',
          status:'Released', cbtFrom:'No CBT', cbtTo:null, cbtPlatform:'TBU',
          obDate:d(2026,1,12), obPlatform:'IOS, AOS', markets:['ID','TW'],
          kickstart:null, note:'' },
        { name:'Pure 3Q SEA', faCode:'A66', alias:'P3QM', owner:'FGS', ranking:'',
          status:'Released', cbtFrom:'No CBT', cbtTo:null, cbtPlatform:null,
          obDate:d(2026,1,8), obPlatform:'Mobile', markets:['TH','PH','ID'],
          kickstart:null, note:'' },
        { name:'Mayor Tycoon', faCode:'A53', alias:'Mayor Tycoon', owner:'GDO', ranking:'',
          status:'Pending', cbtFrom:'TBU', cbtTo:'TBU', cbtPlatform:'TBU',
          obDate:'TBU', obPlatform:'TBU', markets:['Global'],
          kickstart:null, note:'GDO đang xác định testing' },
        { name:'Lục Địa Băng Hoả', faCode:'A10', alias:'AOIAF_VN', owner:'GSG', ranking:'',
          status:'Terminated', cbtFrom:'TBU', cbtTo:'TBU', cbtPlatform:'TBU',
          obDate:'TBU', obPlatform:'TBU', markets:['VN'],
          kickstart:null, note:'' },
        { name:'Rememento: White Shadow', faCode:'929-933', alias:'NBM_*', owner:'GS9', ranking:'',
          status:'Terminated', cbtFrom:d(2025,6,18), cbtTo:d(2025,6,24), cbtPlatform:'Mobile; PC',
          obDate:'TBU', obPlatform:'Mobile', markets:['TWHKMC','TH','ID','PH'],
          kickstart:null, note:'' },
      ],
      release2025: [
        { name:'Lineage 2 Mobile', faCode:'A22', alias:'L2M_VN', owner:'TSN', ranking:'',
          status:'Released', cbtFrom:d(2025,4,20), cbtTo:null, cbtPlatform:'Mobile; PC',
          obDate:d(2025,5,20), obPlatform:'Mobile; PC', markets:['VN','TH','PH','ID','SGMY'],
          kickstart:null, note:'' },
        { name:'Thiên Long Origin', faCode:'940', alias:'TLHJ', owner:'GS1', ranking:'',
          status:'Released', cbtFrom:d(2025,3,17), cbtTo:d(2025,3,22), cbtPlatform:'PC',
          obDate:d(2025,4,18), obPlatform:'PC', markets:['VN'],
          kickstart:null, note:'Tên cũ: Thiên Long Hoài Niệm' },
        { name:'MU Angel War', faCode:'946', alias:'MUAW', owner:'GS2', ranking:'',
          status:'Released', cbtFrom:'No CBT', cbtTo:null, cbtPlatform:null,
          obDate:d(2025,4,3), obPlatform:'Mobile (AOS, IOS)', markets:['VN'],
          kickstart:null, note:'' },
      ],
      close2026: [
        { faCode:'275', alias:'OMG2_Thai', name:'OMG2 Thai', markets:['TH'],
          productType:'Mobile', status:'Closed', owner:'TSN', closeDate:d(2026,1,13) },
        { faCode:'A11', alias:'AOIAF_Global', name:'Sword of Fire and Ice', markets:['Global'],
          productType:'Mobile', status:'Closed', owner:'GSG', closeDate:d(2026,1,31) },
        { faCode:'928', alias:'NBM_VN', name:'Rememento: White Shadow VN', markets:['VN'],
          productType:'Mobile', status:'Closing', owner:'GS9', closeDate:d(2026,3,10) },
        { faCode:'929', alias:'NBM_TH', name:'Rememento: White Shadow TH', markets:['TH'],
          productType:'Mobile', status:'Closing', owner:'GS9', closeDate:d(2026,3,10) },
      ],
      close2025: [],
    });
    const lbl = document.getElementById('pl-fetched-lbl');
    if (lbl) lbl.textContent = '⚠️ Demo data — kết nối Google Sheet để tải dữ liệu thật';
    _render();
  }

  return {
    boot, handleSignIn, closeLoginOverlay,
    fetchData, switchTab, setStatusFilter, applyFilters,
    setDateFilter, clearDateFilter,
    switchView,
    toggleDetail,
  };
})();
