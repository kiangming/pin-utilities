# CLAUDE.md — PIN Utilities (SDK Config Analyzer + Game Launching Pipeline)

> Tài liệu này mô tả toàn bộ codebase, kiến trúc, tính năng, và quy tắc bất biến
> để Claude có thể tiếp tục phát triển chính xác trong các session tiếp theo.

---

## 1. Tổng quan project

| Thuộc tính | Giá trị |
|---|---|
| Tên sản phẩm | **PIN Utilities** — VNGGames Internal Tool |
| Kiến trúc | Frontend (Vanilla JS) + Backend (FastAPI Python) |
| File chính frontend | `frontend/index.html` |
| Backend entry | `backend/main.py` → FastAPI app |
| Chạy local | `python -m uvicorn backend.main:app --host 0.0.0.0 --port 8080` |
| Deploy | **Railway** via Dockerfile |
| Tech stack | Vanilla JS, CSS variables (multi-theme), FastAPI, Python 3.12 |
| Google OAuth | **Authorization Code Flow** (server-side) — KHÔNG dùng GIS implicit flow |

### Cấu trúc thư mục
```
PIN/
├── backend/
│   ├── main.py                  ← FastAPI app entry point
│   ├── config.py                ← Settings (pydantic-settings, đọc từ .env)
│   ├── requirements.txt
│   ├── sessions/                ← File-based session store (*.json)
│   ├── models/
│   │   └── schemas.py           ← Pydantic models: UserInfo, SessionData, BatchStartRequest, SheetsRefreshRequest
│   ├── middleware/
│   │   └── auth_guard.py        ← require_session() dependency, auto token refresh
│   ├── routers/
│   │   ├── auth.py              ← GET /auth/login, GET /auth/callback, POST /auth/logout, GET /auth/me
│   │   ├── bootstrap.py         ← GET /api/config, POST /api/batch, GET /api/batch/status
│   │   └── sheets.py            ← GET /api/sheets/{tab}, GET /api/sheets/all, POST /api/sheets/refresh
│   └── services/
│       ├── session_store.py     ← create/get/update/delete/purge_expired sessions
│       ├── oauth_service.py     ← build_auth_url, exchange_code, refresh_access_token, fetch_userinfo
│       ├── sheets_service.py    ← TTLCache fetch_tab/fetch_all/invalidate, parse_release/parse_close
│       └── bootstrap_service.py ← fetch_config (curl subprocess), start_batch (background thread), get_job
├── frontend/
│   ├── index.html               ← Main app (tất cả tools)
│   ├── login.html               ← Google login page
│   ├── css/
│   │   └── pipeline.css         ← Pipeline panel styles (prefix: pl-, pls-)
│   └── js/
│       ├── api-client.js        ← Wrapper fetch → backend, auto-redirect 401 → /login
│       └── pipeline/
│           ├── data-store.js    ← PipelineDataStore: in-memory + localStorage
│           ├── stats-renderer.js← PipelineStats: Stats Tab — KPI, alert, timeline (v3.0)
│           ├── renderer.js      ← PipelineRenderer: pure HTML generators (v2.0)
│           └── pipeline.js      ← PipelinePanel: controller (v4.0)
├── Dockerfile
├── railway.toml
├── .railwayignore
├── .env                         ← KHÔNG commit (xem .env.example)
├── .env.example
└── CLAUDE.md                    ← File này
```

---

## 2. Backend — Kiến trúc

### 2.1 Config (.env / Railway env vars)
```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://your-app.railway.app/auth/callback
SESSION_SECRET=random-secret-key
SESSION_TTL_SECONDS=604800        # 7 days
SHEETS_CACHE_TTL_SECONDS=300      # 5 min
PORT=8080                         # Railway inject tự động
```

### 2.2 Auth Flow (Authorization Code Flow)
```
User → GET /auth/login
  → redirect Google với state (CSRF) + code_challenge
Google → GET /auth/callback?code=...&state=...
  → exchange_code() → access_token + refresh_token
  → fetch userinfo → create session file
  → Set-Cookie: session_id (HTTP-only, Secure, SameSite=Lax)
  → redirect → /
```

- Session lưu trong `backend/sessions/{session_id}.json`
- Cookie HTTP-only → JS không đọc được session_id
- `require_session()` dependency tự động refresh token nếu gần hết hạn

### 2.3 API Endpoints

