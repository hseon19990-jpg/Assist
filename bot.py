"""
بوت Telegram ذكي — مساعد شخصي متكامل
========================================
المتغيرات المطلوبة في Railway:
  BOT_TOKEN      — توكن البوت من @BotFather
  OPENAI_API_KEY — مفتاح OpenAI API
  OWNER_ID       — ايدي مالك البوت (اختياري)
  OPENAI_MODEL   — النموذج (افتراضي: gpt-4o)
"""

import os, re, json, asyncio, logging, traceback, html, io, tempfile
from datetime import datetime
from typing import Optional

from telegram import (
    Update, InlineKeyboardButton, InlineKeyboardMarkup,
    BotCommand, BotCommandScopeChat,
)
from telegram.ext import (
    ApplicationBuilder, CommandHandler, MessageHandler,
    CallbackQueryHandler, ContextTypes, filters,
)
from telegram.constants import ParseMode, ChatAction
from telegram.error import NetworkError, TimedOut, RetryAfter
from telegram.request import HTTPXRequest

import httpx
from openai import AsyncOpenAI

# ─── إعداد اللوقينج ───────────────────────────────────────────────────────────
logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

# ─── المتغيرات البيئية ────────────────────────────────────────────────────────
BOT_TOKEN      = os.environ.get("BOT_TOKEN", "")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
OWNER_ID       = int(os.environ.get("OWNER_ID", "0") or 0)
MODEL          = os.environ.get("OPENAI_MODEL", "gpt-4o")
MAX_HISTORY    = int(os.environ.get("MAX_HISTORY", "30"))

# ─── تهيئة OpenAI ─────────────────────────────────────────────────────────────
ai = AsyncOpenAI(api_key=OPENAI_API_KEY)

# ─── ذاكرة المحادثات لكل مستخدم ──────────────────────────────────────────────
conversations: dict[int, list[dict]] = {}

# ─── Prompt النظام ────────────────────────────────────────────────────────────
SYSTEM_PROMPT = """أنت مساعد ذكي متقدم ومتطور جداً يشبه Replit Agent في قدراته. 

قدراتك:
- كتابة ومراجعة وإصلاح الكود بأي لغة برمجية (Python, JavaScript, TypeScript, Go, Rust, C++, Java, إلخ)
- شرح المفاهيم التقنية والبرمجية بعمق ووضوح
- تحليل الكود وإيجاد الأخطاء (bugs) واقتراح التحسينات
- تصميم قواعد البيانات والـ schemas
- مساعدة في DevOps (Docker, Railway, GitHub Actions, CI/CD)
- تحليل الملفات والصور المرسلة
- تذكر كامل سياق المحادثة
- تقديم حلول كاملة وجاهزة للتطبيق (لا تختصر الكود أبداً)

أسلوبك:
- أجب دائماً بنفس لغة السؤال (عربي أو إنجليزي)
- استخدم Markdown في ردودك — الكود داخل backticks دائماً
- أعطِ الكود الكامل دائماً، لا تكتب "..." أو "// rest of code"
- كن دقيقاً ومفصّلاً، لا تختصر التفسيرات المهمة
- عند إصلاح خطأ، اشرح سببه وليس فقط الحل
- تعامل مع كل سؤال كأنه مهم وجدير بالاهتمام الكامل"""


# ══════════════════════════════════════════════════════════════════════════════
#  أدوات مساعدة
# ══════════════════════════════════════════════════════════════════════════════

def get_history(user_id: int) -> list[dict]:
    """إرجاع تاريخ المحادثة للمستخدم."""
    return conversations.setdefault(user_id, [])


def add_message(user_id: int, role: str, content) -> None:
    """إضافة رسالة لتاريخ المحادثة مع تقليم التاريخ القديم."""
    history = get_history(user_id)
    history.append({"role": role, "content": content})
    # احتفظ بآخر MAX_HISTORY رسالة فقط
    if len(history) > MAX_HISTORY:
        conversations[user_id] = history[-MAX_HISTORY:]


def clear_history(user_id: int) -> None:
    """مسح تاريخ المحادثة."""
    conversations[user_id] = []


