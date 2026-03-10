# CLAUDE.md — SDK Config Analyzer + Game Launching Pipeline

> Tài liệu này mô tả toàn bộ codebase, kiến trúc, tính năng, và quy tắc bất biến
> để Claude có thể tiếp tục phát triển chính xác trong các session tiếp theo.

---

## 1. Tổng quan project

| Thuộc tính | Giá trị |
|---|---|
| Tên sản phẩm | **SDK Config Analyzer** — VNGGames Bootstrap Inspector |
| File chính | `sdk-config-analyzer.html` (single-file app, ~1700 lines) |
| Chạy local | `python3 serve.py` → `http://localhost:8080/sdk-config-analyzer.html` |
| Tech stack | Vanilla JS, CSS variables (dark theme), không dùng framework |
| Google OAuth | GIS token client (`accounts.google.com/gsi/client`), implicit flow |

### Cấu trúc thư mục
```
outputs/
├── sdk-config-analyzer.html     ← Main app (tất cả tools tích hợp vào đây)
├── serve.py                     ← Local HTTP server (bắt buộc cho Google OAuth)
├── SETUP_GOOGLE_OAUTH.md        ← Hướng dẫn cấu hình OAuth trên Google Cloud Console
├── CLAUDE.md                    ← File này
└── pipeline/
    ├── config/
    │   ├── google-auth.json     ← OAuth config (clientId, scopes, timeout)
    │   └── app-config.json      ← Sheet URL, tab names, fetchRangeRows
    ├── data/
    │   └── pipeline-data.json   ← Cache data (overwrite khi fetch)
    ├── modules/
    │   ├── auth.js              ← PipelineAuth: GIS token client, session storage
    │   ├── sheets-fetcher.js    ← SheetsFetcher: Google Sheets API v4
    │   ├── data-store.js        ← PipelineDataStore: in-memory + localStorage
    │   ├── stats-renderer.js    ← PipelineStats: Stats Tab — KPI, alert, timeline (v3.0)
    │   ├── renderer.js          ← PipelineRenderer: pure HTML generators (v2.0)
    │   └── pipeline.js          ← PipelinePanel: controller (v3.0)
    └── assets/
        └── pipeline.css         ← Styles (prefix: pl-), dark theme
```

---

## 2. Tools trong app

### Tool 1: SDK Config Analyzer
- **Nav ID:** `tool-sdkconfig`
- **Chức năng:** Parse file `games.txt` hoặc nhập path → phân tích SDK config của từng game
- **Rules bất biến (KHÔNG được thay đổi):**
  - `<thead>` KHÔNG hardcode — luôn render 100% qua JS
  - Platform icons: chỉ dùng `androidIcon(size)` / `appleIcon(size)` — KHÔNG dùng emoji/text
  - Hover rows: dùng CSS class `.tr-game`, `.tr-feature`, `.tr-country` — KHÔNG dùng inline `onmouseover`
  - Countries từ single source: `batchJobData?.countries`
  - Column order cố định: `Feature | Enabled | Android | iOS | [countries] | Rate | Bar`
  - Thêm feature mới: chỉ thêm vào arrays `FEATURE_COLS`, `FEATURES` — không sửa HTML tĩnh

### Tool 2: SDK Features Statistic
- **Nav ID:** `tool-batch-stats`
- **Chức năng:** Thống kê tổng hợp feature usage từ nhiều game

### Tool 3: Game Launching Pipeline
- **Nav ID:** `tool-pipeline`
- **Chức năng:** Theo dõi lịch trình CBT/OB của các game từ Google Sheet
- **Lazy boot:** `selectTool('pipeline')` → gọi `PipelinePanel.boot()` lần đầu tiên

---

## 3. Game Launching Pipeline — Kiến trúc chi tiết

### 3.1 Module dependencies
```
sdk-config-analyzer.html
  └── <script> window.PIPELINE_CONFIG   ← inline config (hoạt động với file://)
  └── auth.js           → PipelineAuth
  └── sheets-fetcher.js → SheetsFetcher
  └── data-store.js     → PipelineDataStore
  └── stats-renderer.js → PipelineStats      (v3.0 — MỚI)
  └── renderer.js       → PipelineRenderer
  └── pipeline.js       → PipelinePanel (controller)
```

