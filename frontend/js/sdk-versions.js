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
  let _sortField      = 'adoption';
  let _sortDir        = 'desc';
  let _detailRendered = false;
  let _dropdownOpen   = null; // 'latest' | 'stable' | null
  let _eventsWired    = false;

  const PLATFORM_ICON  = { android: '🤖', ios: '🍎', windows: '🖥️' };
  const DONUT_COLORS   = ['#6c63ff', '#22d3ee', '#a78bfa', '#f59e0b', '#34d399', '#f87171'];
  const STATUS_BORDER  = { ok: '#22c55e', warn: '#f59e0b', critical: '#ef4444', unknown: 'var(--border2)' };

  // ── Public API ───────────────────────────────────────────────────────────────

  async function boot() {
    _booted = true;
    _showLoading();
    await fetchData();
  }

  async function fetchData() {
    _showLoading();
    _detailRendered = false;
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
    _applyAndRenderTable();
  }

  function applyFilter() {
    _filter.platform = document.getElementById('sdkv-filter-platform')?.value || '';
    _filter.status   = document.getElementById('sdkv-filter-status')?.value || '';
    _applyAndRenderTable();
  }

  function setSortField(field) {
    if (_sortField === field) {
      _sortDir = _sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      _sortField = field;
      _sortDir   = field === 'adoption' ? 'desc' : 'asc';
    }
    _updateSortIcons();
    _applyAndRenderTable();
  }

  function toggleVersionFilter(type, ver) {
    const set = type === 'latest' ? _filter.latestVersions : _filter.stableVersions;
    if (set.has(ver)) set.delete(ver); else set.add(ver);
    _updateDropdownGrid(type);
    _updateDropdownTrigger(type);
    _applyAndRenderTable();
  }

  function toggleVersionAll(type) {
    if (type === 'latest') _filter.latestVersions.clear();
    else _filter.stableVersions.clear();
    _updateDropdownGrid(type);
    _updateDropdownTrigger(type);
    _applyAndRenderTable();
  }

  function toggleDropdown(type) {
    const panel = document.getElementById(`sdkv-vf-${type}-panel`);
    if (!panel) return;
    if (_dropdownOpen === type) {
      panel.style.display = 'none';
      _dropdownOpen = null;
    } else {
      if (_dropdownOpen) {
        const other = document.getElementById(`sdkv-vf-${_dropdownOpen}-panel`);
        if (other) other.style.display = 'none';
      }
      panel.style.display = 'block';
      _dropdownOpen = type;
    }
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
        ${v.is_newest ? '<span class="sdkv-legend-badge sdkv-badge-latest">Latest</span>' : ''}
        ${v.is_latest_dominant ? '<span class="sdkv-legend-badge sdkv-badge-popular">Most Popular</span>' : ''}
        <span class="sdkv-legend-pct">${v.pct}% <span style="color:var(--text3)">(${v.game_count})</span></span>
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

  function _renderDetail() {
    const el = document.getElementById('sdkv-detail-content');
    if (!el) return;
    if (!_detailData) {
      el.innerHTML = _emptyState('Chưa có dữ liệu.');
      _detailRendered = false;
      return;
    }
    if (!_detailRendered) {
      el.innerHTML = _buildDetailShell();
      _wireDetailEvents();
      _detailRendered = true;
    }
    _refreshDropdownGrids();
    _updateDropdownTrigger('latest');
    _updateDropdownTrigger('stable');
    _applyAndRenderTable();
  }

  function _applyAndRenderTable() {
    if (!_detailRendered) return;
    _renderTableBody();
    _updateSortIcons();
  }

  function _buildDetailShell() {
    return `
      <div class="sdkv-filters" id="sdkv-filters">
        <input class="sdkv-search" id="sdkv-search" type="text"
               placeholder="🔍 Search game / product..."
               oninput="SdkVersionPanel.applySearch()" />
        <select class="sdkv-select" id="sdkv-filter-platform" onchange="SdkVersionPanel.applyFilter()">
          <option value="">Platform: All</option>
          <option value="android">🤖 Android</option>
          <option value="ios">🍎 iOS</option>
          <option value="windows">🖥️ Windows</option>
        </select>
        <select class="sdkv-select" id="sdkv-filter-status" onchange="SdkVersionPanel.applyFilter()">
          <option value="">Status: All</option>
          <option value="ok">✅ OK (≥80%)</option>
          <option value="warn">⚠️ Warn (50–79%)</option>
          <option value="critical">🔴 Critical (&lt;50%)</option>
        </select>
        <div class="sdkv-vf-wrap" id="sdkv-vf-latest-wrap">
          <button class="sdkv-vf-trigger" id="sdkv-vf-latest-btn"
                  onclick="SdkVersionPanel.toggleDropdown('latest')">
            Latest: All ▾
          </button>
          <div class="sdkv-vf-panel" id="sdkv-vf-latest-panel">
            <div class="sdkv-vf-panel-header">
              <span class="sdkv-vf-panel-title">Latest Version</span>
              <button class="sdkv-vf-all-btn" onclick="SdkVersionPanel.toggleVersionAll('latest')">✓ All</button>
            </div>
            <div class="sdkv-vf-grid" id="sdkv-vf-latest-grid"></div>
          </div>
        </div>
        <div class="sdkv-vf-wrap" id="sdkv-vf-stable-wrap">
          <button class="sdkv-vf-trigger" id="sdkv-vf-stable-btn"
                  onclick="SdkVersionPanel.toggleDropdown('stable')">
            Stable: All ▾
          </button>
          <div class="sdkv-vf-panel" id="sdkv-vf-stable-panel">
            <div class="sdkv-vf-panel-header">
              <span class="sdkv-vf-panel-title">Stable Version</span>
              <button class="sdkv-vf-all-btn" onclick="SdkVersionPanel.toggleVersionAll('stable')">✓ All</button>
            </div>
            <div class="sdkv-vf-grid" id="sdkv-vf-stable-grid"></div>
          </div>
        </div>
      </div>
      <div class="sdkv-detail-table-wrap">
        <table class="sdkv-detail-table">
          <thead><tr>
            <th class="sdkv-th-sort sdkv-th-game" onclick="SdkVersionPanel.setSortField('game')">
              Product / Game <span id="sdkv-si-game" class="sdkv-sort-icon">⇅</span>
            </th>
            <th>Platform</th>
            <th class="sdkv-th-sort" onclick="SdkVersionPanel.setSortField('latest')">
              Latest <span id="sdkv-si-latest" class="sdkv-sort-icon">⇅</span>
            </th>
            <th class="sdkv-th-sort" onclick="SdkVersionPanel.setSortField('adoption')">
              Adoption <span id="sdkv-si-adoption" class="sdkv-sort-icon active">↓</span>
            </th>
            <th class="sdkv-th-sort" onclick="SdkVersionPanel.setSortField('stable')">
              Stable <span id="sdkv-si-stable" class="sdkv-sort-icon">⇅</span>
            </th>
            <th>Status</th>
          </tr></thead>
          <tbody id="sdkv-detail-tbody"></tbody>
        </table>
      </div>
      <div class="sdkv-detail-footer" id="sdkv-detail-footer"></div>`;
  }

  function _wireDetailEvents() {
    const tbody = document.getElementById('sdkv-detail-tbody');
    if (tbody) {
      tbody.addEventListener('mouseover', e => {
        const row = e.target.closest('tr[data-gid]');
        tbody.querySelectorAll('tr[data-gid]').forEach(r => {
          r.classList.toggle('sdkv-row-hover', row ? r.dataset.gid === row.dataset.gid : false);
        });
      });
      tbody.addEventListener('mouseleave', () => {
        tbody.querySelectorAll('.sdkv-row-hover').forEach(r => r.classList.remove('sdkv-row-hover'));
      });
    }
    if (!_eventsWired) {
      document.addEventListener('click', e => {
        if (!_dropdownOpen) return;
        const wrap = document.getElementById(`sdkv-vf-${_dropdownOpen}-wrap`);
        if (wrap && !wrap.contains(e.target)) {
          const panel = document.getElementById(`sdkv-vf-${_dropdownOpen}-panel`);
          if (panel) panel.style.display = 'none';
          _dropdownOpen = null;
        }
      });
      _eventsWired = true;
    }
  }

  function _refreshDropdownGrids() {
    _updateDropdownGrid('latest');
    _updateDropdownGrid('stable');
  }

  function _updateDropdownGrid(type) {
    const gridEl = document.getElementById(`sdkv-vf-${type}-grid`);
    if (!gridEl) return;
    const field    = type === 'latest' ? 'latest_version' : 'stable_version';
    const versions = _getVersionOptions(field);
    const selected = type === 'latest' ? _filter.latestVersions : _filter.stableVersions;
    gridEl.innerHTML = versions.map(v => {
      const checked = selected.has(v) ? 'checked' : '';
      const active  = selected.has(v) ? 'active' : '';
      return `<label class="sdkv-vf-item ${active}">
        <input type="checkbox" ${checked}
               onchange="SdkVersionPanel.toggleVersionFilter('${type}', ${JSON.stringify(v)})">
        <span>${_esc(v)}</span>
      </label>`;
    }).join('');
  }

  function _updateDropdownTrigger(type) {
    const btn = document.getElementById(`sdkv-vf-${type}-btn`);
    if (!btn) return;
    const selected = type === 'latest' ? _filter.latestVersions : _filter.stableVersions;
    const label    = type === 'latest' ? 'Latest' : 'Stable';
    if (selected.size === 0) {
      btn.textContent = `${label}: All ▾`;
      btn.classList.remove('active');
    } else if (selected.size === 1) {
      btn.textContent = `${label}: ${[...selected][0]} ▾`;
      btn.classList.add('active');
    } else {
      btn.textContent = `${label}: ${selected.size} selected ▾`;
      btn.classList.add('active');
    }
  }

  function _updateSortIcons() {
    ['game', 'latest', 'adoption', 'stable'].forEach(field => {
      const el = document.getElementById(`sdkv-si-${field}`);
      if (!el) return;
      if (_sortField === field) {
        el.textContent = _sortDir === 'asc' ? '↑' : '↓';
        el.classList.add('active');
      } else {
        el.textContent = '⇅';
        el.classList.remove('active');
      }
    });
  }

  function _renderTableBody() {
    const tbody  = document.getElementById('sdkv-detail-tbody');
    const footer = document.getElementById('sdkv-detail-footer');
    if (!tbody) return;

    const filtered = _applyFilters(_detailData.items || []);
    const groups   = _sortGroups(_groupByGame(filtered));

    if (groups.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--text3)">Không có kết quả phù hợp</td></tr>`;
    } else {
      tbody.innerHTML = groups.map(g => _buildMergedRows(g)).join('');
    }

    if (footer) {
      const latestDate = filtered.length
        ? filtered.reduce((max, i) => (!max || (i.latest_date || '') > max ? i.latest_date : max), '')
        : null;
      footer.innerHTML = `
        <span>${filtered.length} records · ${groups.length} games</span>
        <span>${latestDate ? '📅 Snapshot: ' + _fmtDate(latestDate) : ''}</span>`;
    }
  }

  function _buildMergedRows(group) {
    const worstStatus = _worstStatus(group.rows);
    const borderColor = STATUS_BORDER[worstStatus] || 'var(--border2)';
    const sortedRows  = [...group.rows].sort((a, b) =>
      (b.latest_version_share_ratio ?? -1) - (a.latest_version_share_ratio ?? -1)
    );
    const rowCount = sortedRows.length;

    return sortedRows.map((row, i) => {
      const ratio     = row.latest_version_share_ratio ?? null;
      const fillClass = row.status === 'critical' ? 'crit' : row.status === 'warn' ? 'warn' : '';
      const gameCell  = i === 0 ? `
        <td class="sdkv-game-cell" rowspan="${rowCount}"
            style="border-left:3px solid ${borderColor}">
          <div class="sdkv-game-name">${_esc(group.product_name || group.game_id)}</div>
          ${group.product_name ? `<div class="sdkv-game-id-tag">${_esc(group.game_id)}</div>` : ''}
        </td>` : '';

      return `<tr data-gid="${_esc(group.game_id)}">
        ${gameCell}
        <td class="sdkv-platform-td">
          <span class="sdkv-platform-icon">${PLATFORM_ICON[row.platform] || '💻'}</span>
          <span>${_esc(row.platform)}</span>
        </td>
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
  }

  // ── Data helpers ──────────────────────────────────────────────────────────────

  function _worstStatus(rows) {
    const priority = { critical: 3, warn: 2, ok: 1, unknown: 0 };
    return rows.reduce((worst, r) => {
      return (priority[r.status] ?? 0) > (priority[worst] ?? 0) ? r.status : worst;
    }, 'unknown');
  }

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

  // ── UI helpers ────────────────────────────────────────────────────────────────

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
    toggleDropdown,
    _switchDistTab,
  };
})();
