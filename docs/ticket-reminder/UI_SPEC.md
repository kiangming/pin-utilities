# UI_SPEC.md — Ticket Reminder UI
> Mô tả chi tiết giao diện người dùng của tính năng Reminder.
> Tuân thủ DESIGN.md — Glassmorphism Gradient, prefix `pls-`, file `pipeline.css`.

---

## 1. Tích hợp vào App Shell hiện có

Tính năng Reminder thêm **2 nav item mới** vào `.pls-sidebar-nav`:

```html
<!-- Thêm vào sidebar nav -->
<div class="pls-nav-item" data-tool="ticket-fetch">
  <!-- Icon: ticket / inbox -->
  <svg class="pls-nav-icon" viewBox="0 0 20 20" ...>...</svg>
  <span class="pls-nav-label">Ticket Fetch</span>
</div>

<div class="pls-nav-item" data-tool="remind-manage">
  <!-- Icon: bell -->
  <svg class="pls-nav-icon" viewBox="0 0 20 20" ...>...</svg>
  <span class="pls-nav-label">Remind Config</span>
</div>
```

Mỗi tool view là một `<section>` ẩn/hiện theo `data-tool` active — đúng pattern hiện có.

---

## 2. View 1 — Ticket Fetch (`data-tool="ticket-fetch"`)

Mục đích: User cấu hình filter → fetch ticket → review danh sách → chuyển sang gửi remind.

### 2.1 Layout tổng thể

```
┌─────────────────────────────────────────────────────┐
│  [Filter Panel — glass card]                        │
│  ┌───────────────────────────────────────────────┐  │
│  │  Service IDs   [tag input]                    │  │
│  │  Statuses      [tag input]                    │  │
│  │  Due days ≤    [number input, default: 5]     │  │
│  │  Assignee      [text input]                   │  │
│  │  Date range    [from] — [to]                  │  │
│  │                                               │  │
│  │  [Fetch Tickets ▶]          [Reset]           │  │
│  └───────────────────────────────────────────────┘  │
│                                                     │
│  [Ticket List — xuất hiện sau khi fetch]            │
│  ┌───────────────────────────────────────────────┐  │
│  │  Tìm thấy: 42 tickets  ·  Cần nhắc: 12       │  │
│  │  [Review & Build Remind List ▶]               │  │
│  │                                               │  │
│  │  ┌──────────────────────────────────────────┐ │  │
│  │  │ # │ Ticket │ Product │ Requester │ Due  │ │  │
│  │  │   │        │         │           │ Date │ │  │
│  │  ├───┼────────┼─────────┼───────────┼──────┤ │  │
│  │  │   │ #1234  │ GameA   │ john.doe  │ 3d   │ │  │
│  │  └──────────────────────────────────────────┘ │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

### 2.2 Filter Panel

**HTML structure:**
```html
<section data-tool="ticket-fetch" class="pls-tool-content">
  <div class="pls-card pls-filter-panel">
    <h2 class="pls-section-title">Fetch Tickets</h2>

    <div class="pls-filter-grid">
      <!-- Service IDs: tag input -->
      <div class="pls-field">
        <label class="pls-label">Service IDs</label>
        <div class="pls-tag-input" id="input-service-ids">
          <!-- Tags được render bằng JS -->
        </div>
      </div>

      <!-- Statuses -->
      <div class="pls-field">
        <label class="pls-label">Statuses</label>
        <div class="pls-tag-input" id="input-statuses"></div>
      </div>

      <!-- Due days threshold -->
      <div class="pls-field pls-field--sm">
        <label class="pls-label">Nhắc khi còn ≤ N ngày</label>
        <input type="number" class="pls-input" id="input-due-days" value="5" min="0" max="30">
      </div>

      <!-- Assignee -->
      <div class="pls-field">
        <label class="pls-label">Assignee (username)</label>
        <input type="text" class="pls-input" id="input-assignee" placeholder="VD: john.doe">
      </div>

      <!-- Date range -->
      <div class="pls-field pls-field--date-range">
        <label class="pls-label">Created At</label>
        <div class="pls-date-range">
          <input type="date" class="pls-input" id="input-date-from">
          <span class="pls-date-sep">—</span>
          <input type="date" class="pls-input" id="input-date-to">
        </div>
      </div>
    </div>

    <div class="pls-filter-actions">
      <button class="pls-btn-primary" id="btn-fetch">Fetch Tickets ▶</button>
      <button class="pls-btn" id="btn-reset-filter">Reset</button>
    </div>
  </div>

  <!-- Kết quả fetch -->
  <div class="pls-card pls-ticket-result" id="ticket-result" hidden>
    <div class="pls-result-summary">
      <span class="pls-result-stat">Tìm thấy: <strong id="stat-total">0</strong> tickets</span>
      <span class="pls-result-stat pls-result-stat--warn">Cần nhắc: <strong id="stat-remind">0</strong></span>
      <button class="pls-btn-primary" id="btn-build-remind">Review & Build Remind List ▶</button>
    </div>
    <div class="pls-ticket-table-wrap">
      <table class="pls-table" id="ticket-table">
        <thead>
          <tr>
            <th>#</th><th>Ticket</th><th>Product</th>
            <th>Requester</th><th>Status</th><th>Due Date</th>
          </tr>
        </thead>
        <tbody id="ticket-tbody"></tbody>
      </table>
    </div>
  </div>

  <!-- Loading state -->
  <div class="pls-loading" id="fetch-loading" hidden>
    <div class="pls-spinner"></div>
    <span>Đang fetch tickets... <span id="fetch-progress"></span></span>
  </div>
