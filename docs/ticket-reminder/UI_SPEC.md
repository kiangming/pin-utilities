# UI_SPEC.md — Ticket Reminder UI
> Mô tả chi tiết giao diện người dùng của tính năng Reminder.
> Cập nhật theo trạng thái **đã implement** (v4.8+).
> CSS prefix: `tkr-`. File: `frontend/css/ticket-reminder.css`.

---

## 1. Tích hợp vào App Shell

2 nav item trong `.left-nav`:
- `tool-ticket-fetch` → `TicketReminderPanel.boot()`
- `tool-remind-config` → `TicketReminderPanel.bootConfig()`

Boot lazy (chỉ init lần đầu khi user click nav). Flag: `_booted`, `_configBooted`.

---

## 2. View 1 — Ticket Fetch (`#tool-ticket-fetch`)

### 2.1 Layout

```
┌─────────────────────────────────────────────────────────┐
│  🎫 Ticket Fetch                         [🐛 Debug]     │
│  ┌─────────────────────────────────────────────────┐    │
│  │  Services    [tag picker — multi-select]        │    │
│  │  Statuses *  [tag picker — required]            │    │
│  │  Due ≤ N ngày  [number]  Assignee  [text]       │    │
│  │  Created From [date]  Created To [date]         │    │
│  │  [▶ Fetch Tickets]  [Reset]                     │    │
│  └─────────────────────────────────────────────────┘    │
│                                                          │
│  [Result area — empty / progress spinner / table]        │
└─────────────────────────────────────────────────────────┘
```

### 2.2 Bộ lọc (Filter Card)

| Field | Type | Ghi chú |
|---|---|---|
| Services | Tag picker (multi-select) | Dữ liệu từ `/api/remind/services`, tuỳ chọn |
| Statuses | Tag picker (multi-select) | Dữ liệu từ `/api/remind/statuses`, **bắt buộc** |
| Due ≤ N ngày | Number input | Mặc định 5 — ngưỡng `due_days_threshold` |
| Assignee | Text input | domain.username, tuỳ chọn |
| Created From/To | Date inputs | Lọc theo `created_at` |

### 2.3 Progress states

- **Empty**: icon + "Nhấn Fetch để tải danh sách ticket"
- **Loading**: spinner + text cập nhật real-time:
  - Phase tickets: "Đang tải ticket... (page X/Y)"
  - Phase comments: "Đang kiểm tra comments... (X/Y tickets)"
- **Error**: thẻ đỏ + nút "Thử lại"
- **Done**: bảng ticket + summary bar

### 2.4 Summary bar (sau khi fetch xong)

```
Tìm thấy: 42  |  Cần nhắc: 12  |  Không due date: 5
[📋 Xem Danh Sách Remind (12)]
```

### 2.5 Ticket Table (10 cột)

| Cột | Field | Ghi chú |
|---|---|---|
| Ticket ID | `id` | Link `#id` → `ticket_url`, mở tab mới |
| Product | `product_id`, `product_code`, `product_name` | Format: `id - [code - name]` hoặc `id - [name]` nếu không có code |
| Title | `title` | Wrap text, `word-break: break-word` |
| Requester | `requester_name` | |
| Assignee | `assignee_name` | Mới — từ `handler.name` |
| Created | `created_at` | Format DD/MM/YYYY |
| Due Date | `due_date_fmt` | Format DD/MM/YYYY, `—` nếu không có |
| Expire In | `diff_days` | Pill: `-29d` (overdue), `3d` (urgent), `7d` (warning), `10d` (ok) |
| Need Remind | `need_remind` | Badge màu — xem mục 2.6 |
| Last Comment | `last_comment` | 3 dòng: name, notes (HTML stripped), created_on |

**Sort order:** `need_remind=true` trước, sau đó `diff_days` tăng dần (âm nhất lên đầu trong mỗi nhóm).

### 2.6 Row colors & Need Remind badges

**Row background (theo trạng thái):**

| Class | Điều kiện | Màu |
|---|---|---|
| `.tkr-row--reminded` | ticket đã được remind thành công trong session | `rgba(34,197,94,.12)` xanh lá — **ưu tiên cao nhất** |
| `.tkr-row--overdue` | `need_remind=true` và `diff_days < 0` | `rgba(248,113,113,.08)` đỏ |
| `.tkr-row--warning` | `need_remind=true` và `diff_days <= 3` | `rgba(251,191,36,.08)` vàng |
| `.tkr-row--remind` | `need_remind=true`, còn lại | `rgba(34,197,94,.05)` xanh nhạt |
| (none) | `need_remind=false` | mặc định |

