<div align="center">

# 🕷️ SpiderPanel — Cloudflare Workers Edition

**پنل و تونل VLESS در یک ورکر — استقرار مستقیم از گیت‌هاب روی Cloudflare**

</div>

<div align="right" dir="rtl">

این نسخه از SpiderPanel به‌طور کامل روی **Cloudflare Workers** اجرا می‌شود؛ بدون VPS، بدون Railway و بدون پایتون. کل پنل مدیریت، حساب کاربری‌ها، اشتراک‌ها و موتور تونل VLESS در **یک ورکر** جمع شده و همه داده‌ها در **Workers KV** ذخیره می‌شوند.

---

## ✨ امکانات

- 🧑‍💼 **پنل مدیریت فارسی** روی مسیر `/spider` — تم مدرن با کارت‌های آمار، کاتالوگ کشورها، toast و پشتیبانی کامل از موبایل
- 👥 **مدیریت کاربران**: حجم مصرفی، تاریخ انقضا، حد اتصال همزمان (محدودیت IP)، فعال/غیرفعال‌سازی
- 🌍 **مسیریابی کشوری**: هر کاربر می‌تواند از چند لوکیشن (کد کشور) عبور کند — `/route/{code}`؛ خروجی پیش‌فرض برای نودهای عادی مستقیم است و فقط مسیر کشوری انتخاب‌شده از پروکسی استفاده می‌کند
- 📡 **کاتالوگ زنده = لوکیشن خودکار**: اتصال مستقیم به [EDT-Pages/Proxy-List](https://github.com/EDT-Pages/Proxy-List) — هر کشوری در کاتالوگ، خودش یک لوکیشن قابل مسیریابی است؛ تونل `/route/{code}` اول پروکسی‌های دستی، بعد پروکسی‌های زنده کاتالوگ (socks5 → https → http) و در نهایت خروج مستقیم را امتحان می‌کند (کش ۱۰ دقیقه‌ای در KV، قابل خاموش‌کردن از تنظیمات)
- 🔐 **پروکسی TLS خروجی**: پشتیبانی از `https://ip:port` (اتصال رمزنگاری‌شده به پروکسی)
- ⚡ **موتور نودسازی cfnew**: آدرس‌های برتر کلادفلر (优选) دقیقاً مثل [byJoey/cfnew](https://github.com/byJoey/cfnew) از منابع زنده گرفته می‌شوند — دامنه‌های برتر، IPهای برتر اپراتورها (API uouin) و لیست bestip مخزن گیت‌هاب؛ هر نود فقط بعد از **تست TCP زنده** ساخته می‌شود و استخر هر **۲۰ دقیقه** با پنجره‌ی بعدی تازه می‌شود (نودها همیشه زنده می‌مانند)
- 🏷️ **نام‌گذاری cfnew**: نودها به‌صورت `IPv4优选-01`، `优选域名-02` و… نام‌گذاری می‌شوند و لینک‌ها دقیقاً با ساختار cfnew ساخته می‌شوند (`path=/?ed=2048`، `eh=Sec-WebSocket-Protocol`، `fp=randomized` و با ECH «fp=chrome»)
- 🔗 **پروتکل‌های پروکسی خروجی**: رله خام `ip:port`، `socks5://`، `http://`
- 📱 **اشتراک‌گذاری**: لینک سابسکریپشن عمومی `/sub/{token}` برای ایمپورت در v2rayNG، Streisand، Hiddify، Nekobox و…
- 📦 **قالب‌های آماده چندکلاینتی**: `/sub/{token}?target=singbox` برای sing-box و `/sub/{token}?target=clash` برای Clash/Mihomo؛ User-Agent کلاینت‌های sing-box و Clash نیز خودکار تشخیص داده می‌شود
- 🧪 **تست تأخیر داخلی**: تب «تست IP» در پنل و تب جدید «آدرس‌های برتر» برای دیدن استخر زنده و تست مجدد دستی
- 📊 **تداخل کاتالوگ و آدرس برتر**: مسیرهای کشوری هم از پروکسی‌های کاتالوگ زنده و هم از استخر آدرس برتر cfnew عبور می‌کنند
- ⚙️ **تنظیمات اتصال**: موتور آدرس برتر (دامنه‌های برتر / IPهای اپراتورها / bestip مخزن)، آدرس دلخواه (yx)، URL منبع دلخواه (yxURL)، پورت‌های TLS، حالت خروجی `direct-first` (پیش‌فرض) / `proxy-first` / `proxy-only`، ECH و ALPN در KV نگهداری می‌شوند. CDN و Fragment عمداً حذف شده‌اند
- 📦 **قالب sing-box**: `/sub/{token}?target=singbox` — فول کانفیگ آماده با سلکتور سرویس‌ها، rule-setهای سایت‌ها، fakeip DNS، اینباند tun + mixed و گروه urltest خودکار برای هر کشور؛ ساختار VLESS شامل `path=/`، `ed=2048` و `Sec-WebSocket-Protocol` است
- 🔐 **احراز هویت**: اولین لاگین، توکن مدیر را ثبت می‌کند (یا متغیر `SPIDER_TOKEN`)؛ نشست با کوکی HttpOnly به مدت ۲۴ ساعت
- 🚫 **ضد حلقه**: اتصال به خود ورکر هرگز به داخل تونل برنمی‌گردد
- 📊 **حساب‌داری ترافیک**: شمارش مصرف با نوشتن دسته‌ای در KV (هر ~۱ مگابایت)

---

## 🚀 استقرار مستقیم از گیت‌هاب (روش پیشنهادی)

نیازی به نصب هیچ ابزاری روی سیستم خودتان نیست. کافی است یک بار این مخزن را Fork کنید:

### ۱. Fork کنید
این مخزن را روی اکانت گیت‌هاب خودتان Fork کنید.

### ۲. اتصال به Cloudflare
1. وارد داشبورد [Cloudflare Workers](https://workers.cloudflare.com) شوید.
2. روی **Create** → **Worker** → **Import a repository** (یا **Connect to Git**) کلیک کنید.
3. حساب گیت‌هاب را وصل کرده و مخزن Fork‌شده (همین پروژه) را انتخاب کنید.

### ۳. تنظیمات دیپلوی
Cloudflare به‌صورت خودکار `wrangler.jsonc` را می‌خواند:
- **Entry point**: `src/worker.js`
- **KV binding**: `SPIDER_KV` — نیازی به ساخت دستی نیست؛ اسکریپت build هنگام دیپلوی، namespace را پیدا یا می‌سازد و شناسه‌اش را در کانفیگ قرار می‌دهد (`scripts/provision-kv.mjs`).

> ⚠️ اگر توکن Workers Builds دسترسی Workers KV Storage نداشته باشد، اسکریپت خطا می‌دهد و می‌گویید namespace با نام `metsim-SPIDER_KV` بسازید؛ در آن صورت شناسه‌اش را در `wrangler.jsonc` جای `SPIDER_KV_PLACEHOLDER` بگذارید.

### ۴. Deploy
روی **Deploy** بزنید. از این به بعد هر `git push` به شاخه `main`، ورکر را به‌صورت خودکار به‌روزرسانی می‌کند.

### ۵. ورود به پنل
به آدرس زیر بروید:

```
https://<your-worker>.<your-subdomain>.workers.dev/spider
```

اولین توکنی که در صفحه ورود وارد کنید (حداقل ۸ کاراکتر)، **توکن مدیر** پنل می‌شود. آن را جایی ایمن ذخیره کنید.

---

## 🛠️ دیپلوی با Wrangler (اختیاری)

اگر ترجیح می‌دهید از ترمینال دیپلوی کنید:

```bash
npm install
npx wrangler kv namespace create SPIDER_KV
# شناسه‌ی تولیدشده را در wrangler.jsonc جای SPIDER_KV_PLACEHOLDER بگذارید
# (یا CLOUDFLARE_ACCOUNT_ID و CLOUDFLARE_API_TOKEN را در env بگذارید و
#  اسکریپت build به‌صورت خودکار این کار را انجام می‌دهد)
npx wrangler deploy
```

برای تست محلی:

```bash
npx wrangler dev
```

---

## 📌 اطلاعات پروژه

| مورد | مقدار |
| --- | --- |
| مسیر ورود به پنل | `/spider` |
| مسیر اشتراک | `/sub/{token}` |
| اشتراک قالب sing-box | `/sub/{token}?target=singbox` |
| اشتراک قالب Clash/Mihomo | `/sub/{token}?target=clash` |
| تست تأخیر مدیریتی | `POST /spider/latency` (حداکثر ۵۰ هدف)؛ سلامت کشور نیز از `GET /spider/location-health?code=DE` قابل مشاهده است |
| کاتالوگ پروکسی | `/spider/catalog` (اختیاری: `?country=DE&proto=socks5&refresh=1`) |
| تونل مستقیم | `/{uuid}` |
| تونل کشوری | `/route/{code}` |
| متغیرهای محیطی | `SPIDER_KV` (الزامی)، `SPIDER_TOKEN` (اختیاری) |

---

## 🔗 ساختار لینک اتصال (VLESS)

```
vless://{uuid}@{worker-domain}:443?encryption=none&security=tls&sni={worker-domain}&host={worker-domain}&fp=randomized&type=ws&path=/&ed=2048&eh=Sec-WebSocket-Protocol#{نام کاربر}
```

پنل این لینک‌ها را برای هر کاربر تولید می‌کند؛ کافی است در جدول کاربران روی **لینک‌ها** کلیک کنید یا از **اشتراک** استفاده کنید.

---

## 🧭 معماری

```
src/
├── worker.js     → روتر اصلی (ورکر): مسیریابی درخواست‌ها
├── panel.js      → پنل، احراز هویت، API مدیریتی و اشتراک
├── catalog.js    → کاتالوگ زنده EDT-Pages/Proxy-List با کش KV
├── dashboard.txt → اسکریپت کلاینت داشبورد
└── tunnel.js     → موتور VLESS-over-WS، KV، پروکسی‌های خروجی
```

منشأ این نسخه، پروژه [amirh00sain/SpiderPanel](https://github.com/amirh00sain/SpiderPanel) است که برای اجرای مستقیم روی Cloudflare Workers بازنویسی شده است. الگوهای تنظیمات پویا، تست تأخیر، تشخیص User-Agent و پشتیبانی چندکلاینتی نیز با الهام از [byJoey/cfnew](https://github.com/byJoey/cfnew) به این معماری اضافه شده‌اند.

---

## 📢 اعتبار

👤 سازنده پروژه اصلی: **amirsp1ider** — کانال: **SPiDER_VPN1**

❤️ نسخه Cloudflare Workers برای استقرار بدون سرور بازنویسی شده است.

</div>