</section>
```

### 2.3 States của bảng ticket

| State | Hiển thị |
|---|---|
| Due ≤ 0 (quá hạn) | Row background đỏ nhạt: `rgba(239,68,68,0.15)` |
| Due 1–3 ngày | Row background vàng nhạt: `rgba(251,191,36,0.15)` |
| Due 4–5 ngày | Background mặc định glass |
| Đã review/cần nhắc | Badge `pls-status-launch` pill trên cột Due Date |

---

## 3. View 2 — Remind List (panel phụ, hiện sau "Build Remind List")

Không phải view riêng — là **modal/drawer** slide in từ phải, hoặc replace phần dưới của View 1.

### 3.1 Layout

```
┌─────────────────────────────────────────────────────┐
│  Remind List  (12 tickets cần nhắc)   [← Quay lại] │
│                                                     │
│  Gửi theo:  [● Tất cả]  [○ Chọn nhóm]  [○ Tùy chọn]│
│  Chọn nhóm: [GameA ✓] [GameB] [GameC ✓]             │
│                                                     │
│  [🔔 Gửi Remind (8)]                    [Preview]  │
│                                                     │
│  ┌──────────────────────────────────────────────┐   │
│  │☐│ #1234 │ GameA │ john.doe │ 3d │ Message... │   │
│  │☑│ #1235 │ GameB │ jane.doe │ 0d │ Message... │   │
│  └──────────────────────────────────────────────┘   │
│                                                     │
│  Status: ✅ #1234 Đã gửi · ❌ #1235 Lỗi: no route  │
└─────────────────────────────────────────────────────┘
```

### 3.2 HTML structure (remind list panel)

```html
<div class="pls-card pls-remind-panel" id="remind-panel" hidden>
  <div class="pls-remind-header">
    <h3>Remind List</h3>
    <span class="pls-badge" id="remind-count">12 tickets cần nhắc</span>
    <button class="pls-btn" id="btn-back-to-fetch">← Quay lại</button>
  </div>

  <!-- Chế độ gửi -->
  <div class="pls-send-mode">
    <label class="pls-radio-label">
      <input type="radio" name="send-mode" value="all" checked> Tất cả
    </label>
    <label class="pls-radio-label">
      <input type="radio" name="send-mode" value="group"> Theo nhóm (product)
    </label>
    <label class="pls-radio-label">
      <input type="radio" name="send-mode" value="custom"> Tùy chọn từng ticket
    </label>
  </div>

  <!-- Group filter — hiện khi chọn "Theo nhóm" -->
  <div class="pls-group-filter" id="group-filter" hidden>
    <!-- Render dynamic product buttons -->
  </div>

  <!-- Action bar -->
  <div class="pls-remind-actions">
    <button class="pls-btn-primary" id="btn-send-remind">
      🔔 Gửi Remind (<span id="selected-count">12</span>)
    </button>
    <button class="pls-btn" id="btn-preview-remind">Preview Message</button>
  </div>

  <!-- Remind table -->
  <div class="pls-ticket-table-wrap">
    <table class="pls-table" id="remind-table">
      <thead>
        <tr>
          <th><input type="checkbox" id="chk-all"></th>
          <th>Ticket</th><th>Product</th><th>Requester</th>
          <th>Due</th><th>Last Comment</th><th>Message</th><th>Status</th>
        </tr>
      </thead>
      <tbody id="remind-tbody"></tbody>
    </table>
  </div>

  <!-- Send progress log -->
  <div class="pls-send-log" id="send-log" hidden>
    <h4>Kết quả gửi</h4>
    <div id="send-log-content"></div>
  </div>
</div>
```

---

## 4. View 3 — Remind Config (`data-tool="remind-manage"`)

Phần quản lý gồm **3 tab**: Webhooks, Templates, Handler Usernames.

### 4.1 Tab navigation

```html
<div class="pls-tab-nav">
  <button class="pls-tab-btn pls-tab-btn--active" data-tab="webhooks">Webhook Config</button>
  <button class="pls-tab-btn" data-tab="templates">Message Templates</button>
  <button class="pls-tab-btn" data-tab="handlers">Handler Usernames</button>
