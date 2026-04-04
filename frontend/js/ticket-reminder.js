/**
 * TicketReminderPanel — IIFE module
 * Lazy boot: chỉ init khi user click nav lần đầu.
 * Pattern giống SdkVersionPanel (AX-18/19 — không re-render shell khi filter thay đổi).
 */
const TicketReminderPanel = (() => {
  let _booted = false;
  let _pollTimer = null;
  let _sentTicketIds = new Set();   // session-scoped, reset khi fetch mới
  let _sendMode = 'all';            // 'all' | 'select'
  let _remindList = [];             // tickets cần nhắc (need_remind=true)
  let _allTickets = [];             // tất cả tickets từ fetch
  let _services = [];               // cached services list
  let _selectedServiceIds = new Set();
  let _statusTags = [];
  let _pickerOpen = false;
  let _configTabsLoaded = {};       // { webhooks: true, ... }
  let _debugMode = localStorage.getItem('tkrDebugMode') === 'true';

  // ── Public API ─────────────────────────────────────────────────────────────

  function boot() {
    if (_booted) return;
    _booted = true;
    _loadServices();
    _renderFetchView();
  }

  function toggleDebugMode() {
    _debugMode = !_debugMode;
    localStorage.setItem('tkrDebugMode', _debugMode);
    const btn = document.getElementById('tkr-debug-toggle');
    if (btn) {
      btn.classList.toggle('active', _debugMode);
      btn.title = _debugMode ? 'Debug ON — click để tắt' : 'Debug OFF — click để bật';
    }
    _showToast(_debugMode ? '🐛 Debug mode ON' : 'Debug mode OFF', 'info');
  }

  function closeDebugDialog() {
    const el = document.getElementById('tkr-debug-dialog');
    if (el) el.remove();
  }

  function _showDebugDialog(debugRequests) {
    closeDebugDialog();
    if (!debugRequests || !debugRequests.length) return;
    const d = debugRequests[0];
    const lines = [
      '── URL ─────────────────────────────────────',
      d.url || '(unknown)',
      '',
      '── Request Headers ─────────────────────────',
      JSON.stringify(d.request_headers || {}, null, 2),
      '',
      '── Signature Params (sau ksort) ─────────────',
      JSON.stringify(d.hash_data || {}, null, 2),
      '',
      '── Steps ────────────────────────────────────',
      ...(d.steps || []).map(s =>
        s.appended
          ? `  [${s.key}] = ${JSON.stringify(s.raw)}${s.note ? '\n    note: ' + s.note : ''}\n    append → "${s.appended}"`
          : `  [${s.key}] = ${JSON.stringify(s.raw)} → ${s.action}`
      ),
      '',
      '── Hash string trước sha1 ───────────────────',
      d.hash_string_before_sha1 || '',
      '',
      '── Signature ────────────────────────────────',
      d.signature || '',
    ].join('\n');

    const overlay = document.createElement('div');
    overlay.id = 'tkr-debug-dialog';
    overlay.className = 'tkr-debug-overlay';
    overlay.innerHTML = `
      <div class="tkr-debug-dialog">
        <div class="tkr-debug-header">
          <span>🐛 Debug — Signature Trace (Page 1)</span>
          <button class="tkr-debug-close" onclick="TicketReminderPanel.closeDebugDialog()">✕</button>
        </div>
        <pre class="tkr-debug-body">${_esc(lines)}</pre>
      </div>
    `;
    overlay.addEventListener('click', e => { if (e.target === overlay) closeDebugDialog(); });
    document.body.appendChild(overlay);
  }

  function switchConfigTab(tab) {
    _activeConfigTab = tab;
    document.querySelectorAll('.tkr-config-tab-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    document.querySelectorAll('.tkr-tab-content').forEach(c => {
      c.style.display = c.dataset.tab === tab ? 'block' : 'none';
    });
    if (!_configTabsLoaded[tab]) {
      _configTabsLoaded[tab] = true;
      _loadConfigTab(tab);
    }
  }

  function applyFetchFilter() {
    const dueDays = parseInt(document.getElementById('tkr-due-days').value) || 5;
    const assignee = (document.getElementById('tkr-assignee').value || '').trim();
    const createdFrom = document.getElementById('tkr-date-from').value || '';
    const createdTo = document.getElementById('tkr-date-to').value || '';
    const serviceIds = [..._selectedServiceIds];
    const statuses = [..._statusTags];

    _sentTicketIds = new Set();
    _allTickets = [];
    _remindList = [];

    _showFetchProgress('Đang khởi tạo...');
    const fetchBtn = document.getElementById('tkr-fetch-btn');
    if (fetchBtn) fetchBtn.disabled = true;

    ApiClient.post('/api/remind/tickets/fetch', {
      service_ids: serviceIds.map(Number),
      statuses,
      due_days_threshold: dueDays,
      assignee,
      created_at_from: createdFrom,
      created_at_to: createdTo,
    }).then(res => {
      _startPolling(res.job_id);
    }).catch(err => {
      _showFetchError('Lỗi kết nối: ' + (err.message || err));
      if (fetchBtn) fetchBtn.disabled = false;
    });
  }

  function resetFilter() {
    document.getElementById('tkr-due-days').value = '5';
    document.getElementById('tkr-assignee').value = '';
    document.getElementById('tkr-date-from').value = '';
    document.getElementById('tkr-date-to').value = '';
    _selectedServiceIds = new Set();
    _statusTags = [];
    _renderServiceChips();
    _renderStatusTags();
    _showFetchEmpty();
  }

  function buildRemindList() {
    _currentView = 'remind';
    _remindList = _allTickets.filter(t => t.need_remind && !_sentTicketIds.has(t.id));
    _renderRemindView();
  }

  function backToFetch() {
    _currentView = 'fetch';
    const resultArea = document.getElementById('tkr-result-area');
    if (resultArea) {
      _renderTicketTable(resultArea);
    }
  }

  function setSendMode(mode) {
    _sendMode = mode;
    document.querySelectorAll('.tkr-mode-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    const chkCol = document.getElementById('tkr-chk-col');
    const headerChk = document.getElementById('tkr-select-all');
    if (mode === 'all') {
      if (chkCol) chkCol.style.display = 'none';
      if (headerChk) headerChk.style.display = 'none';
      _updateSendBtn();
    } else {
      if (chkCol) chkCol.style.display = '';
      if (headerChk) headerChk.style.display = '';
      _updateSendBtn();
    }
  }

  function toggleSelectAll(chk) {
    document.querySelectorAll('.tkr-row-chk').forEach(c => {
      if (!c.disabled) c.checked = chk.checked;
    });
    _updateSendBtn();
  }

  function onRowCheck() {
    _updateSendBtn();
  }

  function sendRemind() {
    const tickets = _getTicketsToSend();
    if (!tickets.length) return;

    const sendBtn = document.getElementById('tkr-send-btn');
    if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = '⟳ Đang gửi...'; }

    const log = document.getElementById('tkr-send-log');
    if (log) { log.innerHTML = ''; log.classList.add('visible'); }

    ApiClient.post('/api/remind/send', { tickets }).then(res => {
      res.results.forEach(r => {
        _sentTicketIds.add(r.ticket_id);
        _appendLog(r);
        _markRowSent(r.ticket_id, r.status);
      });
      _appendLogSummary(res.sent, res.failed, res.skipped);
      if (sendBtn) {
        sendBtn.disabled = false;
        sendBtn.textContent = `✓ Đã gửi xong (${res.sent}/${res.sent + res.failed + res.skipped})`;
      }
    }).catch(err => {
      if (log) _appendLogLine(log, '❌ Lỗi: ' + (err.message || err), 'err');
      if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = '🔔 Gửi Remind'; }
    });
  }

  function syncProducts() {
    const btn = document.getElementById('tkr-sync-products-btn');
    if (btn) btn.disabled = true;
    ApiClient.post('/api/remind/products/sync', {}).then(res => {
      _showToast(`Đã sync ${res.synced} products`, 'info');
      if (_debugMode && res.debug_requests) _showDebugDialog(res.debug_requests);
    }).catch(err => {
      _showToast('Lỗi sync products: ' + (err.message || err), 'err');
    }).finally(() => {
      if (btn) btn.disabled = false;
    });
  }

  function syncServices() {
    const btn = document.getElementById('tkr-sync-services-btn');
    if (btn) btn.disabled = true;
    ApiClient.post('/api/remind/services/sync', {}).then(res => {
      _showToast(`Đã sync ${res.synced} services`, 'info');
      if (_debugMode && res.debug_requests) _showDebugDialog(res.debug_requests);
      _loadServices();
      _loadConfigTab('services');
    }).catch(err => {
      _showToast('Lỗi sync services: ' + (err.message || err), 'err');
    }).finally(() => {
      if (btn) btn.disabled = false;
    });
  }

  function togglePickerPanel() {
    const panel = document.getElementById('tkr-svc-panel');
    if (!panel) return;
    _pickerOpen = !_pickerOpen;
    panel.classList.toggle('open', _pickerOpen);
    if (_pickerOpen) {
      const search = document.getElementById('tkr-svc-search');
      if (search) { search.value = ''; _filterPickerItems(''); search.focus(); }
    }
  }

  function filterPickerItems(val) {
    _filterPickerItems(val);
  }

  function toggleService(id, _name, checked) {
    if (checked) {
      _selectedServiceIds.add(id);
    } else {
      _selectedServiceIds.delete(id);
    }
    _renderServiceChips();
  }

  function removeServiceChip(id) {
    _selectedServiceIds.delete(id);
    const cb = document.querySelector(`#tkr-svc-panel input[data-id="${id}"]`);
    if (cb) cb.checked = false;
    _renderServiceChips();
  }

  function addStatusTag(input) {
    if (input.key !== 'Enter') return;
    const val = input.target.value.trim();
    if (!val || _statusTags.includes(val)) { input.target.value = ''; return; }
    _statusTags.push(val);
    input.target.value = '';
    _renderStatusTags();
  }

  function removeStatusTag(idx) {
    _statusTags.splice(idx, 1);
    _renderStatusTags();
  }

  // ── Config CRUD — Webhooks ─────────────────────────────────────────────────

  function showWebhookForm(data) {
    const form = document.getElementById('tkr-webhook-form');
    if (!form) return;
    form.dataset.editId = data ? data.id : '';
    form.querySelector('#tkr-wh-product').value = data ? data.product_name : '';
    form.querySelector('#tkr-wh-channel').value = data ? data.channel_name : '';
    form.querySelector('#tkr-wh-url').value = data ? data.webhook_url : '';
    form.querySelector('#tkr-wh-default').checked = data ? !!data.is_default : false;
    _loadTemplateSelect('tkr-wh-template', data ? data.template_id : null);
    form.classList.add('visible');
    form.querySelector('#tkr-wh-product').focus();
  }

  function hideWebhookForm() {
    const form = document.getElementById('tkr-webhook-form');
    if (form) form.classList.remove('visible');
  }

  function saveWebhook() {
    const form = document.getElementById('tkr-webhook-form');
    if (!form) return;
    const editId = form.dataset.editId;
    const payload = {
      product_name: form.querySelector('#tkr-wh-product').value.trim(),
      channel_name: form.querySelector('#tkr-wh-channel').value.trim(),
      webhook_url: form.querySelector('#tkr-wh-url').value.trim(),
      template_id: form.querySelector('#tkr-wh-template').value || null,
      is_default: form.querySelector('#tkr-wh-default').checked,
      product_code: '',
    };
    if (!payload.product_name || !payload.channel_name || !payload.webhook_url) {
      _showToast('Vui lòng điền đầy đủ thông tin', 'err');
      return;
    }
    const saveBtn = form.querySelector('.tkr-save-btn');
    if (saveBtn) saveBtn.disabled = true;
    const req = editId
      ? ApiClient.put(`/api/remind/webhooks/${editId}`, payload)
      : ApiClient.post('/api/remind/webhooks', payload);
    req.then(() => {
      _showToast(editId ? 'Đã cập nhật webhook' : 'Đã thêm webhook', 'ok');
      hideWebhookForm();
      _configTabsLoaded['webhooks'] = false;
      _loadConfigTab('webhooks');
    }).catch(err => {
      _showToast('Lỗi: ' + (err.message || err), 'err');
    }).finally(() => {
      if (saveBtn) saveBtn.disabled = false;
    });
  }

  function deleteWebhook(id) {
    if (!confirm('Xóa webhook này?')) return;
    ApiClient.delete(`/api/remind/webhooks/${id}`).then(() => {
      _showToast('Đã xóa webhook', 'ok');
      _configTabsLoaded['webhooks'] = false;
      _loadConfigTab('webhooks');
    }).catch(err => _showToast('Lỗi: ' + (err.message || err), 'err'));
  }

  function testWebhook(id) {
    ApiClient.post(`/api/remind/webhooks/${id}/test`, {}).then(res => {
      _showToast(res.ok ? 'Test thành công ✓' : `Test thất bại: ${res.error}`, res.ok ? 'ok' : 'err');
    }).catch(err => _showToast('Lỗi: ' + (err.message || err), 'err'));
  }

  // ── Config CRUD — Templates ────────────────────────────────────────────────

  function showTemplateForm(data) {
    const form = document.getElementById('tkr-template-form');
    if (!form) return;
    form.dataset.editId = data ? data.id : '';
    form.querySelector('#tkr-tmpl-name').value = data ? data.name : '';
    form.querySelector('#tkr-tmpl-content').value = data ? data.content : '';
    form.querySelector('#tkr-tmpl-default').checked = data ? !!data.is_default : false;
    form.classList.add('visible');
    form.querySelector('#tkr-tmpl-name').focus();
  }

  function hideTemplateForm() {
    const form = document.getElementById('tkr-template-form');
    if (form) form.classList.remove('visible');
  }

  function saveTemplate() {
    const form = document.getElementById('tkr-template-form');
    if (!form) return;
    const editId = form.dataset.editId;
    const payload = {
      name: form.querySelector('#tkr-tmpl-name').value.trim(),
      content: form.querySelector('#tkr-tmpl-content').value.trim(),
      is_default: form.querySelector('#tkr-tmpl-default').checked,
    };
    if (!payload.name || !payload.content) {
      _showToast('Vui lòng điền tên và nội dung template', 'err');
      return;
    }
    const saveBtn = form.querySelector('.tkr-save-btn');
    if (saveBtn) saveBtn.disabled = true;
    const req = editId
      ? ApiClient.put(`/api/remind/templates/${editId}`, payload)
      : ApiClient.post('/api/remind/templates', payload);
    req.then(() => {
      _showToast(editId ? 'Đã cập nhật template' : 'Đã thêm template', 'ok');
      hideTemplateForm();
      _configTabsLoaded['templates'] = false;
      _loadConfigTab('templates');
    }).catch(err => {
      _showToast('Lỗi: ' + (err.message || err), 'err');
    }).finally(() => {
      if (saveBtn) saveBtn.disabled = false;
    });
  }

  function deleteTemplate(id) {
    if (!confirm('Xóa template này?')) return;
    ApiClient.delete(`/api/remind/templates/${id}`).then(() => {
      _showToast('Đã xóa template', 'ok');
      _configTabsLoaded['templates'] = false;
      _loadConfigTab('templates');
    }).catch(err => _showToast('Lỗi: ' + (err.message || err), 'err'));
  }

  function previewTemplate(id) {
    ApiClient.post(`/api/remind/templates/${id}/preview`, {}).then(res => {
      alert('Preview:\n\n' + res.preview);
    }).catch(err => _showToast('Lỗi: ' + (err.message || err), 'err'));
  }

  // ── Config CRUD — Handlers ─────────────────────────────────────────────────

  function showHandlerForm() {
    const form = document.getElementById('tkr-handler-form');
    if (form) { form.classList.add('visible'); form.querySelector('#tkr-hdl-username').focus(); }
  }

  function hideHandlerForm() {
    const form = document.getElementById('tkr-handler-form');
    if (form) form.classList.remove('visible');
  }

  function saveHandler() {
    const form = document.getElementById('tkr-handler-form');
    if (!form) return;
    const payload = {
      username: form.querySelector('#tkr-hdl-username').value.trim(),
      full_name: form.querySelector('#tkr-hdl-fullname').value.trim(),
      note: form.querySelector('#tkr-hdl-note').value.trim(),
    };
    if (!payload.username) { _showToast('Vui lòng nhập username', 'err'); return; }
    const saveBtn = form.querySelector('.tkr-save-btn');
    if (saveBtn) saveBtn.disabled = true;
    ApiClient.post('/api/remind/handlers', payload).then(() => {
      _showToast('Đã thêm handler', 'ok');
      hideHandlerForm();
      form.querySelector('#tkr-hdl-username').value = '';
      form.querySelector('#tkr-hdl-fullname').value = '';
      form.querySelector('#tkr-hdl-note').value = '';
      _configTabsLoaded['handlers'] = false;
      _loadConfigTab('handlers');
    }).catch(err => {
      _showToast('Lỗi: ' + (err.message || err), 'err');
    }).finally(() => {
      if (saveBtn) saveBtn.disabled = false;
    });
  }

  function deleteHandler(id) {
    if (!confirm('Xóa handler này?')) return;
    ApiClient.delete(`/api/remind/handlers/${id}`).then(() => {
      _showToast('Đã xóa handler', 'ok');
      _configTabsLoaded['handlers'] = false;
      _loadConfigTab('handlers');
    }).catch(err => _showToast('Lỗi: ' + (err.message || err), 'err'));
  }

  function filterLogs(status) {
    _loadConfigTab('logs', status);
  }

  // ── Private: Rendering ─────────────────────────────────────────────────────

  function _renderFetchView() {
    const panel = document.getElementById('tool-ticket-fetch');
    if (!panel) return;
    panel.innerHTML = `
      <div class="tkr-panel" id="tkr-fetch-panel">
        <div class="tkr-header">
          <div class="tkr-title">🎫 Ticket Fetch</div>
          <button id="tkr-debug-toggle" class="tkr-debug-toggle ${_debugMode ? 'active' : ''}"
            title="${_debugMode ? 'Debug ON — click để tắt' : 'Debug OFF — click để bật'}"
            onclick="TicketReminderPanel.toggleDebugMode()">🐛 Debug</button>
        </div>
        ${_buildFilterCard()}
        <div id="tkr-result-area" class="tkr-result-area"></div>
      </div>
      <div class="tkr-toast-wrap" id="tkr-toasts-fetch"></div>
    `;
    // Wire click-outside for picker
    document.addEventListener('click', _handlePickerOutsideClick);
    _showFetchEmpty();
  }

  function _buildFilterCard() {
    return `
      <div class="tkr-card">
        <div class="tkr-section-title">Bộ lọc</div>
        <div class="tkr-filter-grid">
          <div class="tkr-field tkr-field--wide">
            <label class="tkr-label" for="tkr-services-wrap">Services</label>
            <div class="tkr-tag-input" id="tkr-services-wrap">
              <div id="tkr-service-chips"></div>
              <div class="tkr-picker-wrap">
                <span class="tkr-picker-trigger" onclick="TicketReminderPanel.togglePickerPanel()">+ Chọn service</span>
                <div class="tkr-picker-panel" id="tkr-svc-panel">
                  <input class="tkr-picker-search" id="tkr-svc-search" placeholder="🔍 Tìm service..."
                    oninput="TicketReminderPanel.filterPickerItems(this.value)">
                  <div id="tkr-svc-list"></div>
                </div>
              </div>
            </div>
          </div>
          <div class="tkr-field tkr-field--wide">
            <label class="tkr-label">Statuses (Enter để thêm)</label>
            <div class="tkr-tag-input" onclick="this.querySelector('.tkr-tag-text-input').focus()">
              <div id="tkr-status-tags"></div>
              <input class="tkr-tag-text-input" placeholder="VD: In Progress" onkeydown="TicketReminderPanel.addStatusTag(event)">
            </div>
          </div>
          <div class="tkr-field tkr-field--sm">
            <label class="tkr-label" for="tkr-due-days">Due ≤ N ngày</label>
            <input class="tkr-input" id="tkr-due-days" type="number" value="5" min="0" max="365">
          </div>
          <div class="tkr-field">
            <label class="tkr-label" for="tkr-assignee">Assignee</label>
            <input class="tkr-input" id="tkr-assignee" type="text" placeholder="domain.username">
          </div>
          <div class="tkr-field">
            <label class="tkr-label" for="tkr-date-from">Created From</label>
            <input class="tkr-input" id="tkr-date-from" type="date">
          </div>
          <div class="tkr-field">
            <label class="tkr-label" for="tkr-date-to">Created To</label>
            <input class="tkr-input" id="tkr-date-to" type="date">
          </div>
        </div>
        <div class="tkr-filter-actions">
          <button class="tkr-btn-primary" id="tkr-fetch-btn" onclick="TicketReminderPanel.applyFetchFilter()">▶ Fetch Tickets</button>
          <button class="tkr-btn" onclick="TicketReminderPanel.resetFilter()">Reset</button>
        </div>
      </div>
    `;
  }

  function _showFetchEmpty() {
    const area = document.getElementById('tkr-result-area');
    if (!area) return;
    area.innerHTML = `
      <div class="tkr-empty" aria-live="polite">
        <div class="tkr-empty-icon">🎫</div>
        <div class="tkr-empty-text">Nhấn Fetch để tải danh sách ticket</div>
      </div>
    `;
  }

  function _showFetchProgress(msg) {
    const area = document.getElementById('tkr-result-area');
    if (!area) return;
    area.innerHTML = `
      <div class="tkr-progress" aria-live="polite" aria-label="Đang tải">
        <div class="tkr-spinner"></div>
        <span id="tkr-progress-text">${_esc(msg)}</span>
      </div>
    `;
  }

  function _showFetchError(msg) {
    const area = document.getElementById('tkr-result-area');
    if (!area) return;
    area.innerHTML = `
      <div class="tkr-error-card" role="alert">
        <span>⚠️</span>
        <div class="tkr-error-card-msg">${_esc(msg)}</div>
        <button class="tkr-btn" onclick="TicketReminderPanel.applyFetchFilter()">Thử lại</button>
      </div>
    `;
    const fetchBtn = document.getElementById('tkr-fetch-btn');
    if (fetchBtn) fetchBtn.disabled = false;
  }

  function _renderTicketTable(container) {
    const remindCount = _allTickets.filter(t => t.need_remind).length;
    const noDue = _allTickets.filter(t => t.diff_days === null).length;
    container.innerHTML = `
      <div class="tkr-summary">
        <div class="tkr-summary-stat">Tìm thấy: <strong>${_allTickets.length}</strong></div>
        <div class="tkr-summary-stat tkr-summary-stat--warn">Cần nhắc: <strong>${remindCount}</strong></div>
        <div class="tkr-summary-stat">Không due date: <strong>${noDue}</strong></div>
        <button class="tkr-btn-primary" id="tkr-go-remind-btn" ${remindCount === 0 ? 'disabled' : ''}
          onclick="TicketReminderPanel.buildRemindList()">
          📋 Xem Danh Sách Remind (${remindCount})
        </button>
      </div>
      <div class="tkr-table-wrap">
        <table class="tkr-table">
          <thead>
            <tr>
              <th>#</th>
              <th>ID</th>
              <th>Product</th>
              <th>Requester</th>
              <th>Due Date</th>
              <th>Nhắc?</th>
              <th>Last Comment</th>
            </tr>
          </thead>
          <tbody>
            ${_allTickets.map((t, i) => _buildTicketRow(t, i + 1)).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function _buildTicketRow(t, idx) {
    const rowClass = t.diff_days !== null && t.diff_days < 0 ? 'tkr-row--overdue'
      : t.diff_days !== null && t.diff_days <= 3 ? 'tkr-row--warning' : '';
    const dueClass = t.diff_days !== null && t.diff_days < 0 ? 'tkr-due--overdue'
      : t.diff_days !== null && t.diff_days <= 3 ? 'tkr-due--urgent' : 'tkr-due--normal';
    const dueText = t.diff_days !== null
      ? (t.diff_days < 0 ? `${Math.abs(t.diff_days)}d quá hạn` : `${t.diff_days}d`) : '—';
    const remindBadge = t.need_remind
      ? '<span class="tkr-badge-remind">✓ Nhắc</span>'
      : '<span class="tkr-badge-skip">—</span>';
    return `
      <tr class="${rowClass}">
        <td>${idx}</td>
        <td><a href="${_esc(t.ticket_url || '#')}" target="_blank" style="color:var(--accent);text-decoration:none;">#${t.id}</a></td>
        <td>${_esc(t.product_name)}</td>
        <td>${_esc(t.requester_name)}</td>
        <td><span class="tkr-due ${dueClass}">${dueText}</span></td>
        <td>${remindBadge}</td>
        <td style="font-size:11px;color:var(--text3);">${_esc(t.last_comment_by || '—')}</td>
      </tr>
    `;
  }

  function _renderRemindView() {
    const area = document.getElementById('tkr-result-area');
    if (!area) return;
    const count = _remindList.length;
    area.innerHTML = `
      <div class="tkr-remind-view">
        <div class="tkr-panel-header">
          <button class="tkr-back-btn" onclick="TicketReminderPanel.backToFetch()">← Quay lại</button>
          <span class="tkr-remind-count">${count} ticket cần nhắc</span>
        </div>
        <div class="tkr-send-mode">
          <button class="tkr-mode-btn active" data-mode="all" onclick="TicketReminderPanel.setSendMode('all')">● Remind All (${count})</button>
          <button class="tkr-mode-btn" data-mode="select" onclick="TicketReminderPanel.setSendMode('select')">○ Chọn từng ticket</button>
        </div>
        <div class="tkr-send-actions">
          <button class="tkr-btn-primary" id="tkr-send-btn" onclick="TicketReminderPanel.sendRemind()">
            🔔 Gửi Remind (${count})
          </button>
        </div>
        <div class="tkr-table-wrap">
          <table class="tkr-table">
            <thead>
              <tr>
                <th id="tkr-chk-col" style="display:none;width:36px;">
                  <input type="checkbox" id="tkr-select-all" style="display:none;"
                    aria-label="Chọn tất cả"
                    onchange="TicketReminderPanel.toggleSelectAll(this)">
                </th>
                <th>ID</th>
                <th>Product</th>
                <th>Requester</th>
                <th>Due</th>
                <th>Message Preview</th>
              </tr>
            </thead>
            <tbody>
              ${_remindList.map(t => _buildRemindRow(t)).join('')}
            </tbody>
          </table>
        </div>
        <div class="tkr-send-log" id="tkr-send-log" role="log" aria-live="polite"></div>
      </div>
    `;
  }

  function _buildRemindRow(t) {
    const dueClass = t.diff_days !== null && t.diff_days < 0 ? 'tkr-due--overdue'
      : t.diff_days !== null && t.diff_days <= 3 ? 'tkr-due--urgent' : 'tkr-due--normal';
    const dueText = t.diff_days !== null
      ? (t.diff_days < 0 ? `${Math.abs(t.diff_days)}d quá hạn` : `${t.diff_days}d`) : '—';
    const preview = (t.time_label || '') ? `…${_esc(t.time_label)}` : '(template chưa config)';
    return `
      <tr id="tkr-remind-row-${t.id}">
        <td style="display:none;">
          <input type="checkbox" class="tkr-row-chk" data-id="${t.id}"
            aria-label="Chọn ticket #${t.id}"
            onchange="TicketReminderPanel.onRowCheck()">
        </td>
        <td><a href="${_esc(t.ticket_url || '#')}" target="_blank" style="color:var(--accent);text-decoration:none;">#${t.id}</a></td>
        <td>${_esc(t.product_name)}</td>
        <td>${_esc(t.requester_name)}</td>
        <td><span class="tkr-due ${dueClass}">${dueText}</span></td>
        <td style="font-size:11px;color:var(--text3);max-width:260px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
          Hi ${_esc(t.requester_name)}, ${preview}
        </td>
      </tr>
    `;
  }

  // ── Private: Config Panel ──────────────────────────────────────────────────

  function _renderConfigView() {
    const panel = document.getElementById('tool-remind-config');
    if (!panel) return;
    panel.innerHTML = `
      <div class="tkr-panel">
        <div class="tkr-header">
          <div class="tkr-title">🔔 Remind Config</div>
        </div>
        <div class="tkr-config-tabs">
          <button class="tkr-config-tab-btn active" data-tab="webhooks" onclick="TicketReminderPanel.switchConfigTab('webhooks')">Webhooks</button>
          <button class="tkr-config-tab-btn" data-tab="templates" onclick="TicketReminderPanel.switchConfigTab('templates')">Templates</button>
          <button class="tkr-config-tab-btn" data-tab="handlers" onclick="TicketReminderPanel.switchConfigTab('handlers')">Handlers</button>
          <button class="tkr-config-tab-btn" data-tab="services" onclick="TicketReminderPanel.switchConfigTab('services')">Services</button>
          <button class="tkr-config-tab-btn" data-tab="logs" onclick="TicketReminderPanel.switchConfigTab('logs')">Logs</button>
        </div>
        <div id="tkr-tab-webhooks"  class="tkr-tab-content" data-tab="webhooks"></div>
        <div id="tkr-tab-templates" class="tkr-tab-content" data-tab="templates" style="display:none;"></div>
        <div id="tkr-tab-handlers"  class="tkr-tab-content" data-tab="handlers"  style="display:none;"></div>
        <div id="tkr-tab-services"  class="tkr-tab-content" data-tab="services"  style="display:none;"></div>
        <div id="tkr-tab-logs"      class="tkr-tab-content" data-tab="logs"      style="display:none;"></div>
      </div>
      <div class="tkr-toast-wrap" id="tkr-toasts-config"></div>
    `;
    _configTabsLoaded = {};
    _loadConfigTab('webhooks');
  }

  function _loadConfigTab(tab, filter) {
    const container = document.getElementById(`tkr-tab-${tab}`);
    if (!container) return;
    container.innerHTML = '<div class="tkr-progress"><div class="tkr-spinner"></div> Đang tải...</div>';

    if (tab === 'webhooks') {
      ApiClient.get('/api/remind/webhooks').then(rows => {
        container.innerHTML = _buildWebhooksTab(rows);
      }).catch(err => {
        container.innerHTML = `<div class="tkr-error-card">${_esc(String(err))}</div>`;
      });
    } else if (tab === 'templates') {
      ApiClient.get('/api/remind/templates').then(rows => {
        container.innerHTML = _buildTemplatesTab(rows);
      }).catch(err => {
        container.innerHTML = `<div class="tkr-error-card">${_esc(String(err))}</div>`;
      });
    } else if (tab === 'handlers') {
      ApiClient.get('/api/remind/handlers').then(rows => {
        container.innerHTML = _buildHandlersTab(rows);
      }).catch(err => {
        container.innerHTML = `<div class="tkr-error-card">${_esc(String(err))}</div>`;
      });
    } else if (tab === 'services') {
      ApiClient.get('/api/remind/services').then(rows => {
        container.innerHTML = _buildServicesTab(rows);
      }).catch(err => {
        container.innerHTML = `<div class="tkr-error-card">${_esc(String(err))}</div>`;
      });
    } else if (tab === 'logs') {
      const qs = filter && filter !== 'all' ? `?status=${filter}&limit=50` : '?limit=50';
      ApiClient.get('/api/remind/logs' + qs).then(rows => {
        container.innerHTML = _buildLogsTab(rows, filter);
      }).catch(err => {
        container.innerHTML = `<div class="tkr-error-card">${_esc(String(err))}</div>`;
      });
    }
  }

  function _buildWebhooksTab(rows) {
    return `
      <table class="tkr-config-table">
        <thead><tr>
          <th>Product</th><th>Channel</th><th>Webhook URL</th><th>Template</th><th>Default</th><th>Actions</th>
        </tr></thead>
        <tbody>
          ${rows.length === 0 ? `<tr><td colspan="6"><div class="tkr-empty"><div class="tkr-empty-icon">🪝</div><div class="tkr-empty-text">Chưa có webhook. Nhấn + để thêm.</div></div></td></tr>` : ''}
          ${rows.map(w => `
            <tr>
              <td>${_esc(w.product_name)}</td>
              <td>${_esc(w.channel_name)}</td>
              <td class="tkr-webhook-url">${_esc((w.webhook_url || '').substring(0, 30))}...</td>
              <td>${_esc(w.template_id || '—')}</td>
              <td>${w.is_default ? '★' : ''}</td>
              <td style="white-space:nowrap;">
                <button class="tkr-btn" title="Edit" onclick="TicketReminderPanel.showWebhookForm(${JSON.stringify(w).replace(/"/g, '&quot;')})">✏</button>
                <button class="tkr-btn tkr-btn-danger" title="Delete" onclick="TicketReminderPanel.deleteWebhook('${w.id}')">🗑</button>
                <button class="tkr-btn" title="Test webhook" onclick="TicketReminderPanel.testWebhook('${w.id}')">▶ Test</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <div style="margin-top:12px;display:flex;gap:10px;align-items:center;">
        <button class="tkr-btn-primary" onclick="TicketReminderPanel.showWebhookForm(null)">+ Thêm Webhook</button>
        <button class="tkr-btn" id="tkr-sync-products-btn" onclick="TicketReminderPanel.syncProducts()">⟳ Sync Products</button>
      </div>
      <div class="tkr-inline-form" id="tkr-webhook-form">
        <div class="tkr-form-grid">
          <div class="tkr-field"><label class="tkr-label" for="tkr-wh-product">Product Name</label><input class="tkr-input" id="tkr-wh-product"></div>
          <div class="tkr-field"><label class="tkr-label" for="tkr-wh-channel">Channel Name</label><input class="tkr-input" id="tkr-wh-channel"></div>
          <div class="tkr-field tkr-field--wide"><label class="tkr-label" for="tkr-wh-url">Webhook URL</label><input class="tkr-input" id="tkr-wh-url" placeholder="https://...webhook.office.com/..."></div>
          <div class="tkr-field"><label class="tkr-label" for="tkr-wh-template">Template</label><select class="tkr-select" id="tkr-wh-template"><option value="">— None —</option></select></div>
          <div class="tkr-field" style="justify-content:flex-end;padding-top:18px;">
            <label style="display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--text2);cursor:pointer;">
              <input type="checkbox" id="tkr-wh-default"> Set as Default
            </label>
          </div>
        </div>
        <div class="tkr-form-actions">
          <button class="tkr-btn-primary tkr-save-btn" onclick="TicketReminderPanel.saveWebhook()">Lưu</button>
          <button class="tkr-btn" onclick="TicketReminderPanel.hideWebhookForm()">Hủy</button>
        </div>
      </div>
    `;
  }

  function _buildTemplatesTab(rows) {
    return `
      <table class="tkr-config-table">
        <thead><tr><th>Tên</th><th>Preview</th><th>Default</th><th>Actions</th></tr></thead>
        <tbody>
          ${rows.length === 0 ? `<tr><td colspan="4"><div class="tkr-empty"><div class="tkr-empty-icon">📝</div><div class="tkr-empty-text">Chưa có template.</div></div></td></tr>` : ''}
          ${rows.map(t => `
            <tr>
              <td>${_esc(t.name)}</td>
              <td style="font-size:11px;color:var(--text3);max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc((t.content || '').substring(0, 60))}...</td>
              <td>${t.is_default ? '★' : ''}</td>
              <td style="white-space:nowrap;">
                <button class="tkr-btn" title="Edit" onclick="TicketReminderPanel.showTemplateForm(${JSON.stringify(t).replace(/"/g, '&quot;')})">✏</button>
                <button class="tkr-btn tkr-btn-danger" title="Delete" onclick="TicketReminderPanel.deleteTemplate('${t.id}')">🗑</button>
                <button class="tkr-btn" title="Preview" onclick="TicketReminderPanel.previewTemplate('${t.id}')">👁</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <div style="margin-top:12px;">
        <button class="tkr-btn-primary" onclick="TicketReminderPanel.showTemplateForm(null)">+ Thêm Template</button>
      </div>
      <div class="tkr-inline-form" id="tkr-template-form">
        <div class="tkr-form-grid">
          <div class="tkr-field"><label class="tkr-label" for="tkr-tmpl-name">Tên template</label><input class="tkr-input" id="tkr-tmpl-name"></div>
          <div class="tkr-field" style="justify-content:flex-end;padding-top:18px;">
            <label style="display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--text2);cursor:pointer;">
              <input type="checkbox" id="tkr-tmpl-default"> Set as Default
            </label>
          </div>
          <div class="tkr-field tkr-field--wide">
            <label class="tkr-label" for="tkr-tmpl-content">Nội dung</label>
            <textarea class="tkr-input" id="tkr-tmpl-content" rows="4" style="resize:vertical;"
              placeholder="Hi {requester_name}, ticket #{ticket_id} {time_label}..."></textarea>
          </div>
          <div style="grid-column:span 2;font-size:11px;color:var(--text3);">
            Placeholders: {requester_name} {product_name} {ticket_id} {due_date} {days_left} {time_label}
          </div>
        </div>
        <div class="tkr-form-actions">
          <button class="tkr-btn-primary tkr-save-btn" onclick="TicketReminderPanel.saveTemplate()">Lưu</button>
          <button class="tkr-btn" onclick="TicketReminderPanel.hideTemplateForm()">Hủy</button>
        </div>
      </div>
    `;
  }

  function _buildHandlersTab(rows) {
    return `
      <table class="tkr-config-table">
        <thead><tr><th>Username</th><th>Full Name</th><th>Note</th><th>Actions</th></tr></thead>
        <tbody>
          ${rows.length === 0 ? `<tr><td colspan="4"><div class="tkr-empty"><div class="tkr-empty-icon">👤</div><div class="tkr-empty-text">Chưa có handler.</div></div></td></tr>` : ''}
          ${rows.map(h => `
            <tr>
              <td style="font-family:monospace;">${_esc(h.username)}</td>
              <td>${_esc(h.full_name || '—')}</td>
              <td style="font-size:11px;color:var(--text3);">${_esc(h.note || '')}</td>
              <td>
                <button class="tkr-btn tkr-btn-danger" title="Delete" onclick="TicketReminderPanel.deleteHandler('${h.id}')">🗑</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <div style="margin-top:12px;">
        <button class="tkr-btn-primary" onclick="TicketReminderPanel.showHandlerForm()">+ Thêm Handler</button>
      </div>
      <div class="tkr-inline-form" id="tkr-handler-form">
        <div class="tkr-form-grid">
          <div class="tkr-field"><label class="tkr-label" for="tkr-hdl-username">Username (domain)</label><input class="tkr-input" id="tkr-hdl-username" placeholder="nguyen.vana"></div>
          <div class="tkr-field"><label class="tkr-label" for="tkr-hdl-fullname">Full Name</label><input class="tkr-input" id="tkr-hdl-fullname"></div>
          <div class="tkr-field"><label class="tkr-label" for="tkr-hdl-note">Note</label><input class="tkr-input" id="tkr-hdl-note"></div>
        </div>
        <div class="tkr-form-actions">
          <button class="tkr-btn-primary tkr-save-btn" onclick="TicketReminderPanel.saveHandler()">Lưu</button>
          <button class="tkr-btn" onclick="TicketReminderPanel.hideHandlerForm()">Hủy</button>
        </div>
      </div>
    `;
  }

  function _buildServicesTab(rows) {
    return `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
        <button class="tkr-btn-primary" id="tkr-sync-services-btn" onclick="TicketReminderPanel.syncServices()">⟳ Sync Services</button>
        <span class="tkr-sync-info">${rows.length} services trong DB</span>
      </div>
      <table class="tkr-config-table">
        <thead><tr><th>ID</th><th>Name</th><th>Description</th></tr></thead>
        <tbody>
          ${rows.length === 0 ? `<tr><td colspan="3"><div class="tkr-empty"><div class="tkr-empty-icon">🔧</div><div class="tkr-empty-text">Chưa sync. Nhấn Sync Services.</div></div></td></tr>` : ''}
          ${rows.map(s => `
            <tr>
              <td style="font-family:monospace;color:var(--text3);">${s.id}</td>
              <td>${_esc(s.name)}</td>
              <td style="font-size:11px;color:var(--text3);">${_esc(s.description || '')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  function _buildLogsTab(rows, currentFilter) {
    const f = currentFilter || 'all';
    return `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
        <span style="font-size:12px;color:var(--text3);">Filter:</span>
        ${['all','sent','failed','skipped'].map(s => `
          <button class="tkr-btn ${f === s ? 'tkr-btn-primary' : ''}" onclick="TicketReminderPanel.filterLogs('${s}')">${s}</button>
        `).join('')}
        <span class="tkr-sync-info">${rows.length} gần nhất</span>
      </div>
      <table class="tkr-config-table">
        <thead><tr><th>Ticket</th><th>Product</th><th>Requester</th><th>Status</th><th>Sent At</th></tr></thead>
        <tbody>
          ${rows.length === 0 ? `<tr><td colspan="5"><div class="tkr-empty"><div class="tkr-empty-icon">📋</div><div class="tkr-empty-text">Không có log.</div></div></td></tr>` : ''}
          ${rows.map(l => `
            <tr>
              <td>${l.ticket_url ? `<a href="${_esc(l.ticket_url)}" target="_blank" style="color:var(--accent);">#${_esc(l.ticket_id)}</a>` : `#${_esc(l.ticket_id)}`}</td>
              <td>${_esc(l.product || '—')}</td>
              <td>${_esc(l.requester || '—')}</td>
              <td><span class="tkr-result tkr-result--${l.status}">${l.status}</span></td>
              <td style="font-size:11px;color:var(--text3);">${_esc((l.reminded_at || '').substring(0, 16).replace('T', ' '))}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  // ── Private: Polling ───────────────────────────────────────────────────────

  function _startPolling(jobId) {
    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = setInterval(() => _pollJob(jobId), 1500);
  }

  function _pollJob(jobId) {
    ApiClient.get(`/api/remind/tickets/fetch/status?job_id=${jobId}`).then(job => {
      const txt = document.getElementById('tkr-progress-text');
      if (job.status === 'running') {
        if (txt) {
          if (job.phase === 'tickets') {
            txt.textContent = `Đang tải ticket... (page ${job.tickets_page}/${job.tickets_total_pages || '?'})`;
          } else {
            txt.textContent = `Đang kiểm tra comments... (${job.comments_done}/${job.comments_total} tickets)`;
          }
        }
        return;
      }
      clearInterval(_pollTimer);
      _pollTimer = null;
      const fetchBtn = document.getElementById('tkr-fetch-btn');
      if (fetchBtn) fetchBtn.disabled = false;

      if (job.status === 'error') {
        _showFetchError(job.error || 'Lỗi không xác định');
        if (_debugMode && job.debug_requests) {
          _showDebugDialog(job.debug_requests);
        }
        return;
      }

      // Done
      _allTickets = (job.result && job.result.tickets) || [];
      const area = document.getElementById('tkr-result-area');
      if (area) _renderTicketTable(area);

      if (_debugMode && job.result && job.result.debug_requests) {
        _showDebugDialog(job.result.debug_requests);
      }
    }).catch(() => {
      // silent fail, keep polling
    });
  }

  // ── Private: Send helpers ──────────────────────────────────────────────────

  function _getTicketsToSend() {
    if (_sendMode === 'all') return _remindList.filter(t => !_sentTicketIds.has(t.id));
    return _remindList.filter(t => {
      if (_sentTicketIds.has(t.id)) return false;
      const chk = document.querySelector(`.tkr-row-chk[data-id="${t.id}"]`);
      return chk && chk.checked;
    });
  }

  function _updateSendBtn() {
    const btn = document.getElementById('tkr-send-btn');
    if (!btn) return;
    const tickets = _getTicketsToSend();
    const count = tickets.length;
    btn.disabled = count === 0;
    btn.textContent = `🔔 Gửi Remind (${count})`;
  }

  function _appendLog(result) {
    const log = document.getElementById('tkr-send-log');
    if (!log) return;
    const icon = result.status === 'sent' ? '✅' : result.status === 'failed' ? '❌' : '⚠️';
    const cls = result.status === 'sent' ? 'ok' : result.status === 'failed' ? 'err' : 'warn';
    const channel = result.channel ? ` → ${result.channel}` : '';
    const err = result.error ? ` — ${result.error}` : '';
    _appendLogLine(log, `${icon} #${result.ticket_id}${channel}${err}`, cls);
  }

  function _appendLogSummary(sent, failed, skipped) {
    const log = document.getElementById('tkr-send-log');
    if (!log) return;
    const div = document.createElement('div');
    div.className = 'tkr-log-summary';
    div.textContent = `${sent} thành công · ${failed} thất bại · ${skipped} bỏ qua`;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  function _appendLogLine(log, text, type) {
    const div = document.createElement('div');
    div.className = `tkr-log-line tkr-log-line--${type}`;
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  function _markRowSent(ticketId, status) {
    const row = document.getElementById(`tkr-remind-row-${ticketId}`);
    if (row && status === 'sent') {
      row.classList.add('tkr-row--sent');
      const chk = row.querySelector('.tkr-row-chk');
      if (chk) chk.disabled = true;
    }
  }

  // ── Private: Services picker ───────────────────────────────────────────────

  function _loadServices() {
    ApiClient.get('/api/remind/services').then(rows => {
      _services = rows;
      _renderPickerItems();
    }).catch(() => {});
  }

  function _renderPickerItems() {
    const list = document.getElementById('tkr-svc-list');
    if (!list) return;
    list.innerHTML = _services.map(s => `
      <label class="tkr-picker-item ${_selectedServiceIds.has(s.id) ? 'active' : ''}">
        <input type="checkbox" data-id="${s.id}" ${_selectedServiceIds.has(s.id) ? 'checked' : ''}
          onchange="TicketReminderPanel.toggleService(${s.id}, '${_esc(s.name)}', this.checked)">
        ${_esc(s.name)}
      </label>
    `).join('');
  }

  function _filterPickerItems(query) {
    const list = document.getElementById('tkr-svc-list');
    if (!list) return;
    const q = query.toLowerCase();
    list.querySelectorAll('.tkr-picker-item').forEach(item => {
      item.style.display = item.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  }

  function _renderServiceChips() {
    const container = document.getElementById('tkr-service-chips');
    if (!container) return;
    const selected = _services.filter(s => _selectedServiceIds.has(s.id));
    container.innerHTML = selected.map(s => `
      <span class="tkr-tag">
        ${_esc(s.name)}
        <span class="tkr-tag-remove" onclick="TicketReminderPanel.removeServiceChip(${s.id})">×</span>
      </span>
    `).join('');
  }

  function _renderStatusTags() {
    const container = document.getElementById('tkr-status-tags');
    if (!container) return;
    container.innerHTML = _statusTags.map((t, i) => `
      <span class="tkr-tag">
        ${_esc(t)}
        <span class="tkr-tag-remove" onclick="TicketReminderPanel.removeStatusTag(${i})">×</span>
      </span>
    `).join('');
  }

  function _handlePickerOutsideClick(e) {
    const wrap = document.querySelector('.tkr-picker-wrap');
    if (wrap && !wrap.contains(e.target)) {
      const panel = document.getElementById('tkr-svc-panel');
      if (panel) { panel.classList.remove('open'); _pickerOpen = false; }
    }
  }

  // ── Private: Template select ───────────────────────────────────────────────

  function _loadTemplateSelect(selectId, selectedId) {
    ApiClient.get('/api/remind/templates').then(rows => {
      const sel = document.getElementById(selectId);
      if (!sel) return;
      sel.innerHTML = '<option value="">— None —</option>' +
        rows.map(t => `<option value="${t.id}" ${t.id === selectedId ? 'selected' : ''}>${_esc(t.name)}</option>`).join('');
    }).catch(() => {});
  }

  // ── Private: Toast ─────────────────────────────────────────────────────────

  function _showToast(msg, type) {
    // Try config panel toast first, fallback to fetch panel
    let wrap = document.getElementById('tkr-toasts-config') || document.getElementById('tkr-toasts-fetch');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'tkr-toast-wrap';
      document.body.appendChild(wrap);
    }
    const toast = document.createElement('div');
    toast.className = `tkr-toast tkr-toast--${type}`;
    toast.setAttribute('role', 'alert');
    toast.textContent = msg;
    wrap.appendChild(toast);
    setTimeout(() => toast.remove(), type === 'err' ? 5000 : 3000);
  }

  // ── Private: Utils ─────────────────────────────────────────────────────────

  function _esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ── Public: Config panel boot ──────────────────────────────────────────────

  let _configBooted = false;
  function bootConfig() {
    if (_configBooted) return;
    _configBooted = true;
    _renderConfigView();
  }

  return {
    boot,
    bootConfig,
    switchConfigTab,
    applyFetchFilter,
    resetFilter,
    buildRemindList,
    backToFetch,
    setSendMode,
    toggleSelectAll,
    onRowCheck,
    sendRemind,
    syncProducts,
    syncServices,
    togglePickerPanel,
    filterPickerItems,
    toggleService,
    removeServiceChip,
    addStatusTag,
    removeStatusTag,
    showWebhookForm,
    hideWebhookForm,
    saveWebhook,
    deleteWebhook,
    testWebhook,
    showTemplateForm,
    hideTemplateForm,
    saveTemplate,
    deleteTemplate,
    previewTemplate,
    showHandlerForm,
    hideHandlerForm,
    saveHandler,
    deleteHandler,
    filterLogs,
    toggleDebugMode,
    closeDebugDialog,
  };
})();
