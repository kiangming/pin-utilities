# CLAUDE.md — PIN Utilities (SDK Config Analyzer + Game Launching Pipeline + Ticket Reminder)

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
│   │   ├── sheets.py            ← GET /api/sheets/{tab}, GET /api/sheets/all, POST /api/sheets/refresh
│   │   └── remind.py            ← /api/remind/* (20 endpoints) — Ticket Reminder
│   └── services/
│       ├── session_store.py     ← create/get/update/delete/purge_expired sessions
│       ├── oauth_service.py     ← build_auth_url, exchange_code, refresh_access_token, fetch_userinfo
│       ├── sheets_service.py    ← TTLCache fetch_tab/fetch_all/invalidate, parse_release/parse_close
│       ├── bootstrap_service.py ← fetch_config (curl subprocess), start_batch (background thread), get_job
│       ├── sdk_version_service.py ← fetch_all_snapshots, build_summary, build_detail
│       ├── ticket_service.py    ← External Nexus API + HMAC signature auth
│       ├── filter_service.py    ← needRemind logic, calc_diff_days (pure functions)
│       ├── template_service.py  ← render {placeholder} templates
│       ├── teams_service.py     ← Teams Incoming Webhook send/test
│       ├── remind_db.py         ← Supabase CRUD: webhooks, templates, handlers, logs, products, services
│       └── fetch_job_service.py ← Background job: fetch tickets + comments, progress polling
├── sync/                        ← Chạy thủ công / cron, KHÔNG deploy lên Railway
│   ├── run_sync.py              ← Entry point: 2 MCP calls → map/filter → Supabase
│   ├── mcp_client.py            ← JSON-RPC 2.0 over HTTP, fetch_game_list, fetch_sdk_snapshot, fetch_sdk_snapshot_all
│   ├── supabase_writer.py       ← upsert_batch via REST API (merge-duplicates)
│   ├── requirements.txt         ← httpx, python-dotenv
│   ├── .gitignore               ← exclude data/, .env, *.log
│   ├── data/                    ← Intermediate files (gitignored, overwrite mỗi lần chạy)
│   │   ├── game_list.json       ← Output bước 1: list game ACTIVE/NOT_RELEASED
│   │   └── snapshot_data.json   ← Output bước 2: full snapshot từ MCP
│   └── .env                     ← MCP_BASE_URL, MCP_BEARER_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY (KHÔNG commit)
├── frontend/
│   ├── index.html               ← Main app (tất cả tools)
│   ├── login.html               ← Google login page
│   ├── css/
│   │   ├── pipeline.css         ← Pipeline panel styles (prefix: pl-, pls-)
│   │   └── sdk-versions.css     ← SDK Version Management styles (prefix: sdkv-)
│   └── js/
│       ├── api-client.js        ← Wrapper fetch → backend, auto-redirect 401 → /login
│       ├── sdk-versions.js      ← SdkVersionPanel module (v2.0)
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
| GET | `/api/sdk-versions/summary` | KPI, version distribution, platform usage, mismatch list |
| GET | `/api/sdk-versions/detail?platform=&status=&search=` | Bảng chi tiết SDK versions |

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

### Tool 4: SDK Version Management
- **Nav ID:** `tool-sdk-versions`
- **Chức năng:** Dashboard thống kê SDK version adoption rate của các game theo platform
- **Data source:** MCP `sdk_version_snapshot` (sync script) → Supabase → FastAPI → Frontend
- **Lazy boot:** `selectTool('sdk-versions')` → `SdkVersionPanel.boot()`
- **2 views:** Summary (KPI + charts) / Detail (bảng merged-cell + filter)

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
| **v4.3** | **Mar 2026** | **Tool 4: SDK Version Management — full implementation** |
| **v4.4** | **Mar 2026** | **Detail view redesign: merged cells, dropdown filter, fix search focus, group hover** |
| **v4.5** | **Mar 2026** | **Fix "latest" badge: semver comparison (`_parse_version`); rename popular version label → "Most Popular"** |
| **v4.6** | **Mar 2026** | **Version Distribution redesign: bigger donut (180px), 2-column compact legend, bordered badges; cache-busting `?v=` query string** |
| **v4.7** | **Apr 2026** | **Export Excel (Detail tab, theo filter); Sync script refactor: 2 MCP calls + intermediate data files** |
| **v4.8** | **Apr 2026** | **Tool 5: Ticket Reminder — fetch Nexus tickets, phân tích needRemind, gửi Teams webhook** |
| **v4.8.1** | **Apr 2026** | **Debug mode: signature trace + request/response log (DEBUG_TICKET_API env var)** |
| **v4.8.2** | **Apr 2026** | **Ticket table redesign: 10 cột, Assignee/Created/Expire In mới, ticket_url hardcoded, fetch comments mọi ticket, sort need_remind+expire_in** |
| **v4.8.3** | **Apr 2026** | **Webhook multi-row add form; "Reminded" green badge + row tint khi quay lại từ remind view; Product column format id-[code-name]; fix sig_params comments/detail API** |
| **v4.8.4** | **Apr 2026** | **Tag handler trong Teams message: `{tagged_handler}` placeholder, Adaptive Card mention, handler_usernames name-matching** |
| **v4.8.5** | **Apr 2026** | **Thêm `{tagged_commenter}`, `{tagged_requester}`, `{ticket_link}` placeholders; send_mention_message nhận list[dict] hỗ trợ multi-mention** |
| **v4.8.6** | **May 2026** | **Fix Remind Config tabs không scroll khi list dài: `.tkr-tab-content` đổi `overflow:visible` → `overflow-y:auto`** |

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
- Light theme tăng contrast: `--text: #0d0f1a`, `--text2: #2e3358`, `--text3: #5a6090`, `--accent: #4338ca`
- `pipeline.css`: thêm `[data-theme="light"]` overrides cho pastel alert colors (invisible on light bg):
  - Urgent `#fca5a5` → `#b91c1c`, Warning `#fde68a` → `#92400e`, Info `#a5f3fc` → `#0e7490`
  - Áp dụng cho: `.pls-alert-title`, `.pls-alert-evtype`, `.pls-alert-days`

### v4.3 chi tiết
- **Tool 4 SDK Version Management:** `SdkVersionPanel` IIFE, 2 views (Summary/Detail)
- **Sync script:** `sync/` — MCP JSON-RPC 2.0, fetch game_list + sdk_version_snapshot, upsert Supabase
- **Backend:** `sdk_versions.py` router + `sdk_version_service.py`, `product_name` trong SELECT_ALL
- **Supabase:** `sdk_version_snapshots` table, UNIQUE(game_id, platform), dedup trước upsert
- **Fix:** MCP game_list dùng `product_code` làm fallback game_id (field `game_id` trả về null)

### v4.4 chi tiết
- **Fix search focus:** Tách shell render (1 lần) khỏi table render — `applySearch()` chỉ update tbody
- **Version filter dropdown:** Custom dropdown absolute, 3-column checkbox grid, click-outside handler
- **Merged cells:** `<td rowspan="N">` cho cột Product/Game, border-left màu worst status
- **Group hover:** Event delegation trên tbody — highlight toàn bộ rows cùng game khi hover
- **Sort icons:** In-place update `<span id="sdkv-si-{field}">` — không re-render thead

### v4.5 chi tiết
- **Fix "latest" badge:** Dùng semver comparison thay vì popularity để xác định version mới nhất
  - `_parse_version(v)` helper: tách `"a.b.c"` → `tuple(int)` để so sánh đúng thứ tự minor→major→patch
  - `newest_version = max(versions.keys(), key=_parse_version)` — version có semver lớn nhất
  - Field `is_newest: bool` trong distribution response — đánh dấu version thực sự mới nhất
- **Rename "Latest" → "Most Popular":** Label cũ đánh sai (dùng popularity), đổi tên cho đúng nghĩa
  - `is_latest_dominant` giữ nguyên cơ chế (version phổ biến nhất theo số lượng game)
  - Badge CSS split: `.sdkv-badge-latest` (accent/purple) cho newest, `.sdkv-badge-popular` (green) cho most popular
  - Legend hiển thị cả 2 badge riêng biệt, 1 version có thể có cả 2 nếu vừa mới nhất vừa phổ biến nhất

### v4.6 chi tiết
- **Version Distribution card redesign:**
  - Donut chart: 120px → **180px**, hole inset 22px → 32px, center % font 16px → 20px
  - Legend: `flex column gap:7px` → **CSS Grid 2 columns**, row height compact (padding 3px), font 12px → 11px
  - Legend dot: 10px → 8px; `sdkv-legend-pct` thêm `font-variant-numeric: tabular-nums; white-space: nowrap`
  - `.sdkv-donut-wrap` đổi `align-items: center` → `flex-start` (legend align top với donut)
- **Badge style update:** Thêm `border: 1px solid` vào cả `.sdkv-badge-latest` và `.sdkv-badge-popular`, giữ background fill
  - "Latest" viết hoa chữ L (trước là lowercase "latest")
- **Cache-busting:** Thêm `?v=X.X` query string vào tất cả `<script>` và `<link>` trong `index.html`
  - Bump version khi deploy JS/CSS mới để force browser reload, tránh stale cache

### v4.8 chi tiết
- **Tool 5: Ticket Reminder** — tính năng mới hoàn chỉnh
- **Backend** (7 files mới):
  - `remind.py` router: 20 endpoints `/api/remind/*`, `require_session()` trên tất cả
  - `ticket_service.py`: HMAC SHA1 auth port từ PHP/JS, `fetch_all_tickets` (pagination + `on_page` callback), `fetch_ticket_comments`, `fetch_ticket_detail`, `fetch_products`, `fetch_services`
  - `filter_service.py`: pure functions `calc_diff_days`, `is_need_remind`, `build_time_label`, `build_remind_item`
  - `template_service.py`: `render(content, data)` — `{placeholder}` substitution; `preview(content)` với SAMPLE_DATA
  - `teams_service.py`: `send_message(webhook_url, message)`, `send_test(webhook_url)` — timeout 10s, trả tuple
  - `remind_db.py`: Supabase httpx CRUD cho 6 tables; `find_webhook_for_product` — case-insensitive match + `is_default` fallback; `_check_sb()` graceful khi Supabase chưa cấu hình
  - `fetch_job_service.py`: background thread job store, `start_fetch_job` → `job_id`, `_run_fetch` với phase 1 (tickets, `on_page` callback) + phase 2 (comments, 100ms delay)
- **Frontend** (2 files mới):
  - `ticket-reminder.css`: tất cả `tkr-*` classes, dùng CSS variables only
  - `ticket-reminder.js`: `TicketReminderPanel` IIFE — `boot()` (Ticket Fetch panel) + `bootConfig()` (Remind Config panel); 2 send modes (Remind All / Select); `_sentTicketIds` Set cho session-scoped dedup
- **Database:** `docs/ticket-reminder/migration.sql` — 6 tables (remind_templates, webhook_configs, handler_usernames, remind_logs, products, services) + 2 seed templates
- **onclick encoding:** JSON data trong onclick dùng `onclick="...${JSON.stringify(x).replace(/"/g, '&quot;')}..."` — tuân thủ CLAUDE.md section 8.3
- **service_ids:** Server expect string IDs (`"53"` không phải `53`) — `[str(s) for s in req.service_ids]` là intentional
- **config.py:** Thêm `ticket_api_base_url`, `ticket_api_client_id`, `ticket_api_client_secret`
- **api-client.js:** Thêm `put()` và `delete()` methods, export trong return object

### v4.7 chi tiết
- **Export Excel — Detail tab (`sdk-versions.js`):**
  - Nút `⬇ Export Excel` nằm cuối filter bar (margin-left: auto)
  - `exportExcel()`: lấy data qua `_applyFilters()` — respect toàn bộ filter hiện tại
  - Group và sort theo `_sortGroups()` — thứ tự khớp với table đang hiển thị
  - Cột export: Game ID, Product Name, Platform, Latest Version, Adoption (%), Stable Version, Stable Adoption (%), Status, Mismatch, Snapshot Date
  - Filename: `sdk-versions-YYYY-MM-DD.xlsx` (no filter) / `sdk-versions-filtered-YYYY-MM-DD.xlsx` (có filter)
  - Dùng **SheetJS** (`xlsx.full.min.js` CDN) — không cần backend
  - CSS: `.sdkv-export-btn` — hover màu xanh lá
- **Sync script refactor — 2 MCP calls:**
  - **Trước:** N+1 calls (1 `game_list` + 1 `sdk_version_snapshot` per game)
  - **Sau:** 2 calls flat:
    - Call 1: `fetch_game_list()` → save `sync/data/game_list.json`
    - Call 2: `fetch_sdk_snapshot_all()` (không có `game_id`) → save `sync/data/snapshot_data.json`
    - Map step: filter snapshot theo `game_id` trong game_list, attach `product_name`
  - `sync/data/` gitignored, overwrite mỗi lần chạy, giữ lại để debug
  - Thêm `fetch_sdk_snapshot_all()` vào `mcp_client.py` — gọi `sdk_version_snapshot` arguments `{}`
  - `sync/.gitignore` mới: exclude `data/`, `.env`, `*.log`, `__pycache__/`

---

## 16. Tool 4: SDK Version Management — SdkVersionPanel v2.0

> Status: **Implemented & Deployed**

### 16.1 Kiến trúc
```
sync/ (chạy thủ công / cron, KHÔNG deploy Railway)
  run_sync.py
    1. fetch_game_list()        → MCP "game_list" (ACTIVE/NOT_RELEASED) → data/game_list.json
    2. fetch_sdk_snapshot_all() → MCP "sdk_version_snapshot" (no filter) → data/snapshot_data.json
    3. Map & filter             → loại bỏ records không có trong game_list
    4. upsert_batch()           → Supabase REST API (merge-duplicates, on_conflict=game_id,platform)

backend/
  routers/sdk_versions.py         ← GET /api/sdk-versions/summary, /detail
  services/sdk_version_service.py ← fetch_all_snapshots, build_summary, build_detail

frontend/
  js/sdk-versions.js              ← SdkVersionPanel IIFE (v2.0)
  css/sdk-versions.css            ← prefix: sdkv-
```

### 16.2 Supabase table: `sdk_version_snapshots`
Columns: `game_id, platform, product_name, latest_version, latest_version_records, latest_version_share_ratio, stable_version, stable_version_share_ratio, latest_date, updated_time, synced_at`
Constraint: `UNIQUE(game_id, platform)` — upsert strategy.

### 16.3 Sync script — mcp_client.py
- MCP transport: JSON-RPC 2.0 over HTTP POST, supports SSE response parsing
- `fetch_game_list()`: gọi tool `game_list`, filter ACTIVE/NOT_RELEASED
  - game_id fallback: `game_id → product_code → id → gameId` (MCP thường trả `game_id: null`, ID thực ở `product_code`)
  - product_name: `product_name → name → ""`
- `fetch_sdk_snapshot_all()`: gọi tool `sdk_version_snapshot` với `arguments: {}` — trả về toàn bộ data
- `fetch_sdk_snapshot(game_id)`: vẫn giữ lại để dùng riêng lẻ nếu cần
- `ALLOWED_COLUMNS` filter trước khi upsert để tránh lỗi column không tồn tại
- Dedup theo `(game_id, platform)` trước upsert tránh ON CONFLICT conflict

### 16.3b Sync script — run_sync.py (v2.0 flow)
- `DATA_DIR = sync/data/` — tạo tự động nếu chưa tồn tại
- `GAME_LIST_FILE = data/game_list.json` — format: `{synced_at, count, games: [{game_id, product_name}]}`
- `SNAPSHOT_FILE  = data/snapshot_data.json` — format: `{synced_at, count, records: [...]}`
- Cả 2 file overwrite mỗi lần chạy, gitignored, giữ lại để debug
- Map step: `game_id_set` + `product_name_map` từ game_list → filter snapshot → attach product_name
- Log rõ: N games, M snapshot records, K records sau filter, X records upserted

### 16.4 Backend service
- `SELECT_ALL` bao gồm `product_name`
- `build_summary()`: KPI đếm `unique game_ids` (không phải records)
  - `_parse_version(v)`: helper tách `"a.b.c"` → `tuple(int)` để so sánh semver đúng
  - Distribution mỗi version có 2 fields: `is_newest` (semver max) và `is_latest_dominant` (most popular by count)
- `build_detail()`: search match cả `game_id` lẫn `product_name`; trả về `product_name` trong items

### 16.5 Status thresholds (env var)
| Status | Condition |
|---|---|
| ✅ OK | `latest_version_share_ratio` ≥ `ADOPTION_WARN_THRESHOLD` (default 80) |
| ⚠️ WARN | ≥ `ADOPTION_CRITICAL_THRESHOLD` (default 50) và < warn |
| 🔴 CRIT | < `ADOPTION_CRITICAL_THRESHOLD` |

### 16.6 Summary tab UI
- 4 KPI cards: Total Games (unique game_ids), Fully Updated, Warning, Critical
- Version Distribution: donut chart (180px) + 2-column compact legend per platform (Android/iOS/Windows), platform tabs
  - Donut center: hiển thị % và version của top version
  - Legend layout: CSS Grid 2 columns, font 11px, row padding compact
  - Legend badges: `.sdkv-badge-latest` (purple, bordered) = semver newest "Latest"; `.sdkv-badge-popular` (green, bordered) = most popular "Most Popular"
  - 1 version có thể có cả 2 badges nếu vừa newest vừa most popular
- Platform Usage: horizontal bar chart theo total login records
- Latest ≠ Stable: bảng game có version mismatch

### 16.7 Detail tab — SdkVersionPanel v2.0

**Architecture — Fix search focus loss:**
- `_buildDetailShell()`: render filter bar + table skeleton một lần duy nhất (`_detailRendered = true`)
- `_applyAndRenderTable()`: chỉ update `<tbody>` và footer — KHÔNG rebuild filter bar
- `applySearch()` / `applyFilter()` / `setSortField()` gọi `_applyAndRenderTable()`, không gọi `_renderDetail()`

**Version filter — Custom dropdown:**
- Trigger button: `"Latest: All ▾"` / `"v4.2.1 ▾"` / `"3 selected ▾"`
- Panel: `position:absolute`, 3-column checkbox grid (`.sdkv-vf-grid`)
- Click outside → đóng dropdown (`document.addEventListener('click', ...)` — đăng ký 1 lần qua `_eventsWired`)
- `toggleDropdown(type)` public API

**Merged cell table:**
- Group by `game_id` → `_groupByGame()` → `_sortGroups()` → `_buildMergedRows()`
- Cột Product/Game: `<td rowspan="N" class="sdkv-game-cell">` — vertical-align middle
- Border-left 3px màu theo worst status của game: ok=`#22c55e`, warn=`#f59e0b`, crit=`#ef4444`
- Sub-rows: Platform | Latest | Adoption bar | Stable | Status

**Group hover highlight:**
- `data-gid` attribute trên mỗi `<tr>`
- Event delegation trên `tbody`: `mouseover` → highlight tất cả `tr[data-gid=X]`
- `mouseleave` trên `tbody` → clear tất cả

**Sort fields:** `game` (product_name/game_id), `latest`, `adoption` (default desc, sort by min across platforms), `stable`
**Sort icons:** `<span id="sdkv-si-{field}">` — updated in-place, không re-render thead

### 16.8 CSS Classes — sdk-versions.css (prefix: `sdkv-`)

| Class | Mô tả |
|---|---|
| `.sdkv-vf-wrap` | `position:relative` wrapper cho dropdown |
| `.sdkv-vf-trigger` | Dropdown trigger button, `.active` = accent border |
| `.sdkv-vf-panel` | Absolute dropdown panel, hidden by default |
| `.sdkv-vf-grid` | 3-column checkbox grid |
| `.sdkv-vf-item` | Checkbox label, `.active` = accent bg |
| `.sdkv-game-cell` | Merged rowspan cell — vertical-align middle |
| `.sdkv-game-name` | Product name (bold) |
| `.sdkv-game-id-tag` | Game ID dưới product name (monospace, muted) |
| `.sdkv-row-hover` | Hover state cho toàn bộ rows của 1 game |
| `.sdkv-th-sort` | Sortable header — cursor pointer |
| `.sdkv-sort-icon` | Sort indicator, `.active` = accent color |
| `.sdkv-legend-badge` | Base badge style cho version legend (9px, bold, transparent bg) |
| `.sdkv-badge-latest` | Badge "Latest" — purple/accent fill + border (semver newest version) |
| `.sdkv-badge-popular` | Badge "Most Popular" — green fill + border (highest game count version) |
| `.sdkv-export-btn` | Nút Export Excel — margin-left:auto, hover xanh lá |

### 16.9 Security rules
- `MCP_BEARER_TOKEN` chỉ trong `sync/.env` — KHÔNG commit, KHÔNG lên Railway
- `SUPABASE_SERVICE_KEY` trong Railway env vars + `sync/.env`
- Frontend KHÔNG gọi Supabase trực tiếp — chỉ qua FastAPI
- `/api/sdk-versions/*` dùng `require_session()`
- `sync/` trong `.railwayignore`

### 16.10 Anti-regression rules
| Rule | Mô tả |
|---|---|
| **AX-14** | Frontend KHÔNG import Supabase client — chỉ gọi `/api/sdk-versions/*` |
| **AX-15** | `sync/` KHÔNG deploy lên Railway |
| **AX-16** | CSS prefix `sdkv-` giữ nguyên, không conflict với `pl-`, `pls-` |
| **AX-17** | Status tính server-side từ env var threshold, không hardcode |
| **AX-18** | `applySearch()` / `applyFilter()` gọi `_applyAndRenderTable()` — KHÔNG gọi `_renderDetail()` (sẽ mất focus input) |
| **AX-19** | `_buildDetailShell()` render 1 lần duy nhất — KHÔNG rebuild khi filter thay đổi |
| **AX-20** | game_id trong sync: dùng `product_code` làm fallback khi `game_id: null` từ MCP |
| **AX-21** | Sync script dùng 2 MCP calls — KHÔNG loop `fetch_sdk_snapshot(game_id)` per game |
| **AX-22** | `sync/data/` gitignored — KHÔNG commit file game_list.json hoặc snapshot_data.json |
| **AX-23** | Ticket Reminder onclick dùng `&quot;` encoding — KHÔNG dùng single-quote wrapper với JSON data |
| **AX-24** | `service_ids` luôn là string list (`[str(s) for s in ...]`) — server expect string IDs |
| **AX-25** | `boot()` / `bootConfig()` chỉ init 1 lần (`_booted` / `_configBooted` flags) |
| **AX-26** | KHÔNG gửi remind tự động — user phải bấm nút Send |
| **AX-27** | `_sentTicketIds` reset khi fetch mới hoặc reset filter — không lưu localStorage |
| **AX-28** | `fetch_ticket_detail()` ĐÃ BỎ — ticket_url build từ hardcoded template `https://nexus.vnggames.com/home/tickets-v2/{id}` |
| **AX-29** | CSS prefix `tkr-` giữ nguyên, không conflict với `pl-`, `pls-`, `sdkv-` |
| **AX-30** | `DEBUG_TICKET_API` chỉ dùng để debug — KHÔNG để `true` trên production |
| **AX-31** | `sig_params` cho comments/detail API chỉ gồm `requestUser` — KHÔNG thêm path params như `ticketId` |
| **AX-32** | Fetch comments cho mọi ticket (không skip theo due_date hay threshold) — last comment luôn hiện |
| **AX-33** | "Reminded" badge/row tint dựa vào `_sentTicketIds` — client-side only, reset khi fetch mới |
| **AX-34** | Webhook multi-row form dùng `rowId` làm DOM namespace cho picker — KHÔNG dùng fixed IDs |

---

## 17. Hướng phát triển tiếp theo (Backlog)

- **v4.9:** Preset date ranges Pipeline ("Tháng này", "Q2 2026", "30 ngày tới")
- **v4.9:** Export Excel cho Pipeline Detail
- **v4.9:** Notification badge trên nav khi có CBT/OB trong 7 ngày tới
- **v4.9:** SDK Versions — pagination hoặc virtual scroll khi có nhiều games
- **Ticket Reminder v5.1:** BUG-004 — Webhook table hiện tên template thay UUID
- **Ticket Reminder v5.1:** SEC-001 — Validate `ticket_url` chỉ chấp nhận `https://` prefix
- **Future:** Date filter cho tab Pipeline "Closed"
- **Future:** Lưu date range preference vào localStorage
- **Future:** Sorting/grouping trong Stats timeline theo owner hoặc market
- **Future:** Multi-user session management / role-based access
- **Future:** SDK Version — lịch sử adoption rate (lưu nhiều snapshot theo ngày)
- **Future:** SDK Version — alert khi adoption rate giảm đột ngột

---

## 18. Tool 5: Ticket Reminder — v4.8.5

> Status: **Implemented & Deployed**

### 18.1 Tổng quan nghiệp vụ

Fetch ticket từ Nexus Ticket API, xác định ticket nào cần nhắc (due date sắp tới + comment cuối là handler), gửi Teams webhook message theo từng sản phẩm.

**needRemind logic:**
- Ticket không có `due_date` → bỏ qua (false)
- `diffDays > threshold` → false (còn nhiều ngày)
- Không có comment → true (handler chưa phản hồi lần nào)
- Comment cuối cùng từ `handler_usernames` → true (last reply là handler, chưa có phản hồi mới)
- Comment cuối từ requester → false (requester đã comment lại, không cần nhắc)

**time_label:**
- `diffDays >= 0`: `"will expire on DD/MM/YYYY"`
- `diffDays < 0`: `"expired on DD/MM/YYYY"`

### 18.2 Kiến trúc

```
backend/
  routers/remind.py                ← 22+ endpoints /api/remind/*
  services/
    ticket_service.py              ← HMAC auth, fetch tickets/comments/products/services/statuses; fetch_users_by_ids (plain GET)
    filter_service.py              ← calc_diff_days, is_need_remind, build_remind_item (incl. handler_id)
    template_service.py            ← render(content, data), preview(content); placeholder {tagged_handler}
    teams_service.py               ← send_message, send_test, send_mention_message (Adaptive Card)
    remind_db.py                   ← Supabase httpx CRUD (7 tables)
    fetch_job_service.py           ← Background job: fetch + analyze tickets

frontend/
  css/ticket-reminder.css          ← prefix: tkr-
  js/ticket-reminder.js            ← TicketReminderPanel IIFE

docs/ticket-reminder/
  migration.sql                    ← 7 Supabase tables + 2 seed templates
  FEATURE.md                       ← Nghiệp vụ, luồng xử lý
  ARCHITECTURE.md                  ← Tech stack, DB schema, API routes
  UI_SPEC.md                       ← Giao diện, HTML, CSS
  MANAGEMENT_SPEC.md               ← Webhook, template, handler, products, services, statuses config
  TAGGING_DESIGN.md                ← Design: tag handler/commenter/requester trong Teams message (v4.8.5)
```

### 18.3 Supabase tables

| Table | Mô tả |
|---|---|
| `remind_templates` | Message templates với `{ticket_id}`, `{time_label}`, ... placeholders |
| `webhook_configs` | Teams webhook URLs, match theo `product_name` (case-insensitive) + `is_default` fallback |
| `handler_usernames` | Username danh sách handler (so với comment author) |
| `remind_logs` | Log mỗi lần gửi: ticket_id, ticket_url, status (sent/failed/skipped), timestamp |
| `products` | Cache sản phẩm từ Nexus API (id, name, code, alias) |
| `services` | Cache dịch vụ từ Nexus API |
| `ticket_statuses` | Cache trạng thái từ Nexus API (id, name, is_closed) |

### 18.4 API Endpoints (tất cả `require_session()`)

| Method | Path | Mô tả |
|---|---|---|
| POST | `/api/remind/tickets/fetch` | Start background fetch job → `{job_id}` |
| GET | `/api/remind/tickets/fetch/status` | Poll job progress → phase, progress, result |
| POST | `/api/remind/send` | Gửi remind cho list tickets đã chọn |
| GET/POST/PUT/DELETE | `/api/remind/templates[/{id}]` | CRUD templates |
| POST | `/api/remind/templates/{id}/preview` | Preview rendered template |
| GET/POST/PUT/DELETE | `/api/remind/webhooks[/{id}]` | CRUD webhooks |
| POST | `/api/remind/webhooks/{id}/test` | Send test message |
| GET/POST | `/api/remind/handlers[/{id}]` | CRUD handlers |
| DELETE | `/api/remind/handlers/{id}` | Remove handler |
| POST | `/api/remind/products/sync` | Sync products từ Nexus API |
| GET | `/api/remind/products?offset=&limit=` | List products (phân trang) |
| POST | `/api/remind/services/sync` | Sync services từ Nexus API |
| GET | `/api/remind/services` | List services |
| POST | `/api/remind/statuses/sync` | Sync statuses từ Nexus API |
| GET | `/api/remind/statuses` | List statuses |
| GET | `/api/remind/logs?status=&limit=` | List remind logs |

### 18.5 Background Job Flow

```
POST /api/remind/tickets/fetch
  → start_fetch_job() → job_id (returned immediately)
  → Thread: _run_fetch()
      Phase 1 "tickets": fetch_all_tickets() với on_page callback
        → job["tickets_page"] / ["tickets_total_pages"] update real-time
      Phase 2 "comments": loop qua TẤT CẢ tickets (không skip)
        → fetch_ticket_comments() (100ms delay)
        → build_remind_item()
      Phase "done": job["result"] = { total, remind_count, tickets }

GET /api/remind/tickets/fetch/status?job_id=
  → trả job dict: phase, tickets_page, tickets_total_pages,
                  comments_done, comments_total, status, result, error
```

### 18.6 Frontend — TicketReminderPanel

**2 panels:**
- `boot()` → Ticket Fetch panel (`#tool-ticket-fetch`) — lazy init 1 lần
- `bootConfig()` → Remind Config panel (`#tool-remind-config`) — lazy init 1 lần

**Ticket Fetch flow:**
1. User chọn filters (service, status, assignee, date range, threshold)
2. Click Fetch → `POST /api/remind/tickets/fetch` → `job_id`
3. Poll `/status` mỗi 1.5s → update progress bar và status text
4. Khi done → render ticket table **10 cột**: Ticket ID | Product | Title | Requester | Assignee | Created | Due Date | Expire In | Need Remind | Last Comment
5. Send modes:
   - **Mode A** (Remind All): gửi tất cả `need_remind=true` tickets
   - **Mode B** (Select): user check checkbox → chỉ gửi các ticket đã chọn
6. `_sentTicketIds` Set — reset khi fetch mới, prevent double-send trong session
7. Khi "Quay lại" từ remind view: bảng re-render, ticket đã gửi thành công → row xanh lá + badge "✓ Reminded"

**Config tabs:** Webhooks | Templates | Handlers | Services | Products | Statuses | Logs

**Webhooks tab — thêm mới:**
- Multi-row form: "+ Thêm Webhook" → bảng với nhiều dòng, mỗi dòng có product picker riêng
- "+ Thêm dòng" → append dòng mới ngay lập tức
- "💾 Lưu tất cả (N)" → `Promise.all` save song song
- Sửa: Edit form inline riêng với direct PUT save

### 18.7 HMAC Signature Auth

Port từ PHP `buildSignature()`:
```python
def _build_signature(client_secret, params):
    sorted_params = dict(sorted(params.items()))
    hash_string = sha1(client_secret).hexdigest()
    for value in sorted_params.values():
        if isinstance(value, list):
            filtered = [v for v in value if v]
            value = json.dumps(filtered, separators=(",", ":"))
        str_val = str(value) if value is not None else ""
        str_val = html_entity_decode(str_val)   # &amp; → &, etc.
        if str_val:
            hash_string += "|" + str_val
    return sha1(hash_string).hexdigest()
```

Array params trong URL: PHP-style `key[]=val1&key[]=val2` (không phải `key=val1&key=val2`).

### 18.8 Config (env vars)

```
TICKET_API_BASE_URL=https://ticket.vnggames.net/integration/v1
TICKET_API_CLIENT_ID=...
TICKET_API_CLIENT_SECRET=...
SUPABASE_URL=...          (tái dụng từ sdk-versions)
SUPABASE_SERVICE_KEY=...  (tái dụng từ sdk-versions)
DEBUG_TICKET_API=false    (set true để bật debug logging — tắt trên production)
```

### 18.8b Debug Mode

Khi `DEBUG_TICKET_API=true`, mỗi request đến Nexus API sẽ print ra Railway logs:

**Signature trace** (giống format `api-test.js`):
```
========== SIGNATURE BUILD ==========
[1] sha1(client_secret) = "508dd96a..."
[2] Params sau ksort:
    key="client-id" | raw="STORE"  → append "|STORE"
    key="requestUser" | raw="minhgv" → append "|minhgv"
    ...
[3] hash_string_before_sha1: "508dd96a...|STORE|minhgv|..."
[4] signature = "c2b8a793..."
=====================================
```

**Request + Response log:**
```
========== PRODUCTS ==========
REQUEST  https://ticket.../products?requestUser=...
  client-id: STORE
  timestamp: 17753...
  signature: c2b8a7...
RESPONSE 200
  {"data": [...]}
================================
```

**Frontend debug toggle:**
- Nút 🐛 Debug ở góc phải header của Ticket Fetch panel
- Trạng thái lưu vào `localStorage` (`tkrDebugMode`)
- Khi on + job done/error → tự popup dialog với signature trace của request đầu tiên
- `syncProducts()` / `syncServices()` cũng tự popup dialog khi debug on

**Endpoints in debug:**
- `fetch_all_tickets` — log page 1 request
- `fetch_products` — log full request/response
- `fetch_services` — log full request/response

**Workflow debug signature:**
1. Chạy `api-test.js` local với cùng params → note `hash_string_before_sha1`
2. Gọi endpoint Python → xem Railway logs → so sánh `hash_string_before_sha1`
3. Nếu giống → algorithm đúng, vấn đề ở credentials hoặc server
4. Nếu khác → tìm step đầu tiên diverge

### 18.9 Anti-regression rules (Ticket Reminder)

| Rule | Mô tả |
|---|---|
| **AX-23** | onclick với JSON data dùng `&quot;` encoding — KHÔNG single-quote wrapper (CLAUDE.md 8.3) |
| **AX-24** | `service_ids` luôn là string list — server expect `"53"` không phải `53` |
| **AX-25** | `boot()` / `bootConfig()` chỉ init 1 lần (`_booted` / `_configBooted` flags) |
| **AX-26** | KHÔNG gửi remind tự động — user phải bấm nút Send |
| **AX-27** | `_sentTicketIds` reset khi fetch mới / reset filter — không lưu localStorage |
| **AX-28** | `fetch_ticket_detail()` ĐÃ BỎ — ticket_url từ hardcoded template `https://nexus.vnggames.com/home/tickets-v2/{id}` |
| **AX-29** | CSS prefix `tkr-` giữ nguyên, không conflict với `pl-`, `pls-`, `sdkv-` |
| **AX-30** | `DEBUG_TICKET_API` chỉ dùng để debug — KHÔNG để `true` trên production |
| **AX-31** | `sig_params` cho comments/detail API chỉ gồm `requestUser` — KHÔNG thêm path params như `ticketId` |
| **AX-32** | Fetch comments cho mọi ticket (không skip) — last comment luôn hiển thị |
| **AX-33** | "Reminded" badge/row tint client-side only (`_sentTicketIds`) — reset khi fetch mới |
| **AX-34** | Webhook multi-row form: product picker dùng `rowId` DOM namespace — KHÔNG dùng fixed IDs |
| **AX-35** | `fetch_users_by_ids()` dùng plain GET — KHÔNG thêm HMAC headers, KHÔNG thêm `requestUser` |
| **AX-36** | `send_mention_message()` dùng cho remind thực tế; `send_message()` chỉ dùng cho `send_test` — KHÔNG dùng lẫn |
| **AX-37** | Tất cả tagged_* resolved trước khi gọi `render()` — caller truyền vào đã là `<at>Name</at>` hoặc plain name |
| **AX-38** | `send_mention_message()` nhận `mentions: list[dict]` — KHÔNG truyền single `dict\|None` |
| **AX-39** | `{tagged_commenter}` lấy từ `last_comment_by` + `last_comment.name` — KHÔNG dùng `assignee_name` |
| **AX-40** | `{tagged_requester}` lấy từ `requester_login` — KHÔNG dùng `handler_id` hay DB lookup |

### v4.8.4 chi tiết
- **Tag handler trong Teams message** — gắn mention `<at>Name</at>` vào remind message
- **`filter_service.py`**: `build_remind_item()` thêm field `handler_id`, `assignee_name`
- **`ticket_service.py`**: thêm `fetch_users_by_ids()` — plain GET, không HMAC (giữ lại nhưng không gọi; nexus users API không accessible từ Railway)
- **`teams_service.py`**: thêm `send_mention_message(url, message_text, mention: dict|None)` — Adaptive Card v1.2
- **`template_service.py`**: thêm `tagged_handler` vào `SAMPLE_DATA`
- **`remind.py`**: `SendTicket` thêm `assignee_name`, `handler_id`; send endpoint dùng `handler_usernames` name-matching thay users API
- **Frontend**: payload thêm `assignee_name`, `handler_id`; hint thêm `{tagged_handler}`

### v4.8.5 chi tiết
- **Thêm 3 placeholders mới** cho Teams message
- **`{tagged_commenter}`**: tag người comment cuối — từ `last_comment.user.username` + `name` trong comments API response
- **`{tagged_requester}`**: tag người tạo ticket — từ `ticket.requester.login` (đã có trong job result)
- **`{ticket_link}`**: hyperlink `[#id](url)` trong Adaptive Card TextBlock (Markdown)
- **`teams_service.py`**: `send_mention_message` đổi signature `mention: dict|None` → `mentions: list[dict]`; build `entities` array hỗ trợ 0–3 mentions đồng thời
- **`remind.py`**: `SendTicket` thêm `last_comment_username`, `last_comment_name`, `requester_login`; resolve 3 mention blocks; `mentions = [m for m in [...] if m]`
- **`template_service.py`**: SAMPLE_DATA thêm `ticket_link`, `tagged_commenter`, `tagged_requester`
- **Frontend**: payload thêm `last_comment_username`, `last_comment_name`, `requester_login`; hint text cập nhật đủ 9 placeholders

### v4.8.6 chi tiết
- **Fix Remind Config tabs không scroll**: list webhook (và các tab Templates/Handlers/Services/Products/Statuses/Logs) bị clip khi nội dung dài hơn vùng visible
- **Root cause**: `.tkr-tab-content { overflow: visible }` — content tràn ra bị clip bởi `.tool-panel { overflow:hidden }` của ancestor, không có scrollbar
- **Fix**: đổi sang `overflow-y: auto; overflow-x: visible` — mỗi tab tự scroll dọc khi content vượt height
- **Không ảnh hưởng product picker**: `#tkr-body-product-panel` được append vào `<body>` với `position:fixed`, thoát mọi overflow context của ancestor
- **Bump cache**: `ticket-reminder.css?v=1.0` → `?v=1.1`

---

## Multi-Agent Workflow — Ticket Reminder

Tính năng này được phát triển theo quy trình **Sequential Handoff** với 6 roles.

### Cách khởi động

```bash
claude "Đọc agents/WORKFLOW.md và bắt đầu"
```

### Thứ tự roles

| # | Role | File | Output |
|---|---|---|---|
| 1 | PM | `agents/roles/pm.md` | `agents/outputs/01-prd.md` |
| 2 | BA | `agents/roles/ba.md` | `agents/outputs/02-spec.md` |
| 3 | Design | `agents/roles/design.md` | `agents/outputs/03-design-spec.md` |
| 4 | Tech Lead | `agents/roles/tech-lead.md` | `agents/outputs/04-tech-plan.md` |
| 5 | Dev | `agents/roles/dev.md` | `agents/outputs/05-dev-log.md` |
| 6 | QC | `agents/roles/qc.md` | `agents/outputs/06-qc-report.md` |

### Nguyên tắc confirm

- Gõ `ok` / `next` → chuyển role tiếp theo
- Gõ feedback cụ thể → role hiện tại xử lý, không chuyển tiếp
- Gõ `back` → quay lại role trước để sửa
- Xem `agents/workflows/handoff-protocol.md` để biết thêm

### Skills location

Tất cả skill files nằm tại: `~/.claude/skills/`
