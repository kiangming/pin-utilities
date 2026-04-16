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

## 2. Handler Mention Resolution

### 2.1 Vấn đề API unreachable

`nexus.vnggames.com/api/ticket-management/v1/users` là internal API, **không thể gọi từ Railway** (cloud environment). API đã được thiết kế nhưng bị blocked bởi network policy.

### 2.2 Giải pháp thay thế: handler_usernames table matching

Thay vì gọi users API, resolve mention bằng cách lookup bảng `handler_usernames` trong Supabase theo `full_name`:

```
ticket.assignee_name (full_name)
    ↓ normalize: .strip().lower()
handler_usernames.full_name (case-insensitive match)
    ↓ nếu match
handler_usernames.username → "{username}@vng.com.vn" = mention.id
handler_usernames.full_name = mention.name
```

### 2.3 Mapping
| Field dùng | Source | Dùng để |
|---|---|---|
| `mention.id` | `"{username}@vng.com.vn"` | Teams mention target |
| `mention.name` | `handler_usernames.full_name` | Tên hiển thị trong `<at>` tag |
| fallback text | `ticket.assignee_name` | Plain text khi không match |

### 2.4 Điều kiện để tag thành công
- Handler đã được thêm vào bảng `handler_usernames` (tab Handlers trong Config)
- `full_name` trong DB phải khớp với `assignee_name` từ ticket (case-insensitive)
- `username` phải điền đúng (dùng để build `username@vng.com.vn`)

### 2.5 Users API (thiết kế gốc — hiện không dùng)

API đã thiết kế nhưng không khả dụng từ Railway:
```
GET https://nexus.vnggames.com/api/ticket-management/v1/users?limit=5000&ids={id1},{id2},...
```
Code `fetch_users_by_ids()` trong `ticket_service.py` vẫn tồn tại nhưng không được gọi trong implementation hiện tại.

---

## 3. Data Flow

### 3.1 Chain từ raw ticket đến mention

```
Raw ticket (Nexus API)
  ticket["handler"]["id"]       ← handler_id, vẫn lưu nhưng không dùng để lookup
  ticket["handler"]["name"]     ← assignee_name
      ↓
build_remind_item() — filter_service.py
  fields: assignee_name, handler_id (optional)
      ↓
Job result ticket dict
  { ..., handler_id: 11, assignee_name: "Tran Van B", ... }
      ↓
SendTicket Pydantic model — remind.py
  fields: assignee_name: str, handler_id: int | None
      ↓
POST /api/remind/send
  1. Load tất cả handlers từ DB (1 lần)
  2. Build handler_name_map: full_name.lower() → { username, full_name }
  3. Per ticket: lookup assignee_name.lower() trong map
  4. Nếu match → build mention; nếu không → plain text fallback
```

### 3.2 Implementation trong remind.py
```python
handlers = remind_db.get_handlers()
handler_name_map = {
    h["full_name"].strip().lower(): h
    for h in handlers
    if h.get("full_name") and h.get("username")
}

# Per ticket:
handler_key = (ticket.assignee_name or "").strip().lower()
handler_info = handler_name_map.get(handler_key)
if handler_info:
    username = handler_info["username"]
    fullname = handler_info["full_name"]
    tagged_handler = f"<at>{fullname}</at>"
    mention = {"id": f"{username}@vng.com.vn", "name": fullname}
else:
    tagged_handler = ticket.assignee_name or ""
    mention = None
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

### 5.3 Tất cả placeholders tag

| Placeholder | Source username | Source name | Fallback |
|---|---|---|---|
| `{tagged_handler}` | `handler_usernames` DB (lookup by `assignee_name`) | DB `full_name` | `assignee_name` plain text |
| `{tagged_commenter}` | `last_comment.user.username` từ comments API | `last_comment.user.name` | `""` rỗng |
| `{tagged_requester}` | `ticket.requester.login` | `ticket.requester.name` | `requester_name` plain text |

### 5.4 Template mẫu gợi ý
```
Hi {tagged_requester}, ticket {ticket_link} ({product_name}) {time_label}.
{tagged_commenter} please check and respond.
cc: {tagged_handler}
```

---

## 6. teams_service.py — Adaptive Card

### 6.1 Hai hàm riêng biệt (không upgrade send_message)
- `send_message(url, message)` — giữ nguyên (plain text), dùng cho `send_test`
- `send_mention_message(url, message_text, mentions)` — Adaptive Card, dùng cho remind

### 6.2 Adaptive Card payload (multiple mentions)
```python
def send_mention_message(url: str, message_text: str, mentions: list[dict]) -> tuple[bool, str | None]:
    """
    mentions = []  → fallback plain text
    mentions = [{ "id": "user@vng.com.vn", "name": "Name" }, ...]
    """
    if mentions:
        entities = [
            {
                "type": "mention",
                "text": f"<at>{m['name']}</at>",
                "mentioned": {"id": m["id"], "name": m["name"]},
            }
            for m in mentions
        ]
        payload = {
            "type": "message",
            "attachments": [{
                "contentType": "application/vnd.microsoft.card.adaptive",
                "content": {
                    "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                    "type": "AdaptiveCard",
                    "version": "1.2",
                    "body": [{"type": "TextBlock", "text": message_text, "wrap": True}],
                    "msteams": {"entities": entities},  # ← list, hỗ trợ 0–3 mentions
                }
            }]
        }
    else:
        payload = {"text": message_text}
