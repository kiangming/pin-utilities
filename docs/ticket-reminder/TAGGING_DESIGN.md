# TAGGING_DESIGN.md — Tag Assignee in Teams Message
> Design document cho tính năng tag handler trong Teams remind message.
> Status: **Implemented — v4.8.4**

---

## 1. Tổng quan

Khi gửi remind message đến Teams, tag tên handler (assignee) của ticket để handler nhận được notification trực tiếp.

**Message mẫu (có tag):**
```
Hi John Doe, the sandbox account for GameA (ticket #1234) will expire on 15/04/2024. ...
cc: <at>Vũ Nguyên Kha</at>
```

**Fallback (không lấy được user info):**
```
Hi John Doe, ...
cc: Vũ Nguyên Kha
```

---

## 2. User Lookup API

### 2.1 Endpoint
```
GET https://nexus.vnggames.com/api/ticket-management/v1/users?limit=5000&ids={id1},{id2},...
```

- **Không cần HMAC headers** — plain GET, không cần `requestUser`, không cần `client-id`/`timestamp`/`signature`
- `ids`: comma-separated, ví dụ `ids=12,138,456`
- `limit=5000`: bắt buộc để lấy đủ kết quả

### 2.2 Response
```json
{
  "data": [
    {
      "id": 12,
      "username": "khavn",
      "fullname": "Vũ Nguyên Kha",
      "email": "khavn@vng.com.vn",
      "is_admin": 0
    }
  ]
}
```

### 2.3 Mapping
| Field dùng | Source | Dùng để |
|---|---|---|
| `mention.id` | `data[i].email` | Teams mention target (e.g. `khavn@vng.com.vn`) |
| `mention.name` | `data[i].fullname` | Tên hiển thị trong `<at>` tag |
| fallback text | `data[i].fullname` | Plain text khi không có mention |

Dùng `email` trực tiếp thay vì tự build `username@vng.com.vn` — chính xác hơn vì domain có thể khác nhau.

---

## 3. Data Flow — handler_id

### 3.1 Vấn đề hiện tại
`ticket.handler.id` có trong raw ticket data từ Nexus API nhưng **không** được đưa qua:
- `build_remind_item()` → `filter_service.py`
- `SendTicket` Pydantic model → `remind.py`
- Frontend → send endpoint

### 3.2 Giải pháp: thêm `handler_id` vào chain

```
Raw ticket (Nexus API)
  ticket["handler"]["id"]          ← có sẵn
      ↓
build_remind_item() — filter_service.py
  thêm field: handler_id = ticket.get("handler", {}).get("id")
      ↓
Job result ticket dict
  { ..., handler_id: 11, assignee_name: "Tran Van B", ... }
      ↓
SendTicket Pydantic model — remind.py
  thêm field: handler_id: Optional[int] = None
      ↓
POST /api/remind/send
  body tickets[] chứa handler_id
      ↓
send endpoint — thu thập unique handler_ids → batch user lookup
```

---

## 4. User Lookup — Batch + In-request Cache

### 4.1 Vị trí gọi
Gọi **một lần duy nhất** tại đầu `POST /api/remind/send`, trước khi loop gửi tickets.

### 4.2 Flow
```python
# 1. Thu thập unique handler_ids (bỏ None)
handler_ids = list({t.handler_id for t in req.tickets if t.handler_id})

# 2. Batch lookup (1 API call cho tất cả)
if handler_ids:
    user_map = await fetch_users_by_ids(handler_ids)
    # user_map: { handler_id (int) → { "email": ..., "fullname": ... } }
else:
    user_map = {}

# 3. Loop gửi — mỗi ticket resolve từ user_map
for ticket in req.tickets:
    user_info = user_map.get(ticket.handler_id)  # None nếu không có
    ...
```

### 4.3 Không cần persistent cache
- Gửi remind xảy ra 1 lần per batch → in-request dict là đủ
- Không cần Redis/file cache giữa các request
- Mỗi `POST /api/remind/send` chỉ có 1 batch lookup dù có bao nhiêu tickets

### 4.4 Hàm mới trong ticket_service.py
```python
async def fetch_users_by_ids(handler_ids: list[int]) -> dict[int, dict]:
    """
    Gọi Nexus users API — không cần HMAC auth.
    Trả về dict: { handler_id → { email, fullname } }
    """
    url = f"https://nexus.vnggames.com/api/ticket-management/v1/users"
    ids_str = ",".join(str(i) for i in handler_ids)
    params = {"limit": 5000, "ids": ids_str}
    # Plain GET — không có headers đặc biệt
    resp = await client.get(url, params=params, timeout=10)
    result = {}
    for user in resp.json().get("data", []):
        result[user["id"]] = {
            "email": user.get("email", ""),
            "fullname": user.get("fullname", ""),
        }
    return result
```

---

## 5. Template — Placeholder `{tagged_handler}`

### 5.1 Ý nghĩa
Placeholder mới trong template content:
```
cc: {tagged_handler}
```

