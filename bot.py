"""
بوت Telegram ذكي — مساعد شخصي متكامل
========================================
المتغيرات المطلوبة في Railway:
  TELEGRAM_BOT_TOKEN      — توكن البوت من @BotFather
  GEMINI_API_KEY          — مفتاح Google Gemini API
  TELEGRAM_OWNER_ID       — ايدي مالك البوت (اختياري)
  GEMINI_MODEL            — النموذج (افتراضي: gemini-2.0-flash-exp)
"""

import os, re, json, asyncio, logging, traceback, base64
from typing import Optional

from telegram import Update, BotCommand
from telegram.ext import (
    ApplicationBuilder, CommandHandler, MessageHandler,
    ContextTypes, filters,
)
from telegram.constants import ParseMode, ChatAction
from telegram.error import NetworkError, TimedOut
from telegram.request import HTTPXRequest

import httpx

# ─── إعداد اللوقينج ───────────────────────────────────────────────────────────
logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

# ─── المتغيرات البيئية ────────────────────────────────────────────────────────
BOT_TOKEN   = os.environ.get("TELEGRAM_BOT_TOKEN", "")
GEMINI_KEY  = os.environ.get("GEMINI_API_KEY", "")
OWNER_ID    = int(os.environ.get("TELEGRAM_OWNER_ID", "0") or 0)
MODEL       = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")
MAX_HISTORY = int(os.environ.get("MAX_HISTORY", "30"))

GEMINI_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"

# ─── ذاكرة المحادثات ──────────────────────────────────────────────────────────
conversations: dict[int, list[dict]] = {}

# ─── Prompt النظام ────────────────────────────────────────────────────────────
SYSTEM_PROMPT = """أنت مساعد ذكي متقدم جداً، خبير في البرمجة والتقنية.

قدراتك:
- كتابة ومراجعة وإصلاح الكود بأي لغة (Python, JS, TS, Go, Rust, Java, C++, إلخ)
- شرح المفاهيم التقنية والبرمجية بعمق ووضوح
- تصميم قواعد البيانات والـ APIs
- مساعدة في DevOps (Docker, Railway, GitHub Actions)
- تحليل الكود وإيجاد الأخطاء واقتراح التحسينات
- تذكر كامل سياق المحادثة

قواعد ثابتة:
- أجب دائماً بنفس لغة السؤال (عربي أو إنجليزي)
- استخدم Markdown — الكود دائماً داخل backticks
- أعطِ الكود الكامل دائماً، لا تكتب "..." أو تختصر أبداً
- عند إصلاح خطأ، اشرح سببه وليس فقط الحل
- كن دقيقاً ومفصلاً، لا تختصر الشرح المهم"""


# ══════════════════════════════════════════════════════════════════════════════
#  Gemini API
# ══════════════════════════════════════════════════════════════════════════════