| Method | Path | Mô tả |
|---|---|---|
| GET | `/auth/login` | Redirect → Google OAuth |
| GET | `/auth/callback` | Exchange code, set session cookie, redirect → `/` |
| POST | `/auth/logout` | Delete session, clear cookie |
| GET | `/auth/me` | Trả userInfo từ session |
| GET | `/api/config?gameId=&platform=&country=` | Proxy Bootstrap API (1 game) |
| POST | `/api/batch` | Start batch job: `{ game_ids: [], countries: [] }` |
| GET | `/api/batch/status?jobId=` | Poll batch job progress |
| GET | `/api/sheets/{tab}` | Fetch 1 tab từ Google Sheets |
| GET | `/api/sheets/all?sheetUrl=` | Fetch tất cả tabs |
| POST | `/api/sheets/refresh` | Invalidate TTLCache |

### 2.4 main.py — App Setup
- Mount `frontend/` as `StaticFiles`
- Route `/login` → serve `frontend/login.html`
- Route `/` → nếu chưa có session → redirect `/login`; nếu có → serve `frontend/index.html`
- Background task: `purge_expired()` sessions mỗi giờ

---

## 3. Frontend — Kiến trúc

### 3.1 api-client.js
Wrapper tất cả API calls với `credentials: 'include'` (gửi cookie).
```js
ApiClient.get(path)         // → fetch GET, auto-redirect /login nếu 401
ApiClient.post(path, body)  // → fetch POST JSON
ApiClient.me()              // → GET /auth/me
ApiClient.logout()          // → POST /auth/logout → redirect /login
```

### 3.2 Script load order (index.html)
```
api-client.js → data-store.js → stats-renderer.js → renderer.js → pipeline.js
```
> `stats-renderer.js` phải load TRƯỚC `renderer.js` và `pipeline.js`.

### 3.3 PROXY constant
```js
const PROXY = '';  // same-origin — backend FastAPI xử lý /api/*
```
**KHÔNG** được set lại thành `http://localhost:8765` hoặc bất kỳ URL hardcode nào khác.

---

## 4. Tools trong app

### Tool 1: SDK Config Analyzer
- **Nav ID:** `tool-sdk-config`
- **Chức năng:** Upload hoặc nhập `games.txt` → fetch Bootstrap API cho từng game → phân tích SDK config
- **Backend call:** `GET ${PROXY}/api/config?gameId=&platform=&country=`
- **Rules bất biến (KHÔNG được thay đổi):**
  - `<thead>` KHÔNG hardcode — luôn render 100% qua JS
  - Platform icons: chỉ dùng `androidIcon(size)` / `appleIcon(size)` — KHÔNG dùng emoji/text
  - Hover rows: dùng CSS class `.tr-game`, `.tr-feature`, `.tr-country` — KHÔNG dùng inline `onmouseover`
  - Countries từ single source: `batchJobData?.countries`
  - Column order cố định: `Feature | Enabled | Android | iOS | [countries] | Rate | Bar`
  - Thêm feature mới: chỉ thêm vào arrays `FEATURE_COLS`, `FEATURES` — không sửa HTML tĩnh

### Tool 2: SDK Features Statistic
- **Nav ID:** `tool-batch-stats`
- **Chức năng:** Upload file `games.txt` từ máy local → parse game IDs client-side → gửi lên backend chạy batch → thống kê tổng hợp feature usage
- **Input:** `<input type="file" accept=".txt">` — KHÔNG dùng filepath text input
- **Flow:**
  1. User chọn file → `onBatchFileSelected()` enable nút Run
  2. `startBatch()` đọc file qua `file.text()`, parse game IDs client-side
  3. Gọi `POST /api/batch` với `{ game_ids: [...], countries: [...] }`
  4. Poll `GET /api/batch/status?jobId=` cho đến khi done

### Tool 3: Game Launching Pipeline
- **Nav ID:** `tool-pipeline`
- **Chức năng:** Theo dõi lịch trình CBT/OB của các game từ Google Sheet
- **Lazy boot:** `selectTool('pipeline')` → gọi `PipelinePanel.boot()` lần đầu tiên
- **Data source:** Google Sheets qua backend (`GET /api/sheets/all?sheetUrl=...`)
- **Không còn:** login overlay, GIS token client, `PipelineAuth`, `SheetsFetcher`

---

## 5. Game Launching Pipeline — Kiến trúc v4.0

