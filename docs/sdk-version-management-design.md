# SDK Version Management — Feature Design Spec

> Version: v1.0 · Ngày: 2026-03-20
> Status: **Confirmed — Pending Implementation**

---

## 1. Tổng quan

Tính năng **SDK Version Management** hiển thị thống kê phiên bản SDK của các game đang vận hành, giúp team theo dõi adoption rate và phát hiện game chậm update.

### Mục tiêu
- Biết game nào đang dùng version SDK nào trên từng platform
- Theo dõi tỷ lệ adoption của latest version
- Alert khi game có adoption rate thấp (< 80%)
- Phát hiện gap giữa latest và stable version

### Non-goals (phạm vi không bao gồm)
- Lịch sử adoption rate theo thời gian (không lưu nhiều snapshot)
- Raw login event theo từng user/device
- Tự động trigger sync từ UI

---

## 2. Kiến trúc tổng thể

```
┌──────────────────────────────────────────────────────────────┐
│  Cron Script (server nội bộ — độc lập, KHÔNG trên Railway)   │
│                                                              │
│  sync/game_ids.txt ──► run_sync.py ──► MCP API (Bearer)     │
│                              │                               │
│                              ▼                               │
│                    supabase_writer.py                        │
└──────────────────────┬───────────────────────────────────────┘
                       │ UPSERT (game_id, platform)
                       ▼
        ┌──────────────────────────────┐
        │  Supabase                    │
        │  table: sdk_version_snapshots│
        └──────────────┬───────────────┘
                       │ REST (service key)
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  FastAPI Backend (Railway)                                   │
│  routers/sdk_versions.py                                     │
│  services/sdk_version_service.py                             │
│  GET /api/sdk-versions/summary                               │
│  GET /api/sdk-versions/detail                                │
└──────────────────────┬───────────────────────────────────────┘
                       │ fetch (credentials: include)
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  Frontend (Vanilla JS)                                       │
│  js/sdk-versions.js  ──  SdkVersionPanel                     │
│  css/sdk-versions.css    prefix: sdkv-                       │
└──────────────────────────────────────────────────────────────┘
```

---

## 3. Folder / File Structure

```
PIN/
├── sync/                          ← Script độc lập (KHÔNG deploy lên Railway)
│   ├── run_sync.py                ← Entry point
│   ├── mcp_client.py              ← HTTP client gọi MCP API
│   ├── supabase_writer.py         ← Upsert data vào Supabase
│   ├── game_ids.txt               ← Danh sách game_id, mỗi dòng 1 ID
│   ├── requirements.txt           ← httpx, supabase, python-dotenv
│   └── .env                       ← MCP_BASE_URL, MCP_BEARER_TOKEN,
│                                     SUPABASE_URL, SUPABASE_SERVICE_KEY
│
├── backend/
│   ├── routers/
│   │   └── sdk_versions.py        ← GET /api/sdk-versions/summary & /detail
│   └── services/
│       └── sdk_version_service.py ← Query + transform từ Supabase
│
└── frontend/
    ├── css/
    │   └── sdk-versions.css       ← prefix: sdkv-
    └── js/
        └── sdk-versions.js        ← SdkVersionPanel module
```

> **`.railwayignore` cần thêm:** `sync/` — KHÔNG deploy sync script lên Railway.

---

## 4. Supabase Schema

```sql
CREATE TABLE sdk_version_snapshots (
  id                          BIGSERIAL PRIMARY KEY,
  game_id                     TEXT        NOT NULL,
  platform                    TEXT        NOT NULL
                              CHECK (platform IN ('android', 'ios', 'windows')),
  latest_version              TEXT,
  latest_version_records      BIGINT,
  latest_version_share_ratio  INTEGER     CHECK (latest_version_share_ratio BETWEEN 0 AND 100),
  stable_version              TEXT,
  stable_version_share_ratio  INTEGER     CHECK (stable_version_share_ratio BETWEEN 0 AND 100),
  latest_date                 TIMESTAMPTZ,
  updated_time                TIMESTAMPTZ,
  synced_at                   TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (game_id, platform)  -- upsert target: 1 row per game × platform
);

CREATE INDEX idx_sdk_platform        ON sdk_version_snapshots(platform);
CREATE INDEX idx_sdk_latest_ratio    ON sdk_version_snapshots(latest_version_share_ratio);
CREATE INDEX idx_sdk_version_mismatch ON sdk_version_snapshots(
  (latest_version IS DISTINCT FROM stable_version)
);
```

