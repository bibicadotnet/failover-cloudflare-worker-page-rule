# Cloudflare Worker — Website Monitor & Auto Failover

Công cụ giám sát website chạy trên Cloudflare Workers. Khi website chính bị down, worker tự động bật Page Rule chuyển hướng traffic sang server backup và gửi thông báo qua Telegram. Khi website phục hồi, traffic được khôi phục về server chính và gửi thông báo recovery.

---

## Tính năng

- Kiểm tra trạng thái website mỗi 5 giây
- Xác minh DOWN 3 lần trước khi hành động (tránh false alarm)
- Tự động bật/tắt Cloudflare Page Rules để chuyển traffic sang backup
- Gửi thông báo Telegram khi DOWN và khi phục hồi
- Sync lại trạng thái Page Rules mỗi lần worker khởi động
- Lưu trạng thái vào KV để tránh gửi thông báo trùng lặp giữa các lần chạy

---

## Yêu cầu

- Tài khoản Cloudflare (Free plan trở lên)
- Domain đang dùng Cloudflare làm DNS/Proxy
- 2 Page Rules đã tạo sẵn trên Cloudflare:
  - **Main rule**: redirect sang backup server khi DOWN
  - **Backup rule**: rule bình thường khi UP
- Bot Telegram và Chat ID để nhận thông báo

---

## Cách lấy thông tin cấu hình

### Cloudflare API Key
1. Đăng nhập [dash.cloudflare.com](https://dash.cloudflare.com)
2. Avatar → **My Profile** → **API Tokens**
3. Mục **Global API Key** → **View** → Copy

### Zone ID
1. Vào domain cần monitor
2. Kéo xuống cột phải → mục **API** → Copy **Zone ID**

### Page Rule ID
Gọi API để lấy danh sách Page Rules:
```
GET https://api.cloudflare.com/client/v4/zones/{zone_id}/pagerules
X-Auth-Email: your-email
X-Auth-Key: your-api-key
```
Hoặc dùng curl:
```bash
curl -X GET "https://api.cloudflare.com/client/v4/zones/ZONE_ID/pagerules" \
  -H "X-Auth-Email: your@email.com" \
  -H "X-Auth-Key: your-api-key"
```
Copy `id` của rule cần dùng từ response.

### Telegram Bot Token & Chat ID
1. Nhắn `/newbot` cho [@BotFather](https://t.me/BotFather) → làm theo hướng dẫn → lấy **Bot Token**
2. Nhắn bất kỳ tin nhắn nào cho bot vừa tạo
3. Truy cập `https://api.telegram.org/bot{TOKEN}/getUpdates` → lấy `chat.id`

---

## Cài đặt

### Bước 1 — Tạo KV Namespace

Vào Cloudflare Dashboard → **Workers & Pages** → **KV** → **Create namespace**

Đặt tên: `NOTIFICATION_STATUS`

### Bước 2 — Tạo Worker

1. Vào **Workers & Pages** → **Create** → **Create Worker**
2. Đặt tên worker (ví dụ: `site-monitor`)
3. Paste toàn bộ nội dung file `worker.js` vào editor
4. **Save and Deploy**

### Bước 3 — Điền thông tin cấu hình

Sửa phần CONFIG trong file worker:

```javascript
const CONFIG = {
  apiEmail: 'your-email@gmail.com',        // Email đăng nhập Cloudflare
  apiKey: 'your-cloudflare-api-key',        // Global API Key
  zoneId: 'your-zone-id',                   // Zone ID của domain
  pageRuleId: 'your-main-page-rule-id',     // ID Page Rule chính (bật khi DOWN)
  pageRuleBackupId: 'your-backup-rule-id',  // ID Page Rule backup (bật khi UP)
  targetDomain: 'yourdomain.com',           // Domain cần monitor (không có https://)
  checkInterval: 5000,                      // Kiểm tra mỗi 5 giây
  maxRetries: 3,                            // Số lần verify trước khi kết luận DOWN
  retryDelay: 3000,                         // Thời gian giữa mỗi lần retry (ms)
  maxExecutionTime: 55000,                  // Thời gian chạy tối đa mỗi lần (ms)
  telegram: {
    botToken: 'your-bot-token',             // Token của Telegram bot
    chatId: 'your-chat-id'                  // Chat ID nhận thông báo
  }
};
```

### Bước 4 — Bind KV vào Worker

1. Vào Worker vừa tạo → **Settings** → **Variables** → **KV Namespace Bindings**
2. **Add binding**:
   - Variable name: `NOTIFICATION_STATUS`
   - KV namespace: chọn namespace đã tạo ở Bước 1
3. **Save**

### Bước 5 — Thiết lập Cron Trigger

1. Vào Worker → **Settings** → **Triggers** → **Cron Triggers**
2. **Add Cron Trigger**: `* * * * *` (chạy mỗi phút)
3. **Save**

---

## Cách hoạt động

```
Mỗi phút Cron kích hoạt worker
    │
    ├─ syncPageRules()
    │   └─ Kiểm tra site và đồng bộ Page Rules về đúng trạng thái
    │
    └─ Vòng lặp 55 giây, check mỗi 5 giây
        │
        ├─ Site DOWN?
        │   ├─ Đã notify DOWN rồi → bỏ qua
        │   └─ Chưa notify → verify 3 lần
        │       ├─ Vẫn DOWN → bật Main Rule, tắt Backup Rule, gửi Telegram, lưu KV='DOWN'
        │       └─ Có lần UP → bỏ qua (false alarm)
        │
        └─ Site UP?
            ├─ KV đang là 'UP' → bỏ qua
            └─ KV đang là 'DOWN' → tắt Main Rule, bật Backup Rule, gửi Telegram, lưu KV='UP'
```

---

## Thông báo Telegram

**Khi DOWN:**
```
⚠️ Website Down Alert

Domain: yourdomain.com
Status: DOWN
Time: 23:25:26 9/9/2025
Action: Main Page Rule enabled, Backup Page Rule disabled

➡️ Redirecting traffic to backup server
```

**Khi phục hồi:**
```
✅ Website Recovery Alert

Domain: yourdomain.com
Status: UP
Time: 23:34:55 22/4/2026
Action: Main Page Rule disabled, Backup Page Rule enabled

➡️ Traffic restored to main server
```

---

## Kiểm tra thủ công

Worker expose một HTTP endpoint để kiểm tra trạng thái hiện tại:

```
GET https://your-worker.workers.dev/
```

Response:
```json
{
  "status": "up",
  "mainPageRuleEnabled": false,
  "backupPageRuleEnabled": true,
  "lastNotificationStatus": "UP",
  "timestamp": "2026-04-27T10:00:00.000Z"
}
```

Để test cron thủ công: vào Worker → **Triggers** → **Cron Triggers** → **Test**.

---

## Lưu ý

- `targetDomain` không có `https://`, ví dụ: `yourdomain.com` hoặc `yourdomain.com/path/index.html`
- Worker Free plan có giới hạn 100,000 requests/ngày — cron mỗi phút tốn khoảng 1,440 requests/ngày, an toàn
- `retryDelay` không nên vượt quá 10,000ms để tránh timeout worker
- Nếu Cloudflare API trả về lỗi 502, worker sẽ dùng giá trị cache của Page Rules thay vì crash