### 5.1 Module dependencies
```
frontend/index.html
  └── api-client.js      → ApiClient
  └── data-store.js      → PipelineDataStore
  └── stats-renderer.js  → PipelineStats      (v3.0)
  └── renderer.js        → PipelineRenderer   (v2.0)
  └── pipeline.js        → PipelinePanel      (v4.0)
```

### 5.2 PipelinePanel v4.0 — thay đổi so với v3.0
- **Xóa:** `PipelineAuth`, `SheetsFetcher`, login overlay, `handleSignIn()`, `closeLoginOverlay()`
- **Thêm:** `fetchData()` gọi `ApiClient.get('/api/sheets/all?sheetUrl=...')`
- **Boot:** synchronous, không cần `.catch` cho auth errors
- **Không còn** `window.PIPELINE_CONFIG` block trong HTML

### 5.3 PipelinePanel — Public API
```js
PipelinePanel.boot()              // lazy init khi tab mở lần đầu (synchronous)
PipelinePanel.fetchData()         // Fetch button → ApiClient.get /api/sheets/all
PipelinePanel.switchTab(tab)      // 'release2026'|'release2025'|'close2026'|'close2025'
PipelinePanel.switchView(view)    // 'stats' | 'detail'
PipelinePanel.setStatusFilter(val)// 'all'|'On Process'|'Released'|'Terminated'|'Pending'
PipelinePanel.applyFilters()      // search/owner/market input oninput
PipelinePanel.setDateFilter()     // date picker onchange
PipelinePanel.clearDateFilter()   // nút ✕ Clear click
PipelinePanel.toggleDetail(uid,card) // card expand/collapse
```

### 5.4 Boot flow (v4.0)
1. Init `PipelineDataStore`
2. Restore sheet URL từ localStorage / stored data
3. Nếu có cache → render; nếu không → load demo data
4. **KHÔNG** hiện login overlay (đã bỏ hoàn toàn)

---

## 6. renderer.js v2.0 — Multi-group Display

### 6.1 Thay đổi chính (từ v1.0)
- **Xóa deduplication Set** — v1.0 dùng `seen = new Set()` khiến mỗi game chỉ xuất hiện ở 1 nhóm
- v2.0: mỗi nhóm evaluate điều kiện riêng → 1 game có thể xuất hiện ở **cả CBT và OB**

### 6.2 Group logic

| Group | Điều kiện | Hiện khi date filter? |
|---|---|---|
| 🧪 CBT / AT Stage | `cbtFrom` hợp lệ (≠ null, ≠ "No CBT", ≠ "TBU") | ✅ Luôn hiện |
| 🚀 OB Launch | `obDate` hợp lệ (≠ null, ≠ "TBU", ≠ "-") | ✅ Luôn hiện |
| ⚡ No CBT → Straight to OB | `cbtFrom === "No CBT"` AND `obDate` hợp lệ | ❌ Ẩn khi filter |
| ✅ Released | Không có CBT/OB hợp lệ, `status === "Released"` | ❌ Ẩn khi filter |
| ⏳ Pending / TBU | `status === "Pending"` hoặc `obDate === "TBU"` | ❌ Ẩn khi filter |
| ❌ Terminated | `status` là Terminated/Cancelled/Closed | ❌ Ẩn khi filter |

### 6.3 Signature
```js
PipelineRenderer.renderRelease(data, dateFrom = null, dateTo = null)
PipelineRenderer.renderClose(data)
PipelineRenderer.statusBadge(status)
PipelineRenderer.esc(str)
PipelineRenderer.fmtDate(isoStr)
```

### 6.4 Date filter helpers
```js
_hasCbt(g)                    // cbtFrom hợp lệ
_hasOb(g)                     // obDate hợp lệ
_cbtOverlaps(g, from, to)     // CBT interval overlap date window (null = unbounded)
_obInRange(g, from, to)       // OB date nằm trong date window
```

---

## 7. pipeline.js v3.0+ — Date Range Filter & View Switch

### 7.1 State
```js
let _dateFrom    = null;      // ISO "YYYY-MM-DD" hoặc null
let _dateTo      = null;
let _activeView  = 'detail';  // 'stats' | 'detail'
```

### 7.2 setDateFilter()
1. Đọc `#pl-date-from` và `#pl-date-to`
2. **Validation:** nếu cả 2 có giá trị và `f > t` → `_showDateWarning()`, return
3. Cập nhật `_dateFrom`, `_dateTo` → `_updateClearBtn()` → `_render()`

