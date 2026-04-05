# MANAGEMENT_SPEC.md — Remind Config
> Mô tả chi tiết phần quản lý: Webhook, Template, Handler, Services, Products, Statuses, Logs.
> Cập nhật theo trạng thái **đã implement** (v4.8+).

---

## 1. Webhook Config

### 1.1 Mục đích
Map từng product → Teams Channel Webhook URL. Routing đúng channel theo tên product của ticket khi gửi remind.

### 1.2 Data model
```
product_name : text         — match với ticket product name (case-insensitive trim)
product_code : text?        — optional
channel_name : text         — tên hiển thị của Teams channel
webhook_url  : text         — Incoming Webhook URL của Teams
template_id  : uuid?        — template mặc định khi gửi cho product này
is_default   : boolean      — fallback khi không match product nào
```

### 1.3 Routing logic (remind_db.find_webhook_for_product)
```python
1. Tìm webhook có product_name.lower().strip() == ticket.product_name.lower().strip()
2. Nếu không tìm thấy → tìm bản ghi có is_default = true
3. Nếu vẫn không có → status = "skipped", ghi log lỗi
```

### 1.4 Thêm nhiều webhooks cùng lúc (Multi-row form)
- Click "+ Thêm Webhook" → hiện bảng với 1 dòng trống
- Mỗi dòng: product picker (dropdown search từ DB), channel name, webhook URL, template select, default checkbox
- "+ Thêm dòng" append dòng mới ngay lập tức
- "💾 Lưu tất cả (N)": validate tất cả dòng → `Promise.all(POST)` song song
- Lỗi: validation trước khi gửi — báo số dòng chưa điền đầy đủ

### 1.5 Chỉnh sửa webhook
- Nút ✏ → Edit form inline với text inputs (sẵn product name)
- Direct PUT save, không qua staging

### 1.6 Test webhook
- Nút "▶ Test" → `POST /api/remind/webhooks/{id}/test`
- Teams gửi message: `[TEST] Ticket Reminder — test message at {timestamp}`
- Trả về: `{ ok: bool, error: str | null }`

---

## 2. Message Templates

### 2.1 Placeholders được hỗ trợ

| Placeholder | Giá trị | Ví dụ |
|---|---|---|
| `{requester_name}` | ticket.requester.name | `John Doe` |
| `{product_name}` | ticket.product.name | `GameA` |
| `{ticket_id}` | ticket.id | `1234` |
| `{due_date}` | due_date_fmt DD/MM/YYYY | `15/04/2024` |
| `{days_left}` | diff_days (âm nếu quá hạn) | `3` hoặc `-2` |
| `{time_label}` | computed | `will expire on 15/04/2024` |
| `{tagged_handler}` | Teams mention hoặc plain name | `<at>Vũ Nguyên Kha</at>` hoặc `Vũ Nguyên Kha` |

### 2.2 time_label logic
```python
if diff_days < 0:
    return f"expired on {fmt}"
else:
    return f"will expire on {fmt}"
```

### 2.3 tagged_handler logic

```
Khi send_remind():
  Nếu handler_id có và fetch_users_by_ids() trả về user_info:
    tagged_handler = "<at>{fullname}</at>"     → Teams mention (Adaptive Card)
    mention = { id: email, name: fullname }
  Else:
    tagged_handler = assignee_name             → plain text fallback
    mention = None                             → gửi plain text payload
```

### 2.4 Template mặc định (seed data)

**Sandbox Expiry EN:**
```
Hi {requester_name}, the sandbox account for {product_name} (ticket #{ticket_id}) {time_label}. Do you need to extend it? If so, please leave a comment on the ticket. Thank you!
cc: {tagged_handler}
```

**Sandbox Expiry VI:**
```
Xin chào {requester_name}, tài khoản sandbox cho {product_name} (ticket #{ticket_id}) {time_label}. Bạn có cần gia hạn tiếp không? Nếu có vui lòng comment vào ticket nhé. Cảm ơn!
cc: {tagged_handler}
```

### 2.5 Preview
`POST /api/remind/templates/{id}/preview` → render với SAMPLE_DATA cố định trong `template_service.py`.
SAMPLE_DATA bao gồm `tagged_handler: "Jane Smith"` để preview placeholder.

---

## 3. Handler Usernames

### 3.1 Mục đích
`username` của team handler. Khi comment cuối của ticket có `user.username` trong set này → ticket cần nhắc.

### 3.2 Lấy username
Từ field `user.username` trong response của `/tickets/{id}/comments`.

### 3.3 Data model
```
username  : text unique    — case-sensitive
full_name : text?
note      : text?
```

### 3.4 UI
Bảng: Username | Full Name | Note | 🗑

Form thêm: Username (required) | Full Name | Note. Không có edit — xóa rồi thêm lại.

---

## 4. Services

### 4.1 Mục đích
Cache danh sách service từ Nexus API. Dùng để populate filter "Services" khi fetch ticket.

### 4.2 Sync
`POST /api/remind/services/sync` → gọi `GET /services` từ Nexus API → upsert vào Supabase `services`.

### 4.3 Hiển thị
Bảng: ID | Name | Description. Không có CRUD từ UI — chỉ sync + xem.

---

## 5. Products

### 5.1 Mục đích
Cache danh sách product từ Nexus API. Dùng để populate product picker trong webhook form.

### 5.2 Sync
`POST /api/remind/products/sync` → gọi `GET /products` từ Nexus API → upsert vào Supabase `products`.

### 5.3 Hiển thị
Bảng: ID | Name | Code | Alias. Pagination 100 records/trang.

### 5.4 Product picker trong Webhook form
- Load từ `GET /api/remind/products?limit=500`
- Dropdown search theo tên hoặc ID
- Row-scoped (mỗi dòng trong multi-row form có picker riêng)

---

## 6. Statuses

### 6.1 Mục đích
Cache danh sách status từ Nexus API. Dùng để populate filter "Statuses" khi fetch ticket.

### 6.2 Sync
`POST /api/remind/statuses/sync` → gọi `GET /statuses` từ Nexus API → upsert vào Supabase `ticket_statuses`.

### 6.3 Response từ Nexus API
```json
{ "data": [{ "id": 1, "name": "Open", "isClosed": false }] }
```

### 6.4 Hiển thị
Bảng: ID | Name | Closed?. Statuses có `is_closed=true` hiện label `(closed)` trong filter picker.

---

## 7. Remind Logs

### 7.1 Hiển thị
- 50 log gần nhất, filter theo status: All / sent / failed / skipped
- Bảng: Ticket (link) | Product | Requester | Status | Sent At
- Link ticket mở tab mới

### 7.2 Ghi log
Log được ghi tự động sau mỗi lần gửi (`remind_db.create_log()`), bao gồm cả skipped (không có webhook) và failed (webhook lỗi).

---

## 8. Lưu ý triển khai

- Tất cả CRUD gọi qua `/api/remind/*`
- Dữ liệu load lazy khi user mở tab (`_configTabsLoaded[tab]`)
- Webhook URL lưu plaintext trong Supabase (Railway + Supabase có encryption at rest)
- `_loadConfigTab('webhooks')` load đồng thời webhooks + products + templates (`Promise.all`)
- Không cần phân quyền ở giai đoạn này
