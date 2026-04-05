# ARCHITECTURE.md — Ticket Reminder Feature
> Mô tả kiến trúc kỹ thuật, tech stack, và database schema.
> Cập nhật theo trạng thái **đã implement** (v4.8+).

---

## 1. Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla JS (IIFE module `TicketReminderPanel`) + CSS Variables |
| Backend | FastAPI (Python 3.12) |
| Database | Supabase (PostgreSQL) — truy cập qua REST API + httpx (không dùng supabase-py) |
| Deploy | Railway via Dockerfile |
| Messaging | Microsoft Teams Incoming Webhook |

---

## 2. Kiến trúc Client-Server

```
Browser (Frontend — ticket-reminder.js)
    │
    │  REST API calls (same-origin, credentials: include)
    ▼
FastAPI Backend (Railway)
    ├── /api/remind/tickets/fetch          → start background job
    ├── /api/remind/tickets/fetch/status   → poll job progress
    ├── /api/remind/send                   → gửi Teams webhook
    ├── /api/remind/webhooks               → CRUD webhook config
    ├── /api/remind/templates              → CRUD message templates
    ├── /api/remind/handlers               → CRUD handler usernames
    ├── /api/remind/products               → CRUD + sync products
    ├── /api/remind/services               → CRUD + sync services
    ├── /api/remind/statuses               → CRUD + sync statuses
    └── /api/remind/logs                   → remind history
    │
    ├── Supabase (DB)         → lưu config, templates, remind logs, products, services, statuses
    └── Nexus Ticket API      → external ticket system (HMAC SHA1 signature auth)
```

**Files backend:**
```
backend/
  routers/remind.py            ← 20+ endpoints /api/remind/*
  services/
    ticket_service.py          ← HMAC auth, fetch tickets/comments/products/services/statuses
    filter_service.py          ← calc_diff_days, is_need_remind, build_remind_item (pure functions)
    template_service.py        ← render {placeholder} templates, preview với SAMPLE_DATA
    teams_service.py           ← send_message, send_test (timeout 10s)
    remind_db.py               ← Supabase httpx CRUD (6 tables)
    fetch_job_service.py       ← Background job: fetch tickets + comments, progress polling
```

---

## 3. Database Schema (Supabase)

### 3.1 Bảng `remind_templates`
```sql
CREATE TABLE remind_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  content     TEXT NOT NULL,
  -- Placeholders: {requester_name}, {product_name}, {ticket_id},
  --               {due_date}, {days_left}, {time_label}
  is_default  BOOLEAN DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);
```

### 3.2 Bảng `webhook_configs`
```sql
CREATE TABLE webhook_configs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_name TEXT NOT NULL,          -- match với ticket product name (case-insensitive)
  product_code TEXT,                   -- optional
  channel_name TEXT NOT NULL,
  webhook_url  TEXT NOT NULL,
  template_id  UUID REFERENCES remind_templates(id),
  is_default   BOOLEAN DEFAULT false,
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);
```

### 3.3 Bảng `handler_usernames`
```sql
CREATE TABLE handler_usernames (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username  TEXT NOT NULL UNIQUE,
  full_name TEXT,
  note      TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### 3.4 Bảng `remind_logs`
```sql
CREATE TABLE remind_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   TEXT NOT NULL,
  ticket_url  TEXT,
  product     TEXT,
  requester   TEXT,
  webhook_id  UUID REFERENCES webhook_configs(id),
  template_id UUID REFERENCES remind_templates(id),
  message     TEXT,
  status      TEXT NOT NULL,           -- 'sent' | 'failed' | 'skipped'
  error_msg   TEXT,
  reminded_at TIMESTAMPTZ DEFAULT now()
);
```

### 3.5 Bảng `products`
```sql
CREATE TABLE products (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  code      TEXT,
  alias     TEXT,
  synced_at TIMESTAMPTZ DEFAULT now()
);
```

### 3.6 Bảng `services`
```sql
CREATE TABLE services (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  synced_at   TIMESTAMPTZ DEFAULT now()
);
```

### 3.7 Bảng `ticket_statuses`
```sql
CREATE TABLE ticket_statuses (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  is_closed BOOLEAN DEFAULT false,
  synced_at TIMESTAMPTZ DEFAULT now()
);
```

---

## 4. Backend API Routes (thực tế đã implement)

### Ticket Fetch (Background Job)
```
POST /api/remind/tickets/fetch
     Body: { service_ids, statuses, due_days_threshold, assignee, created_at_from, created_at_to }
     → start_fetch_job() → { job_id }

GET  /api/remind/tickets/fetch/status?job_id=
     → { status, phase, tickets_page, tickets_total_pages, comments_done, comments_total, result, error }
     result: { total, remind_count, no_due_date_count, tickets: [...] }
```

### Remind Send
```
POST /api/remind/send
     Body: { tickets: [{ id, product_name, requester_name, due_date_fmt, diff_days, time_label, title, ticket_url }] }
     → { results: [{ ticket_id, status, channel, message, error }], sent, failed, skipped }