> **Thứ tự load script quan trọng:** `stats-renderer.js` phải load TRƯỚC `renderer.js` và `pipeline.js` vì `pipeline.js` gọi `PipelineStats.render()` trực tiếp.

### 3.2 Config inline (quan trọng)
`window.PIPELINE_CONFIG` được nhúng thẳng trong HTML để hoạt động với `file://` protocol.
Khi cần cập nhật `clientId` hoặc `sheetTabs`, sửa tại block này trong HTML:

```html
<script>
window.PIPELINE_CONFIG = {
  googleAuth: {
    clientId: "YOUR_CLIENT_ID.apps.googleusercontent.com",
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    fetchTimeoutMs: 30000,
    sessionStorageKey: "pipeline_gauth_token",
    tokenExpiryBufferSec: 120
  },
  app: {
    sheetUrl: "",
    sheetTabs: {
      release2026: "List game release 2026",
      release2025: "List game release 2025",
      close2026:   "List game close 2026",
      close2025:   "List game close 2025"
    },
    fetchRangeRows: 300
  }
};
</script>
```

### 3.3 PipelinePanel — Public API
```js
PipelinePanel.boot()                  // lazy init khi tab mở lần đầu
PipelinePanel.handleSignIn()          // Google sign-in button click
PipelinePanel.closeLoginOverlay()     // Cancel / backdrop click
PipelinePanel.fetchData()             // Fetch button
PipelinePanel.switchTab(tab)          // 'release2026'|'release2025'|'close2026'|'close2025'
PipelinePanel.switchView(view)        // 'stats' | 'detail'  — toggle Stats ↔ Chi tiết (v3.0)
PipelinePanel.setStatusFilter(val)    // 'all'|'On Process'|'Released'|'Terminated'|'Pending'
PipelinePanel.applyFilters()          // search/owner/market input oninput
PipelinePanel.setDateFilter()         // date picker onchange (v2.0)
PipelinePanel.clearDateFilter()       // nút ✕ Clear click (v2.0)
PipelinePanel.toggleDetail(uid,card)  // card expand/collapse
```

### 3.4 Boot flow
1. Đọc `window.PIPELINE_CONFIG` (fallback: fetch JSON nếu chạy qua HTTP)
2. Init `PipelineAuth`, `SheetsFetcher`, `PipelineDataStore`
3. Restore sheet URL từ config / stored data
4. Update auth button state
5. Nếu có cache → render; nếu không → load demo data
6. **KHÔNG** tự hiện login overlay — chỉ hiện khi user click "Sign in with Google" hoặc fetch fail do auth expired

### 3.5 Login overlay behavior
- Hiện khi: user click nút **Sign in with Google** hoặc fetch trả về `AUTH_EXPIRED`
- Ẩn khi: sign-in thành công hoặc user click **Cancel / backdrop**
- Cancel → `closeLoginOverlay()` → nếu chưa có data thì load demo

---

## 4. renderer.js v2.0 — Multi-group Display

### 4.1 Thay đổi chính (từ v1.0)
- **Xóa deduplication Set** — v1.0 dùng `seen = new Set()` khiến mỗi game chỉ xuất hiện ở 1 nhóm
- v2.0: mỗi nhóm evaluate điều kiện riêng → 1 game có thể xuất hiện ở **cả CBT và OB**

### 4.2 Group logic

| Group | Điều kiện | Hiện khi date filter? |
|---|---|---|
| 🧪 CBT / AT Stage | `cbtFrom` hợp lệ (≠ null, ≠ "No CBT", ≠ "TBU") | ✅ Luôn hiện |
| 🚀 OB Launch | `obDate` hợp lệ (≠ null, ≠ "TBU", ≠ "-") | ✅ Luôn hiện |
| ⚡ No CBT → Straight to OB | `cbtFrom === "No CBT"` AND `obDate` hợp lệ | ❌ Ẩn khi filter |
| ✅ Released | Không có CBT/OB hợp lệ, `status === "Released"` | ❌ Ẩn khi filter |
| ⏳ Pending / TBU | `status === "Pending"` hoặc `obDate === "TBU"` | ❌ Ẩn khi filter |
| ❌ Terminated | `status` là Terminated/Cancelled/Closed | ❌ Ẩn khi filter |

