# API_REFERENCE.md — Nexus Ticket Management API
> Tài liệu này dành cho tất cả agents (BA, TechLead, Dev) đọc để hiểu contract API.
> Base URL: `{HOST}/integration/v1`
> Content-Type: `application/json`

---

## Authentication

Mọi request đều phải có 3 headers sau:

| Header | Mô tả |
|---|---|
| `client-id` | Client ID được cấp riêng cho từng bên tích hợp |
| `timestamp` | Unix timestamp milliseconds tại thời điểm gọi. Phải nằm trong ±5 phút so với server time |
| `signature` | Chữ ký tính theo thuật toán bên dưới |

### Thuật toán tính Signature

```
Bước 1 — Xây dựng hash_data:
  Tạo object gồm: { client_id, timestamp, ...tất cả query params }
  Sort theo key bằng ksort() — ascending, byte-by-byte (strcmp)

Bước 2 — Tính signature:
  hash_string = sha1(client_secret)
  foreach (hash_data as value):
    if value is array:
      value = json_encode(array_filter(value))   // PHP array_filter: loại falsy
    if value is not empty:
      hash_string += "|" + html_entity_decode(value)
  signature = sha1(hash_string)
```

> Implementation tham khảo: `api-test.js` — hàm `buildSignature()`

---

## Param bắt buộc trên mọi request

Ngoài các params được mô tả riêng cho từng endpoint, **tất cả request đều phải có thêm**:

| Tên | Kiểu | Mô tả |
|---|---|---|
| `requestUser` | string | Domain của user đang thực hiện request. VD: `nguyen.vana` |

`requestUser` được đưa vào query string và đưa vào `hash_data` khi tính signature.

---

## Endpoints

---

### 1. GET /services — Lấy danh sách services

```
GET {BASE_URL}/services
```

**Query Parameters**

| Tên | Kiểu | Bắt buộc | Mô tả |
|---|---|---|---|
| `requestUser` | string | ✅ | Domain user login |

**Response thành công (200)**

```json
{
  "code": "SUCCESS",
  "message": "Successfully get services",
  "data": [
    {
      "id": 1,
      "name": "Service Name",
      "description": "Mô tả service"
    }
  ]
}
```

**Dùng để:** Sync vào Supabase `services` table (service_id, service_name). UI hiển thị danh sách để user chọn khi filter ticket.

---

### 2. GET /products — Lấy danh sách sản phẩm

```
GET {BASE_URL}/products
```

**Query Parameters**

| Tên | Kiểu | Bắt buộc | Mô tả |
|---|---|---|---|
| `requestUser` | string | ✅ | Domain user login |

**Response thành công (200)**

```json
{
  "code": "SUCCESS",
  "message": "Successfully get services of Growth Team",
  "data": [
    {
      "id": 10,
      "name": "Product Name",
      "code": "PROD",
      "alias": "prod-alias"
    }
  ]
}
```

**Dùng để:** Lấy danh sách product → populate dropdown filter, mapping `product.name` với webhook config.

---

### 2. GET /tickets — Lấy danh sách ticket

```
GET {BASE_URL}/tickets
```

**Query Parameters**

| Tên | Kiểu | Bắt buộc | Mô tả |
|---|---|---|---|
| `requestUser` | string | ✅ | Domain user login |
| `service_ids` | array | Không | Lọc theo service ID. Format: `service_ids[]=1&service_ids[]=2` |
| `statuses` | array | Không | Lọc theo tên status. Format: `statuses[]=New&statuses[]=In%20Progress` |
| `created_at_from` | string | Không | Ngày bắt đầu tạo ticket. Format: `Y-m-d` |
| `created_at_to` | string | Không | Ngày kết thúc tạo ticket. Format: `Y-m-d`. Phải ≥ `created_at_from` |
| `assignee` | string | Không | Login (domain) của người được giao ticket |
| `per_page` | integer | Không | Số ticket mỗi trang. Min: 1, Max: 100. Mặc định: 20 |
| `page` | integer | Không | Trang hiện tại. Mặc định: 1 |

> Array params dùng format PHP-style: `key[]=val1&key[]=val2`

**Response thành công (200)**

```json
{
  "code": "SUCCESS",
  "message": "Successfully get Tickets",
  "data": [
    {
      "id": 123,
      "title": "Tiêu đề ticket",
      "service": {
        "id": 1,
        "name": "Service Name"
      },
      "status": {
        "id": 2,
        "name": "In Progress"
      },
      "requester": {
        "id": 10,
        "login": "user.domain",
        "fullname": "Nguyen Van A"
      },
      "handler": {
        "id": 11,
        "login": "handler.domain",
        "fullname": "Tran Van B"
      },
      "products": [
        { "id": 5, "name": "Product A" }
      ],
      "created_at": "2024-04-01 09:00:00",
      "updated_at": "2024-04-02 10:30:00",
      "due_date": "2024-04-05",
      "action_time": null,
      "sla": null
    }
  ],
  "meta": {
    "current_page": 1,
    "last_page": 3,
    "per_page": 20,
    "total": 55
  },
  "links": {
    "first": "...",
    "last": "...",
    "prev": null,
    "next": "..."
  }
}
```

