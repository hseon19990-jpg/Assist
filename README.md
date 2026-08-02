# 🤖 بوت تعديل GitHub بالعربي

بوت تيليجرام بسيط — أرسل `/start` ثم تكلم بالعربي مباشرة.

---

## المتغيرات على Railway

| المتغير | الوصف |
|--------|-------|
| `TELEGRAM_BOT_TOKEN` | توكن البوت من @BotFather |
| `TELEGRAM_OWNER_ID` | رقمك من @userinfobot |
| `GEMINI_API_KEY` | مفتاح Gemini من https://aistudio.google.com/app/apikey |
| `GROQ_API_KEY` | **بديل مجاني** من https://console.groq.com |

> أضف **واحداً فقط**: إما `GEMINI_API_KEY` أو `GROQ_API_KEY`، البوت يتعرف عليهما تلقائياً.

---

## كيف يعمل

1. أرسل `/start`
2. أرسل رابط الريبو: `https://github.com/username/repo`
3. أرسل توكن GitHub يبدأ بـ `ghp_`
4. اكتب أي تعليمات بالعربي ✨

**مثال:**
> في ملف index.js غير رسالة /start لتقول: أهلاً بك في بوتي!

البوت سيفهم ويعدّل الكود تلقائياً.

---

لتغيير الريبو في أي وقت: فقط أرسل رابط GitHub جديد وتوكن جديد.