</div>
```

### 4.2 Tab: Webhook Config

Bảng hiển thị danh sách webhook, mỗi row có action Edit / Delete / Test:

```
┌──────────────┬──────────────┬─────────────────────┬──────────────┬────────┐
│ Product Name │ Channel Name │ Webhook URL (masked) │ Template     │ Action │
├──────────────┼──────────────┼─────────────────────┼──────────────┼────────┤
│ GameA        │ #sandbox-ga  │ https://outlook...  │ Sandbox EN   │ ✏ 🗑 ▶ │
│ DEFAULT      │ #sandbox-all │ https://outlook...  │ Sandbox EN   │ ✏ 🗑 ▶ │
└──────────────┴──────────────┴─────────────────────┴──────────────┴────────┘
[+ Thêm Webhook]
```

**Form thêm/sửa webhook** (inline expand hoặc modal nhỏ):
- Product Name (text)
- Channel Name (text)
- Webhook URL (text, validate URL format)
- Template (dropdown từ danh sách templates)
- Is Default (checkbox)

### 4.3 Tab: Message Templates

```
┌──────────────────────────┬─────────────────────────────────────┬────────┐
│ Tên template             │ Preview (50 chars)                  │ Action │
├──────────────────────────┼─────────────────────────────────────┼────────┤
│ Sandbox Expiry EN ★      │ Hi {requester_name}, the sandbox... │ ✏ 🗑   │
│ Sandbox Expiry VI        │ Xin chào {requester_name}...        │ ✏ 🗑   │
└──────────────────────────┴─────────────────────────────────────┴────────┘
[+ Thêm Template]
```

**Form tạo/sửa template:**
- Tên template
- Textarea nội dung (với hint về placeholder hỗ trợ)
- Nút "Preview" — render message mẫu với data giả
- Checkbox "Default"

**Placeholder hint** (hiển thị bên dưới textarea):
```
Placeholders: {requester_name} {product_name} {ticket_id} {due_date} {days_left} {time_label}
```

### 4.4 Tab: Handler Usernames

Danh sách username — chỉ cần table đơn giản + add/delete:

```
┌─────────────────┬───────────────────────┬────────┐
│ Username        │ Full Name             │ Action │
├─────────────────┼───────────────────────┼────────┤
│ huong.tran      │ Trần Thị Hương        │ 🗑     │
│ tien.ngo        │ Ngô Tiến              │ 🗑     │
└─────────────────┴───────────────────────┴────────┘
[+ Thêm Username]
```

---

## 5. CSS cần thêm vào `pipeline.css`

Tất cả thêm vào `pipeline.css` — KHÔNG tạo file CSS mới.

```css
/* ── Table ── */
.pls-table { width: 100%; border-collapse: collapse; font-size: var(--pls-font-sm); }
.pls-table th { color: var(--pls-text-secondary); font-weight: 500; padding: var(--pls-space-sm) var(--pls-space-md); border-bottom: 0.5px solid var(--pls-glass-border); text-align: left; }
.pls-table td { padding: var(--pls-space-sm) var(--pls-space-md); border-bottom: 0.5px solid rgba(255,255,255,0.06); color: var(--pls-text-primary); vertical-align: middle; }
.pls-table tr:hover td { background: var(--pls-glass-bg); }
.pls-table-wrap { overflow-x: auto; border-radius: var(--pls-radius-md); }

/* ── Input ── */
.pls-input {
  background: var(--pls-glass-bg);
  border: 0.5px solid var(--pls-glass-border);
  border-radius: var(--pls-radius-sm);
  color: var(--pls-text-primary);
  font-size: var(--pls-font-sm);
  padding: 6px 10px;
  width: 100%;
  outline: none;
  transition: border-color var(--pls-transition-fast);
}
.pls-input:focus { border-color: var(--pls-glass-border-hover); background: var(--pls-glass-bg-hover); }

/* ── Label ── */
.pls-label { font-size: var(--pls-font-xs); color: var(--pls-text-secondary); margin-bottom: var(--pls-space-xs); display: block; }

/* ── Filter grid ── */
.pls-filter-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: var(--pls-space-md); margin-bottom: var(--pls-space-lg); }
.pls-field--sm { max-width: 160px; }
.pls-field--date-range { grid-column: span 2; }
.pls-date-range { display: flex; align-items: center; gap: var(--pls-space-sm); }
.pls-date-sep { color: var(--pls-text-muted); }

