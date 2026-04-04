# Ticket Reminder — Feature Spec
> Tài liệu mô tả tổng quan tính năng, dành cho Claude Code session.
> Đọc file này trước, sau đó đọc ARCHITECTURE.md và UI_SPEC.md.

---

## 1. Mục tiêu

Tự động hoá việc nhắc nhở (remind) các ticket sắp hết hạn hoặc chưa được phản hồi, thay thế hoàn toàn luồng thủ công hiện đang chạy trên Google Sheets (SandboxTracker.gs).

Tin nhắn remind được gửi đến **Microsoft Teams Channel** thông qua Incoming Webhook, routing theo từng sản phẩm.

---

## 2. Luồng nghiệp vụ tổng quan

```
[User cấu hình filter]
        ↓
[Fetch danh sách ticket từ API — có phân trang]
        ↓
[Với từng ticket: fetch comments → xác định last comment]
        ↓
[Áp điều kiện lọc: duedate + last comment author]
        ↓
[Xuất danh sách "Cần nhắc" + nội dung message từ template]
        ↓
[User review → chọn gửi hàng loạt hoặc chọn nhóm]
        ↓
[Gửi message lên Teams Webhook theo product routing]
        ↓
[Ghi nhận trạng thái "Đã nhắc" vào DB]
```

---

## 3. Điều kiện lọc ticket "Cần nhắc"

Một ticket được đưa vào danh sách remind khi **đồng thời** thỏa:

### 3.1 Điều kiện duedate
- Số ngày từ hôm nay đến `due_date` của ticket **≤ N ngày** (N do user cấu hình, mặc định 5).
- Bao gồm cả ticket **đã quá hạn** (diffDays < 0).
- Ticket không có `due_date` → bỏ qua.

### 3.2 Điều kiện last comment
- Comment cuối cùng trong ticket được viết bởi **handler** (người thuộc team xử lý) → `needRemind = true`.
- Comment cuối là của **requester** → không cần nhắc (`needRemind = false`).
- Ticket chưa có comment nào → cũng cần nhắc.
- Danh sách `handlerUsernames` được cấu hình trong phần quản lý (xem MANAGEMENT_SPEC.md).

---

## 4. Nội dung tin nhắn

### 4.1 Template mặc định (tham khảo từ GS script)
```
Hi {requester_name}, the sandbox account for {product_name}
(ticket #{ticket_id}) {time_label}.
Do you need to extend it? If so, please leave a comment on the ticket. Thank you!
```

Trong đó `time_label`:
- Nếu còn hạn: `will expire on {due_date}`
- Nếu quá hạn: `expired on {due_date}`

### 4.2 Template system
- Nhiều template, mỗi template có tên và nội dung với các placeholder chuẩn.
- Placeholder hỗ trợ: `{requester_name}`, `{product_name}`, `{ticket_id}`, `{due_date}`, `{days_left}`, `{time_label}`.
- Template được quản lý trong phần admin (xem MANAGEMENT_SPEC.md).
- Mỗi webhook config có thể chọn template mặc định riêng.

---

## 5. Gửi remind

### 5.1 Routing
- Mỗi sản phẩm (product) map với 1 Teams Webhook URL.
- Nếu không tìm thấy webhook cho product → fallback về `DEFAULT` webhook nếu có.
- Nếu không có fallback → đánh dấu lỗi, hiển thị cho user.

### 5.2 Chế độ gửi
- **Gửi tất cả**: Gửi toàn bộ danh sách "Cần nhắc" trong một lần.
- **Gửi theo nhóm**: User chọn một hoặc nhiều product để gửi.
- **Gửi từng ticket**: Checkbox từng dòng, gửi những dòng được chọn.

### 5.3 Sau khi gửi
- Ticket được đánh dấu `reminded_at = timestamp` trong DB.
- Trạng thái hiển thị: `Đã nhắc - DD/MM/YYYY HH:mm`.
- Ticket đã nhắc không bị gửi lại trừ khi user reset thủ công.

---

## 6. API endpoints cần dùng

> Document đầy đủ sẽ bổ sung sau. Các endpoint đã xác định từ GS script:

| Mục đích | Endpoint |
|---|---|
| Danh sách Product | `GET /integration/v1/products` |
| Danh sách ticket | `GET /integration/v1/tickets` |
| Xem nội dung chi tiết của ticket | `GET /integration/v1/tickets/{ticketId}` |
| Comments của ticket | `GET /integration/v1/tickets/{ticketId}/comments` |
| Thông tin user theo ID | `GET /ticket-management/v1/users?ids=${userId}` |

Tất cả request dùng signature authentication (xem `api-test.js` và tài liệu API riêng).
URL gọi endpoint: https://ticket.vnggames.net
Riêng URL gọi endpint "Thông tin user theo ID" là: https://nexus.vnggames.com/api/

---

## 7. Dữ liệu cần lưu vào Supabase

Chi tiết schema xem **ARCHITECTURE.md**.

| Bảng | Mục đích |
|---|---|
| `webhook_configs` | Mapping product → Teams Webhook + template |
| `remind_templates` | Nội dung template message |
| `handler_usernames` | Danh sách username của team handler |
| `remind_logs` | Lịch sử các lần đã gửi remind |

---

## 8. Phạm vi không làm (out of scope)

- Không tự động chạy theo schedule (cron) — user chủ động fetch và gửi.
- Không gửi 1-1 qua Teams chat trực tiếp — chỉ gửi vào Channel.
- Không xử lý attachment hay rich card Teams — chỉ plain text message.
