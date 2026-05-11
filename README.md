# Hermes Telegram Bot

Bot Telegram riêng cho Hermes: lịch làm việc, lịch trực, KPI, doanh thu phòng, dashboard tổng hợp và thông báo thay đổi trạng thái phiếu yêu cầu.

## 1. Yêu cầu môi trường

- Node.js 20+ khuyến nghị.
- Máy chạy bot cần truy cập được `https://hermes.ipos.vn` và Google Sheet KPI/lịch trực.
- Nếu dùng Playwright lần đầu, cần cài browser Chromium.

## 2. Cài đặt sau khi clone từ GitHub

```bash
cd hermes_bot
npm install
npm run install:browsers
cp .env.example .env
```

Trên Windows có thể copy `.env.example` thành `.env` thủ công.

## 3. Cấu hình `.env`

Các biến bắt buộc:

```env
TELEGRAM_BOT_TOKEN=token_bot_hermes
BOT_SECRET_KEY=chuoi_bi_mat_32_64_ky_tu
ALLOWED_TELEGRAM_IDS=telegram_id_duoc_phep
BOT_LOCK_PORT=47831
HERMES_BASE_URL=https://hermes.ipos.vn
HERMES_LOGIN_PATH=/login
KPI_SHEET_ID=google_sheet_id_kpi
```

Ghi chú:

- `BOT_SECRET_KEY` dùng để mã hóa mật khẩu/session Hermes trong `data/`.
- `ALLOWED_TELEGRAM_IDS` có thể nhập nhiều ID, phân tách bằng dấu phẩy.
- File `.env` và thư mục `data/` không nên đẩy lên GitHub vì chứa token/session thật.

## 4. Chạy bot

```bash
npm start
```

Hoặc:

```bash
npm run bot
```

Nếu chạy server lâu dài, có thể dùng PM2:

```bash
pm2 start src/bot.js --name hermes-bot
```

## 5. Lệnh Telegram chính

- `/start` hoặc `/menu`: mở trang chủ Hermes Bot.
- `/today`: xem Dashboard tổng hợp hôm nay.
- `/lich`: xem lịch làm việc hôm nay.
- `/lich mai`: xem lịch làm việc ngày mai.
- `/lich 28/04/2026`: xem lịch làm việc theo ngày.
- `/truc`: xem lịch trực hôm nay.
- `/truc mai`: xem lịch trực ngày mai.
- `/kpi`: mở KPI theo tháng năm 2026.
- `/sethermes`: lưu hoặc đổi tài khoản Hermes.
- `/deletehermes`: xóa tài khoản Hermes đã lưu.
- `/id`: xem Telegram ID.
- `/cancel`: hủy thao tác đang chờ.

## 6. Lệnh test ẩn

Các lệnh này không show trong menu, chỉ gõ khi cần test:

- `/testtruc`: test thông báo lịch trực hôm nay.
- `/testtruc mai`: test thông báo lịch trực ngày mai.
- `/testnotify`: test đọc thông báo Hermes mới nhất.

## 7. Tính năng tự động

- `07:00`: nhắc lịch trực hôm nay.
- `08:00`: tự gửi Dashboard tổng hợp hôm nay.
- `11:00`: nhắc lịch trực hôm nay.
- `17:00`: nhắc lịch trực ngày mai.
- Mỗi `30 giây`: kiểm tra thông báo Hermes mới tại `/api/notify/get`.

Thông báo Hermes chỉ gửi khi có thông báo mới và mỗi thông báo chỉ gửi 1 lần, không báo trùng.

## 8. Tính năng chính

### Lịch làm việc

- Xem hôm qua, hôm nay, ngày mai, cả tuần hoặc ngày tùy chọn.
- Nhóm lịch theo cả ngày, ca sáng, ca chiều.
- Mã phiếu có thể bấm để mở nhanh phiếu Hermes.
- Nút `Xem lịch` kéo chi tiết phiếu yêu cầu từ Hermes.

### Lịch trực

- Đối chiếu tên/username Telegram để báo người có lịch trực.
- Xem lịch trực ngày hoặc cả tuần.
- Thông báo tự động theo mốc 7h, 11h, 17h.

### KPI

- Tự dò sheet KPI dạng `2026_01` đến `2026_12`.
- Khi có sheet tháng mới, bấm `/kpi` để menu tự cập nhật.
- Hiển thị KPI, point, doanh thu phòng, tỷ lệ cá nhân và thu nhập ước tính/tạm tính.

### Thông báo Hermes

- Bot kiểm tra thông báo mới từ Hermes mỗi 30 giây.
- Khi phiếu yêu cầu thay đổi trạng thái, bot gửi Telegram gồm mã phiếu, trạng thái, chi tiết và nút `View chi tiết`.
- Link phiếu được gắn trực tiếp vào mã phiếu nếu Hermes trả link.
- Bot lưu key đã báo để không gửi trùng.

## 9. Dữ liệu runtime

Sau khi chạy, bot tạo/cập nhật:

- `data/hermes-users.json`: tài khoản Telegram/Hermes, session, trạng thái notification.

Không commit thư mục `data/` lên GitHub.

## 10. Cập nhật bot từ GitHub

Sau khi đẩy code mới lên GitHub, mở Telegram chat với bot và gõ:

```bash
/update
```

Cơ chế update sẽ:

- Kiểm tra repo local có thay đổi chưa commit không; nếu có thì dừng để tránh ghi đè.
- `git fetch` và `git pull --ff-only` từ đúng branch đang chạy.
- Tự chạy `npm install` nếu `package.json` hoặc `package-lock.json` thay đổi.
- Thoát tiến trình sau khi cập nhật để PM2/service tự khởi động lại bản mới.

Khuyến nghị chạy bot bằng PM2 để bot tự bật lại sau khi `/update`:

```bash
pm2 start src/bot.js --name hermes-bot
pm2 save
```

Nếu chạy bằng `npm start` thủ công, sau khi `/update` thành công cần tự chạy lại `npm start`.

### Khi VPS vẫn đang chạy bản cũ

Nếu bot trên Telegram chưa nhận `/update`, nghĩa là VPS đang chạy code cũ chưa có lệnh update. SSH vào VPS và chạy thủ công một lần:

```bash
cd /duong/dan/toi/hermes_bot
git status
git pull --ff-only origin main
npm install
pm2 restart hermes-bot --update-env
pm2 save
```

Nếu repo của anh dùng branch `master` thay vì `main`, đổi `main` thành `master`.

Hoặc dùng script có sẵn:

```bash
cd /duong/dan/toi/hermes_bot
bash ./scripts/update-vps.sh
```

Sau lần cập nhật thủ công này, bot sẽ có lệnh `/update` để các lần sau cập nhật trực tiếp từ Telegram.

Nếu `git status` báo có file local bị sửa, kiểm tra kỹ trước khi pull để tránh mất cấu hình. File `.env` và thư mục `data/` đã được ignore nên bình thường không cản update.


### Version bot

Bắt đầu từ bản này version là `1.0.0` trong `package.json`.

Mỗi lần anh đẩy bản update mới, tăng version trước khi commit để dễ phân biệt bản đang chạy:

```bash
npm version patch --no-git-tag-version
```

Ví dụ `1.0.0` -> `1.0.1`. Bot sẽ hiển thị version trong `/status`, thông báo khởi động và kết quả `/update`.