def build_gemini_payload(history: list[dict], system: str) -> dict:
    """بناء payload لـ Gemini API من تاريخ المحادثة."""
    contents = []
    for msg in history:
        role = "user" if msg["role"] == "user" else "model"
        content = msg["content"]
        # إذا كان المحتوى قائمة (صور) نتعامل معه كـ parts
        if isinstance(content, list):
            parts = []
            for item in content:
                if item.get("type") == "text":
                    parts.append({"text": item["text"]})
                elif item.get("type") == "image_url":
                    url = item["image_url"]["url"]
                    if url.startswith("data:"):
                        # base64 image
                        mime, data = url.split(";base64,")
                        mime = mime.replace("data:", "")
                        parts.append({"inline_data": {"mime_type": mime, "data": data}})
            contents.append({"role": role, "parts": parts})
        else:
            contents.append({"role": role, "parts": [{"text": str(content)}]})
    
    return {
        "system_instruction": {"parts": [{"text": system}]},
        "contents": contents,
        "generationConfig": {
            "maxOutputTokens": 8192,
            "temperature": 0.7,
        },
        "safetySettings": [
            {"category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE"},
            {"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE"},
            {"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE"},
            {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE"},
        ],
    }


async def ask_gemini(user_id: int, history_override: list = None) -> str:
    """إرسال طلب لـ Gemini وإرجاع الرد."""
    history = history_override or conversations.get(user_id, [])
    
    if not history:
        return "أرسل رسالتك!"
    
    payload = build_gemini_payload(history, SYSTEM_PROMPT)
    
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                GEMINI_URL,
                params={"key": GEMINI_KEY},
                json=payload,
            )
        
        if resp.status_code != 200:
            err = resp.text[:300]
            logger.error(f"Gemini error {resp.status_code}: {err}")
            if "API_KEY" in err or "401" in str(resp.status_code):
                return "❌ مفتاح GEMINI_API_KEY غير صحيح أو منتهي الصلاحية."
            if "quota" in err.lower() or "429" in str(resp.status_code):
                return "⏳ تجاوزنا الحد المسموح من Gemini. انتظر دقيقة وأعد المحاولة."
            return f"❌ خطأ من Gemini ({resp.status_code}): {err}"
        
        data = resp.json()
        candidates = data.get("candidates", [])
        if not candidates:
            # تحقق من blocked
            block = data.get("promptFeedback", {}).get("blockReason", "")
            if block:
                return f"⚠️ تم حجب الرد من Gemini: {block}"
            return "لم أتمكن من الرد. حاول مرة أخرى."
        
        parts = candidates[0].get("content", {}).get("parts", [])
        text = "".join(p.get("text", "") for p in parts).strip()
        return text or "لم أتمكن من الرد."
    
    except httpx.TimeoutException:
        return "⏳ انتهت مهلة الاتصال بـ Gemini. حاول مرة أخرى."
    except Exception as e:
        logger.error(f"Gemini exception: {e}")
        return f"❌ خطأ في الاتصال بـ Gemini: {str(e)[:150]}"


# ══════════════════════════════════════════════════════════════════════════════
#  أدوات مساعدة
# ══════════════════════════════════════════════════════════════════════════════

def add_message(user_id: int, role: str, content) -> None:
    history = conversations.setdefault(user_id, [])
    history.append({"role": role, "content": content})
    if len(history) > MAX_HISTORY:
        conversations[user_id] = history[-MAX_HISTORY:]


def clear_history(user_id: int) -> None:
    conversations[user_id] = []


async def web_search(query: str) -> str:
    """بحث سريع عبر DuckDuckGo."""
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
            resp = await client.get(
                "https://api.duckduckgo.com/",
                params={"q": query, "format": "json", "no_html": 1, "skip_disambig": 1},
            )
            data = resp.json()
        
        results = []
        if data.get("AbstractText"):
            results.append(f"📌 {data['AbstractText']}")
        for r in data.get("RelatedTopics", [])[:4]:
            if isinstance(r, dict) and r.get("Text"):
                results.append(f"• {r['Text']}")
        
        return ("نتائج البحث:\n" + "\n".join(results)) if results else f"لم أجد نتائج مباشرة عن '{query}'."
    except Exception as e:
        logger.warning(f"Search error: {e}")
        return "تعذّر البحث. سأجيب من معلوماتي."


