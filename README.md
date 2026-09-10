<div align="center">

# 🕷️ SpiderPanel — Cloudflare Workers Edition

**پنل و تونل VLESS در یک ورکر — استقرار مستقیم از گیت‌هاب روی Cloudflare**

</div>

<div align="right" dir="rtl">

این نسخه از SpiderPanel به‌طور کامل روی **Cloudflare Workers** اجرا می‌شود؛ بدون VPS، بدون Railway و بدون پایتون. کل پنل مدیریت، حساب کاربری‌ها، اشتراک‌ها و موتور تونل VLESS در **یک ورکر** جمع شده و همه داده‌ها در **Workers KV** ذخیره می‌شوند.

---

## ✨ امکانات

- 🧑‍💼 **پنل مدیریت فارسی** روی مسیر `/spider` — با تم تاریک و پشتیبانی کامل از موبایل
- 👥 **مدیریت کاربران**: حجم مصرفی، تاریخ انقضا، حد اتصال همزمان (محدودیت IP)، فعال/غیرفعال‌سازی
- 🌍 **مسیریابی کشوری**: هر کاربر می‌تواند از چند لوکیشن (کد کشور) عبور کند — `/route/{code}`
- ⚡ **انتخاب سریع‌ترین پروکسی**: در هر لوکیشن، همه پروکسی‌ها با هم مسابقه تأخیر TCP می‌دهند و سریع‌ترین برنده می‌شود (با کش ۲ دقیقه‌ای)
- 🔗 **پروتکل‌های پروکسی خروجی**: رله خام `ip:port`، `socks5://`، `http://`
- 📱 **اشتراک‌گذاری**: لینک سابسکریپشن عمومی `/sub/{token}` برای ایمپورت در v2rayNG، Streisand، Hiddify، Nekobox و…
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
| تونل مستقیم | `/{uuid}` |
| تونل کشوری | `/route/{code}` |
| متغیرهای محیطی | `SPIDER_KV` (الزامی)، `SPIDER_TOKEN` (اختیاری) |

---

## 🔗 ساختار لینک اتصال (VLESS)

```
vless://{uuid}@{worker-domain}:443?encryption=none&security=tls&sni={worker-domain}&host={worker-domain}&fp=chrome&type=ws&path=/{uuid یا /route/{code}}#{نام کاربر}
```

پنل این لینک‌ها را برای هر کاربر تولید می‌کند؛ کافی است در جدول کاربران روی **لینک‌ها** کلیک کنید یا از **اشتراک** استفاده کنید.

---

## 🧭 معماری

```
src/
├── worker.js   → روتر اصلی (ورکر): مسیریابی درخواست‌ها
├── panel.js    → پنل، احراز هویت، API مدیریتی و اشتراک
└── tunnel.js   → موتور VLESS-over-WS، KV، پروکسی‌های خروجی
```

منشأ این نسخه، پروژه [amirh00sain/SpiderPanel](https://github.com/amirh00sain/SpiderPanel) است که برای اجرای مستقیم روی Cloudflare Workers بازنویسی شده است.

---

## 📢 اعتبار

👤 سازنده پروژه اصلی: **amirsp1ider** — کانال: **SPiDER_VPN1**

❤️ نسخه Cloudflare Workers برای استقرار بدون سرور بازنویسی شده است.

</div>
