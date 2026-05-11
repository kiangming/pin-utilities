# TAGGING_DESIGN.md — Tag Assignee in Teams Message
> Design document cho tính năng tag handler/commenter/requester trong Teams remind message.
> Status: **Implemented — v4.8.7**

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

## 2. Handler Mention Resolution (v4.8.7+ — đơn giản hóa)

### 2.1 Phương thức hiện tại: lấy thẳng từ Nexus API

Nexus `/tickets` đã trả `handler.username` trong response — dùng trực tiếp, KHÔNG cần lookup DB:

```
ticket.handler.username  → "{username}@vng.com.vn" = mention.id
ticket.handler.name      → display name trong <at> tag
```

### 2.2 Mapping
| Field dùng | Source | Dùng để |
|---|---|---|
| `mention.id` | `"{ticket.assignee_username}@vng.com.vn"` | Teams mention target |
| `mention.name` | `ticket.assignee_name` | Tên hiển thị trong `<at>` tag |
| fallback text | `ticket.assignee_name` (plain) | Khi `assignee_username` rỗng |

### 2.3 Điều kiện để tag thành công
- Ticket có `handler.username` (mọi ticket có handler đều có) → luôn tag được
- UPN `{username}@vng.com.vn` phải khớp với account M365 thực tế của handler

### 2.4 Lịch sử thiết kế

**v4.8.4 (cũ):** Dùng DB lookup `handler_usernames` table theo `full_name` vì lúc đó:
- Không biết `handler.username` đã có sẵn trong ticket response
- Đã thử gọi `nexus.vnggames.com/api/ticket-management/v1/users` API riêng nhưng bị blocked từ Railway

**v4.8.7 (hiện tại):** Phát hiện `ticket.handler.username` có sẵn → bỏ DB lookup. Code `fetch_users_by_ids()` trong `ticket_service.py` vẫn tồn tại nhưng deprecated.

### 2.5 `handler_usernames` table — vẫn được giữ
Bảng vẫn cần thiết cho **need_remind logic**: check `last_comment.user.username in handler_usernames` để biết comment cuối là của handler hay requester. Đây là set các username "thuộc team handler", semantic khác với tag mention (handler của ticket cụ thể).

---

## 3. Data Flow (v4.8.7+)

### 3.1 Chain từ raw ticket đến mention

```
Raw ticket (Nexus API GET /tickets)
  ticket["handler"]["id"]        ← handler_id
  ticket["handler"]["name"]      ← assignee_name (display name)
  ticket["handler"]["username"]  ← assignee_username (login)
      ↓
build_remind_item() — filter_service.py
  fields: assignee_name, assignee_username, handler_id
      ↓
Job result ticket dict
  { ..., assignee_username: "tiennvt", assignee_name: "Ngô Võ Thủy Tiên", ... }
      ↓
SendTicket Pydantic model — remind.py
  fields: assignee_name: str, assignee_username: str
      ↓
POST /api/remind/send
  Per ticket: build mention trực tiếp từ assignee_username + assignee_name
              (KHÔNG load DB, không lookup)
```

### 3.2 Implementation trong remind.py (v4.8.7)
```python
# Resolve handler mention: lấy thẳng từ ticket.handler.username
if ticket.assignee_username and ticket.assignee_name:
    tagged_handler = f"<at>{ticket.assignee_name}</at>"
    handler_mention = {
        "id": f"{ticket.assignee_username}@vng.com.vn",
        "name": ticket.assignee_name,
    }
else:
    tagged_handler = ticket.assignee_name or ""
    handler_mention = None
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

### 7.1 Flow đầy đủ (v4.8.7+)
```
POST /api/remind/send
  Body: { tickets: [SendTicket] }
        ← gồm assignee_username, last_comment_username/name, requester_login

1. Load templates và webhook configs (KHÔNG còn load handler_name_map từ DB)

2. Loop mỗi ticket:
   a. find_webhook_for_product(product_name)
      → nếu không có → status=skipped
   b. Resolve handler_mention: từ ticket.assignee_username + assignee_name (trực tiếp)
   c. Resolve commenter_mention: last_comment_username + last_comment_name
   d. Resolve requester_mention: requester_login + requester_name
   e. Build ticket_link: "[#id](ticket_url)"
   f. render(template, {..., tagged_handler, tagged_commenter, tagged_requester, ticket_link})
   g. mentions = [] + orphan/dedup check:
      for each mention (handler, commenter, requester):
        - skip nếu mention là None
        - skip nếu mention.id đã có trong seen_ids (dedup)
        - skip nếu f"<at>{mention.name}</at>" không có trong rendered message (orphan)
        - else: append vào mentions, add id vào seen_ids
   h. send_mention_message(webhook_url, message_text, mentions)
   i. create_log(...)

3. Return results[]
```

### 7.2 Fallback tại mỗi bước

| Bước | Failure | Fallback |
|---|---|---|
| `assignee_username` rỗng | Ticket không có handler hoặc field thiếu | plain text `assignee_name`, không tag |
| `last_comment_username` rỗng | Không có last comment | `tagged_commenter = ""` |
| `requester_login` rỗng | API không trả về `username` | plain text `requester_name` |
| mentions array rỗng | Không có `<at>` nào trong message HOẶC không resolve được user nào | gửi `{"text": message_text}` plain |
| Webhook không tìm thấy | product chưa cấu hình | status=skipped, ghi log |

---

## 8. Thay đổi tóm tắt theo file (v4.8.4 → v4.8.7)

| File | v4.8.4 | v4.8.5 | v4.8.7 |
|---|---|---|---|
| `filter_service.py` | thêm `handler_id`, `assignee_name` | thêm `requester_login` | đọc `requester.username`/`handler.username` (không phải `login`); thêm `assignee_username` |
| `ticket_service.py` | thêm `fetch_users_by_ids()` (không gọi) | — | — |
| `teams_service.py` | `send_mention_message(mention)` | đổi sang `mentions: list[dict]` | — |
| `template_service.py` | SAMPLE_DATA `tagged_handler` | thêm `ticket_link`, `tagged_commenter`, `tagged_requester` | — |
| `remind.py` | resolve handler qua DB lookup | resolve 3 mentions | bỏ DB lookup; handler từ `assignee_username` trực tiếp; orphan/dedup check trên `mentions` |
| `frontend/ticket-reminder.js` | payload `assignee_name`, `handler_id` | thêm `last_comment_username/name`, `requester_login` | thêm `assignee_username` |

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
| D12 | Bỏ DB lookup `handler_usernames` cho mention; lấy thẳng `ticket.handler.username` | Nexus API đã trả `username` trong response — DB lookup trở nên thừa, mọi handler đều tag được tự động |
| D13 | Đọc `requester.username`/`handler.username` thay vì `login` | API thực tế trả `username`, doc cũ ghi `login` là sai (tương tự với `name` vs `fullname`) |
| D14 | `mentions` chỉ add entity nếu `<at>Name</at>` có trong message; dedup theo `mention.id` | Microsoft spec yêu cầu exact-match `<at>` text ↔ entity text; orphan entity gây render/notify issues |
