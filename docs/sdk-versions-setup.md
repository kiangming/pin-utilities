# SDK Version Management — Hướng dẫn cấu hình kỹ thuật

> Tài liệu này hướng dẫn cấu hình đầy đủ tính năng **Tool 4: SDK Version Management** trong PIN Utilities.

---

## Tổng quan kiến trúc

```
MCP Gateway (VNG internal)
    │
    ▼  [sync script — chạy thủ công / cron]
sync/run_sync.py
    ├── mcp_client.py      → fetch game_list + sdk_version_snapshot
    └── supabase_writer.py → upsert vào Supabase

Supabase (PostgreSQL)
    │
    ▼  [FastAPI backend — deploy Railway]
GET /api/sdk-versions/summary
GET /api/sdk-versions/detail

    │
    ▼  [Frontend — Vanilla JS]
SdkVersionPanel (Summary + Detail views)
```

**Luồng dữ liệu:** MCP → Supabase → FastAPI → Browser
**Sync script KHÔNG deploy lên Railway** — chỉ chạy thủ công hoặc qua crontab.

---

## 1. Supabase — Tạo bảng

### 1.1 Tạo bảng `sdk_version_snapshots`

Chạy SQL sau trong Supabase SQL Editor:

```sql
CREATE TABLE sdk_version_snapshots (
    id                          bigserial PRIMARY KEY,
    game_id                     text        NOT NULL,
    platform                    text        NOT NULL,
    product_name                text,
    latest_version              text,
    latest_version_records      bigint,
    latest_version_share_ratio  integer,
    stable_version              text,
    stable_version_share_ratio  integer,
    latest_date                 text,
    updated_time                text,
    synced_at                   timestamptz,

    CONSTRAINT sdk_version_snapshots_game_platform_unique
        UNIQUE (game_id, platform)
);
```

### 1.2 Lấy credentials

Vào **Supabase Dashboard → Project Settings → API**:

| Giá trị | Mô tả |
|---|---|
| `Project URL` | → `SUPABASE_URL` |
| `service_role` key (Secret) | → `SUPABASE_SERVICE_KEY` |

> **Lưu ý:** Dùng `service_role` key, **không** dùng `anon` key — cần quyền ghi dữ liệu.

---

## 2. Sync Script — Cấu hình

Script nằm trong thư mục `sync/`, chạy độc lập với Railway deployment.

### 2.1 Cài đặt dependencies

```bash
cd sync/
pip install -r requirements.txt
# httpx==0.28.1
# python-dotenv==1.0.1
```

### 2.2 Tạo file `sync/.env`

```bash
cp sync/.env.example sync/.env
```

Chỉnh sửa `sync/.env`:

```env
# MCP API — VNG internal gateway
MCP_BASE_URL=https://mcp-gateway.gio.vng.vn/mcp
MCP_BEARER_TOKEN=<bearer_token_từ_VNG>

# Supabase — dùng service_role key
SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

# Tuỳ chọn
MCP_TIMEOUT_SECONDS=30        # timeout mỗi request MCP (giây)
ERROR_THRESHOLD_PCT=20        # % lỗi tối đa trước khi exit code 1
MCP_DEBUG=                    # đặt thành "1" để log raw MCP response
```

> **Bảo mật:** File `sync/.env` đã được thêm vào `.gitignore` và `.railwayignore` — **không commit**.

### 2.3 Chạy thủ công

```bash
cd sync/
python run_sync.py
```

**Output mẫu:**
```
[sync] Đang lấy danh sách game từ MCP game_list...
[sync] Tìm thấy 219 games.
  • A01 — GameName1
  • A78 — GameName2
  ...
[sync] ✓ A01 (GameName1): 2 records
[sync] ✓ A78 (GameName2): 3 records
[sync] – B99 (GameName3): không có data snapshot, bỏ qua
[sync] Upserted 480 records vào Supabase
[sync] Hoàn thành trong 45.2s — 180 OK, 39 bỏ qua (no data), 0 lỗi
```