**Upsert strategy:** `ON CONFLICT (game_id, platform) DO UPDATE SET ...` — luôn giữ snapshot mới nhất. Không tích lũy lịch sử.

---

## 5. Sync Script

### `.env` (sync/)
```
MCP_BASE_URL=https://...
MCP_BEARER_TOKEN=...
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=eyJ...
PLATFORMS=android,ios,windows
ADOPTION_WARN_THRESHOLD=80
ADOPTION_CRITICAL_THRESHOLD=50
```

### `game_ids.txt` format
```
# Danh sách game IDs cần sync
cfmvn
tghm
cssea
# Dòng bắt đầu bằng # là comment, bỏ qua
```

### `run_sync.py` — Logic flow
```
1. Load game_ids từ game_ids.txt
   - Bỏ qua dòng trống
   - Bỏ qua dòng bắt đầu bằng #
2. Với mỗi game_id:
   - Gọi MCP sdk_version_snapshot (không filter platform → lấy cả 3)
   - Map response fields → Supabase row
3. Batch upsert tất cả records vào Supabase
4. Log: tổng games, tổng records, số lỗi, thời gian chạy
```

### Error handling
| Tình huống | Xử lý |
|---|---|
| 1 game lỗi (MCP timeout/404) | Log + continue, không dừng toàn bộ |
| Supabase upsert lỗi | Retry 1 lần, sau đó log error |
| > 20% games lỗi | Exit code 1 (cron alert) |
| ≤ 20% games lỗi | Exit code 0 (chấp nhận được) |

### `requirements.txt` (sync/)
```
httpx==0.28.1
supabase==2.x
python-dotenv==1.0.x
```

---

## 6. Backend — API Endpoints

### Env vars mới (thêm vào `.env` và Railway)
```
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=eyJ...
ADOPTION_WARN_THRESHOLD=80
ADOPTION_CRITICAL_THRESHOLD=50
```

### `GET /api/sdk-versions/summary`

**Response:**
```json
{
  "kpi": {
    "total_records": 67,
    "fully_updated": 28,
    "warn_count": 9,
    "critical_count": 5,
    "last_synced": "2026-03-20T06:00:00Z"
  },
  "version_distribution": {
    "android": [
      { "version": "3.9.0", "game_count": 25, "is_latest_dominant": true },
      { "version": "3.8.2", "game_count": 7,  "is_latest_dominant": false }
    ],
    "ios": [...],
    "windows": [...]
  },
  "platform_usage": [
    { "platform": "android", "total_records": 120000000, "game_count": 35, "pct": 68 },
    { "platform": "ios",     "total_records":  45000000, "game_count": 28, "pct": 25 },
    { "platform": "windows", "total_records":   8000000, "game_count": 10, "pct":  7 }
  ],
  "mismatch_games": [
    {
      "game_id": "tghm",
      "platform": "android",
      "latest_version": "3.9.0",
      "stable_version": "3.8.2",
      "latest_version_share_ratio": 45,
      "stable_version_share_ratio": 82
    }
  ]
}
```

### `GET /api/sdk-versions/detail`

**Query params:**
| Param | Values | Default |
|---|---|---|
| `platform` | `android` \| `ios` \| `windows` \| `` | `` (all) |
| `status` | `ok` \| `warn` \| `critical` \| `` | `` (all) |
| `search` | substring match trên `game_id` | `` |

**Response:**
```json
{
  "items": [
    {
      "game_id": "tghm",
      "platform": "android",
      "latest_version": "3.9.0",
      "latest_version_records": 5000000,
      "latest_version_share_ratio": 45,
      "stable_version": "3.8.2",
      "stable_version_share_ratio": 82,
      "version_mismatch": true,
      "status": "critical",
      "latest_date": "2026-03-14T00:00:00Z"
    }
  ],
  "total": 67
}
```

**Status logic (server-side):**
```python
if ratio >= ADOPTION_WARN_THRESHOLD:   status = "ok"
elif ratio >= ADOPTION_CRITICAL_THRESHOLD: status = "warn"
else:                                   status = "critical"
```

---

## 7. Frontend — SdkVersionPanel Module

### Script load order (index.html)
```
api-client.js → ... → sdk-versions.js
```

### Public API
```js
SdkVersionPanel.boot()          // lazy init khi tab mở lần đầu
SdkVersionPanel.fetchData()     // Refresh button
SdkVersionPanel.switchView(v)   // 'summary' | 'detail'
SdkVersionPanel.setFilter(f)    // { platform, status, search }
SdkVersionPanel.applySearch()   // search input oninput
```