**Phân trang:** Dùng `meta.last_page` để fetch tất cả pages. Delay 300ms giữa mỗi page.

**Fields quan trọng cho Reminder logic:**

| Field | Dùng để |
|---|---|
| `id` | Fetch comment, fetch detail |
| `products[0].name` | Routing webhook |
| `requester.fullname` | Điền vào template message |
| `due_date` | Tính số ngày còn lại (`diffDays`) |
| `status.name` | Lọc theo status nếu cần |

---

### 3. GET /tickets/{ticketId} — Xem chi tiết ticket

```
GET {BASE_URL}/tickets/{ticketId}
```

**Path Parameter**

| Tên | Kiểu | Mô tả |
|---|---|---|
| `ticketId` | integer | ID của ticket |

**Query Parameters**

| Tên | Kiểu | Bắt buộc | Mô tả |
|---|---|---|---|
| `requestUser` | string | ✅ | Domain user login |

> `ticketId` là path param nhưng vẫn đưa vào `hash_data` khi tính signature.

**Response thành công (200)**

```json
{
  "code": "SUCCESS",
  "message": "Successfully get Ticket detail",
  "data": {
    "ticketId": 456,
    "ticketUrl": "https://nexus.example.com/456",
    "status": "In Progress",
    "assignee": "handler.domain",
    "requestId": 98765,
    "requestUser": "nguyen.vana",
    "referenceUrl": "https://example.com/request/98765",
    "actorLevels": [
      {
        "level": 1,
        "status": "In Progress",
        "actors": [
          {
            "domain": "approver.domain",
            "fullname": "Nguyen Van Approver"
          }
        ]
      }
    ],
    "actionTracking": [
      {
        "performedAction": "Approve",
        "performedBy": "handler.domain",
        "performedAt": "2024-04-02 10:00:00",
        "fromStatus": "New",
        "toStatus": "In Progress",
        "comment": "Đã tiếp nhận"
      }
    ]
  }
}
```

---

### 4. GET /tickets/{ticketId}/comments — Lấy danh sách comments

```
GET {BASE_URL}/tickets/{ticketId}/comments
```

**Path Parameter**

| Tên | Kiểu | Mô tả |
|---|---|---|
| `ticketId` | integer | ID của ticket |

**Query Parameters**

| Tên | Kiểu | Bắt buộc | Mô tả |
|---|---|---|---|
| `requestUser` | string | ✅ | Domain user login |

> `ticketId` là path param nhưng vẫn đưa vào `hash_data` khi tính signature.

**Response thành công (200)**

```json
{
  "code": "SUCCESS",
  "message": "Successfully get Ticket Comments",
  "data": [
    {
      "id": 1,
      "user": {
        "id": 10,
        "username": "nguyen.vana",
        "name": "Nguyen Van A"
      },
      "notes": "Nội dung comment",
      "created_on": "2024-04-01 09:00:00"
    }
  ]
}
```

**Logic xác định `needRemind`** (dùng trong Reminder feature):

```
comments = data (mảng, sắp xếp theo thời gian tăng dần)

if comments.length === 0:
  needRemind = true   // chưa có comment nào

else:
  lastComment = comments[comments.length - 1]
  lastUsername = lastComment.user.username

  if lastUsername thuộc danh sách handler_usernames:
    needRemind = true   // comment cuối là của handler → requester chưa reply

  else:
    needRemind = false  // comment cuối là của requester → đã phản hồi
```

---

## Error Responses

| HTTP Status | `code` | Ý nghĩa |
|---|---|---|
| 401 | `UNAUTHORIZED` | Signature sai hoặc timestamp lệch > 5 phút |
| 403 | `FORBIDDEN` | `client_id` không có quyền truy cập |
| 404 | `NOT_FOUND` | Ticket ID không tồn tại |
| 422 | `VALIDATION_ERROR` | Params không hợp lệ (VD: `created_at_to` < `created_at_from`) |
| 500 | `SERVER_ERROR` | Lỗi server |

---

## Notes cho Developer

- Array params luôn dùng format `key[]=val1&key[]=val2` — không dùng `key=val1,val2`
- `requestUser` phải có trong tất cả requests, kể cả khi không có query param nào khác
- Khi tính signature cho endpoint có path param (ticketId): đưa `ticketId` vào `hash_data` cùng với các params khác
- Fetch toàn bộ ticket: loop từ `page=1` đến `meta.last_page`, delay 300ms mỗi page
- Fetch comment: delay 100ms giữa mỗi ticket để tránh rate limit