### 2.4 Debug MCP response

```bash
MCP_DEBUG=1 python run_sync.py 2>&1 | head -50
```

---

## 3. Crontab — Lên lịch tự động

### 3.1 Cài đặt cron

```bash
crontab -e
```

Thêm dòng sau để sync mỗi ngày lúc 6:00 AM:

```cron
0 6 * * * cd /path/to/PIN/sync && /usr/bin/python3 run_sync.py >> /var/log/sdk-sync.log 2>&1
```

**Các tần suất khác:**

```cron
# Mỗi 6 giờ
0 */6 * * * cd /path/to/PIN/sync && python3 run_sync.py >> /var/log/sdk-sync.log 2>&1

# Mỗi ngày 2:00 AM
0 2 * * * cd /path/to/PIN/sync && python3 run_sync.py >> /var/log/sdk-sync.log 2>&1

# Thứ Hai hàng tuần lúc 7:00 AM
0 7 * * 1 cd /path/to/PIN/sync && python3 run_sync.py >> /var/log/sdk-sync.log 2>&1
```

### 3.2 Kiểm tra cron đang chạy

```bash
# Xem log
tail -f /var/log/sdk-sync.log

# Kiểm tra cron service
systemctl status cron      # Ubuntu/Debian
# hoặc
launchctl list | grep cron  # macOS
```

### 3.3 Exit code

| Code | Ý nghĩa |
|---|---|
| `0` | Thành công |
| `1` | Lỗi nghiêm trọng (không lấy được game_list, Supabase lỗi, hoặc > `ERROR_THRESHOLD_PCT`% games lỗi) |

---

## 4. Backend (FastAPI) — Cấu hình

### 4.1 Tạo file `.env` (root)

```bash
cp .env.example .env
```

Thêm phần Supabase vào `.env`:

```env
# ... (Google OAuth, Session, v.v.)

# Supabase — SDK Version Management
SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

# Ngưỡng alert adoption rate (%)
ADOPTION_WARN_THRESHOLD=80    # dưới 80% → WARN
ADOPTION_CRITICAL_THRESHOLD=50 # dưới 50% → CRITICAL
```

### 4.2 Status thresholds

| Status | Badge | Điều kiện |
|---|---|---|
| ✅ OK | Xanh | `latest_version_share_ratio` ≥ `ADOPTION_WARN_THRESHOLD` (mặc định 80%) |
| ⚠️ WARN | Vàng | ≥ `ADOPTION_CRITICAL_THRESHOLD` (50%) và < warn threshold |
| 🔴 CRITICAL | Đỏ | < `ADOPTION_CRITICAL_THRESHOLD` (mặc định 50%) |

Thay đổi thresholds không cần restart — chỉ cần cập nhật env var và redeploy.

### 4.3 Chạy local

```bash
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8080 --reload
```

Kiểm tra:
```bash
curl -b "session_id=<token>" http://localhost:8080/api/sdk-versions/summary
curl -b "session_id=<token>" http://localhost:8080/api/sdk-versions/detail?platform=android
```

---

## 5. Railway — Deploy backend

### 5.1 Environment Variables trên Railway Dashboard