### Nav item (index.html)
```html
<a class="nav-item" onclick="selectTool('sdk-versions', this)" href="#">
  <span class="nav-item-icon">📦</span>
  SDK Versions
</a>
```

### CSS prefix: `sdkv-`
Toàn bộ classes dùng prefix `sdkv-` để tránh conflict với `pl-`, `pls-`, và main app styles.

---

## 8. Dashboard UI Wireframe

### Summary Tab

```
╔══════════════════════════════════════════════════════════════════════════╗
║  📦 SDK Version Management                           [🔄 Refresh]       ║
╠══════════════════════════════════════════════════════════════════════════╣
║  [📊 Summary]  [📋 Detail]                  🕐 Synced: 2026-03-20 06:00 ║
╠══════════════════════════════════════════════════════════════════════════╣
║                                                                          ║
║  ┌─────────────────┐  ┌─────────────────┐  ┌────────────────┐  ┌──────┐ ║
║  │ 📊              │  │ ✅              │  │ ⚠️             │  │ 🔴   │ ║
║  │  67             │  │  28             │  │  9             │  │  5   │ ║
║  │  Games Tracked  │  │  Fully Updated  │  │  Need Attention│  │ Crit │ ║
║  │                 │  │  ratio = 100%   │  │  ratio < 80%   │  │ <50% │ ║
║  └─────────────────┘  └─────────────────┘  └────────────────┘  └──────┘ ║
║                                                                          ║
║  ┌─────────────────────────────────┐  ┌──────────────────────────────┐  ║
║  │  VERSION DISTRIBUTION           │  │  PLATFORM USAGE              │  ║
║  │  [Android] [iOS] [Windows]      │  │  (by total login records)    │  ║
║  │                                 │  │                              │  ║
║  │        ┌───────────┐            │  │  Android  ████████████  68%  │  ║
║  │      ╭─┤           ├─╮          │  │  iOS      ████████      25%  │  ║
║  │     ╭┤ │   72%     │ ├╮         │  │  Windows  ███            7%  │  ║
║  │     │╰─┤  latest   ├─╯│         │  │                              │  ║
║  │     ╰──┤           ├──╯         │  │  Total: 173,000,000 records  │  ║
║  │        └───────────┘            │  │  Across 42 games tracked     │  ║
║  │                                 │  │                              │  ║
║  │  ● 3.9.0  72%  (latest)  ████▌  │  └──────────────────────────────┘  ║
║  │  ● 3.8.2  20%            ██░░░  │                                    ║
║  │  ● 3.7.1   8%            █░░░░  │                                    ║
║  └─────────────────────────────────┘                                    ║
║                                                                          ║
║  ┌──────────────────────────────────────────────────────────────────┐   ║
║  │  ⚡ LATEST ≠ STABLE  (3 games chưa rollout hoàn chỉnh)           │   ║
║  │  game_id   platform  latest   stable   latest%   stable%   gap  │   ║
║  │  ────────────────────────────────────────────────────────────── │   ║
║  │  tghm      🤖 AND    3.9.0    3.8.2      45%       82%    ▼37%  │   ║
║  │  cssea      🍎 iOS   2.1.0    2.0.5      60%       95%    ▼35%  │   ║
║  └──────────────────────────────────────────────────────────────────┘   ║
╚══════════════════════════════════════════════════════════════════════════╝
```

### Detail Tab

```
╔══════════════════════════════════════════════════════════════════════════╗
║  [📊 Summary]  [📋 Detail]                                              ║
╠══════════════════════════════════════════════════════════════════════════╣
║  🔍 [Search game_id...    ]  [Platform: All ▼]  [Status: All ▼]        ║
╠══════════╦══════════╦═══════════╦════════════════╦═══════════╦═════════╣
║ Game ID  ║ Platform ║ Latest    ║ Adoption Rate  ║ Stable    ║ Status  ║
╠══════════╬══════════╬═══════════╬════════════════╬═══════════╬═════════╣
║ cfmvn    ║ 🤖 AND   ║  3.9.0   ║ ████████  100% ║  3.9.0   ║ ✅ OK   ║
║ cfmvn    ║ 🍎 iOS   ║  3.9.0   ║ ████████   98% ║  3.9.0   ║ ✅ OK   ║
║ tghm     ║ 🤖 AND   ║  3.9.0   ║ ████░░░░   45% ║  3.8.2 ⚡║ 🔴 CRIT ║
║ tghm     ║ 🍎 iOS   ║  3.9.0   ║ ██████░░   72% ║  3.8.2 ⚡║ ⚠️ WARN ║
║ cssea    ║ 🍎 iOS   ║  2.1.0   ║ ██████░░   60% ║  2.0.5 ⚡║ ⚠️ WARN ║
║ cssea    ║ 🖥️ WIN   ║  2.1.0   ║ ████████   88% ║  2.1.0   ║ ✅ OK   ║
╠══════════╩══════════╩═══════════╩════════════════╩═══════════╩═════════╣
║  67 records  ·  📅 Data snapshot: 2026-03-14                            ║
╚══════════════════════════════════════════════════════════════════════════╝
```