```

---

## 7. remind.py — Send Endpoint Orchestration

### 7.1 Flow đầy đủ
```
POST /api/remind/send
  Body: { tickets: [SendTicket] }  ← gồm last_comment_username, last_comment_name, requester_login

1. Load handler_name_map từ DB (1 lần)
   map: full_name.lower() → { username, full_name }

2. Loop mỗi ticket:
   a. find_webhook_for_product(product_name)
      → nếu không có → status=skipped
   b. Resolve handler_mention: assignee_name → handler_name_map
   c. Resolve commenter_mention: last_comment_username + last_comment_name
   d. Resolve requester_mention: requester_login + requester_name
   e. Build ticket_link: "[#id](ticket_url)"
   f. render(template, {..., tagged_handler, tagged_commenter, tagged_requester, ticket_link})
   g. mentions = [m for m in [handler_mention, commenter_mention, requester_mention] if m]
   h. send_mention_message(webhook_url, message_text, mentions)
   i. create_log(...)

3. Return results[]
```

### 7.2 Fallback tại mỗi bước

| Bước | Failure | Fallback |
|---|---|---|
| handler_name_map lookup | full_name không khớp | plain text `assignee_name`, không tag |
| last_comment_username rỗng | không có last comment | `tagged_commenter = ""` |
| requester_login rỗng | API không trả về login | plain text `requester_name` |
| mentions rỗng | không resolve được user nào | gửi `{"text": message_text}` plain |
| Webhook không tìm thấy | product chưa cấu hình | status=skipped, ghi log |

---

## 8. Thay đổi tóm tắt theo file

| File | Thay đổi |
|---|---|
| `filter_service.py` | `build_remind_item()`: thêm `handler_id`, `assignee_name`, `requester_login` fields |
| `ticket_service.py` | Giữ `fetch_users_by_ids()` (không gọi trong flow hiện tại) |
| `teams_service.py` | `send_mention_message`: đổi `mention: dict\|None` → `mentions: list[dict]`; build `entities` array |
| `template_service.py` | SAMPLE_DATA: thêm `ticket_link`, `tagged_commenter`, `tagged_requester` |
| `remind.py` | `SendTicket` thêm `last_comment_username`, `last_comment_name`, `requester_login`; resolve 3 mentions; render 3 placeholders mới |
| `frontend/ticket-reminder.js` | SendTicket payload thêm 3 fields; template hint cập nhật đủ 9 placeholders |

---

## 9. Decision Log

| # | Quyết định | Lý do |
|---|---|---|
| D1 | Dùng `handler_usernames` table thay vì users API | nexus.vnggames.com không accessible từ Railway — internal network policy |
| D2 | Match theo `full_name` (không phải `handler_id`) | handler_id không dùng được; full_name là thông tin đã có ở cả ticket và DB |
| D3 | Giữ `send_message` riêng, thêm `send_mention_message` mới | Không break test flow; plain text và Adaptive Card là 2 format khác nhau |
| D4 | `tagged_handler` resolved trước khi gọi `render()` | template_service không cần biết về mention; render() vẫn pure function |
| D5 | Fallback về plain text khi không match | UX tốt hơn so với skip/fail — message vẫn gửi được, chỉ thiếu tag |
| D6 | Build mention.id = `{username}@vng.com.vn` | Domain VNG thống nhất; username lưu trong DB do admin nhập thủ công |
| D7 | Adaptive Card version 1.2 (không phải 1.0) | 1.2 hỗ trợ đầy đủ Teams mention; 1.0 có thể không render `msteams.entities` |
| D8 | `send_mention_message` nhận `list[dict]` thay vì `dict\|None` | Hỗ trợ nhiều mention trong 1 message; `entities` là array trong spec Adaptive Card |
| D9 | `{tagged_commenter}` lấy từ last_comment.user.username | Data đã có trong job result, không cần API call thêm |
| D10 | `{tagged_requester}` lấy từ ticket.requester.login | Có sẵn trong raw ticket data; login = VNG username = `login@vng.com.vn` |
| D11 | `{ticket_link}` dùng Markdown `[#id](url)` | Teams Adaptive Card TextBlock hỗ trợ Markdown link natively |