### 4.3 Signature
```js
// dateFrom / dateTo: ISO "YYYY-MM-DD" strings hoặc null
PipelineRenderer.renderRelease(data, dateFrom = null, dateTo = null)
PipelineRenderer.renderClose(data)
PipelineRenderer.statusBadge(status)
PipelineRenderer.esc(str)
PipelineRenderer.fmtDate(isoStr)
```

### 4.4 Date filter helpers
```js
_hasCbt(g)                    // cbtFrom hợp lệ
_hasOb(g)                     // obDate hợp lệ
_cbtOverlaps(g, from, to)     // CBT interval overlap date window (null = unbounded)
_obInRange(g, from, to)       // OB date nằm trong date window
```

---

## 5. pipeline.js v2.0 — Date Range Filter

### 5.1 State mới
```js
let _dateFrom = null;   // ISO "YYYY-MM-DD" hoặc null
let _dateTo   = null;
```

### 5.2 setDateFilter()
1. Đọc `#pl-date-from` và `#pl-date-to`
2. **Validation FR-07:** nếu cả 2 có giá trị và `f > t` → `_showDateWarning()`, return sớm
3. Cập nhật `_dateFrom`, `_dateTo`
4. `_updateClearBtn()` — show/hide nút Clear
5. `_render()`

### 5.3 clearDateFilter()
1. Reset `_dateFrom = null`, `_dateTo = null`
2. Xóa value của 2 input
3. `_hideDateWarning()`
4. `_updateClearBtn()`
5. `_render()`

### 5.4 _render() — pass date params
```js
content.innerHTML = isClose
  ? PipelineRenderer.renderClose(data)
  : PipelineRenderer.renderRelease(data, _dateFrom, _dateTo);  // v2.0
```

---

## 6. HTML Controls Bar — Date Filter UI

Vị trí inject: trong `#pl-controls`, sau status filter buttons, trước `pl-count`.

```html
<!-- Date Range Filter (v2.0) -->
<span class="pl-date-sep">📅 Từ</span>
<input type="date" id="pl-date-from" class="pl-date-input"
  aria-label="Start date filter"
  onchange="PipelinePanel.setDateFilter()" />
<span class="pl-date-sep">đến</span>
<input type="date" id="pl-date-to" class="pl-date-input"
  aria-label="End date filter"
  onchange="PipelinePanel.setDateFilter()" />
<button class="pl-clear-date" id="pl-clear-date"
  onclick="PipelinePanel.clearDateFilter()">✕ Clear</button>
<div class="pl-date-warn" id="pl-date-warn">⚠️ End date phải sau start date</div>
```

**Hành vi:**
- `pl-clear-date`: `display:none` mặc định, JS show/hide qua `_updateClearBtn()`
- `pl-date-warn`: `display:none` mặc định, JS show/hide qua `_showDateWarning()`
- Khi date filter active: banner `pl-date-active-banner` hiện trong content area

---

## 7. pipeline.js v3.0 — Stats Tab View Switch

### 7.1 State mới
```js
let _activeView = 'detail'; // 'stats' | 'detail'
```

### 7.2 switchView(view)
1. Cập nhật `_activeView`
2. Toggle class `active` trên các `.pl-vtab` button
3. Show/hide `#pl-stats-content` và `#pl-detail-content` qua class `active`
4. Gọi `_render()` để render đúng view

### 7.3 _render() — phân nhánh theo view
```js
if (_activeView === 'stats') {
  PipelineStats.render(data, year);   // year = 2025 hoặc 2026 theo _activeTab
  return;                              // return sớm, không render detail
}
// else: render detail như cũ
```

### 7.4 HTML additions (sdk-config-analyzer.html)
```html
<!-- Inner view switcher — nằm giữa pl-tabs và pl-detail-content -->
<div class="pl-view-tabs" id="pl-view-tabs">
  <button class="pl-vtab" id="pl-vtab-stats"
    onclick="PipelinePanel.switchView('stats')">📊 Thống kê</button>
  <button class="pl-vtab active" id="pl-vtab-detail"
    onclick="PipelinePanel.switchView('detail')">📋 Chi tiết</button>
</div>

<!-- Stats view container (empty on load, filled by PipelineStats.render) -->
<div id="pl-stats-content"></div>

<!-- Detail view wrapper (bao bọc controls + pl-content) -->
<div id="pl-detail-content" class="active">
  <div class="pl-controls">...</div>
  <div class="pl-content-wrap"><div id="pl-content"></div></div>
</div>
```

