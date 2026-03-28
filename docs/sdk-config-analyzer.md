# SDK Config Analyzer — Hướng dẫn kỹ thuật

> Tool 1 trong PIN Utilities — phân tích Bootstrap config của từng game theo platform và country.

---

## Tổng quan

SDK Config Analyzer fetch **VNGGames Bootstrap API** cho từng game, phân tích trạng thái bật/tắt của các SDK features theo platform (Android/iOS) và từng quốc gia.

```
User nhập game_id + platform + country
    │
    ▼
GET /api/config?gameId=&platform=&country=
    │
    ▼
bootstrap_service.fetch_config()
    │  curl → https://login-{gameId}.vnggames.net/?do=Bootstrap.show&os={platform}&country={country}
    ▼
JSON response → phân tích feature flags
    │
    ▼
Hiển thị bảng: Feature | Enabled | Android | iOS | [Countries] | Rate | Bar
```

---

## API Endpoint

### `GET /api/config`

Fetch Bootstrap config cho 1 game.

**Query parameters:**

| Param | Bắt buộc | Mô tả | Ví dụ |
|---|---|---|---|
| `gameId` | ✅ | Game ID (code nội bộ) | `A78`, `C08` |
| `platform` | ❌ | Platform (`android` hoặc `ios`). Mặc định: `android` | `ios` |
| `country` | ❌ | Mã quốc gia 2 chữ hoa | `VN`, `TH`, `ID` |

**Response thành công:**
```json
{
  "success": true,
  "gameId": "A78",
  "platform": "android",
  "country": "VN",
  "data": {
    "bann": { "banned": "false" },
    "notify": { "show": "true", ... },
    "login_channel": { "list": ["facebook", "google"] },
    ...
  }
}
```

**Response lỗi (502):**
```json
{ "detail": "DNS failed: Could not resolve host" }
```

**Cách hoạt động:** Backend dùng `curl` gọi trực tiếp tới Bootstrap endpoint của game:
```
https://login-{gameId}.vnggames.net/?do=Bootstrap.show&os={platform}&country={country}
```

---

## Features được phân tích

| Feature key | Tên hiển thị | Điều kiện "Enabled" |
|---|---|---|
| `bann` | Ban Check | `banned == "true"` |
| `notify` | Notify | `show == "true"` |
| `local_push` | Local Push | `data[]` có ít nhất 1 phần tử |
| `login_channel` | Login Channel | `list[]` có ít nhất 1 phần tử |
| `translate` | Translate | `type == 1` |
| `secure_account_status` | Secure Account | value `== 1` |
| `vn_policy_13` | VN Policy 13 | `show == 1` |
| `appsflyer` | AppsFlyer | object có ít nhất 1 key |

---

## Sử dụng trong Frontend

### Nhập game_id thủ công

1. Vào tab **SDK Config Analyzer**
2. Nhập game ID vào ô input (ví dụ: `A78`)
3. Chọn Platform và Country (tuỳ chọn)
4. Nhấn **Fetch**

### Upload file `games.txt`

Format file: mỗi dòng 1 game ID.

```
A01
A78
C08
B99
```

Blank lines và dòng bắt đầu bằng `#` bị bỏ qua.

---

## Lưu ý kỹ thuật

- Bootstrap API gọi qua `curl` subprocess với timeout 15 giây
- User-Agent giả lập iOS để nhận đúng config mobile
- Nếu game ID không tồn tại → DNS fail hoặc empty response
- Không cache — mỗi request fetch fresh từ Bootstrap API
- **Column order cố định:** `Feature | Enabled | Android | iOS | [countries] | Rate | Bar`
- Platform icons render qua JS functions `androidIcon()` / `appleIcon()` — không dùng emoji

---

## Troubleshooting

| Lỗi | Nguyên nhân | Xử lý |
|---|---|---|
| `DNS failed` | Game ID sai hoặc domain không tồn tại | Kiểm tra lại game ID |
| `Timeout (15s)` | Bootstrap server không phản hồi | Thử lại hoặc kiểm tra network |
| `Empty response` | Game ID đúng nhưng Bootstrap trả về rỗng | Game chưa có config hoặc platform không hỗ trợ |
| `JSON parse error` | Response không phải JSON | Bootstrap trả về HTML/error page |
| `502` từ `/api/config` | curl lỗi ở backend | Xem log Railway |