### 7.3 switchView(view)
1. Cập nhật `_activeView`
2. Toggle class `active` trên `.pl-vtab` buttons
3. Show/hide `#pl-stats-content` và `#pl-detail-content`
4. `_render()`

### 7.4 _render() — phân nhánh
```js
if (_activeView === 'stats') {
  PipelineStats.render(data, year);
  return;
}
content.innerHTML = isClose
  ? PipelineRenderer.renderClose(data)
  : PipelineRenderer.renderRelease(data, _dateFrom, _dateTo);
```

---

## 8. stats-renderer.js v1.0 — PipelineStats Module

### 8.1 Public API
```js
PipelineStats.render(games, year)   // render vào #pl-stats-content
PipelineStats.wireEvents()          // attach hover dialog + filter chips (tự gọi sau render)
```

### 8.2 Các thành phần UI

#### KPI Cards (`.pls-kpi-row`)
| Card | Nội dung |
|---|---|
| Total OB Launch | Số game có obDate hợp lệ trong năm |
| Total CBT/AT | Số game có cbtFrom hợp lệ |
| Sắp xảy ra ≤7d | Pulse animation |
| Tháng này | Event trong tháng hiện tại |

#### Alert Strip (`.pls-alert-strip`)
- **Urgent** (≤7d, đỏ, pulsing), **Warning** (8–14d, vàng), **Upcoming** (15–30d, teal)
- Mỗi card tối đa 5 game + "+N more"

#### Filter Chips
- **"Cả năm"** (`data-q="-1"`), **Q1–Q4** (`data-q="0..3"`), **12 month chips**

#### Timeline — Bifurcated
- CSS Grid `repeat(12, 1fr)` — không dùng D3/Canvas
- OB section: `.pls-ob-pill` (gradient tím, overflow:visible)
- CBT section: `.pls-cbt-pill` (gradient teal) + `.pls-cbt-cont` (continuation bar)

### 8.3 Hover Dialog (singleton `#pls-hover-dialog`)
- Tạo lazy, append vào `<body>`, position:fixed
- **Data encode:** `JSON.stringify(obj).replace(/"/g, '&quot;')` — KHÔNG dùng single-quote attribute
- Auto-flip above/below khi gần cạnh viewport

### 8.4 Bug Fixes đã áp dụng (BF-01→BF-06)
| Bug | Fix |
|---|---|
| BF-01: Scroll không hoạt động | `flex:1; min-height:0` trên `#pl-stats-content` và `#pl-detail-content` |
| BF-02: OB dot quá nhỏ | Thay `pls-ob-dot` bằng `pls-ob-pill` |
| BF-03: tl-cell clip pill | `height:100%; overflow:visible` trên `.pls-tl-row` và `.pls-tl-cell` |
| BF-04: timeline clip pill | Bỏ `overflow:hidden` trên `.pls-timeline` |
| BF-05: CBT pill vỡ dòng | Rewrite `_renderCbtRow()` dùng `pls-cbt-pill` + `pls-cbt-cont` |
| BF-06: Hover dialog không hiện | Fix selector typo + dùng `&quot;` thay `&#39;` cho data-game |

---

## 9. Theme System

### 9.1 5 Themes
| Theme | `data-theme` | Nền | Accent |
|---|---|---|---|
| Dark (default) | `dark` | `#0f1117` | `#6c63ff` |
| Light | `light` | `#f0f2f8` | `#4338ca` |
| Midnight | `midnight` | `#050508` | `#89b4fa` |
| Ocean | `ocean` | `#071221` | `#38bdf8` |
| Coffee | `coffee` | `#18110a` | `#f59e0b` |

### 9.2 CSS Variables (mỗi theme định nghĩa đầy đủ)
```css
--bg, --surface, --surface2
--border, --border2
--text, --text2, --text3
--accent, --accent2
--nav-bg, --header-bg
--input-bg, --btn-logout-bg, --btn-logout-border
```

### 9.3 setTheme() function
```js
function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  document.querySelectorAll('.theme-dot').forEach(d => {
    d.classList.toggle('active', d.dataset.t === theme);
  });
}
// Init on load: localStorage.getItem('theme') || 'dark'
```