---

## 8. stats-renderer.js v1.0 — PipelineStats Module

### 8.1 Public API
```js
PipelineStats.render(games, year)   // render toàn bộ Stats view vào #pl-stats-content
PipelineStats.wireEvents()          // attach hover dialog + filter chip events (tự động gọi sau render)
```

### 8.2 Các thành phần UI

#### KPI Cards (4 cards — `.pls-kpi-row`)
| Card | Class | Nội dung |
|---|---|---|
| Total OB Launch | `.pls-kpi.ob` | Số game có obDate hợp lệ trong năm |
| Total CBT/AT | `.pls-kpi.cbt` | Số game có cbtFrom hợp lệ |
| Sắp xảy ra ≤7d | `.pls-kpi.alert` | Số game OB/CBT trong 7 ngày tới — pulse animation |
| Tháng này | `.pls-kpi.month` | Số game có event trong tháng hiện tại |

#### Alert Strip (`.pls-alert-strip`)
3 alert cards tự động ẩn nếu trống:
- **Urgent** (≤7d, đỏ, pulsing): `.pls-alert-card.urgent`
- **Warning** (8–14d, vàng dashed): `.pls-alert-card.warning`
- **Upcoming** (15–30d, teal): `.pls-alert-card.info`

Mỗi card hiện tối đa 5 game, nếu nhiều hơn thì hiện "+N more".

#### Filter Chips (`.pls-filter-row`)
- **"Cả năm"** (`.pls-qchip`, `data-q="-1"`): reset, highlight tất cả columns
- **Q1–Q4** (`.pls-qchip`, `data-q="0..3"`): activate 3 tháng con
- **12 month chips** (`.pls-mchip`, `data-month="0..11"`): highlight/dim columns timeline

Khi chip active → columns không thuộc filter bị dim (`.pls-month-col.dimmed` + `.pls-tl-cell.dimmed`).

#### Timeline — Bifurcated (`.pls-timeline`)
```
┌─────────────────────────────────────────────────────────┐
│  Jan    Feb    Mar    Apr    May    Jun   ...  Dec       │  ← month header + count badges
├─────────────────────────────────────────────────────────┤
│  🚀 OB LAUNCH SCHEDULE                                   │  ← section label
│  ████ Game A  76d     ████ Game B  22d                  │  ← ob-rows (pill bars)
├── ─ ─ ─ OB Launch (trên) ─ ─ CBT/AT Stage (dưới) ─ ─ ─ ┤  ← divider
│  🧪 CBT / AT STAGE SCHEDULE                              │  ← section label
│  ████████ Game X  37d    ████ Game Y  5d               │  ← cbt-rows (pill bars)
└─────────────────────────────────────────────────────────┘
```

Layout: CSS Grid `grid-template-columns: repeat(12, 1fr)` — không dùng D3/Canvas.

**Month header row** (`.pls-tl-months`): 12 cells, mỗi cell hiện `[N OB · N CBT]` badge.  
**OB section**: mỗi game = 1 `.pls-tl-row.ob-row` (height 28px) — pill bắt đầu tại % trong tháng, overflow sang cell bên cạnh.  
**CBT section**: mỗi game = 1 `.pls-tl-row` (height 26px) — pill tại cell bắt đầu + continuation bar mờ cho các tháng tiếp theo.

### 8.3 OB Pill (`.pls-ob-pill`)
```js
// Render tại fromPos.col, overflow sang phải qua overflow:visible
<div class="pls-ob-pill [alert-7|alert-14]" style="left:X%">
  🚀 {gameName} <span class="pls-ob-pill-cd">{Nd}</span>
</div>
```
- Màu mặc định: gradient tím `#6c63ff → #8b85ff`
- Alert-7: gradient đỏ + pulse animation
- Alert-14: gradient amber

