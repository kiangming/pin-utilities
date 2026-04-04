# MANAGEMENT_SPEC.md — Remind Config
> Mô tả chi tiết phần quản lý: Webhook, Template, Handler Usernames.
> Đây là phần admin/config — user thiết lập một lần, ít thay đổi.

---

## 1. Webhook Config

### 1.1 Mục đích
Map từng product → Teams Channel Webhook URL. Khi gửi remind, backend tự động routing đúng channel theo tên product của ticket.

### 1.2 Data model
```
product_name : text         — match với ticket.products[0].name (case-insensitive trim)
product_code : text?        — optional, dự phòng match theo code
channel_name : text         — tên hiển thị của Teams channel
webhook_url  : text         — Incoming Webhook URL của Teams
template_id  : uuid?        — template mặc định khi gửi cho product này
is_default   : boolean      — nếu true, dùng làm fallback khi không match product nào
```

### 1.3 Routing logic (backend)
```
1. Tìm webhook có product_name match ticket.products[0].name (trim, toLowerCase)
2. Nếu không tìm thấy → tìm bản ghi có is_default = true
3. Nếu vẫn không có → đánh dấu ticket là "Không tìm thấy channel", bỏ qua gửi
```

### 1.4 Validation
- `webhook_url` phải bắt đầu bằng `https://`.
- Không được có 2 bản ghi cùng `product_name` (unique).
- Chỉ 1 bản ghi được có `is_default = true`.

### 1.5 Test webhook
- Nút "Test ▶" trên mỗi row → gửi message mẫu cố định đến webhook đó.
- Message test: `[TEST] Remind system connected successfully — {timestamp}`.
- Hiển thị kết quả: ✅ `200 OK` hoặc ❌ `Lỗi: {status}`.

---

## 2. Message Templates

### 2.1 Placeholders được hỗ trợ

| Placeholder | Giá trị | Ví dụ |
|---|---|---|
| `{requester_name}` | Tên hiển thị của requester | `John Doe` |
| `{product_name}` | Tên product của ticket | `GameA` |
| `{ticket_id}` | ID của ticket | `1234` |
| `{due_date}` | Ngày hết hạn format DD/MM/YYYY | `15/04/2024` |
| `{days_left}` | Số ngày còn lại (âm nếu quá hạn) | `3` hoặc `-2` |
| `{time_label}` | Tự động chọn cụm từ phù hợp | `will expire on 15/04/2024` hoặc `expired on 13/04/2024` |

### 2.2 `time_label` logic
```js
if (days_left < 0) {
  time_label = `expired on ${due_date}`
} else {
  time_label = `will expire on ${due_date}`
}
```

### 2.3 Template mặc định (seed data)

**Template: Sandbox Expiry EN**
```
Hi {requester_name}, the sandbox account for {product_name} (ticket #{ticket_id}) {time_label}. Do you need to extend it? If so, please leave a comment on the ticket. Thank you!
```

**Template: Sandbox Expiry VI**
```
Xin chào {requester_name}, tài khoản sandbox cho {product_name} (ticket #{ticket_id}) {time_label}. Bạn có cần gia hạn tiếp không? Nếu có vui lòng comment vào ticket nhé. Cảm ơn!
```

### 2.4 Preview function
Khi user nhấn Preview, backend render template với data giả:
```json
{
  "requester_name": "John Doe",
  "product_name": "GameA",
  "ticket_id": "9999",
  "due_date": "15/04/2024",
  "days_left": 3,
  "time_label": "will expire on 15/04/2024"
}
```

---

## 3. Handler Usernames

### 3.1 Mục đích
Danh sách `username` của team handler (người xử lý ticket phía nội bộ).

Khi comment cuối cùng của ticket có `user.username` thuộc danh sách này → ticket **cần nhắc** (requester chưa reply lại).

### 3.2 Lấy username
Username lấy từ field `user.username` trong API response của `/tickets/{id}/comments`.

Ví dụ từ GS script:
```js
CONFIG.handlerUsernames = ["huong.tran", "tien.ngo"]
```

### 3.3 Data model
```
username  : text unique   — username chính xác, case-sensitive
full_name : text?         — tên đầy đủ để dễ nhận biết
note      : text?         — ghi chú (VD: "Team Sandbox", "đã nghỉ")
```

### 3.4 UI
- Bảng đơn giản: Username | Full Name | Note | [Xóa].
- Form thêm: input Username + Full Name + Note → Thêm.
- Không có edit — muốn sửa thì xóa rồi thêm lại.

---

## 4. Remind Logs

Không có UI quản lý phức tạp — chỉ cần **hiển thị history** gần đây:
- 50 log gần nhất, sort theo `reminded_at` DESC.
- Columns: Ticket ID | Product | Requester | Message (truncated) | Status | Sent At.
- Filter theo status: All / Sent / Failed.
- Nút "Xem" → mở ticket URL trong tab mới.

---

## 5. Lưu ý triển khai

- Tất cả CRUD của phần config gọi qua `/api/webhooks`, `/api/templates`, `/api/handlers`.
- Dữ liệu load khi user mở tab config (lazy load, không load ở app init).
- Không cần real-time — refresh thủ công hoặc sau mỗi thao tác CRUD.
- Webhook URL trong DB lưu plaintext — Railway + Supabase đã có encryption at rest.
- Không cần phân quyền ở giai đoạn này — tất cả user đều có quyền config.