**Need Remind badges:**

| Badge class | Hiển thị | Màu | Điều kiện |
|---|---|---|---|
| `.tkr-badge-reminded` | ✓ Reminded | Xanh lá (green), bold | `_sentTicketIds.has(t.id)` — đã gửi trong session |
| `.tkr-badge-remind` | ✓ Remind | Accent (tím) | `need_remind=true` |
| `.tkr-badge-skip` | — | Muted | `need_remind=false` |

**"Reminded" state:** lưu trong `_sentTicketIds` (Set) — reset khi Fetch mới hoặc Reset. Khi user click "Quay lại" từ remind view, bảng re-render với trạng thái đã được remind.

### 2.7 Expire In pill

| Class | Điều kiện | Text | Màu |
|---|---|---|---|
| `.tkr-expire--overdue` | `diff_days < 0` | `-Nd` | Đỏ |
| `.tkr-expire--urgent` | `diff_days <= 3` | `Nd` | Vàng |
| `.tkr-expire--warning` | `diff_days <= 7` | `Nd` | Cam nhạt |
| `.tkr-expire--ok` | `diff_days > 7` | `Nd` | Xanh |
| (empty) | `diff_days === null` | `—` | — |

---

## 3. View 2 — Remind List (trong `#tkr-result-area`)

Hiển thị khi user click "Xem Danh Sách Remind". Cùng container với bảng fetch.

### 3.1 Layout

```
[← Quay lại]  12 ticket cần nhắc

[● Remind All (12)]  [○ Chọn từng ticket]

[🔔 Gửi Remind (12)]

┌────┬──────┬──────────┬───────────┬────┬─────────────────────────────┐
│ ☐  │  ID  │ Product  │ Requester │Due │ Message Preview             │
├────┼──────┼──────────┼───────────┼────┼─────────────────────────────┤
│ ☐  │#1234 │ GameA    │ John Doe  │ 3d │ Hi John, …will expire on... │
└────┴──────┴──────────┴───────────┴────┴─────────────────────────────┘

[Send log — real-time append]
```

### 3.2 Send modes

- **Remind All**: gửi tất cả `need_remind=true` chưa có trong `_sentTicketIds`
- **Chọn từng ticket**: hiện cột checkbox — chỉ gửi dòng được check

Checkbox column header + per-row cells ẩn/hiện đồng thời khi đổi mode.

### 3.3 Sau khi gửi

- Log append real-time: `✅ #1234 → #channel` hoặc `❌ #1235 — Lỗi: ...`
- Row đã sent: `tkr-row--sent` (opacity giảm), checkbox disabled
- `_sentTicketIds.add(ticket_id)` cho mọi `status === "sent"`
- Khi click "Quay lại": bảng fetch re-render, các ticket đã remind hiển thị badge "Reminded" xanh

---

## 4. View 3 — Remind Config (`#tool-remind-config`)

### 4.1 Tabs

```
[Webhooks] [Templates] [Handlers] [Services] [Products] [Statuses] [Logs]
```

Lazy load: mỗi tab chỉ load khi user click lần đầu (`_configTabsLoaded[tab]`).

### 4.2 Tab Webhooks

**Bảng danh sách:** Product | Channel | Webhook URL (masked 30 chars) | Template | Default | Actions (✏ 🗑 ▶ Test)

**Thêm mới — Multi-row form:**
- Click "+ Thêm Webhook" → hiện bảng với 1 dòng trống
- "+ Thêm dòng" → append dòng mới ngay lập tức
- Mỗi dòng có: product picker (dropdown search), channel, URL, template select, default checkbox, ✕ remove
- "💾 Lưu tất cả (N)" → `Promise.all` save song song, label cập nhật theo số dòng
- Validation: product, channel, URL bắt buộc — báo lỗi trước khi save

**Product picker (per-row):**
- Trigger text click → dropdown search panel
- Dữ liệu từ `/api/remind/products?limit=500` (load khi mở tab)
- Search theo tên hoặc ID
- Close khi click outside (phát hiện bằng class `tkr-wh-row-product-panel`)

