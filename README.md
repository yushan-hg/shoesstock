# Hệ Thống Lên Kệ Kho

Giao diện chạy trên **GitHub Pages**, dữ liệu vẫn lưu ở **Google Sheets** qua Apps Script (làm API).

```
index.html            → giao diện, đưa lên GitHub Pages
apps-script/Code.gs   → dán vào Apps Script của Google Sheet (backend)
```

## 1. Cập nhật Apps Script (backend)

1. Mở Google Sheet → **Tiện ích mở rộng → Apps Script**.
2. Xoá nội dung `Code.gs` cũ, dán toàn bộ `apps-script/Code.gs` vào. Có thể xoá file `index.html` trong Apps Script (không còn dùng).
3. (Nên làm) Đổi PIN Admin: **Project Settings → Script Properties → Add property**
   `ADMIN_PIN` = mã PIN mới. Nếu không đặt, PIN mặc định là `1234`.
4. **Deploy → New deployment** → loại **Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Copy URL Web App (dạng `https://script.google.com/macros/s/.../exec`).

> Mỗi lần sửa `Code.gs`, vào **Deploy → Manage deployments → Edit → Version: New version** để giữ nguyên URL.

## 2. Gắn URL vào giao diện

Mở `index.html`, tìm dòng:

```js
const API_URL = "https://script.google.com/macros/s/DAN_DEPLOYMENT_ID_VAO_DAY/exec";
```

thay bằng URL vừa copy.

## 3. Đưa lên GitHub Pages

1. Tạo repo mới trên github.com (để **Public** — GitHub Pages miễn phí chỉ cho repo public).
2. Push code lên (xem lệnh bên dưới).
3. Repo → **Settings → Pages** → Source: **Deploy from a branch** → Branch: `main` / `(root)` → Save.
4. Sau ~1 phút, web chạy tại `https://<tên-tài-khoản>.github.io/<tên-repo>/`.

```bash
git remote add origin https://github.com/<tên-tài-khoản>/<tên-repo>.git
git push -u origin main
```

## Lưu ý bảo mật

- Repo public nên ai cũng xem được code và URL API. PIN Admin **không** nằm trong code nữa — được kiểm tra ở server (Script Properties).
- Ai có URL đều đọc được dữ liệu kho và lưu vị trí kệ (giống như web app cũ).
- Nút "Xuất File" mở link tải của Google Sheet — người bấm phải đăng nhập Google và có quyền xem Sheet.
