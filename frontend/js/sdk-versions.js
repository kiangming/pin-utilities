/**
 * SdkVersionPanel — SDK Version Management module
 * Lazy boot, 2 views: summary & detail
 */
const SdkVersionPanel = (() => {
  let _booted = false;
  let _summaryData = null;
  let _detailData  = null;
  let _activeView  = 'summary';
  let _filter = {
    platform: '', status: '', search: '',
    latestVersions: new Set(),
    stableVersions: new Set(),
  };
  let _sortField = 'adoption';
  let _sortDir   = 'desc';

  const PLATFORM_ICON = { android: '🤖', ios: '🍎', windows: '🖥️' };
  const DONUT_COLORS  = ['#6c63ff', '#22d3ee', '#a78bfa', '#f59e0b', '#34d399', '#f87171'];

  // ── Public API ───────────────────────────────────────────────────────────────

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
      _filter.latestVersions = new Set();
      _filter.stableVersions = new Set();
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

  function setSortField(field) {
    if (_sortField === field) {
      _sortDir = _sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      _sortField = field;
      _sortDir   = field === 'adoption' ? 'desc' : 'asc';
    }
    _renderDetail();
  }

  function toggleVersionFilter(type, ver) {
    const set = type === 'latest' ? _filter.latestVersions : _filter.stableVersions;
    if (set.has(ver)) set.delete(ver); else set.add(ver);
    _renderDetail();
  }

  function toggleVersionAll(type) {
    if (type === 'latest') _filter.latestVersions.clear();
    else _filter.stableVersions.clear();
    _renderDetail();
  }

  // ── Private ──────────────────────────────────────────────────────────────────

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

  // ── Summary rendering ────────────────────────────────────────────────────────

  function _renderSummary() {
    const el = document.getElementById('sdkv-summary-content');
    if (!el) return;
    if (!_summaryData || !_summaryData.kpi || !_summaryData.kpi.total_games) {
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
    const firstPlatform = Object.keys(version_distribution || {})[0] || 'android';
    _switchDistTab(firstPlatform);
  }

  function _kpiRow(kpi) {
    return `
    <div class="sdkv-kpi-row">
      <div class="sdkv-kpi total">
        <div class="sdkv-kpi-value">${kpi.total_games ?? 0}</div>
        <div class="sdkv-kpi-label">Games Tracked</div>
        <div class="sdkv-kpi-sub">Số game đang theo dõi</div>
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

    let deg = 0;
    const segments = versions.map((v, i) => {
      const start = deg;
      const end = deg + (v.pct * 3.6);
      deg = end;
      return `${DONUT_COLORS[i % DONUT_COLORS.length]} ${start}deg ${end}deg`;
    });
    const gradient = `conic-gradient(${segments.join(', ')})`;
    const topVer = versions[0];

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
            <span class="sdkv-donut-center-pct">${topVer ? topVer.pct + '%' : ''}</span>
            <span class="sdkv-donut-center-label">${topVer ? _esc(topVer.version) : ''}</span>
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

  // ── Detail rendering ──────────────────────────────────────────────────────────

  function _getVersionOptions(field) {
    return [...new Set((_detailData?.items || []).map(i => i[field]).filter(Boolean))].sort();
  }

  function _applyFilters(items) {
    const s = _filter.search.toLowerCase();
    return items.filter(i => {
      if (_filter.platform && i.platform !== _filter.platform) return false;
      if (_filter.status   && i.status   !== _filter.status)   return false;
      if (s && !(i.game_id||'').toLowerCase().includes(s) && !(i.product_name||'').toLowerCase().includes(s)) return false;
      if (_filter.latestVersions.size && !_filter.latestVersions.has(i.latest_version)) return false;
      if (_filter.stableVersions.size && !_filter.stableVersions.has(i.stable_version)) return false;
      return true;
    });
  }

  function _groupByGame(items) {
    const map = new Map();
    for (const item of items) {
      const gid = item.game_id;
      if (!map.has(gid)) {
        map.set(gid, { game_id: gid, product_name: item.product_name || '', rows: [] });
      }
      map.get(gid).rows.push(item);
    }
    return [...map.values()];
  }

  function _sortGroups(groups) {
    return [...groups].sort((a, b) => {
      let ka, kb;
      if (_sortField === 'adoption') {
        // sort by min adoption across platforms (worst platform)
        ka = Math.min(...a.rows.map(r => r.latest_version_share_ratio ?? -1));
        kb = Math.min(...b.rows.map(r => r.latest_version_share_ratio ?? -1));
        return _sortDir === 'desc' ? kb - ka : ka - kb;
      }
      if (_sortField === 'game') {
        ka = (a.product_name || a.game_id).toLowerCase();
        kb = (b.product_name || b.game_id).toLowerCase();
      } else if (_sortField === 'latest') {
        ka = (a.rows[0]?.latest_version || '').toLowerCase();
        kb = (b.rows[0]?.latest_version || '').toLowerCase();
      } else if (_sortField === 'stable') {
        ka = (a.rows[0]?.stable_version || '').toLowerCase();
        kb = (b.rows[0]?.stable_version || '').toLowerCase();
      } else { ka = kb = ''; }
      return _sortDir === 'asc' ? ka.localeCompare(kb) : kb.localeCompare(ka);
    });
  }

  function _sortIcon(field) {
    if (_sortField !== field) return '<span class="sdkv-sort-icon">⇅</span>';
    return `<span class="sdkv-sort-icon active">${_sortDir === 'asc' ? '↑' : '↓'}</span>`;
  }

  function _renderVersionChips(allVersions, selectedSet, type) {
    const allActive = selectedSet.size === 0;
    const chips = allVersions.map(v => {
      const active = selectedSet.has(v) ? 'active' : '';
      return `<span class="sdkv-vchip ${active}" onclick="SdkVersionPanel.toggleVersionFilter('${type}', ${JSON.stringify(v)})">${_esc(v)}</span>`;
    }).join('');
    return `<span class="sdkv-vchip ${allActive ? 'active' : ''}" onclick="SdkVersionPanel.toggleVersionAll('${type}')">All</span>${chips}`;
  }

  function _renderGameGroup(group) {
    const header = `
      <tr class="sdkv-group-header">
        <td colspan="5">
          <span class="sdkv-group-name">${_esc(group.product_name || group.game_id)}</span>
          ${group.product_name ? `<span class="sdkv-group-gid">${_esc(group.game_id)}</span>` : ''}
          <span class="sdkv-group-count">${group.rows.length} platform${group.rows.length > 1 ? 's' : ''}</span>
        </td>
      </tr>`;

    // sub-rows: sort platforms by adoption desc within group
    const sortedRows = [...group.rows].sort((a, b) =>
      (b.latest_version_share_ratio ?? -1) - (a.latest_version_share_ratio ?? -1)
    );

    const rows = sortedRows.map(row => {
      const ratio = row.latest_version_share_ratio ?? null;
      const fillClass = row.status === 'critical' ? 'crit' : row.status === 'warn' ? 'warn' : '';
      return `
      <tr class="sdkv-sub-row">
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

    return header + rows;
  }

  function _renderDetail() {
    const el = document.getElementById('sdkv-detail-content');
    if (!el) return;
    if (!_detailData) {
      el.innerHTML = _emptyState('Chưa có dữ liệu.');
      return;
    }

    const allLatest = _getVersionOptions('latest_version');
    const allStable = _getVersionOptions('stable_version');

    const filtered = _applyFilters(_detailData.items || []);
    const groups   = _sortGroups(_groupByGame(filtered));

    const tableRows = groups.map(g => _renderGameGroup(g)).join('');
    const emptyRow  = groups.length === 0
      ? `<tr><td colspan="5" style="text-align:center;padding:32px;color:var(--text3)">Không có kết quả phù hợp</td></tr>`
      : '';

    const latestDate = filtered.length
      ? filtered.reduce((max, i) => (!max || (i.latest_date || '') > max ? i.latest_date : max), '')
      : null;

    el.innerHTML = `
      <div class="sdkv-filters">
        <input class="sdkv-search" id="sdkv-search" type="text"
               placeholder="🔍 Search game / product..."
               value="${_esc(_filter.search)}" oninput="SdkVersionPanel.applySearch()" />
        <select class="sdkv-select" id="sdkv-filter-platform" onchange="SdkVersionPanel.applyFilter()">
          <option value="">Platform: All</option>
          <option value="android" ${_filter.platform==='android' ? 'selected':''}>🤖 Android</option>
          <option value="ios"     ${_filter.platform==='ios'     ? 'selected':''}>🍎 iOS</option>
          <option value="windows" ${_filter.platform==='windows' ? 'selected':''}>🖥️ Windows</option>
        </select>
        <select class="sdkv-select" id="sdkv-filter-status" onchange="SdkVersionPanel.applyFilter()">
          <option value="">Status: All</option>
          <option value="ok"       ${_filter.status==='ok'       ? 'selected':''}>✅ OK (≥80%)</option>
          <option value="warn"     ${_filter.status==='warn'     ? 'selected':''}>⚠️ Warn (50–79%)</option>
          <option value="critical" ${_filter.status==='critical' ? 'selected':''}>🔴 Critical (&lt;50%)</option>
        </select>
      </div>
      ${allLatest.length ? `
      <div class="sdkv-version-filters">
        <span class="sdkv-vf-label">Latest:</span>
        ${_renderVersionChips(allLatest, _filter.latestVersions, 'latest')}
      </div>` : ''}
      ${allStable.length ? `
      <div class="sdkv-version-filters">
        <span class="sdkv-vf-label">Stable:</span>
        ${_renderVersionChips(allStable, _filter.stableVersions, 'stable')}
      </div>` : ''}
      <div class="sdkv-detail-table-wrap">
        <table class="sdkv-detail-table">
          <thead><tr>
            <th class="sdkv-th-sort" onclick="SdkVersionPanel.setSortField('game')">
              Product / Game ${_sortIcon('game')}
            </th>
            <th class="sdkv-th-sort" onclick="SdkVersionPanel.setSortField('latest')">
              Latest Version ${_sortIcon('latest')}
            </th>
            <th class="sdkv-th-sort" onclick="SdkVersionPanel.setSortField('adoption')">
              Adoption Rate ${_sortIcon('adoption')}
            </th>
            <th class="sdkv-th-sort" onclick="SdkVersionPanel.setSortField('stable')">
              Stable Version ${_sortIcon('stable')}
            </th>
            <th>Status</th>
          </tr></thead>
          <tbody>${tableRows}${emptyRow}</tbody>
        </table>
      </div>
      <div class="sdkv-detail-footer">
        <span>${filtered.length} records · ${groups.length} games</span>
        <span>${latestDate ? '📅 Snapshot: ' + _fmtDate(latestDate) : ''}</span>
      </div>`;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  function _statusBadge(status) {
    const map = { ok: '✅ OK', warn: '⚠️ Warn', critical: '🔴 Critical', unknown: '— Unknown' };
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

  return {
    boot, fetchData, switchView,
    applySearch, applyFilter,
    setSortField, toggleVersionFilter, toggleVersionAll,
    _switchDistTab,
  };
})();
