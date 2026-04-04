# CLAUDE.md — Ticket Reminder Feature
> Đọc file này đầu tiên khi bắt đầu session Claude Code cho tính năng Reminder.

---

## Nhiệm vụ

Implement tính năng **Ticket Reminder** vào project hiện có.
Tính năng cho phép fetch ticket từ API, lọc theo điều kiện, và gửi remind message đến Microsoft Teams.

---

## Đọc theo thứ tự này

1. `DESIGN.md` — Design system hiện có (glassmorphism, CSS variables, prefix `pls-`)
2. `FEATURE.md` — Mô tả nghiệp vụ và luồng xử lý
3. `ARCHITECTURE.md` — Tech stack, DB schema, API routes
4. `UI_SPEC.md` — Chi tiết giao diện, HTML structure, CSS cần thêm
5. `MANAGEMENT_SPEC.md` — Chi tiết phần quản lý webhook/template/handler

---

## Nguyên tắc bắt buộc

### Code
- Backend: Node.js / Express. Mỗi nhóm route trong file riêng tại `server/routes/`.
- Logic nghiệp vụ tách vào `server/services/` — không để trong route handler.
- Supabase client khởi tạo một lần tại `server/lib/supabase.js`.
- Tất cả secrets lấy từ `process.env` — không hardcode.

### UI / CSS
- Thêm CSS vào `pipeline.css` — **KHÔNG tạo file CSS mới**.
- Dùng CSS variables `var(--pls-*)` cho tất cả màu sắc.
- Prefix class: `pls-` cho tất cả component mới.
- Sidebar toggle: `mouseenter` / `mouseleave` — không dùng click.
- Glass card luôn có cả `backdrop-filter` và `-webkit-backdrop-filter`.

### API Integration
- Signature auth: `client-id`, `timestamp`, `signature` đặt trong **HTTP header** (không phải query string).
- Thuật toán signature: xem `api-test.js` (đã implement đúng).
- Fetch tất cả pages trước khi trả về frontend — backend xử lý phân trang.
- Delay 300ms giữa các page khi fetch ticket, 100ms khi fetch comment.

---

## Thứ tự implement đề xuất

```
Phase 1 — Backend foundation
  [ ] Supabase schema migration (4 bảng trong ARCHITECTURE.md)
  [ ] Route skeleton: /api/tickets, /api/remind, /api/webhooks, /api/templates, /api/handlers
  [ ] ticketApi.js: fetch + signature + phân trang
  [ ] filterService.js: logic lọc ticket theo duedate + last comment

Phase 2 — Management API
  [ ] CRUD webhooks (với test endpoint)
  [ ] CRUD templates (với preview endpoint)
  [ ] CRUD handler usernames

Phase 3 — Remind core
  [ ] templateService.js: render placeholder
  [ ] teamsService.js: gửi webhook + ghi log
  [ ] POST /api/remind/send

Phase 4 — Frontend View 1 (Ticket Fetch)
  [ ] Filter panel UI
  [ ] Fetch + hiển thị ticket table
  [ ] Build remind list

Phase 5 — Frontend View 2 (Remind List)
  [ ] Remind table với send mode
  [ ] Gửi remind + progress log real-time

Phase 6 — Frontend View 3 (Remind Config)
  [ ] Tab Webhooks: CRUD + test
  [ ] Tab Templates: CRUD + preview
  [ ] Tab Handlers: add/delete
```

---

## Thông tin API external

Document API đầy đủ sẽ được bổ sung. Các endpoint đã xác định:

```
GET /integration/v1/tickets                    — danh sách ticket (có phân trang)
GET /integration/v1/tickets/{id}/comments      — comments của ticket
GET /integration/v1/users?ids={userId}         — thông tin user theo ID
```

Auth: header `client-id`, `timestamp`, `signature` — xem `api-test.js`.

---

## Không làm trong scope này

- Không implement cron job / scheduled task.
- Không gửi Teams 1-1 chat — chỉ Channel webhook.
- Không rich card / Adaptive Card Teams — chỉ plain text.
- Không authentication / login cho web app.
- Không email notification.