async def web_search(query: str, max_results: int = 5) -> str:
    """بحث سريع عبر DuckDuckGo (بدون API key)."""
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
            resp = await client.get(
                "https://api.duckduckgo.com/",
                params={"q": query, "format": "json", "no_html": 1, "skip_disambig": 1},
            )
            data = resp.json()
        
        results = []
        # النتيجة الرئيسية
        if data.get("AbstractText"):
            results.append(f"📌 {data['AbstractText']}")
        # النتائج الجانبية
        for r in data.get("RelatedTopics", [])[:max_results]:
            if isinstance(r, dict) and r.get("Text"):
                results.append(f"• {r['Text']}")
        
        if results:
            return "نتائج البحث:\n" + "\n".join(results[:5])
        return f"لم أجد نتائج مباشرة عن '{query}'. سأجيبك من معلوماتي."
    except Exception as e:
        logger.warning(f"Web search failed: {e}")
        return f"تعذّر البحث في الإنترنت. سأجيبك من معلوماتي."


async def execute_code(language: str, code: str) -> str:
    """تنفيذ الكود عبر Piston API (مجاني، بدون API key)."""
    LANG_MAP = {
        "python": "python", "py": "python",
        "javascript": "javascript", "js": "javascript",
        "typescript": "typescript", "ts": "typescript",
        "go": "go", "rust": "rust",
        "java": "java", "cpp": "c++", "c++": "c++",
        "c": "c", "bash": "bash", "sh": "bash",
        "ruby": "ruby", "rb": "ruby",
        "php": "php", "swift": "swift",
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
                    "stdin": "",
                    "args": [],
                    "compile_timeout": 10000,
                    "run_timeout": 5000,
                },
            )
            result = resp.json()
        
        run = result.get("run", {})
        out = run.get("stdout", "").strip()
        err = run.get("stderr", "").strip()
        
        if err and not out:
            return f"❌ خطأ:\n```\n{err[:1500]}\n```"
        if out:
            output = out[:1500]
            if err:
                output += f"\n⚠️ تحذيرات:\n{err[:500]}"
            return f"✅ النتيجة:\n```\n{output}\n```"
        return "✅ تم تنفيذ الكود بنجاح (بدون مخرجات)"
    except Exception as e:
        return f"❌ تعذّر تنفيذ الكود: {e}"


def detect_code_language(text: str) -> Optional[str]:
    """كشف لغة الكود من المحادثة."""
    pattern = r"```(\w+)?\n([\s\S]+?)```"
    matches = re.findall(pattern, text)
    if matches:
        lang, code = matches[0]
        return lang or "python", code
    return None, None


async def ask_ai(user_id: int, messages_override: list = None) -> str:
    """إرسال طلب لـ OpenAI وإرجاع الرد."""
    history = messages_override or get_history(user_id)
    
    try:
        response = await ai.chat.completions.create(
            model=MODEL,
            messages=[{"role": "system", "content": SYSTEM_PROMPT}] + history,
            max_tokens=4096,
            temperature=0.7,
        )
        return response.choices[0].message.content or "لم أتمكن من الرد."
    except Exception as e:
        logger.error(f"OpenAI error: {e}")
        if "api_key" in str(e).lower() or "auth" in str(e).lower():
            return "❌ مفتاح OPENAI_API_KEY غير صحيح أو غير مضاف في متغيرات البيئة."
        if "rate_limit" in str(e).lower():
            return "⏳ وصلنا للحد الأقصى من الطلبات. انتظر لحظة وأعد المحاولة."
        return f"❌ خطأ في الاتصال بـ OpenAI: {str(e)[:200]}"


async def safe_send(update: Update, text: str, parse_mode=ParseMode.MARKDOWN, **kwargs):
    """إرسال رسالة مع fallback إذا فشل الـ Markdown."""
    try:
        await update.message.reply_text(text, parse_mode=parse_mode, **kwargs)
    except Exception:
        try:
            # fallback بدون markdown
            await update.message.reply_text(text, parse_mode=None, **kwargs)
        except Exception as e:
            logger.error(f"Failed to send message: {e}")


# ══════════════════════════════════════════════════════════════════════════════
#  معالجات الأوامر
# ══════════════════════════════════════════════════════════════════════════════