async def execute_code(language: str, code: str) -> str:
    """تنفيذ الكود عبر Piston API."""
    LANG_MAP = {
        "python": "python", "py": "python",
        "javascript": "javascript", "js": "javascript",
        "typescript": "typescript", "ts": "typescript",
        "go": "go", "rust": "rust", "java": "java",
        "cpp": "c++", "c++": "c++", "c": "c",
        "bash": "bash", "sh": "bash",
        "ruby": "ruby", "rb": "ruby", "php": "php",
    }
    lang = LANG_MAP.get(language.lower(), language.lower())
    
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.post(
                "https://emkc.org/api/v2/piston/execute",
                json={
                    "language": lang,
                    "version": "*",
                    "files": [{"content": code}],
                    "run_timeout": 5000,
                },
            )
            result = resp.json()
        
        run = result.get("run", {})
        out = (run.get("stdout") or "").strip()
        err = (run.get("stderr") or "").strip()
        
        if err and not out:
            return f"❌ خطأ:\n```\n{err[:1500]}\n```"
        if out:
            res = f"✅ النتيجة:\n```\n{out[:1500]}\n```"
            if err:
                res += f"\n⚠️ تحذيرات:\n```\n{err[:500]}\n```"
            return res
        return "✅ تم التنفيذ بنجاح (بدون مخرجات)"
    except Exception as e:
        return f"❌ تعذّر التنفيذ: {str(e)[:100]}"


async def safe_reply(update: Update, text: str):
    """إرسال رسالة مع fallback إذا فشل Markdown."""
    # تقسيم الرسائل الطويلة
    MAX_LEN = 4000
    chunks = [text[i:i+MAX_LEN] for i in range(0, len(text), MAX_LEN)]
    
    for chunk in chunks:
        try:
            await update.message.reply_text(chunk, parse_mode=ParseMode.MARKDOWN)
        except Exception:
            try:
                await update.message.reply_text(chunk, parse_mode=None)
            except Exception as e:
                logger.error(f"Failed to send: {e}")


# ══════════════════════════════════════════════════════════════════════════════
#  معالجات الأوامر
# ══════════════════════════════════════════════════════════════════════════════

async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    name = update.effective_user.first_name or "صديقي"
    await update.message.reply_text(
        f"مرحباً {name}! 👋\n\n"
        "أنا مساعدك الذكي — بإمكاني:\n\n"
        "💻 كتابة ومراجعة وإصلاح الكود\n"
        "▶️ تنفيذ الكود وإرجاع النتيجة\n"
        "🔍 البحث في الإنترنت\n"
        "📄 تحليل الملفات المرسلة\n"
        "🖼️ تحليل وقراءة الصور\n"
        "💬 تذكر المحادثة كاملاً\n\n"
        "**أوامر:**\n"
        "/new — محادثة جديدة\n"
        "/run — تنفيذ كود\n"
        "/search — بحث\n"
        "/help — المساعدة\n\n"
        "ابدأ بسؤالك! 🚀",
        parse_mode=ParseMode.MARKDOWN,
    )


async def cmd_help(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "📖 **دليل الاستخدام**\n\n"
        "**سؤال عادي:** اكتبه مباشرة\n\n"
        "**تنفيذ كود:**\n"
        "/run python\n"
        "```\nprint('مرحبا')\n```\n\n"
        "**بحث:**\n"
        "/search أحدث إصدار Python\n\n"
        "**ملف:** أرسل أي ملف نصي (.py .js .json إلخ)\n\n"
        "**صورة:** أرسل صورة وسأحللها\n\n"
        "**محادثة جديدة:** /new",
        parse_mode=ParseMode.MARKDOWN,
    )


async def cmd_new(update: Update, context: ContextTypes.DEFAULT_TYPE):
    count = len(conversations.get(update.effective_user.id, []))
    clear_history(update.effective_user.id)
    await update.message.reply_text(f"✅ تم مسح {count} رسالة. ابدأ من جديد! 🚀")