```

### Webhooks CRUD
```
GET    /api/remind/webhooks
POST   /api/remind/webhooks           → 201
PUT    /api/remind/webhooks/{id}
DELETE /api/remind/webhooks/{id}      → 204
POST   /api/remind/webhooks/{id}/test → { ok, error }
```

### Templates CRUD
```
GET    /api/remind/templates
POST   /api/remind/templates          → 201
PUT    /api/remind/templates/{id}
DELETE /api/remind/templates/{id}     → 204
POST   /api/remind/templates/{id}/preview → { preview }
```

### Handlers CRUD
```
GET    /api/remind/handlers
POST   /api/remind/handlers           → 201
DELETE /api/remind/handlers/{id}      → 204
```

### Products / Services / Statuses
```
POST /api/remind/products/sync        → { synced, debug_requests }
GET  /api/remind/products?offset=&limit=  → { items, total }

POST /api/remind/services/sync        → { synced, debug_requests }
GET  /api/remind/services

POST /api/remind/statuses/sync        → { synced, debug_requests }
GET  /api/remind/statuses
```

### Logs
```
GET  /api/remind/logs?status=&limit=  → list of log objects
```

---

## 5. External API Integration

### 5.1 HMAC SHA1 Signature Auth
Port từ PHP `buildSignature()`. Signature tính theo:
```python
hash_string = sha1(client_secret).hexdigest()
for value in sorted(params.values()):      # params đã ksort
    if isinstance(value, list):
        value = json.dumps([v for v in value if v], separators=(",",":"))
    str_val = html_entity_decode(str(value))
    if str_val:
        hash_string += "|" + str_val
signature = sha1(hash_string).hexdigest()
```

Headers gửi lên: `client-id`, `timestamp` (milliseconds), `signature`, `Content-Type`.

**Quan trọng:** `sig_params` chỉ chứa query string params — KHÔNG bao gồm path params (vd: `ticket_id` trong `/tickets/{id}/comments`).

### 5.2 Array params trong URL
PHP-style: `service_ids[]=1&service_ids[]=2` (không phải `service_ids=1,2`).

### 5.3 Background Job Flow
```
Phase 1 "tickets": fetch_all_tickets() với on_page callback
  → update job["tickets_page"] / ["tickets_total_pages"] real-time
  → delay 300ms giữa các page

Phase 2 "comments": loop qua tất cả tickets
  → fetch_ticket_comments() cho mọi ticket (không skip)
  → build_remind_item()
  → delay 100ms giữa các ticket

Phase "done": _sort_tickets() → need_remind=true trước, sau đó diff_days tăng dần
```

**Lưu ý:** Phase 3 `fetch_ticket_detail()` đã bị bỏ — ticket_url được build client-side từ hardcoded template `https://nexus.vnggames.com/home/tickets-v2/{id}`.

### 5.4 needRemind Logic (`filter_service.py`)
```python
def is_need_remind(ticket, comments, handler_usernames, threshold):
    diff = calc_diff_days(ticket["due_date"])   # (due_date - today).days
    if diff is None: return False               # không có due_date
    if diff > threshold: return False           # còn nhiều ngày
    if not comments: return True               # chưa có comment nào
    last_username = comments[-1]["user"]["username"]
    return last_username in handler_usernames   # last comment là handler
```

---

## 6. Ticket List — Data Model (build_remind_item)

Mỗi ticket trong job result có các fields:

| Field | Source | Mô tả |
|---|---|---|
| `id` | ticket.id | Ticket ID |
| `ticket_url` | hardcoded template | `https://nexus.vnggames.com/home/tickets-v2/{id}` |
| `product_id` | ticket.product.id | Product ID |
| `product_code` | ticket.product.code | Product code |
| `product_name` | ticket.product.name | Product name |
| `title` | ticket.title | Tiêu đề ticket |
| `requester_name` | ticket.requester.name | Tên người tạo |
| `requester_login` | ticket.requester.login | Login người tạo |
| `assignee_name` | ticket.handler.name | Tên người xử lý |
| `created_at` | ticket.created_at | Ngày tạo (ISO) |
| `status` | ticket.status.name | Trạng thái |
| `due_date` | ticket.due_date | YYYY-MM-DD |
| `due_date_fmt` | computed | DD/MM/YYYY |
| `diff_days` | computed | days from today (negative = overdue) |
| `need_remind` | computed | boolean |
| `time_label` | computed | "will expire on..." / "expired on..." |
| `last_comment` | comments API | `{name, notes, created_on}` — name = comment.user.name |
| `last_comment_by` | comments API | comment.user.username |
| `last_comment_is_handler` | computed | boolean |

**Product display format:** `{product_id} - [{product_code} - {product_name}]`  
Nếu không có code: `{product_id} - [{product_name}]`

---

## 7. Environment Variables (Railway)

```env
# Nexus Ticket API
TICKET_API_BASE_URL=https://ticket.vnggames.net/integration/v1
TICKET_API_CLIENT_ID=...
TICKET_API_CLIENT_SECRET=...

# Supabase (dùng chung với sdk-versions)
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=...

# Debug (tắt trên production)
DEBUG_TICKET_API=false
```

---

## 8. Debug Mode

Khi `DEBUG_TICKET_API=true`:
- Signature trace (từng bước build hash) in ra Railway logs
- Request + response log (URL, headers, status, body 500 chars)
- Frontend: nút 🐛 Debug toggle → popup dialog với signature trace của request đầu tiên
- Trạng thái lưu vào `localStorage('tkrDebugMode')`
