/**
 * SdkVersionPanel — SDK Version Management module
 * Lazy boot, 2 views: summary & detail
 */
const SdkVersionPanel = (() => {
  let _booted = false;
  let _summaryData = null;
  let _detailData = null;
  let _activeView = 'summary';
  let _filter = { platform: '', status: '', search: '' };

  const PLATFORM_ICON = { android: '🤖', ios: '🍎', windows: '🖥️' };
  const DONUT_COLORS = ['#6c63ff', '#22d3ee', '#a78bfa', '#f59e0b', '#34d399', '#f87171'];

  // ── Public API ──────────────────────────────────────────────────────────────

  async function boot() {
    _booted = true;
    _showLoading();
    await fetchData();
  }

  async function fetchData() {
    _showLoading();
    try {
      const [summaryRes, detailRes] = await Promise.all([
        ApiClient.get('/api/sdk-versions/summary'),
        ApiClient.get('/api/sdk-versions/detail'),
      ]);
      _summaryData = summaryRes;
      _detailData  = detailRes;
      _render();
    } catch (e) {
      _showError(e.message);
    }
  }

  function switchView(view) {
    _activeView = view;
    document.getElementById('sdkv-vtab-summary').classList.toggle('active', view === 'summary');
    document.getElementById('sdkv-vtab-detail').classList.toggle('active', view === 'detail');
    document.getElementById('sdkv-summary-content').style.display = view === 'summary' ? '' : 'none';
    document.getElementById('sdkv-detail-content').style.display  = view === 'detail'  ? '' : 'none';
  }

  function applySearch() {
    _filter.search = document.getElementById('sdkv-search')?.value?.trim() || '';
    _renderDetail();
  }

  function applyFilter() {
    _filter.platform = document.getElementById('sdkv-filter-platform')?.value || '';
    _filter.status   = document.getElementById('sdkv-filter-status')?.value || '';
    _filter.search   = document.getElementById('sdkv-search')?.value?.trim() || '';
    _renderDetail();
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  function _render() {
    _renderSummary();
    _renderDetail();
    _updateSyncTime();
  }

  function _showLoading() {
    const s = document.getElementById('sdkv-summary-content');
    if (s) s.innerHTML = '<div class="sdkv-loading">⏳ Đang tải dữ liệu...</div>';
  }

  function _showError(msg) {
    const s = document.getElementById('sdkv-summary-content');
    if (s) s.innerHTML = `<div class="sdkv-empty"><div class="sdkv-empty-icon">⚠️</div><div class="sdkv-empty-text">Lỗi: ${_esc(msg)}</div></div>`;
  }

  function _updateSyncTime() {
    const el = document.getElementById('sdkv-sync-time');
    if (!el) return;
    const ts = _summaryData?.kpi?.last_synced;
    el.textContent = ts ? '🕐 Synced: ' + _fmtDatetime(ts) : '';
  }

  // ── Summary rendering ───────────────────────────────────────────────────────

  function _renderSummary() {
    const el = document.getElementById('sdkv-summary-content');
    if (!el) return;
    if (!_summaryData || !_summaryData.kpi || !_summaryData.kpi.total_records) {
      el.innerHTML = _emptyState('Chưa có dữ liệu. Nhấn Refresh hoặc chạy sync script.');
      return;
    }
    const { kpi, version_distribution, platform_usage, mismatch_games } = _summaryData;
    el.innerHTML = `
      ${_kpiRow(kpi)}
      <div class="sdkv-charts-row">
        ${_versionDistCard(version_distribution)}
        ${_platformUsageCard(platform_usage)}
      </div>
      ${mismatch_games?.length ? _mismatchCard(mismatch_games) : ''}
    `;
    // Init donut với platform đầu tiên có data
    const firstPlatform = Object.keys(version_distribution || {})[0] || 'android';
    _switchDistTab(firstPlatform);
  }

  function _kpiRow(kpi) {
    return `
    <div class="sdkv-kpi-row">
      <div class="sdkv-kpi total">
        <div class="sdkv-kpi-value">${kpi.total_records ?? 0}</div>
        <div class="sdkv-kpi-label">Games Tracked</div>
        <div class="sdkv-kpi-sub">Tổng records trong DB</div>
      </div>
      <div class="sdkv-kpi updated">
        <div class="sdkv-kpi-value">${kpi.fully_updated ?? 0}</div>
        <div class="sdkv-kpi-label">Fully Updated</div>
        <div class="sdkv-kpi-sub">Adoption rate = 100%</div>
      </div>
      <div class="sdkv-kpi warn">
        <div class="sdkv-kpi-value">${kpi.warn_count ?? 0}</div>
        <div class="sdkv-kpi-label">Need Attention</div>
        <div class="sdkv-kpi-sub">Adoption rate &lt; 80%</div>
      </div>
      <div class="sdkv-kpi crit">
        <div class="sdkv-kpi-value">${kpi.critical_count ?? 0}</div>
        <div class="sdkv-kpi-label">Critical</div>
        <div class="sdkv-kpi-sub">Adoption rate &lt; 50%</div>
      </div>
    </div>`;
  }

  function _versionDistCard(distribution) {
    const platforms = Object.keys(distribution || {});
    const tabs = platforms.map(p =>
      `<button class="sdkv-dist-tab" data-p="${_esc(p)}" onclick="SdkVersionPanel._switchDistTab('${_esc(p)}')">${PLATFORM_ICON[p] || '💻'} ${p}</button>`
    ).join('');
    return `
    <div class="sdkv-card">
      <div class="sdkv-card-title">Version Distribution</div>
      <div class="sdkv-dist-tabs" id="sdkv-dist-tabs">${tabs}</div>
      <div id="sdkv-dist-body"></div>
    </div>`;
  }

  function _switchDistTab(platform) {
    // Update active tab
    document.querySelectorAll('.sdkv-dist-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.p === platform);
    });
    const distribution = _summaryData?.version_distribution || {};
    const versions = distribution[platform] || [];
    const body = document.getElementById('sdkv-dist-body');
    if (!body) return;

    if (!versions.length) {
      body.innerHTML = '<div class="sdkv-empty" style="height:120px">Không có dữ liệu</div>';
      return;
    }

    // Build conic-gradient segments
    let deg = 0;
    const segments = versions.map((v, i) => {
      const start = deg;
      const end = deg + (v.pct * 3.6);
      deg = end;
      return `${DONUT_COLORS[i % DONUT_COLORS.length]} ${start}deg ${end}deg`;
    });
    const gradient = `conic-gradient(${segments.join(', ')})`;
    const topVer = versions[0];
    const centerPct = topVer ? topVer.pct + '%' : '';
    const centerLabel = topVer ? _esc(topVer.version) : '';

    const legend = versions.map((v, i) => `
      <div class="sdkv-legend-item">
        <div class="sdkv-legend-dot" style="background:${DONUT_COLORS[i % DONUT_COLORS.length]}"></div>
        <span class="sdkv-legend-ver">${_esc(v.version)}</span>
        ${v.is_latest_dominant ? '<span class="sdkv-legend-badge">latest</span>' : ''}
        <span class="sdkv-legend-pct">${v.pct}% <span style="color:var(--text3);font-size:10px">(${v.game_count})</span></span>
      </div>`).join('');

    body.innerHTML = `
      <div class="sdkv-donut-wrap">
        <div class="sdkv-donut-container">
          <div class="sdkv-donut-ring" style="background:${gradient}"></div>
          <div class="sdkv-donut-hole">
            <span class="sdkv-donut-center-pct">${centerPct}</span>
            <span class="sdkv-donut-center-label">${centerLabel}</span>
          </div>
        </div>
        <div class="sdkv-dist-legend">${legend}</div>
      </div>`;
  }

  function _platformUsageCard(platformUsage) {
    if (!platformUsage?.length) {
      return `<div class="sdkv-card"><div class="sdkv-card-title">Platform Usage</div>${_emptyState('No data')}</div>`;
    }
    const rows = platformUsage.map(p => `
      <div class="sdkv-platform-row">
        <div class="sdkv-platform-meta">
          <span class="sdkv-platform-name">${PLATFORM_ICON[p.platform] || '💻'} ${p.platform}</span>
          <span class="sdkv-platform-rec">${_fmtNum(p.total_records)} records</span>
          <span class="sdkv-platform-pct">${p.pct}%</span>
        </div>
        <div class="sdkv-bar-track">
          <div class="sdkv-bar-fill" style="width:${p.pct}%"></div>
        </div>
      </div>`).join('');
    const total = platformUsage.reduce((s, p) => s + p.total_records, 0);
    return `
    <div class="sdkv-card">
      <div class="sdkv-card-title">Platform Usage</div>
      <div class="sdkv-platform-list">${rows}</div>
      <div style="margin-top:14px;font-size:11px;color:var(--text3)">
        Tổng: ${_fmtNum(total)} login records · ${platformUsage.reduce((s,p)=>s+p.game_count,0)} games
      </div>
    </div>`;
  }

  function _mismatchCard(mismatches) {
    const rows = mismatches.map(m => {
      const gap = (m.stable_version_share_ratio ?? 0) - (m.latest_version_share_ratio ?? 0);
      return `<tr>
        <td class="game-id">${_esc(m.game_id)}</td>
        <td>${PLATFORM_ICON[m.platform] || ''} ${_esc(m.platform)}</td>
        <td class="sdkv-version-tag">${_esc(m.latest_version)}</td>
        <td class="sdkv-version-tag">${_esc(m.stable_version)}</td>
        <td>${m.latest_version_share_ratio ?? '—'}%</td>
        <td>${m.stable_version_share_ratio ?? '—'}%</td>
        <td><span class="sdkv-gap-badge">▼${gap}%</span></td>
      </tr>`;
    }).join('');
    return `
    <div class="sdkv-card sdkv-mismatch-card">
      <div class="sdkv-card-title">⚡ Latest ≠ Stable <span>${mismatches.length} games</span></div>
      <div style="overflow-x:auto">
        <table class="sdkv-table">
          <thead><tr>
            <th>Game ID</th><th>Platform</th><th>Latest</th><th>Stable</th>
            <th>Latest %</th><th>Stable %</th><th>Gap</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
  }

  // ── Detail rendering ─────────────────────────────────────────────────────────

  function _renderDetail() {
    const el = document.getElementById('sdkv-detail-content');
    if (!el) return;
    if (!_detailData) {
      el.innerHTML = _emptyState('Chưa có dữ liệu.');
      return;
    }

    // Client-side filter (nhanh hơn gọi API lại)
    let items = _detailData.items || [];
    if (_filter.platform) items = items.filter(i => i.platform === _filter.platform);
    if (_filter.status)   items = items.filter(i => i.status === _filter.status);
    if (_filter.search)   items = items.filter(i => (i.game_id || '').toLowerCase().includes(_filter.search.toLowerCase()));

    const latestDate = items.length
      ? items.reduce((max, i) => (!max || (i.latest_date || '') > max ? i.latest_date : max), '')
      : null;

    const rows = items.map(row => {
      const ratio = row.latest_version_share_ratio ?? null;
      const fillClass = row.status === 'crit' ? 'crit' : row.status === 'warn' ? 'warn' : '';
      return `<tr>
        <td class="game-id">${_esc(row.game_id)}</td>
        <td><span class="sdkv-platform-icon">${PLATFORM_ICON[row.platform] || '💻'}</span> ${_esc(row.platform)}</td>
        <td class="sdkv-version-tag">${_esc(row.latest_version || '—')}</td>
        <td class="sdkv-adoption-cell">
          <div class="sdkv-adoption-wrap">
            <div class="sdkv-adoption-bar">
              <div class="sdkv-adoption-fill ${fillClass}" style="width:${ratio ?? 0}%"></div>
            </div>
            <span class="sdkv-adoption-pct">${ratio !== null ? ratio + '%' : '—'}</span>
          </div>
        </td>
        <td class="sdkv-version-tag">
          ${_esc(row.stable_version || '—')}
          ${row.version_mismatch ? '<span class="sdkv-mismatch-icon" title="Latest ≠ Stable">⚡</span>' : ''}
        </td>
        <td>${_statusBadge(row.status)}</td>
      </tr>`;
    }).join('');

    const emptyRow = items.length === 0
      ? `<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--text3)">Không có kết quả phù hợp</td></tr>`
      : '';

    el.innerHTML = `
      <div class="sdkv-filters">
        <input  class="sdkv-search"  id="sdkv-search" type="text" placeholder="🔍 Search game_id..."
                value="${_esc(_filter.search)}" oninput="SdkVersionPanel.applySearch()" />
        <select class="sdkv-select" id="sdkv-filter-platform" onchange="SdkVersionPanel.applyFilter()">
          <option value="">Platform: All</option>
          <option value="android"  ${_filter.platform==='android'  ? 'selected':''}>🤖 Android</option>
          <option value="ios"      ${_filter.platform==='ios'      ? 'selected':''}>🍎 iOS</option>
          <option value="windows"  ${_filter.platform==='windows'  ? 'selected':''}>🖥️ Windows</option>
        </select>
        <select class="sdkv-select" id="sdkv-filter-status" onchange="SdkVersionPanel.applyFilter()">
          <option value="">Status: All</option>
          <option value="ok"       ${_filter.status==='ok'       ? 'selected':''}>✅ OK (≥80%)</option>
          <option value="warn"     ${_filter.status==='warn'     ? 'selected':''}>⚠️ Warn (50–79%)</option>
          <option value="critical" ${_filter.status==='critical' ? 'selected':''}>🔴 Critical (&lt;50%)</option>
        </select>
      </div>
      <div class="sdkv-detail-table-wrap">
        <table class="sdkv-detail-table">
          <thead><tr>
            <th>Game ID</th>
            <th>Platform</th>
            <th>Latest Version</th>
            <th>Adoption Rate</th>
            <th>Stable Version</th>
            <th>Status</th>
          </tr></thead>
          <tbody>${rows}${emptyRow}</tbody>
        </table>
      </div>
      <div class="sdkv-detail-footer">
        <span>${items.length} records</span>
        <span>${latestDate ? '📅 Snapshot: ' + _fmtDate(latestDate) : ''}</span>
      </div>`;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function _statusBadge(status) {
    const map = {
      ok:       '✅ OK',
      warn:     '⚠️ Warn',
      critical: '🔴 Critical',
      unknown:  '— Unknown',
    };
    return `<span class="sdkv-status ${status || 'unknown'}">${map[status] || '—'}</span>`;
  }

  function _emptyState(msg) {
    return `<div class="sdkv-empty"><div class="sdkv-empty-icon">📦</div><div class="sdkv-empty-text">${_esc(msg)}</div></div>`;
  }

  function _esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function _fmtNum(n) {
    if (n == null) return '—';
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
  }

  function _fmtDate(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleDateString('vi-VN'); } catch { return iso; }
  }

  function _fmtDatetime(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      return d.toLocaleDateString('vi-VN') + ' ' + d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    } catch { return iso; }
  }

  // ── Exposed internals (called from inline HTML) ──────────────────────────────
  return {
    _booted,
    boot,
    fetchData,
    switchView,
    applySearch,
    applyFilter,
    _switchDistTab,
  };
})();