async def cmd_run(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = (update.message.text or "").strip()
    lines = text.split("\n", 2)
    
    if len(lines) < 2:
        await update.message.reply_text(
            "📝 **الاستخدام:**\n/run python\n```python\nprint('مرحبا')\n```\n\n"
            "اللغات: python, javascript, go, rust, java, c++, bash",
            parse_mode=ParseMode.MARKDOWN,
        )
        return
    
    lang = lines[0].replace("/run", "").strip() or "python"
    code = re.sub(r"```\w*\n?", "", "\n".join(lines[1:])).strip()
    
    if not code:
        await update.message.reply_text("❌ لم أجد كوداً للتنفيذ.")
        return
    
    await update.message.chat.send_action(ChatAction.TYPING)
    result = await execute_code(lang, code)
    await safe_reply(update, result)


async def cmd_search(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = (update.message.text or "").replace("/search", "").strip()
    
    if not query:
        await update.message.reply_text("🔍 `/search موضوع البحث`", parse_mode=ParseMode.MARKDOWN)
        return
    
    await update.message.chat.send_action(ChatAction.TYPING)
    search_result = await web_search(query)
    
    add_message(update.effective_user.id, "user", f"ابحث عن: {query}\n\n{search_result}")
    await update.message.chat.send_action(ChatAction.TYPING)
    reply = await ask_gemini(update.effective_user.id)
    add_message(update.effective_user.id, "assistant", reply)
    await safe_reply(update, reply)


# ══════════════════════════════════════════════════════════════════════════════
#  معالج الرسائل النصية
# ══════════════════════════════════════════════════════════════════════════════

async def handle_text(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    text = (update.message.text or "").strip()
    if not text:
        return
    
    await update.message.chat.send_action(ChatAction.TYPING)
    
    # بحث تلقائي عند الطلب
    search_kw = ["ابحث", "search", "أحدث", "latest", "newest", "اوجد أحدث"]
    if any(kw in text.lower() for kw in search_kw):
        q = re.sub(r"^(ابحث عن|ابحث|search for|search)\s*", "", text, flags=re.IGNORECASE).strip()
        if q and len(q) > 3:
            sr = await web_search(q)
            text = f"{text}\n\n[نتائج البحث: {sr}]"
    
    add_message(user_id, "user", text)
    await update.message.chat.send_action(ChatAction.TYPING)
    reply = await ask_gemini(user_id)
    add_message(user_id, "assistant", reply)
    await safe_reply(update, reply)
    
    # تنفيذ تلقائي إذا طُلب
    run_kw = ["نفّذ", "شغّل", "run", "execute", "اشغل", "نفذ"]
    lang_match = re.search(r"```(\w+)\n([\s\S]+?)```", text)
    if any(kw in text.lower() for kw in run_kw) and lang_match:
        lang, code = lang_match.group(1), lang_match.group(2)
        await update.message.chat.send_action(ChatAction.TYPING)
        exec_result = await execute_code(lang, code)
        await safe_reply(update, exec_result)


# ══════════════════════════════════════════════════════════════════════════════
#  معالج الملفات
# ══════════════════════════════════════════════════════════════════════════════

TEXT_EXTS = {
    ".py", ".js", ".ts", ".jsx", ".tsx", ".go", ".rs", ".java",
    ".cpp", ".c", ".h", ".cs", ".rb", ".php", ".swift",
    ".txt", ".md", ".json", ".yaml", ".yml", ".toml", ".env",
    ".html", ".css", ".sql", ".sh", ".bash", ".xml", ".csv",
}

async def handle_file(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    doc = update.message.document
    if not doc:
        return
    
    fname = doc.file_name or "file"
    ext = os.path.splitext(fname)[1].lower()
    caption = (update.message.caption or "").strip()
    
    await update.message.chat.send_action(ChatAction.TYPING)
    
    if ext not in TEXT_EXTS and (doc.file_size or 0) > 100_000:
        await update.message.reply_text("⚠️ الملف كبير جداً أو نوعه غير مدعوم. أرسل ملفات نصية أقل من 100KB.")
        return
    
    try:
        file = await context.bot.get_file(doc.file_id)
        raw = await file.download_as_bytearray()
        
        try:
            content = raw.decode("utf-8")
        except UnicodeDecodeError:
            content = raw.decode("latin-1", errors="replace")
        
        if len(content) > 12000:
            content = content[:12000] + "\n\n... [مقتصر لـ 12000 حرف]"
        
        prompt = f"تحليل الملف `{fname}`:\n\n```\n{content}\n```"
        if caption:
            prompt += f"\n\nطلب المستخدم: {caption}"
        else:
            prompt += "\n\nحلّل هذا الملف. إذا كان كوداً، راجعه وأشر لأي مشاكل أو تحسينات."
        
        add_message(user_id, "user", prompt)
        await update.message.chat.send_action(ChatAction.TYPING)
        reply = await ask_gemini(user_id)
        add_message(user_id, "assistant", reply)
        await safe_reply(update, reply)
    
    except Exception as e:
        logger.error(f"File error: {e}")
        await update.message.reply_text(f"❌ خطأ في قراءة الملف: {str(e)[:100]}")


# ══════════════════════════════════════════════════════════════════════════════
#  معالج الصور
# ══════════════════════════════════════════════════════════════════════════════

async def handle_photo(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    caption = (update.message.caption or "صف هذه الصورة بالتفصيل. إذا فيها كود أو نص، اقرأه وحلّله.").strip()
    
    await update.message.chat.send_action(ChatAction.TYPING)
    
    try:
        photo = update.message.photo[-1]
        file = await context.bot.get_file(photo.file_id)
        img_bytes = await file.download_as_bytearray()
        b64 = base64.b64encode(img_bytes).decode()
        
        # Gemini يدعم الصور مباشرة
        msg_content = [
            {"type": "text", "text": caption},
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
        ]
        
        add_message(user_id, "user", msg_content)
        await update.message.chat.send_action(ChatAction.TYPING)
        reply = await ask_gemini(user_id)
        add_message(user_id, "assistant", reply)
        await safe_reply(update, reply)
    
    except Exception as e:
        logger.error(f"Photo error: {e}")
        await update.message.reply_text(f"❌ خطأ في معالجة الصورة: {str(e)[:100]}")


# ══════════════════════════════════════════════════════════════════════════════
#  الدالة الرئيسية
# ══════════════════════════════════════════════════════════════════════════════

def main():
    if not BOT_TOKEN:
        raise SystemExit("❌ TELEGRAM_BOT_TOKEN مفقود")
    if not GEMINI_KEY:
        raise SystemExit("❌ GEMINI_API_KEY مفقود")
    
    logger.info(f"🤖 تشغيل البوت | النموذج: {MODEL}")
    
    app = (
        ApplicationBuilder()
        .token(BOT_TOKEN)
        .concurrent_updates(True)
        .get_updates_request(HTTPXRequest(
            connection_pool_size=1,
            read_timeout=60,
            connect_timeout=30,
            write_timeout=30,
        ))
        .build()
    )
    
    app.add_handler(CommandHandler("start",   cmd_start))
    app.add_handler(CommandHandler("help",    cmd_help))
    app.add_handler(CommandHandler("new",     cmd_new))
    app.add_handler(CommandHandler("run",     cmd_run))
    app.add_handler(CommandHandler("search",  cmd_search))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text))
    app.add_handler(MessageHandler(filters.Document.ALL, handle_file))
    app.add_handler(MessageHandler(filters.PHOTO, handle_photo))
    
    app.run_polling(
        drop_pending_updates=True,
        read_timeout=45,
        write_timeout=45,
        connect_timeout=45,
        pool_timeout=45,
        allowed_updates=["message"],
    )


if __name__ == "__main__":
    import time as _t
    _delay = 5
    while True:
        try:
            main()
        except SystemExit:
            raise
        except Exception as e:
            en = type(e).__name__
            if "Conflict" in en:
                logger.warning("⚠️ Conflict — انتظار 45 ثانية...")
                _t.sleep(45)
                _delay = 5
                continue
            logger.critical(f"💥 [{en}]: {e}\n{traceback.format_exc()}")
            _t.sleep(_delay)
            _delay = min(_delay * 2, 30)
        else:
            _t.sleep(3)
            _delay = 5