/* ── Tag input ── */
.pls-tag-input { display: flex; flex-wrap: wrap; gap: 4px; min-height: 34px; background: var(--pls-glass-bg); border: 0.5px solid var(--pls-glass-border); border-radius: var(--pls-radius-sm); padding: 4px 8px; cursor: text; }
.pls-tag { display: inline-flex; align-items: center; gap: 4px; background: var(--pls-accent-bg); border: 0.5px solid var(--pls-accent-border); border-radius: var(--pls-radius-pill); padding: 2px 8px; font-size: var(--pls-font-xs); color: var(--pls-text-primary); }
.pls-tag-remove { cursor: pointer; color: var(--pls-text-muted); font-size: 10px; }

/* ── Result summary ── */
.pls-result-summary { display: flex; align-items: center; gap: var(--pls-space-lg); padding-bottom: var(--pls-space-md); border-bottom: 0.5px solid var(--pls-glass-border); margin-bottom: var(--pls-space-md); }
.pls-result-stat { font-size: var(--pls-font-sm); color: var(--pls-text-secondary); }
.pls-result-stat strong { color: var(--pls-text-primary); }
.pls-result-stat--warn strong { color: rgba(251,191,36,0.9); }

/* ── Tab nav ── */
.pls-tab-nav { display: flex; gap: var(--pls-space-xs); margin-bottom: var(--pls-space-lg); }
.pls-tab-btn { background: var(--pls-glass-bg); border: 0.5px solid var(--pls-glass-border); border-radius: var(--pls-radius-pill); color: var(--pls-text-secondary); font-size: var(--pls-font-sm); padding: 5px 14px; cursor: pointer; transition: all var(--pls-transition-fast); }
.pls-tab-btn:hover { background: var(--pls-glass-bg-hover); color: var(--pls-text-primary); }
.pls-tab-btn--active { background: var(--pls-glass-bg-strong); color: var(--pls-text-primary); border-color: var(--pls-glass-border-hover); }

/* ── Loading spinner ── */
.pls-loading { display: flex; align-items: center; gap: var(--pls-space-md); padding: var(--pls-space-xl); color: var(--pls-text-secondary); font-size: var(--pls-font-sm); }
.pls-spinner { width: 18px; height: 18px; border: 2px solid var(--pls-glass-border); border-top-color: rgba(255,255,255,0.8); border-radius: 50%; animation: pls-spin 0.7s linear infinite; }
@keyframes pls-spin { to { transform: rotate(360deg); } }

/* ── Send mode radio ── */
.pls-send-mode { display: flex; gap: var(--pls-space-lg); margin-bottom: var(--pls-space-md); }
.pls-radio-label { display: flex; align-items: center; gap: 6px; font-size: var(--pls-font-sm); color: var(--pls-text-secondary); cursor: pointer; }

/* ── Send log ── */
.pls-send-log { margin-top: var(--pls-space-lg); padding: var(--pls-space-md); background: var(--pls-glass-bg); border-radius: var(--pls-radius-md); border: 0.5px solid var(--pls-glass-border); font-size: var(--pls-font-xs); color: var(--pls-text-secondary); max-height: 200px; overflow-y: auto; }

/* ── Row status highlight ── */
.pls-row--overdue td  { background: rgba(239, 68, 68, 0.12) !important; }
.pls-row--warning td  { background: rgba(251,191, 36, 0.12) !important; }
.pls-row--sent td     { opacity: 0.5; }
.pls-row--error td    { background: rgba(239, 68, 68, 0.08) !important; }

/* ── Section title ── */
.pls-section-title { font-size: var(--pls-font-md); font-weight: 600; color: var(--pls-text-primary); margin-bottom: var(--pls-space-lg); }

/* ── Badge ── */
.pls-badge { display: inline-flex; align-items: center; padding: 2px 10px; border-radius: var(--pls-radius-pill); font-size: var(--pls-font-xs); background: var(--pls-status-launch); border: 0.5px solid var(--pls-status-border-launch); color: var(--pls-text-primary); }
```

---

## 6. Checklist UI trước khi implement

- [ ] Không hardcode màu — dùng `var(--pls-*)` cho tất cả.
- [ ] Thêm CSS vào `pipeline.css`, không tạo file mới.
- [ ] Tag input dùng class `pls-tag-input` / `pls-tag`.
- [ ] Loading state hiện khi đang fetch (có thể nhiều page).
- [ ] Table có `overflow-x: auto` để không vỡ layout trên màn nhỏ.
- [ ] Progress log gửi remind: append real-time từng dòng, không reload.
- [ ] Webhook URL trong bảng quản lý: **mask** bớt, chỉ hiện 30 ký tự đầu.
- [ ] Nút "Test" webhook gửi message mẫu, hiển thị kết quả inline.
- [ ] Sidebar nav dùng `mouseenter/mouseleave`, không click.