### 9.4 Theme Picker UI (trong header)
```html
<div class="theme-picker">
  <span class="theme-dot active" data-t="dark"     onclick="setTheme('dark')"></span>
  <span class="theme-dot"        data-t="light"    onclick="setTheme('light')"></span>
  <span class="theme-dot"        data-t="midnight" onclick="setTheme('midnight')"></span>
  <span class="theme-dot"        data-t="ocean"    onclick="setTheme('ocean')"></span>
  <span class="theme-dot"        data-t="coffee"   onclick="setTheme('coffee')"></span>
</div>
```

### 9.5 CSS rules bất biến
- `.left-nav` background: `var(--nav-bg)` — **KHÔNG** hardcode màu hex
- `.nav-item.active` color: `var(--text)` — **KHÔNG** hardcode `#fff`
- Mọi màu UI phải dùng CSS variables, không hardcode hex trong các component chính

---

## 10. HTML Structure (frontend/index.html)

### 10.1 Header
```html
<header class="app-header">
  <div class="app-title">PIN Utilities</div>
  <div class="header-right">
    <div class="theme-picker">...</div>
    <span class="user-info">...</span>
    <button onclick="ApiClient.logout()">Logout</button>
  </div>
</header>
```

### 10.2 Layout
```
.app-wrapper
  ├── <header class="app-header">
  └── .app-body
        ├── <nav class="left-nav">   ← nav items, background: var(--nav-bg)
        └── .app-content
              └── .main (tool panels)
```

### 10.3 Pipeline Panel HTML additions (v3.0)
```html
<div class="pl-view-tabs" id="pl-view-tabs">
  <button class="pl-vtab" id="pl-vtab-stats" onclick="PipelinePanel.switchView('stats')">📊 Thống kê</button>
  <button class="pl-vtab active" id="pl-vtab-detail" onclick="PipelinePanel.switchView('detail')">📋 Chi tiết</button>
</div>
<div id="pl-stats-content"></div>
<div id="pl-detail-content" class="active">
  <div class="pl-controls">...</div>
  <div class="pl-content-wrap"><div id="pl-content"></div></div>
</div>
```

---

## 11. CSS Classes Reference

### Pipeline Detail View (prefix: `pl-`)
| Class | Mô tả |
|---|---|
| `.pl-date-input` | Native date picker, dark theme, focus glow |
| `.pl-clear-date` | Nút đỏ nhạt, ẩn mặc định |
| `.pl-date-warn` | Warning màu vàng (invalid range) |
| `.pl-date-active-banner` | Banner gradient tím khi filter active |
| `.pl-sec-cbt` / `.pl-sec-ob` / `.pl-sec-nocbt` | Section headers với màu tương ứng |
| `.pl-view-tabs` | Tab bar Stats/Chi tiết |
| `.pl-vtab` | Tab button, `.active` = underline teal |

### Pipeline Stats View (prefix: `pls-`)
Xem Section 8 — toàn bộ `pls-*` classes cho KPI, Alert Strip, Filter Chips, Timeline, Pills, Hover Dialog.

### Theme Switcher
| Class | Mô tả |
|---|---|
| `.theme-picker` | Flex row chứa dots |
| `.theme-dot` | Circle 18px, `data-t` = theme name |
| `.theme-dot.active` | Border = `var(--text)`, scale 1.15 |

---

## 12. Google OAuth Setup (Server-side)

### Yêu cầu
- Chạy backend FastAPI (local hoặc Railway) — **KHÔNG** chạy file:// hay static server
- Credentials trong `.env` — **KHÔNG** để lộ `GOOGLE_CLIENT_SECRET` ra frontend

### Google Cloud Console
1. APIs & Services → Credentials → OAuth 2.0 Client ID (Web application)
2. **Authorized redirect URIs:**
   - Local: `http://localhost:8080/auth/callback`
   - Railway: `https://your-app.railway.app/auth/callback`
3. Nếu app ở chế độ "Testing": thêm email vào Test users
4. Bật API: Google Sheets API v4

### Railway Deployment
```toml
# railway.toml
[build]
builder = "DOCKERFILE"
[deploy]
restartPolicyType = "ON_FAILURE"
```
Set env vars trên Railway dashboard: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `SESSION_SECRET`.

---

## 13. Data Model

### Game object (release tabs)
```js
{
  name: string,
  faCode: string,        // e.g., "A88", "C08/JV2"
  alias: string,
  owner: string,         // e.g., "GS1", "GS2"
  ranking: string,       // "SSS"|"SS"|"S"|"A"|"B"|"C"|""
  status: string,        // "On Process"|"Released"|"Terminated"|"Pending"
  cbtFrom: string|null,  // ISO date, "No CBT", "TBU", hoặc null
  cbtTo: string|null,
  cbtPlatform: string,
  obDate: string|null,
  obPlatform: string,
  markets: string[],
  kickstart: string|null,
  note: string
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
  closeDate: string
}
```