**Legend:**
- `⚡` = latest ≠ stable (version mismatch)
- Progress bar: filled = adoption%, empty = chưa update
- `✅ OK` = ratio ≥ 80% · `⚠️ WARN` = 50–79% · `🔴 CRIT` = < 50%

---

## 9. CSS & Theme Integration

File: `frontend/css/sdk-versions.css`, prefix `sdkv-`

| Component | CSS variable dùng |
|---|---|
| KPI card background | `var(--surface)` |
| KPI card border | `var(--border)` |
| Table header | `var(--surface2)` |
| Progress bar fill | `var(--accent)` |
| OK status | `#22c55e` |
| WARN status | `#f59e0b` |
| CRIT status | `#ef4444` |
| Mismatch badge | `#f59e0b` |

**Light theme overrides** (tương tự pattern `pipeline.css`):
```css
[data-theme="light"] .sdkv-status-ok   { color: #15803d; }
[data-theme="light"] .sdkv-status-warn { color: #92400e; }
[data-theme="light"] .sdkv-status-crit { color: #b91c1c; }
[data-theme="light"] .sdkv-mismatch    { color: #92400e; }
```

---

## 10. Security Notes

| Điểm | Thiết kế |
|---|---|
| `MCP_BEARER_TOKEN` | Chỉ trong `sync/.env` — KHÔNG commit, KHÔNG lên Railway |
| `SUPABASE_SERVICE_KEY` | Trong Railway env vars (backend) + `sync/.env` (script) |
| Supabase access từ frontend | **KHÔNG** — frontend chỉ gọi `/api/sdk-versions/*` qua FastAPI |
| Auth guard | `/api/sdk-versions/*` dùng `require_session()` dependency (giống các router khác) |
| `sync/.env` | Thêm vào `.gitignore` |

---

## 11. Decision Log

| Quyết định | Lý do | Alternatives loại bỏ |
|---|---|---|
| Upsert strategy (1 row/game×platform) | Đơn giản, user không yêu cầu history | Append-only: phức tạp, query nặng hơn |
| Script độc lập (không trên Railway) | User tự quản lý cron schedule | Railway cron: cần plan trả phí |
| Threshold trong env var | Thay đổi không cần redeploy | Hardcode: kém flexible |
| Supabase REST (không realtime) | Data không cần realtime | Supabase realtime: overkill |
| Python cho sync script | Đồng bộ stack với backend, có `supabase-py` | Node.js: thêm runtime dependency |
| Prefix `sdkv-` | Tránh conflict với `pl-`, `pls-`, main app | Không prefix: dễ gây CSS conflict |
| Frontend KHÔNG gọi Supabase trực tiếp | Bảo mật: ẩn service key, thống nhất auth | Direct Supabase: lộ key ở client |

---

## 12. Implementation Checklist

### Phase 1 — Data Pipeline
- [ ] Tạo Supabase project, chạy schema SQL
- [ ] Viết `sync/mcp_client.py`
- [ ] Viết `sync/supabase_writer.py`
- [ ] Viết `sync/run_sync.py`
- [ ] Test sync script với 5 game IDs
- [ ] Thêm `sync/` vào `.railwayignore`

### Phase 2 — Backend
- [ ] Thêm `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, threshold vào `config.py`
- [ ] Viết `backend/services/sdk_version_service.py`
- [ ] Viết `backend/routers/sdk_versions.py`
- [ ] Register router trong `backend/main.py`
- [ ] Test endpoints với Postman/curl

### Phase 3 — Frontend
- [ ] Viết `frontend/css/sdk-versions.css`
- [ ] Viết `frontend/js/sdk-versions.js` (SdkVersionPanel)
- [ ] Thêm nav item vào `frontend/index.html`
- [ ] Thêm script/css tags vào `frontend/index.html`
- [ ] Test tất cả 5 themes

### Phase 4 — Integration
- [ ] Deploy lên Railway, set env vars
- [ ] Chạy sync script với game_ids.txt thực
- [ ] Verify data hiển thị đúng trên dashboard
- [ ] Update CLAUDE.md
