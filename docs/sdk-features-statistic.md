# SDK Features Statistic — Hướng dẫn kỹ thuật

> Tool 2 trong PIN Utilities — thống kê tổng hợp feature usage trên nhiều games cùng lúc.

---

## Tổng quan

SDK Features Statistic chạy **batch job** — fetch Bootstrap config song song cho nhiều games, rồi tổng hợp thống kê feature enabled/disabled theo platform và quốc gia.

```
User upload file games.txt
    │  Parse game IDs client-side
    ▼
POST /api/batch  { game_ids: [], countries: [] }
    │  → background thread, max 5 games song song
    ▼
GET /api/batch/status?jobId=xxx  (poll cho đến khi done)
    │
    ▼
Hiển thị bảng thống kê: Feature | Enabled | Android | iOS | [Countries] | Rate | Bar
```

---

## API Endpoints

### `POST /api/batch`

Khởi động batch job.

**Request body:**
```json
{
  "game_ids": ["A01", "A78", "C08", "B99"],
  "countries": ["VN", "TH", "ID"]
}
```

**Response (202 Accepted):**
```json
{
  "jobId": "a3f9c1b2",
  "total": 4,
  "status": "running",
  "countries": ["VN", "TH", "ID"]
}
```

### `GET /api/batch/status?jobId=xxx`

Poll tiến độ batch job.

**Response (đang chạy):**
```json
{
  "jobId": "a3f9c1b2",
  "status": "running",
  "total": 100,
  "completed": 45,
  "failed": 2,
  "countries": ["VN", "TH"],
  "results": [...],
  "stats": { ... }
}
```

**Response (hoàn thành):**
```json
{
  "jobId": "a3f9c1b2",
  "status": "done",
  "total": 100,
  "completed": 100,
  "failed": 3,
  "duration": 38.4,
  "stats": {
    "bann": {
      "name": "Ban Check",
      "enabledCount": 87,
      "disabledCount": 10,
      "androidEnabledCount": 85,
      "iosEnabledCount": 82,
      "enabledGames": ["A01", "A78", ...],
      "disabledGames": ["B99", ...],
      "failedGames": ["C08", ...],
      "countryStats": {
        "VN": { "enabled": 80, "disabled": 7, "android": 78, "ios": 75 },
        "TH": { "enabled": 65, "disabled": 22, "android": 63, "ios": 60 }
      }
    },
    "notify": { ... },
    ...
  }
}
```

---

## Parallel execution

Backend xử lý theo 2 tầng concurrent:

```
ThreadPoolExecutor(max_workers=5)      ← tối đa 5 games song song
    └── với mỗi game:
        ThreadPoolExecutor(max_workers=6)  ← tối đa 6 requests song song
            ├── (android, default)
            ├── (android, VN)
            ├── (android, TH)
            ├── (ios, default)
            ├── (ios, VN)
            └── (ios, TH)
```

Với 100 games × 3 countries → tổng ~800 Bootstrap API calls, xử lý song song.

**Thời gian ước tính:** ~30–60 giây tuỳ số lượng games và số countries.

---

## Format file `games.txt`

File upload phải là plain text `.txt`, mỗi dòng 1 game ID:

```
# Danh sách games Q1 2026
A01
A78
C08

B99
# Comment lines và blank lines bị bỏ qua
```

**Quy tắc parse (client-side):**
- Trim whitespace mỗi dòng
- Bỏ qua dòng trống
- Bỏ qua dòng bắt đầu bằng `#`
- Không giới hạn số lượng game IDs

> **Lưu ý:** Input là **file upload** (`<input type="file">`), không phải text field nhập đường dẫn file.

---

## Sử dụng trong Frontend

1. Vào tab **SDK Features Statistic**
2. Nhấn **Choose File** → chọn file `games.txt`
3. (Tuỳ chọn) Nhập danh sách countries, ví dụ: `VN,TH,ID`
4. Nhấn **Run** — nút chỉ enable sau khi đã chọn file
5. Thanh tiến độ hiển thị real-time: `45 / 100 games`
6. Khi done → bảng thống kê xuất hiện

---

## Thống kê được tổng hợp

Với mỗi feature, hệ thống tổng hợp:

| Metric | Mô tả |
|---|---|
| `enabledCount` | Số games có feature bật (Android OR iOS) |
| `disabledCount` | Số games có feature tắt |
| `androidEnabledCount` | Số games có feature bật trên Android |
| `iosEnabledCount` | Số games có feature bật trên iOS |
| `enabledGames` | Danh sách game IDs có feature bật |
| `disabledGames` | Danh sách game IDs có feature tắt |
| `failedGames` | Danh sách game IDs không fetch được |
| `countryStats[country]` | Thống kê riêng cho từng country |

---

## Lưu ý kỹ thuật

- **Job store in-memory:** Batch jobs lưu trong RAM của FastAPI process — mất khi Railway restart
- **Không persist:** Kết quả không lưu DB — refresh page → mất kết quả cũ
- **Poll interval:** Frontend poll `/api/batch/status` mỗi 2 giây cho đến khi `status == "done"`
- **Job ID:** 8 ký tự hex ngẫu nhiên (`uuid4().hex[:8]`), ví dụ: `a3f9c1b2`
- **Timeout per game:** curl timeout 15 giây — game nào timeout → đánh dấu failed, không block job

---

## Troubleshooting

| Vấn đề | Nguyên nhân | Xử lý |
|---|---|---|
| Nút Run không enable | Chưa chọn file | Nhấn Choose File và chọn file `.txt` |
| `failed` count cao | Nhiều game ID sai hoặc network issues | Kiểm tra game IDs trong file |
| Job không tìm thấy (404) | Railway đã restart, job bị mất RAM | Chạy lại batch |
| Thống kê thiếu country | Country code sai format | Dùng 2 chữ hoa: `VN`, `TH`, `ID` |
