# SDK Version Snapshot — Data Format

## Mô tả tool

`sdk_version_snapshot` trả về thông tin phiên bản SDK mới nhất và stable của từng game theo từng platform. Dùng để kiểm tra adoption rate của SDK version.

> **Không dùng tool này cho:** raw login events theo từng user → dùng `sdk_login_logs` thay thế.

---

## Parameters (Input)

| Parameter | Type | Required | Mô tả |
|---|---|---|---|
| `game_id` | string | Không | Filter theo game identifier (e.g. `cfmvn`, `tghm`, `cssea`). Bỏ trống để lấy tất cả games. |
| `platform` | string | Không | Filter theo platform. Allowed: `android`, `ios`, `windows` |

---

## Response Fields (Output)

Mỗi record = **1 game × 1 platform**.

| Field | Type | Mô tả |
|---|---|---|
| `game_id` | string | Game identifier trong hệ thống SDK (e.g. `cfmvn`) |
| `platform` | string | Nền tảng: `android`, `ios`, `windows` |
| `latest_version` | string | SDK version mới nhất đang được dùng (e.g. `3.9.0`) |
| `latest_version_records` | integer | Số lượng login records của latest version |
| `latest_version_share_ratio` | integer | % user đang dùng latest version (0–100) |
| `stable_version` | string | SDK version được coi là stable |
| `stable_version_share_ratio` | integer | % user đang dùng stable version |
| `latest_date` | datetime | Ngày data snapshot gần nhất (e.g. `2026-03-14`) |
| `updated_time` | datetime | Thời điểm record được cập nhật trong hệ thống |

---

## Lưu ý

- `latest_version` và `stable_version` có thể **khác nhau** nếu version mới nhất chưa được rollout rộng (share ratio thấp).
- `latest_version_records` là số **login sessions**, không phải số user unique.
- Nếu `latest_version_share_ratio = 100`, toàn bộ user đã update lên version mới nhất.

---

## Ví dụ Response

```json
{
  "game_id": "cfmvn",
  "platform": "android",
  "latest_version": "3.9.0",
  "latest_version_records": 11791895,
  "latest_version_share_ratio": 100,
  "stable_version": "3.9.0",
  "stable_version_share_ratio": 100,
  "latest_date": "2026-03-14T00:00:00Z",
  "updated_time": "2026-03-15T06:55:41.420438Z"
}
```

---

## Related Tools

| Tool | Dùng khi |
|---|---|
| `sdk_login_logs` | Cần xem raw login events theo từng user/device |
| `sdk_summary_daily` | Cần aggregated daily summary theo platform/version/channel |