### 8.4 CBT Pill (`.pls-cbt-pill`) + Continuation (`.pls-cbt-cont`)
```js
// Cell đầu (isFirst): pill với tên + countdown
<div class="pls-cbt-pill [alert-7|alert-14]" style="left:X%">
  🧪 {gameName} <span class="pls-cbt-pill-cd">{Nd}</span>
</div>

// Các cell tiếp theo nếu CBT kéo dài nhiều tháng: bar mờ 6px
<div class="pls-cbt-cont [alert-7|alert-14]" style="left:X%;width:Y%"></div>
```
- Màu mặc định: gradient teal `#22d3ee → #67e8f9`

### 8.5 Hover Dialog (singleton `#pls-hover-dialog`)
- Tạo lazy, append vào `<body>`, position:fixed
- Trigger: `mouseover` trên `.pls-ob-pill[data-game]` hoặc `.pls-cbt-pill[data-game]`
- Data encode: `JSON.stringify(obj).replace(/"/g, '&quot;')` — double-quote attribute, browser decode `&quot;` → `"` → valid JSON
- Auto-flip vị trí above/below khi gần cạnh viewport
- Hide delay 100ms (hovering vào dialog giữ nó mở)
- Top accent bar: tím=OB, teal=CBT, đỏ=alert-7, vàng=alert-14

### 8.6 Helper functions
```js
_parseDate(iso)           // null nếu iso là "TBU"|"No CBT"|"-"|invalid
_daysFromNow(iso)         // số ngày từ hôm nay (âm = quá khứ)
_alertClass(days)         // '' | 'alert-7' | 'alert-14'
_dateToPos(iso, year)     // {col: 0-11, pct: 0-100} hoặc null nếu không trong year
_hasOb(g)                 // obDate hợp lệ (≠ null, ≠ TBU, ≠ -)
_hasCbt(g)                // cbtFrom hợp lệ
_computeMonthCounts(ob,cbt,year)  // {ob:[12], cbt:[12]} count per month
_gameDataAttr(g, type)    // JSON.stringify → escape &quot; cho data-game attribute
```

---

## 9. CSS v3.0 — Stats Tab Classes (prefix: `pls-`)

> **Quy tắc prefix:** tất cả class của Stats Tab dùng `pls-` (pipeline-stats) để tách biệt với `pl-` của Detail view.

#### Layout containers
| Class | Mô tả |
|---|---|
| `.pl-view-tabs` | Tab bar "Thống kê / Chi tiết" |
| `.pl-vtab` | Từng tab button, `.active` = underline teal |
| `#pl-stats-content` | Flex column, overflow-y:auto, flex:1 — scrollable container |
| `#pl-detail-content` | Flex column, flex:1 — wrapper của detail view |

#### KPI
| Class | Mô tả |
|---|---|
| `.pls-kpi-row` | Flex row của 4 KPI cards |
| `.pls-kpi` | Card với left accent bar, variants: `.ob` `.cbt` `.alert` `.month` |
| `.pls-kpi-value` | Số lớn, màu theo variant |
| `.pls-kpi-label` | Label nhỏ |
| `.pls-kpi-sub` | Sub-text nhỏ hơn |

#### Alert Strip
| Class | Mô tả |
|---|---|
| `.pls-alert-strip` | Flex wrap row |
| `.pls-alert-card` | Card với left bar, variants: `.urgent` `.warning` `.info` |
| `.pls-alert-item` | Mỗi game trong card |
| `.pls-alert-dot` | Chấm màu theo loại event (OB/CBT) |
| `.pls-alert-days` | Badge ngày countdown |

#### Filter Chips
| Class | Mô tả |
|---|---|
| `.pls-filter-row` | Flex row chứa chips |
| `.pls-qchip` | Chip Quarter (Q1–Q4 + Cả năm), `.active` |
| `.pls-mchip` | Chip Month, `.active` |
| `.pls-chips-div` | Divider mờ giữa các nhóm chip |

#### Timeline
| Class | Mô tả |
|---|---|
| `.pls-timeline` | Container chính, border-radius 12px |
| `.pls-tl-header` | Title + legend row |
| `.pls-tl-body` | Chứa months + sections |
| `.pls-tl-months` | Grid 12 cột — month header row |
| `.pls-month-col` | 1 cột tháng, `.current` `.has-events` `.highlighted` `.dimmed` |
| `.pls-month-badge` | Badge `[N OB · N CBT]` |
| `.pls-tl-row` | Grid 12 cột — 1 game swim lane (height 26px) |
| `.pls-tl-row.ob-row` | OB swim lane (height 28px) |
| `.pls-tl-cell` | 1 cell trong grid, `overflow:visible` — cho phép pill tràn sang ô kế |
| `.pls-tl-section-label` | Label "OB LAUNCH SCHEDULE" / "CBT / AT STAGE SCHEDULE" |
| `.pls-tl-divider` | Dashed divider giữa OB và CBT section |