---

## 14. Anti-Regression Rules

| Rule | Mô tả |
|---|---|
| **AX-01** | Filter search, owner, market, status hoạt động đúng khi không có date filter |
| **AX-02** | Tab "2025 Launch", "2026 Closed", "2025 Closed" không bị ảnh hưởng bởi date filter |
| **AX-03** | Demo data load khi chưa fetch Sheet → hiện đúng cả 2 nhóm CBT + OB |
| **AX-04** | Expand/collapse game card detail (`toggleDetail`) không bị ảnh hưởng |
| **AX-05** | Google OAuth chạy server-side — KHÔNG import GIS script, KHÔNG dùng implicit flow |
| **AX-06** | CSS prefix `pl-` và `pls-` giữ nguyên, không conflict với main app styles |
| **AX-07** | `seen = new Set()` dedup logic KHÔNG được tái xuất hiện trong renderer.js |
| **AX-08** | Pipeline panel boot KHÔNG hiện login overlay (đã bỏ hoàn toàn) |
| **AX-09** | SDK Config Analyzer rules (thead qua JS, icon functions, CSS hover classes) giữ nguyên |
| **AX-10** | `const PROXY = ''` — KHÔNG hardcode localhost URL |
| **AX-11** | SDK Features Statistic dùng file upload, KHÔNG dùng text input filepath |
| **AX-12** | `.left-nav` background dùng `var(--nav-bg)`, `.nav-item.active` color dùng `var(--text)` |
| **AX-13** | Mọi màu UI component chính dùng CSS variables — KHÔNG hardcode hex color |

---

## 15. Lịch sử version

| Version | Ngày | Thay đổi chính |
|---|---|---|
| v1.0 | Mar 2026 | Single-file app, Google OAuth GIS implicit flow, modular pipeline |
| v2.0 | Mar 2026 | Multi-group display (no dedup), Date Range Filter, 66 QC tests |
| v3.0 | Mar 2026 | Stats Tab: KPI, Alert strip, Filter chips, Timeline OB/CBT + 6 bug fixes |
| **v4.0** | **Mar 2026** | **Frontend/Backend split, FastAPI, server-side OAuth, Railway deploy** |
| **v4.1** | **Mar 2026** | **SDK Features Statistic: file upload thay filepath; fix PROXY = '' same-origin** |
| **v4.2** | **Mar 2026** | **5-theme switcher (dark/light/midnight/ocean/coffee), left nav dùng CSS vars** |

### v4.0 chi tiết
- **Backend:** FastAPI, sessions file-based, Google OAuth Authorization Code Flow, TTLCache Sheets, Bootstrap proxy
- **Frontend:** Bỏ `auth.js`, `sheets-fetcher.js`, `window.PIPELINE_CONFIG`; thêm `api-client.js`
- **pipeline.js v4.0:** `fetchData()` gọi `ApiClient`, boot synchronous, không có login overlay
- **login.html:** Google login page riêng biệt, redirect từ `/` nếu chưa auth

### v4.1 chi tiết
- `startBatch()` parse file client-side qua `FileReader`, gửi `game_ids[]` lên `POST /api/batch`
- `const PROXY = ''` — backend cùng origin serve cả frontend lẫn API

### v4.2 chi tiết
- CSS: 5 `[data-theme]` blocks thay `:root` single block
- `setTheme(theme)` function + `initTheme()` IIFE từ localStorage
- `.theme-picker` với 5 `.theme-dot` trong header
- `.left-nav { background: var(--nav-bg) }` — bỏ hardcode `#13151f`
- `.nav-item.active { color: var(--text) }` — bỏ hardcode `#fff`

---

## 16. Hướng phát triển tiếp theo (Backlog)

- **v4.3:** Preset date ranges ("Tháng này", "Q2 2026", "30 ngày tới")
- **v4.3:** Export filtered data to Excel/CSV
- **v4.3:** Notification badge trên nav khi có CBT/OB trong 7 ngày tới
- **Future:** Date filter cho tab "Closed"
- **Future:** Lưu date range preference vào localStorage
- **Future:** Sorting/grouping trong Stats timeline theo owner hoặc market
- **Future:** Multi-user session management / role-based access