Vào **Railway → Project → Variables**, thêm:

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://your-app.railway.app/auth/callback
SESSION_SECRET=<random 32-byte hex>
SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
ADOPTION_WARN_THRESHOLD=80
ADOPTION_CRITICAL_THRESHOLD=50
```

> `PORT` được Railway inject tự động — không cần set.

### 5.2 Kiểm tra Supabase config

Endpoint debug (chỉ dùng khi cần, xóa sau):

```bash
GET /api/sdk-versions/debug
```

Response:
```json
{
  "supabase_url": "https://xxxxxxxxxxxx.supabase.co",
  "supabase_key_set": true,
  "supabase_key_prefix": "eyJhbGciOiJIUzI1NiIsI..."
}
```

### 5.3 `.railwayignore`

Đảm bảo `sync/` không deploy lên Railway:

```
sync/
```

---

## 6. API Endpoints

Tất cả endpoints yêu cầu session cookie hợp lệ (đã đăng nhập Google OAuth).

### `GET /api/sdk-versions/summary`

Trả về KPI tổng hợp, version distribution, platform usage, danh sách mismatch.

**Response:**
```json
{
  "kpi": {
    "total_games": 150,
    "fully_updated": 80,
    "warn_count": 45,
    "critical_count": 25,
    "last_synced": "2026-03-28T06:00:00+00:00"
  },
  "version_distribution": {
    "android": [
      {
        "version": "3.14.0",
        "game_count": 80,
        "pct": 53,
        "is_newest": true,
        "is_latest_dominant": true
      }
    ]
  },
  "platform_usage": [...],
  "mismatch_games": [...]
}
```

### `GET /api/sdk-versions/detail`

**Query params:**

| Param | Mô tả | Ví dụ |
|---|---|---|
| `platform` | Filter theo platform | `android`, `ios`, `windows` |
| `status` | Filter theo status | `ok`, `warn`, `critical` |
| `search` | Tìm theo game_id hoặc product_name | `A78`, `GameName` |

**Response:**
```json
{
  "items": [
    {
      "game_id": "A78",
      "product_name": "GameName",
      "platform": "android",
      "latest_version": "3.14.0",
      "latest_version_records": 12500,
      "latest_version_share_ratio": 85,
      "stable_version": "3.12.0",
      "stable_version_share_ratio": 95,
      "version_mismatch": true,
      "status": "ok",
      "latest_date": "2026-03-20"
    }
  ],
  "total": 1
}
```

---

## 7. Troubleshooting

### Sync script không lấy được game list

```bash
MCP_DEBUG=1 python run_sync.py
```

Kiểm tra:
- `MCP_BASE_URL` đúng URL gateway
- `MCP_BEARER_TOKEN` còn hiệu lực
- VPN/network kết nối được tới MCP gateway

### game_id bị null từ MCP

MCP tool `game_list` trả về `game_id: null` nhưng ID thực nằm ở field `product_code`. Script đã xử lý fallback:

```
game_id → product_code → id → gameId
```

Nếu tất cả đều null → game bị bỏ qua.

### Supabase upsert lỗi 409 / conflict

Script đã dedup theo `(game_id, platform)` trước khi upsert + dùng `resolution=merge-duplicates`. Nếu vẫn lỗi, kiểm tra constraint trên bảng:

```sql
SELECT constraint_name FROM information_schema.table_constraints
WHERE table_name = 'sdk_version_snapshots';
```

### Frontend không hiển thị data

1. Kiểm tra `SUPABASE_URL` và `SUPABASE_SERVICE_KEY` đúng trên Railway
2. Gọi `/api/sdk-versions/debug` để verify config
3. Kiểm tra bảng Supabase có data: Supabase Dashboard → Table Editor → `sdk_version_snapshots`

### Version "Latest" badge sai

Backend dùng semver comparison (`minor.major.patch`):
- So sánh từng phần: minor → major → patch
- Version có tuple `(minor, major, patch)` lớn nhất = newest

Nếu badge sai sau deploy → hard refresh browser (Cmd+Shift+R) để xóa cache JS cũ.

---

## 8. Bảo mật

| Thành phần | Lưu ở đâu | Không lưu ở đâu |
|---|---|---|
| `MCP_BEARER_TOKEN` | `sync/.env` | Git, Railway |
| `SUPABASE_SERVICE_KEY` | Railway env vars + `sync/.env` | Git, frontend |
| `GOOGLE_CLIENT_SECRET` | Railway env vars + `.env` | Git, frontend |
| `SESSION_SECRET` | Railway env vars + `.env` | Git |

Frontend **không** gọi Supabase trực tiếp — tất cả đi qua FastAPI với session cookie authentication.
