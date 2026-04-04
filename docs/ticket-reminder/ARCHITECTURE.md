# ARCHITECTURE.md — Ticket Reminder Feature
> Mô tả kiến trúc kỹ thuật, tech stack, và database schema.

---

## 1. Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla JS + CSS Variables (theo DESIGN.md hiện có) |
| Backend | Node.js (Express) |
| Database | Supabase (PostgreSQL) |
| Deploy | Railway |
| Messaging | Microsoft Teams Incoming Webhook |

---

## 2. Kiến trúc Client-Server

```
Browser (Frontend)
    │
    │  REST API calls
    ▼
Node.js / Express (Backend — Railway)
    ├── /api/tickets          → proxy + xử lý logic filter
    ├── /api/remind           → gửi Teams webhook
    ├── /api/webhooks         → CRUD webhook config
    ├── /api/templates        → CRUD message templates
    └── /api/handlers         → CRUD handler usernames
    │
    ├── Supabase (DB)         → lưu config, templates, remind logs
    └── External API          → Nexus ticket system (với signature auth)
```

**Lý do dùng backend làm proxy:**
- Không expose `client_secret` và API credentials ra browser.
- Tập trung xử lý signature, phân trang, và cache logic.
- Kiểm soát rate limit khi gọi API external.

---

## 3. Database Schema (Supabase)

### 3.1 Bảng `remind_templates`
```sql
CREATE TABLE remind_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,           -- Tên template VD: "Sandbox Expiry EN"
  content     TEXT NOT NULL,           -- Nội dung với placeholder
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
  product_name TEXT NOT NULL,          -- Tên product, match với ticket.products[0].name
  product_code TEXT,                   -- Optional: match theo code
  channel_name TEXT NOT NULL,          -- Tên Teams channel (hiển thị)
  webhook_url  TEXT NOT NULL,          -- Incoming Webhook URL
  template_id  UUID REFERENCES remind_templates(id),  -- Template mặc định
  is_default   BOOLEAN DEFAULT false,  -- Fallback nếu không match product
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);
```

### 3.3 Bảng `handler_usernames`
```sql
CREATE TABLE handler_usernames (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username  TEXT NOT NULL UNIQUE,     -- username trong API response (VD: "huong.tran")
  full_name TEXT,                     -- Tên đầy đủ để hiển thị
  note      TEXT,                     -- Ghi chú tùy ý
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### 3.4 Bảng `remind_logs`
```sql
CREATE TABLE remind_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   TEXT NOT NULL,
  product     TEXT,
  requester   TEXT,
  due_date    DATE,
  webhook_id  UUID REFERENCES webhook_configs(id),
  template_id UUID REFERENCES remind_templates(id),
  message     TEXT,                    -- Nội dung message đã gửi
  status      TEXT NOT NULL,           -- 'sent' | 'failed' | 'skipped'
  error_msg   TEXT,                    -- Lý do lỗi nếu failed
  reminded_at TIMESTAMPTZ DEFAULT now()
);
```

---

## 4. Backend API Routes

### Tickets
```
GET  /api/tickets
     Query: service_ids[], statuses[], created_at_from, created_at_to,
            assignee, per_page, page
     → Fetch từ external API, trả về danh sách ticket thô

POST /api/tickets/review
     Body: { tickets: [...], due_days_threshold: 5 }
     → Fetch comments từng ticket → áp điều kiện lọc → trả về remind list
```

### Remind
```
POST /api/remind/send
     Body: { ticket_ids: [...] }  hoặc  { send_all: true }
     → Build message từ template → gửi Teams webhook → ghi log
```

### Webhook Config
```
GET    /api/webhooks          → Danh sách webhook configs
POST   /api/webhooks          → Tạo mới
PUT    /api/webhooks/:id      → Cập nhật
DELETE /api/webhooks/:id      → Xóa
POST   /api/webhooks/:id/test → Gửi test message
```

### Templates
```
GET    /api/templates         → Danh sách templates
POST   /api/templates         → Tạo mới
PUT    /api/templates/:id     → Cập nhật
DELETE /api/templates/:id     → Xóa
POST   /api/templates/:id/preview  → Preview message với sample data
```

### Handler Usernames
```
GET    /api/handlers          → Danh sách
POST   /api/handlers          → Thêm
DELETE /api/handlers/:id      → Xóa
```

---

## 5. External API Integration

### 5.1 Authentication
Dùng signature-based auth (đã có implementation trong `api-test.js`):
- `client-id`, `timestamp`, `signature` đặt trong **HTTP headers**.
- Signature tính theo: `sha1(sha1(secret) + "|" + sorted_values)`.
- Lưu `CLIENT_ID` và `CLIENT_SECRET` trong Railway environment variables.

### 5.2 Phân trang
Ticket API trả về `meta.last_page`. Backend tự động fetch tất cả pages:
```js
do {
  fetchPage(page)
  page++
} while (page <= lastPage)
```
Delay 300ms giữa các page để tránh rate limit.

### 5.3 Comment API
Fetch comment của từng ticket theo ID. Xác định `needRemind`:
- Lấy comment cuối (`comments[comments.length - 1]`).
- Nếu `last.user.username` thuộc `handler_usernames` → `needRemind = true`.
- Nếu chưa có comment nào → `needRemind = true`.

---

## 6. Environment Variables (Railway)

```env
# External API
API_BASE_URL=https://nexus.vnggames.com/api/ticket-management/v1
API_CLIENT_ID=your_client_id
API_CLIENT_SECRET=your_client_secret

# Supabase
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=your_service_key

# App
PORT=3000
NODE_ENV=production
```

---

## 7. Folder Structure (gợi ý)

```
/
├── server/
│   ├── index.js               # Express app entry
│   ├── routes/
│   │   ├── tickets.js
│   │   ├── remind.js
│   │   ├── webhooks.js
│   │   ├── templates.js
│   │   └── handlers.js
│   ├── services/
│   │   ├── ticketApi.js       # Gọi external API + signature
│   │   ├── filterService.js   # Logic lọc ticket
│   │   ├── templateService.js # Build message từ template
│   │   └── teamsService.js    # Gửi Teams webhook
│   └── lib/
│       └── supabase.js        # Supabase client
│
├── public/                    # Frontend (static files)
│   ├── index.html             # App shell (tích hợp vào tool hiện có)
│   ├── pipeline.css           # CSS hiện có — KHÔNG tạo file mới
│   └── js/
│       └── reminder.js        # JS cho tính năng reminder
│
└── package.json
```