#### OB Pill
| Class | Mô tả |
|---|---|
| `.pls-ob-pill` | Pill bar tím gradient, flex, height 18px, `overflow:visible` trên parent |
| `.pls-ob-pill.alert-7` | Đỏ + pulse |
| `.pls-ob-pill.alert-14` | Amber |
| `.pls-ob-pill-cd` | Badge countdown trong pill |

#### CBT Pill
| Class | Mô tả |
|---|---|
| `.pls-cbt-pill` | Pill bar teal gradient, flex, height 18px |
| `.pls-cbt-pill.alert-7` | Đỏ + pulse |
| `.pls-cbt-pill.alert-14` | Amber |
| `.pls-cbt-pill-cd` | Badge countdown trong pill |
| `.pls-cbt-cont` | Continuation bar mờ 6px cho tháng tiếp theo của CBT |

#### Hover Dialog
| Class | Mô tả |
|---|---|
| `.pls-hover-dialog` | Singleton fixed dialog, opacity transition |
| `.pls-hover-dialog.visible` | Hiện ra |
| `.pls-hd-top` | Accent bar header, variants: `.type-ob` `.type-cbt` `.alert-7` `.alert-14` |
| `.pls-hd-name` | Tên game lớn |
| `.pls-hd-alias` | FA Code / alias |
| `.pls-hd-date-row` | Row ngày tháng |
| `.pls-hd-cd` | Countdown badge, variants: `.urgent` `.warning` `.normal` `.past` |
| `.pls-hd-markets` | Flex wrap market tags |

---

## 10. Bug Fixes Log — v3.0

### BF-01: Scroll không hoạt động (Stats + Detail view)
**Nguyên nhân:** Flex layout chain bị đứt:
- `#pl-detail-content.active { display:block }` → `.pl-content-wrap { flex:1 }` vô hiệu
- `#pl-stats-content` không có `flex:1; min-height:0`

**Fix CSS:**
```css
#pl-stats-content { display:none; flex-direction:column; overflow-y:auto; flex:1; min-height:0; }
#pl-stats-content.active { display:flex; }
#pl-detail-content { display:none; flex-direction:column; flex:1; min-height:0; }
#pl-detail-content.active { display:flex; }
```

### BF-02: OB timeline không hiển thị (dùng dot 12px)
**Nguyên nhân:** `pls-ob-dot` (circle 12px) quá nhỏ, không rõ trên dark background. Label tên game được render tách biệt và không có style đủ để nhìn thấy.

**Fix:** Thay toàn bộ bằng `pls-ob-pill` — pill bar gradient có tên game + countdown bên trong, min-width 60px, `display:flex; align-items:center`.

### BF-03: pls-tl-cell clip OB pill
**Nguyên nhân:** `.pls-tl-cell { height:26px }` cứng thay vì `height:100%`, cùng với `overflow` mặc định clip nội dung absolute.

**Fix:** `height:100%; overflow:visible` trên cả `.pls-tl-row` và `.pls-tl-cell`.

### BF-04: pls-timeline overflow:hidden clip nội dung
**Nguyên nhân:** `.pls-timeline { overflow:hidden; border-radius:12px }` tạo stacking context, clip absolute-positioned pill elements.

**Fix:** Bỏ `overflow:hidden` — `border-radius` hoạt động độc lập, không cần overflow:hidden.

### BF-05: CBT section chỉ thấy dot nhỏ, tên game vỡ dòng
**Nguyên nhân (3 bugs):**
1. `pls-cbt-label` không có CSS → text float tự do, vỡ dòng
2. `pls-cbt-bar` dùng 2 elements tách rời (bar + label) không đồng bộ
3. Bar quá hẹp khi CBT ngắn → thu lại thành dot do border-radius

