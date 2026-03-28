# Game Launching Pipeline — Hướng dẫn kỹ thuật

> Tool 3 trong PIN Utilities — theo dõi lịch CBT/OB của các game từ Google Sheet nội bộ.

---

## Tổng quan

Game Launching Pipeline đọc dữ liệu từ **Google Sheet nội bộ** (qua Google Sheets API v4), phân tích lịch CBT/OB của các game và hiển thị dưới 2 dạng: **Thống kê** (KPI + timeline) và **Chi tiết** (danh sách games theo nhóm).

```
User nhập Google Sheet URL
    │
    ▼
GET /api/sheets/all?sheetUrl=...
    │  dùng access_token OAuth của user
    ▼
Google Sheets API v4
    │  fetch 4 tabs: release2026, release2025, close2026, close2025
    ▼
Parse → list game objects
    │  TTL cache 5 phút
    ▼
Frontend render: Stats view + Detail view
```

---

## Cấu hình Google Sheet

### Yêu cầu

1. File Google Sheet phải được **chia sẻ** với tài khoản Google đã đăng nhập vào PIN Utilities (ít nhất quyền **Viewer**)
2. Hoặc chia sẻ với toàn bộ tổ chức (VNGGames internal domain)

### Cấu trúc Sheet — 4 Tabs bắt buộc

| Tab key | Tên tab trong Sheet | Nội dung |
|---|---|---|
| `release2026` | `List game release 2026` | Lịch CBT/OB games ra mắt năm 2026 |
| `release2025` | `List game release 2025` | Lịch CBT/OB games ra mắt năm 2025 |
| `close2026` | `List game close 2026` | Danh sách games đóng cửa 2026 |
| `close2025` | `List game close 2025` | Danh sách games đóng cửa 2025 |

> Tên tab **phải khớp chính xác** (case-sensitive). Backend fetch range `A1:P300` cho mỗi tab.

### Cấu trúc cột — Release tabs

| Cột | Index | Field | Mô tả |
|---|---|---|---|
| A | 0 | `name` | Tên sản phẩm |
| B | 1 | `faCode` | FA Code (ví dụ: `A88`, `C08/JV2`) |
| C | 2 | `alias` | Tên viết tắt |
| D | 3 | `owner` | Team phụ trách (`GS1`, `GS2`, ...) |
| E | 4 | `ranking` | Ranking (`SSS`, `SS`, `S`, `A`, `B`, `C`) |
| F | 5 | `status` | Trạng thái game |
| G | 6 | _(bỏ qua)_ | — |
| H | 7 | `cbtFrom` | Ngày bắt đầu CBT |
| I | 8 | `cbtTo` | Ngày kết thúc CBT |
| J | 9 | `cbtPlatform` | Platform CBT |
| K | 10 | _(bỏ qua)_ | — |
| L | 11 | `obDate` | Ngày OB (Open Beta) |
| M | 12 | `obPlatform` | Platform OB |
| N | 13 | `markets` | Thị trường (`VN,TH,ID,...`) |
| O | 14 | `kickstart` | Ngày Kickstart |
| P | 15 | `note` | Ghi chú |

### Cấu trúc cột — Close tabs

| Cột | Index | Field | Mô tả |
|---|---|---|---|
| A | 0 | `faCode` | FA Code |
| B | 1 | `alias` | Tên viết tắt |
| C | 2 | `name` | Tên sản phẩm |
| D | 3 | `markets` | Thị trường |
| E | 4 | `productType` | Loại sản phẩm (`Mobile`, `PC`) |
| F | 5 | `status` | `Closed`, `Closing` |
| G | 6 | `owner` | Team phụ trách |
| H | 7 | `releaseDate` | Ngày ra mắt |
| I | 8 | `closeDate` | Ngày đóng cửa |
| J | 9 | `paymentClose` | Ngày đóng thanh toán |

---

## Parse rules

### Giá trị ngày (date cells)

Backend tự động nhận diện các format:

| Giá trị trong Sheet | Parse thành |
|---|---|
| `2026-03-15` | `"2026-03-15"` |
| `15/03/2026` | `"2026-03-15"` |
| `TBU`, `TBD` | `"TBU"` |
| `No CBT` (case-insensitive) | `"No CBT"` |
| `-`, _(trống)_ | `null` |

### Giá trị status

| Giá trị trong Sheet | Normalize thành |
|---|---|
| `Released` | `"Released"` |
| `Terminated`, `Cancelled` | `"Terminated"` / `"Cancelled"` |
| `Pending` | `"Pending"` |
| `Closing`, `Closed` | `"Closing"` / `"Closed"` |
| _(trống)_, công thức `=...` | `"On Process"` |

### Markets

Tách theo dấu phẩy, chấm phẩy, hoặc xuống dòng. Tự động uppercase. Ví dụ:
- `VN, TH, ID` → `["VN", "TH", "ID"]`
- `vn;th` → `["VN", "TH"]`

---

## API Endpoints