async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    name = user.first_name or "صديقي"
    
    text = (
        f"مرحباً {name}! 👋\n\n"
        "أنا مساعدك الذكي — أقدر أساعدك في:\n\n"
        "💻 **البرمجة والكود** — كتابة، مراجعة، إصلاح أخطاء\n"
        "🔍 **البحث** — أبحث في الإنترنت لك\n"
        "▶️ **تنفيذ الكود** — أشغّل الكود وأعطيك النتيجة\n"
        "📄 **تحليل الملفات** — أرسل أي ملف نصي\n"
        "🖼️ **تحليل الصور** — أرسل صورة وأصفها أو أحللها\n"
        "💬 **محادثة ذكية** — أتذكر كل المحادثة\n\n"
        "**أوامر مفيدة:**\n"
        "/new — محادثة جديدة (مسح الذاكرة)\n"
        "/run — تنفيذ كود\n"
        "/search — بحث في الإنترنت\n"
        "/help — المساعدة\n\n"
        "ابدأ بسؤالك الآن! 🚀"
    )
    await update.message.reply_text(text, parse_mode=ParseMode.MARKDOWN)


async def cmd_help(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = (
        "📖 **دليل الاستخدام**\n\n"
        "**محادثة عادية:**\n"
        "فقط اكتب سؤالك أو طلبك مباشرة.\n\n"
        "**البرمجة:**\n"
        "• \"اكتب لي كود Python يقرأ ملف CSV\"\n"
        "• \"راجع هذا الكود: `...`\"\n"
        "• \"ليش يطلع هذا الخطأ: `...`\"\n\n"
        "**تنفيذ كود:**\n"
        "/run python\n"
        "```python\nprint('مرحبا')\n```\n\n"
        "**بحث:**\n"
        "/search أحدث إصدار من Python\n\n"
        "**ملفات وصور:**\n"
        "أرسل أي ملف نصي (.py, .js, .txt, .json, إلخ) وسأحلله.\n"
        "أرسل صورة وسأصفها أو أجيب على أسئلتك عنها.\n\n"
        "**أوامر:**\n"
        "/new — محادثة جديدة\n"
        "/history — عدد الرسائل المحفوظة\n"
        "/model — النموذج المستخدم\n"
    )
    await update.message.reply_text(text, parse_mode=ParseMode.MARKDOWN)


async def cmd_new(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    count = len(get_history(user_id))
    clear_history(user_id)
    await update.message.reply_text(
        f"✅ تم مسح المحادثة ({count} رسالة).\nابدأ محادثة جديدة! 🚀"
    )


async def cmd_history(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    count = len(get_history(user_id))
    await update.message.reply_text(
        f"💬 عدد الرسائل المحفوظة: **{count}** / {MAX_HISTORY}",
        parse_mode=ParseMode.MARKDOWN,
    )


async def cmd_model(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        f"🤖 النموذج الحالي: `{MODEL}`\n\n"
        "لتغيير النموذج، أضف `OPENAI_MODEL` في متغيرات Railway.\n"
        "النماذج المتاحة: `gpt-4o`, `gpt-4o-mini`, `gpt-4-turbo`",
        parse_mode=ParseMode.MARKDOWN,
    )


async def cmd_run(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """تنفيذ كود مباشر — /run python\\nكود هنا"""
    text = update.message.text or ""
    lines = text.split("\n", 2)
    
    if len(lines) < 2:
        await update.message.reply_text(
            "📝 **طريقة الاستخدام:**\n\n"
            "/run python\n"
            "```python\nprint('مرحبا')\n```\n\n"
            "اللغات المتاحة: python, javascript, go, rust, java, c++, bash",
            parse_mode=ParseMode.MARKDOWN,
        )
        return
    
    # استخراج اللغة والكود
    first_line = lines[0].replace("/run", "").strip()
    language = first_line or "python"
    code_part = "\n".join(lines[1:])
    
    # تنظيف code blocks
    code_part = re.sub(r"```\w*\n?", "", code_part).strip()
    
    if not code_part:
        await update.message.reply_text("❌ لم أجد كوداً للتنفيذ.")
        return
    
    await update.message.chat.send_action(ChatAction.TYPING)
    result = await execute_code(language, code_part)
    await safe_send(update, result)


async def cmd_search(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """بحث في الإنترنت — /search استعلام"""
    query = update.message.text.replace("/search", "").strip()
    
    if not query:
        await update.message.reply_text("🔍 اكتب ما تريد البحث عنه:\n`/search اسم الموضوع`", parse_mode=ParseMode.MARKDOWN)
        return
    
    await update.message.chat.send_action(ChatAction.TYPING)
    result = await web_search(query)
    
    # أرسل نتائج البحث للـ AI لتلخيصها
    add_message(update.effective_user.id, "user", f"ابحث عن: {query}\n\n{result}")
    await update.message.chat.send_action(ChatAction.TYPING)
    reply = await ask_ai(update.effective_user.id)
    add_message(update.effective_user.id, "assistant", reply)
    
    await safe_send(update, reply)


# ══════════════════════════════════════════════════════════════════════════════
#  معالج الرسائل النصية الرئيسي
# ══════════════════════════════════════════════════════════════════════════════

async def handle_text(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    text = (update.message.text or "").strip()
    
    if not text:
        return
    
    # تحقق من طلب تنفيذ كود في الرسالة
    lang, code = detect_code_language(text)
    run_keywords = ["نفّذ", "شغّل", "run", "execute", "اشغل", "نفذ"]
    wants_run = any(kw in text.lower() for kw in run_keywords) and code
    
    await update.message.chat.send_action(ChatAction.TYPING)
    
    # بحث في الإنترنت إذا طُلب
    search_keywords = ["ابحث", "search", "اوجد", "أوجد", "latest", "أحدث", "newest"]
    if any(kw in text.lower() for kw in search_keywords):
        # استخراج موضوع البحث
        query = re.sub(r"^(ابحث عن|ابحث|search for|search)\s*", "", text, flags=re.IGNORECASE).strip()
        if query and len(query) > 3:
            search_result = await web_search(query)
            text = f"{text}\n\n[نتائج البحث: {search_result}]"
    
    # إضافة رسالة المستخدم للتاريخ
    add_message(user_id, "user", text)
    
    # الحصول على رد الـ AI
    reply = await ask_ai(user_id)
    add_message(user_id, "assistant", reply)
    
    # إرسال الرد
    await safe_send(update, reply)
    
    # تنفيذ الكود تلقائياً إذا طُلب
    if wants_run and lang and code:
        await update.message.chat.send_action(ChatAction.TYPING)
        exec_result = await execute_code(lang, code)
        await safe_send(update, exec_result)


# ══════════════════════════════════════════════════════════════════════════════
#  معالج الملفات
# ══════════════════════════════════════════════════════════════════════════════

TEXT_EXTENSIONS = {
    ".py", ".js", ".ts", ".jsx", ".tsx", ".go", ".rs", ".java",
    ".cpp", ".c", ".h", ".cs", ".rb", ".php", ".swift", ".kt",
    ".txt", ".md", ".json", ".yaml", ".yml", ".toml", ".env",
    ".html", ".css", ".scss", ".sql", ".sh", ".bash", ".zsh",
    ".xml", ".csv", ".log", ".dockerfile", ".gitignore",
}

async def handle_file(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    doc = update.message.document
    
    if not doc:
        return
    
    filename = doc.file_name or "file"
    ext = os.path.splitext(filename)[1].lower()
    caption = (update.message.caption or "").strip()
    
    await update.message.chat.send_action(ChatAction.TYPING)
    
    # تحقق من نوع الملف
    if ext not in TEXT_EXTENSIONS and doc.file_size and doc.file_size > 50_000:
        await update.message.reply_text(
            f"⚠️ الملف `{filename}` كبير جداً أو من نوع غير نصي.\n"
            "أرسل ملفات نصية (كود، JSON، CSV، إلخ) بحجم أقل من 50KB.",
            parse_mode=ParseMode.MARKDOWN,
        )
        return
    
    # تحميل الملف
    try:
        file = await context.bot.get_file(doc.file_id)
        file_bytes = await file.download_as_bytearray()
        
        # محاولة فك التشفير
        try:
            content = file_bytes.decode("utf-8")
        except UnicodeDecodeError:
            try:
                content = file_bytes.decode("latin-1")
            except Exception:
                await update.message.reply_text("❌ لا أستطيع قراءة هذا الملف (ليس نصياً).")
                return
        
        # اقتصار المحتوى
        if len(content) > 8000:
            content = content[:8000] + "\n\n... [مقتصر لـ 8000 حرف]"
        
        prompt = (
            f"تحليل الملف: `{filename}`\n\n"
            f"```\n{content}\n```"
        )
        if caption:
            prompt += f"\n\nملاحظة المستخدم: {caption}"
        else:
            prompt += "\n\nحلّل هذا الملف وأخبرني عن محتواه، وإذا كان كوداً فراجعه وأشر لأي مشاكل."
        
        add_message(user_id, "user", prompt)
        await update.message.chat.send_action(ChatAction.TYPING)
        reply = await ask_ai(user_id)
        add_message(user_id, "assistant", reply)
        await safe_send(update, reply)
        
    except Exception as e:
        logger.error(f"File handling error: {e}")
        await update.message.reply_text(f"❌ خطأ في معالجة الملف: {str(e)[:100]}")


# ══════════════════════════════════════════════════════════════════════════════
#  معالج الصور
# ══════════════════════════════════════════════════════════════════════════════

async def handle_photo(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    caption = (update.message.caption or "").strip()
    
    await update.message.chat.send_action(ChatAction.TYPING)
    
    try:
        # أكبر حجم للصورة
        photo = update.message.photo[-1]
        file = await context.bot.get_file(photo.file_id)
        
        # تحميل الصورة كـ bytes
        img_bytes = await file.download_as_bytearray()
        import base64
        b64 = base64.b64encode(img_bytes).decode()
        
        question = caption or "صف هذه الصورة بالتفصيل. وإذا كانت تحتوي على كود أو نص، اقرأه وحلّله."
        
        # إرسال الصورة لـ GPT-4 Vision
        messages = get_history(user_id) + [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": question},
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
                ],
            }
        ]
        
        response = await ai.chat.completions.create(
            model=MODEL,
            messages=[{"role": "system", "content": SYSTEM_PROMPT}] + messages,
            max_tokens=2048,
        )
        reply = response.choices[0].message.content or "لم أتمكن من تحليل الصورة."
        
        add_message(user_id, "user", f"[صورة] {question}")
        add_message(user_id, "assistant", reply)
        await safe_send(update, reply)
        
    except Exception as e:
        logger.error(f"Photo handling error: {e}")
        if "vision" in str(e).lower() or "image" in str(e).lower():
            await update.message.reply_text("❌ النموذج الحالي لا يدعم الصور. استخدم `gpt-4o` أو `gpt-4-turbo`.")
        else:
            await update.message.reply_text(f"❌ خطأ في معالجة الصورة: {str(e)[:100]}")


# ══════════════════════════════════════════════════════════════════════════════
#  الدالة الرئيسية
# ══════════════════════════════════════════════════════════════════════════════

def main():
    if not BOT_TOKEN:
        raise SystemExit("❌ BOT_TOKEN مفقود — أضفه في متغيرات Railway")
    if not OPENAI_API_KEY:
        raise SystemExit("❌ OPENAI_API_KEY مفقود — أضفه في متغيرات Railway")
    
    logger.info(f"🤖 تشغيل البوت — النموذج: {MODEL}")
    
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
    
    # أوامر
    app.add_handler(CommandHandler("start",   cmd_start))
    app.add_handler(CommandHandler("help",    cmd_help))
    app.add_handler(CommandHandler("new",     cmd_new))
    app.add_handler(CommandHandler("history", cmd_history))
    app.add_handler(CommandHandler("model",   cmd_model))
    app.add_handler(CommandHandler("run",     cmd_run))
    app.add_handler(CommandHandler("search",  cmd_search))
    
    # رسائل
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text))
    app.add_handler(MessageHandler(filters.Document.ALL, handle_file))
    app.add_handler(MessageHandler(filters.PHOTO, handle_photo))
    
    app.run_polling(
        drop_pending_updates=True,
        read_timeout=45,
        write_timeout=45,
        connect_timeout=45,
        pool_timeout=45,
        allowed_updates=["message", "callback_query"],
    )


if __name__ == "__main__":
    import time as _time
    _delay = 5
    while True:
        try:
            main()
        except SystemExit:
            raise
        except Exception as e:
            err = type(e).__name__
            if "Conflict" in err:
                logger.warning("⚠️ Conflict — انتظار 45 ثانية...")
                _time.sleep(45)
                _delay = 5
                continue
            logger.critical(f"💥 البوت توقف [{err}]: {e}\n{traceback.format_exc()}")
            logger.info(f"🔄 إعادة تشغيل بعد {_delay}ث...")
            _time.sleep(_delay)
            _delay = min(_delay * 2, 30)
        else:
            logger.warning("⚠️ run_polling انتهى — إعادة التشغيل...")
            _time.sleep(3)
            _delay = 5