**Fix:** Rewrite `_renderCbtRow()` dùng `pls-cbt-pill` (giống OB pill) + `pls-cbt-cont` cho tháng kéo dài.

### BF-06: Hover dialog không xuất hiện
**Nguyên nhân 1:** Selector typo `#pls-stats-content` (thêm 's') → `getElementById` trả null → wireEvents không attach.

**Nguyên nhân 2:** `data-game` dùng single-quote attribute + `replace(/'/g, '&#39;')` → browser decode `&#39;` → `'` trong `getAttribute()` → `JSON.parse()` throw → dialog silently skip.

**Fix:**
```js
// Dùng double-quote attribute + escape " thành &quot;
const safe = obj => JSON.stringify(obj).replace(/"/g, '&quot;');
data-game="${safe(gameObj)}"
// Browser decode &quot; → " → JSON.parse() hợp lệ ✓
```

---

## 11. CSS v2.0 — Classes mới (Detail View)

| Class | Mô tả |
|---|---|
| `.pl-date-input` | Native date picker, dark theme, focus glow |
| `.pl-date-sep` | Label "Từ" / "đến" nhỏ |
| `.pl-clear-date` | Nút đỏ nhạt, ẩn mặc định |
| `.pl-date-warn` | Warning màu vàng (invalid range) |
| `.pl-date-active-banner` | Banner gradient tím khi filter đang active |
| `.pl-banner-note` | Sub-text italic trong banner |
| `.pl-sec-cbt` | Section header teal cho CBT group |
| `.pl-sec-ob` | Section header purple cho OB group |
| `.pl-sec-nocbt` | Section header amber cho No-CBT group |
| `.pl-name-row` | Flex row cho rank badge + game name |

Tất cả CSS prefix bằng `pl-` để tránh conflict với main app.

---

## 12. Google OAuth Setup

### Yêu cầu
- Phải chạy qua HTTP server (`python3 serve.py`), KHÔNG dùng `file://`
- `clientId` cấu hình trong `window.PIPELINE_CONFIG.googleAuth.clientId` (inline trong HTML)

### Google Cloud Console
1. APIs & Services → Credentials → OAuth 2.0 Client ID (Web application)
2. **Authorized JavaScript origins:** thêm `http://localhost:8080` (không có dấu `/` cuối)
3. **KHÔNG cần** Authorized redirect URIs (GIS implicit flow không dùng)
4. Nếu app ở chế độ "Testing": thêm email vào Test users

### Lỗi `storagerelay://`
Nguyên nhân: `Authorized JavaScript origins` chưa có `http://localhost:8080`.
Fix: thêm origin đúng trên Google Cloud Console → chờ 1-5 phút → reload.

---

## 13. Data Model

### Game object (release tabs)
```js
{
  name: string,          // Tên game
  faCode: string,        // FA Code (e.g., "A88", "C08/JV2")
  alias: string,         // Alias ngắn
  owner: string,         // GS team (e.g., "GS1", "GS2")
  ranking: string,       // "SSS"|"SS"|"S"|"A"|"B"|"C"|""
  status: string,        // "On Process"|"Released"|"Terminated"|"Pending"
  cbtFrom: string|null,  // ISO date, "No CBT", "TBU", hoặc null
  cbtTo: string|null,    // ISO date, "TBU", hoặc null
  cbtPlatform: string,   // e.g., "IOS, AOS", "TBU"
  obDate: string|null,   // ISO date, "TBU", hoặc null
  obPlatform: string,    // e.g., "Mobile (AOS, IOS), PC"
  markets: string[],     // e.g., ["VN", "TH", "ID"]
  kickstart: string|null,// ISO date
  note: string           // Ghi chú tự do
}
```

### Close game object (close tabs)
```js
{
  faCode: string,
  alias: string,
  name: string,
  markets: string[],
  productType: string,   // "Mobile", "PC"
  status: string,        // "Closed", "Closing"
  owner: string,
  closeDate: string      // ISO date
}
```

---

## 14. Anti-Regression Rules

> **KHÔNG** được phá vỡ những rule này khi implement feature mới:

| Rule | Mô tả |
|---|---|
| **AX-01** | Filter search, owner, market, status hoạt động đúng khi không có date filter |
| **AX-02** | Tab "2025 Launch", "2026 Closed", "2025 Closed" không bị ảnh hưởng bởi date filter |
| **AX-03** | Demo data load khi chưa có Google Sheet → hiện đúng cả 2 nhóm CBT + OB |
| **AX-04** | Expand/collapse game card detail (`toggleDetail`) không bị ảnh hưởng |
| **AX-05** | Google OAuth flow và fetch data không thay đổi |
| **AX-06** | CSS prefix `pl-` giữ nguyên, không conflict với main app styles |
| **AX-07** | `seen = new Set()` dedup logic KHÔNG được tái xuất hiện trong renderer.js |
| **AX-08** | Login overlay KHÔNG tự hiện khi panel mở lần đầu (chỉ hiện khi user chủ động) |
| **AX-09** | SDK Config Analyzer rules (Rule 1-6 từ PRD Section 7) vẫn giữ nguyên |

---

## 15. QC Test Suite

File test: `run_qc.js` (chạy bằng `node run_qc.js` trong thư mục outputs)

**Coverage: 66 tests — AC-01 đến AC-11 + EXTRA + STATIC checks**

```bash
node run_qc.js
# Expected: 66/66 passed — v2.0 APPROVED FOR RELEASE
```

Các nhóm test:
- **AC-01→11:** Acceptance Criteria từ PRD v2.0
- **EXTRA-01→02:** Edge cases (empty state, renderClose không bị ảnh hưởng)
- **S-01→09:** pipeline.js static checks
- **R-01→09:** renderer.js static checks
- **H-01→09:** HTML structure checks
- **C-01→07:** CSS class checks

---

## 16. Lịch sử version

| Version | Ngày | Thay đổi chính |
|---|---|---|
| v1.0 | Mar 2026 | Build pipeline panel từ đầu, Google OAuth, modular refactor, demo data |
| v1.1 | Mar 2026 | Fix SVG Google icon size, fix boot flow (login overlay không tự block), closeLoginOverlay() |
| v1.2 | Mar 2026 | Fix inline config (window.PIPELINE_CONFIG), serve.py, fix Authorized JavaScript origins |
| **v2.0** | **Mar 2026** | **Multi-group display (no dedup), Date Range Filter với date picker, 66 QC tests** |
| **v3.0** | **Mar 2026** | **Stats Tab: KPI cards, Alert strip, Filter chips, Timeline bifurcated OB/CBT + 6 bug fixes** |

### v2.0 chi tiết
- `renderer.js`: xóa `seen = new Set()`, CBT và OB group evaluate độc lập, `renderRelease(data, dateFrom, dateTo)`
- `pipeline.js`: thêm `_dateFrom/_dateTo` state, `setDateFilter()`, `clearDateFilter()`, `_updateClearBtn()`, `_showDateWarning()`
- `sdk-config-analyzer.html`: inject 2 date inputs + Clear button + warning vào `#pl-controls`
- `pipeline.css`: thêm `.pl-date-input`, `.pl-clear-date`, `.pl-date-active-banner`, `.pl-date-warn`, section color variants

### v3.0 chi tiết
- **`stats-renderer.js`** (module mới, 666 lines): `PipelineStats.render(games, year)` + `wireEvents()`
- **`pipeline.js`**: thêm `_activeView` state, `switchView(view)`, `_render()` phân nhánh stats/detail
- **`sdk-config-analyzer.html`**: thêm `.pl-view-tabs` với 2 buttons, `#pl-stats-content`, wrap detail vào `#pl-detail-content`
- **`pipeline.css`**: thêm toàn bộ `pls-*` classes (~360 lines) cho stats tab
- **Bug fixes BF-01→BF-06:** scroll chain (flex:1/min-height:0), OB dot→pill, tl-cell overflow:visible, timeline overflow:hidden, CBT pill rewrite, hover dialog JSON encoding

---

## 17. Hướng phát triển tiếp theo (Backlog)

- **v3.1:** Preset date ranges ("Tháng này", "Q2 2026", "30 ngày tới") cho Detail view
- **v3.1:** Export filtered data to Excel/CSV
- **v3.1:** Notification badge trên nav khi có CBT/OB trong 7 ngày tới
- **Future:** Date filter cho tab "Closed"
- **Future:** Lưu date range preference vào localStorage
- **Future:** Sorting/grouping trong Stats timeline theo owner hoặc market