**Chỉnh sửa — Edit form:**
- Click ✏ → hiện inline form với text inputs (không có picker — product name đã biết)
- Direct PUT save

### 4.3 Tab Templates

Bảng: Tên | Preview (60 chars) | Default | Actions (✏ 🗑 👁 Preview)

Form thêm/sửa:
- Tên template
- Textarea nội dung (`{placeholder}`)
- Default checkbox
- Hint: `{requester_name} {product_name} {ticket_id} {due_date} {days_left} {time_label}`

### 4.4 Tab Handlers

Bảng: Username | Full Name | Note | 🗑

Form thêm: Username (required) | Full Name | Note

### 4.5 Tab Services

- Nút "⟳ Sync Services" → `POST /api/remind/services/sync`
- Bảng: ID | Name | Description

### 4.6 Tab Products

- Nút "⟳ Sync Products" → `POST /api/remind/products/sync`
- Bảng: ID | Name | Code | Alias
- Pagination: 100 records/trang, điều hướng bằng `goProductsPage(n)`

### 4.7 Tab Statuses

- Nút "⟳ Sync Statuses" → `POST /api/remind/statuses/sync`
- Bảng: ID | Name | Closed?

### 4.8 Tab Logs

- Filter: All | sent | failed | skipped
- Bảng: Ticket (link) | Product | Requester | Status | Sent At
- 50 records gần nhất

---

## 5. CSS Classes Reference (prefix: `tkr-`)

### Layout & Panel
| Class | Mô tả |
|---|---|
| `.tkr-panel` | Main panel wrapper |
| `.tkr-header` | Panel header với title + debug toggle |
| `.tkr-card` | Filter card |
| `.tkr-result-area` | Container cho empty/progress/table/remind view |
| `.tkr-table-wrap` | Scroll container cho table |

### Ticket Table
| Class | Mô tả |
|---|---|
| `.tkr-table--tickets` | Fixed layout, `min-width:1240px` |
| `.tkr-ticket-link` | Link `#id`, accent color, bold |
| `.tkr-product-cell` | Wrap text |
| `.tkr-title-cell` | Wrap text, `word-break: break-word` |
| `.tkr-expire` | Expire In pill base |
| `.tkr-expire--overdue/urgent/warning/ok` | Màu theo trạng thái |
| `.tkr-row--reminded` | Xanh lá đậm — đã remind thành công trong session |
| `.tkr-row--remind` | Xanh lá nhạt — cần nhắc |
| `.tkr-row--overdue` | Đỏ nhạt — quá hạn |
| `.tkr-row--warning` | Vàng nhạt — sắp hết hạn |
| `.tkr-row--sent` | Opacity 0.45 — đã gửi (trong remind view) |
| `.tkr-badge-reminded` | Badge xanh bold "✓ Reminded" |
| `.tkr-badge-remind` | Badge accent "✓ Remind" |
| `.tkr-badge-skip` | Badge muted "—" |
| `.tkr-last-comment` | Container 3 dòng: name / notes / date |
| `.tkr-lc-notes` | 2-line clamp |

### Config Panel
| Class | Mô tả |
|---|---|
| `.tkr-config-tabs` | Tab bar |
| `.tkr-config-tab-btn` | Tab button, `.active` = underline |
| `.tkr-tab-content` | Tab panel (show/hide) |
| `.tkr-config-table` | Config CRUD tables |
| `.tkr-inline-form` | Inline form, `.visible` = show |
| `.tkr-wh-rows-body` | Tbody của multi-row add form |
| `.tkr-wh-row-product-panel` | Row-scoped product picker panel |

---

## 6. Anti-regression rules (UI)

| Rule | Mô tả |
|---|---|
| **AX-23** | onclick với JSON data dùng `&quot;` encoding |
| **AX-25** | `boot()` / `bootConfig()` init 1 lần duy nhất |
| **AX-26** | KHÔNG gửi remind tự động |
| **AX-27** | `_sentTicketIds` reset khi fetch mới / reset filter |
| **AX-29** | CSS prefix `tkr-` — không conflict với `pl-`, `pls-`, `sdkv-` |
| **AX-33** | "Reminded" badge chỉ dựa vào `_sentTicketIds` — không lưu localStorage |
| **AX-34** | Multi-row webhook form dùng `rowId` làm DOM namespace cho picker |