### `GET /api/sheets/all?sheetUrl=<url>`

Fetch tất cả 4 tabs. Dùng access_token OAuth của user hiện tại.

**Query params:**

| Param | Mô tả |
|---|---|
| `sheetUrl` | URL đầy đủ của Google Sheet hoặc chỉ Sheet ID |

**Ví dụ:**
```
GET /api/sheets/all?sheetUrl=https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms/edit
```

**Response:**
```json
{
  "fetchedAt": "2026-03-28T06:00:00Z",
  "sheetUrl": "https://...",
  "release2026": [ { "name": "GameX", "obDate": "2026-05-15", ... } ],
  "release2025": [ ... ],
  "close2026": [ ... ],
  "close2025": [ ... ]
}
```

### `GET /api/sheets/{tab}?sheetUrl=<url>`

Fetch 1 tab cụ thể. `tab` là một trong: `release2026`, `release2025`, `close2026`, `close2025`.

### `POST /api/sheets/refresh?sheetUrl=<url>`

Force-invalidate TTL cache.

**Request body:**
```json
{ "tab": "release2026" }   // hoặc null để clear tất cả tabs
```

---

## Caching

Backend cache kết quả fetch theo key `{sheet_id}:{tab_key}`:

| Setting | Mặc định | Env var |
|---|---|---|
| TTL | 5 phút | `SHEETS_CACHE_TTL_SECONDS` |
| Max entries | 20 | — |

Cache tự động expire sau TTL. Nhấn **Refresh** trong UI để force-clear cache ngay lập tức.

---

## Sử dụng trong Frontend

### Bước 1: Nhập Sheet URL

1. Vào tab **Game Launching Pipeline**
2. Paste URL Google Sheet vào ô input (URL hoặc Sheet ID đều được)
3. Nhấn **Fetch**

### Bước 2: Chọn tab dữ liệu

| Tab | Nội dung |
|---|---|
| 🚀 2026 Launch | `release2026` — lịch CBT/OB năm 2026 |
| 📅 2025 Launch | `release2025` — lịch CBT/OB năm 2025 |
| ❌ 2026 Closed | `close2026` — games đóng cửa 2026 |
| ❌ 2025 Closed | `close2025` — games đóng cửa 2025 |

### Bước 3: Chọn View

**📊 Thống kê (Stats view):**
- 4 KPI cards: Total OB Launch, Total CBT/AT, Sắp xảy ra ≤7d, Tháng này
- Alert strip: Urgent (≤7d), Warning (8–14d), Upcoming (15–30d)
- Filter chips: Cả năm / Q1–Q4 / từng tháng
- Timeline bifurcated: OB section + CBT section, CSS Grid 12 tháng

**📋 Chi tiết (Detail view):**
- Groups: 🧪 CBT/AT Stage / 🚀 OB Launch / ⚡ No CBT → Straight to OB / ✅ Released / ⏳ Pending / ❌ Terminated
- Filter: search theo tên/alias/owner, status dropdown, date range picker
- Expand card để xem chi tiết từng game

---

## Date Range Filter

| Ô input | Mô tả |
|---|---|
| `From` | Ngày bắt đầu lọc |
| `To` | Ngày kết thúc lọc |

**Logic lọc (release tabs):**
- CBT: interval `[cbtFrom, cbtTo]` overlap với date window → hiện nhóm CBT
- OB: `obDate` nằm trong date window → hiện nhóm OB
- Khi có date filter: ẩn nhóm "No CBT → Straight to OB", "Released", "Pending", "Terminated"

> Date filter **không áp dụng** cho tab Closed (2025/2026).

---

## Google OAuth — Yêu cầu

Sheets API dùng **access_token của user** (không phải service account). Yêu cầu:

1. User đã đăng nhập Google OAuth qua PIN Utilities
2. OAuth scope đã bao gồm `https://www.googleapis.com/auth/spreadsheets.readonly`
3. Google Sheet được share với email của user

Nếu token hết hạn → backend tự động refresh (qua `require_session()` middleware). Nếu refresh thất bại → 401, frontend redirect về trang login.

---

## Troubleshooting

| Lỗi | Nguyên nhân | Xử lý |
|---|---|---|
| `AUTH_EXPIRED` (401) | OAuth token hết hạn và không refresh được | Logout → Login lại |
| `403 Forbidden` từ Sheets API | Sheet chưa share với tài khoản | Share Sheet với email đã đăng nhập |
| Tab không có dữ liệu | Tên tab trong Sheet sai | Kiểm tra tab names theo bảng cấu trúc ở trên |
| Games không hiển thị | Cột trống hoặc format sai | Kiểm tra cột A (tên) không trống |
| Date filter không lọc đúng | Format ngày trong Sheet không nhận diện được | Dùng format `YYYY-MM-DD` hoặc `DD/MM/YYYY` |
| Data cũ (không cập nhật) | TTL cache chưa expire | Nhấn **Refresh** để force-clear cache |