### 5.2 Render logic (template_service.py)
```
Khi có mention (user_info available):
  {tagged_handler} → "<at>Vũ Nguyên Kha</at>"
  (chuỗi này xuất hiện trong message_text của Adaptive Card)

Khi không có mention (fallback):
  {tagged_handler} → "Vũ Nguyên Kha"
  (plain text, không có <at> tag)
```

`render()` nhận thêm arg `tagged_handler_text: str` — caller truyền vào đã resolved.

### 5.3 Template mẫu (seed data cần update)
```
Hi {requester_name}, the sandbox account for {product_name} (ticket #{ticket_id}) {time_label}. Do you need to extend it? If so, please leave a comment on the ticket. Thank you!
cc: {tagged_handler}
```

---

## 6. teams_service.py — Adaptive Card

### 6.1 Hai hàm riêng biệt (không upgrade send_message)
- `send_message(url, message)` — giữ nguyên (plain text), dùng cho `send_test`
- `send_mention_message(url, message_text, mention)` — hàm mới cho remind thực tế

Lý do giữ tách biệt:
- `send_test` không cần tag người
- Tránh breaking change cho test flow
- Adaptive Card có format khác hoàn toàn với plain text payload

### 6.2 Adaptive Card payload
```python
def send_mention_message(url: str, message_text: str, mention: dict | None) -> tuple[bool, str | None]:
    """
    mention = None  → gửi plain text (fallback)
    mention = {
        "id": "khavn@vng.com.vn",
        "name": "Vũ Nguyên Kha"
    }
    """
    if mention:
        mention_entity = {
            "type": "mention",
            "text": f"<at>{mention['name']}</at>",
            "mentioned": {
                "id": mention["id"],
                "name": mention["name"]
            }
        }
        payload = {
            "type": "message",
            "attachments": [{
                "contentType": "application/vnd.microsoft.card.adaptive",
                "content": {
                    "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                    "type": "AdaptiveCard",
                    "version": "1.0",
                    "body": [{"type": "TextBlock", "text": message_text, "wrap": True}],
                    "msteams": {"entities": [mention_entity]}
                }
            }]
        }
    else:
        # Fallback: plain text
        payload = {"text": message_text}
    # POST payload to url, timeout=10s
    ...
```

---

## 7. remind.py — Send Endpoint Orchestration

### 7.1 Flow đầy đủ
```
POST /api/remind/send
  Body: { tickets: [SendTicket] }  ← SendTicket bây giờ có handler_id

1. Thu thập unique handler_ids → batch fetch_users_by_ids()
   → user_map: { id → { email, fullname } }

2. Loop mỗi ticket:
   a. find_webhook_for_product(product_name)
      → nếu không có → status=skipped, tiếp tục
   b. Resolve user_info = user_map.get(handler_id)
   c. Build tagged_handler_text:
        nếu user_info → "<at>{fullname}</at>"
        nếu không     → assignee_name (từ ticket)
   d. render(template_content, {..., tagged_handler: tagged_handler_text})
      → message_text
   e. Build mention dict:
        nếu user_info → { id: email, name: fullname }
        nếu không     → None
   f. send_mention_message(webhook_url, message_text, mention)
      → (ok, error)
   g. create_log(...)

3. Return results[]
```

### 7.2 Fallback tại mỗi bước

| Bước | Failure | Fallback |
|---|---|---|
| fetch_users_by_ids() | API lỗi / timeout | `user_map = {}` → toàn bộ tickets dùng plain text |
| user_map.get(handler_id) | ID không trong response | `None` → dùng `assignee_name` làm fallback text |
| handler_id is None | Frontend không gửi | `None` → plain text, không tag |
| send_mention_message() | mention=None | gửi `{"text": message_text}` plain |

---

## 8. Thay đổi tóm tắt theo file

| File | Thay đổi |
|---|---|
| `filter_service.py` | `build_remind_item()`: thêm `handler_id` field |
| `ticket_service.py` | Thêm `fetch_users_by_ids(ids)` — plain GET, không HMAC |
| `teams_service.py` | Thêm `send_mention_message(url, text, mention)` — giữ `send_message` |
| `template_service.py` | `render()` nhận `tagged_handler` param (đã resolved trước khi gọi) |
| `remind.py` | `SendTicket` model thêm `handler_id: Optional[int]`; send endpoint: batch lookup + mention build |
| `frontend/ticket-reminder.js` | `SendTicket` payload thêm `handler_id` |

---

## 9. Decision Log

| # | Quyết định | Lý do |
|---|---|---|
| D1 | Dùng `email` từ API thay vì build `username@vng.com.vn` | Email trực tiếp, chính xác hơn, không giả định domain |
| D2 | Batch lookup 1 lần đầu send endpoint | Tránh N API calls; users API nhanh, không cần persistent cache |
| D3 | Giữ `send_message` riêng, thêm `send_mention_message` mới | Không break test flow; plain text và Adaptive Card là 2 format khác nhau |
| D4 | `tagged_handler_text` resolved trước khi gọi `render()` | template_service không cần biết về mention; render() vẫn pure function |
| D5 | Fallback về plain text khi không có user_info | UX tốt hơn so với skip/fail — message vẫn gửi được |
| D6 | Users API không cần HMAC — plain GET | Confirmed: endpoint public, không cần auth headers |
