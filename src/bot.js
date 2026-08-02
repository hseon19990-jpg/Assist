/**
 * بوت تيليجرام الذكي لتعديل GitHub
 * نظام ثنائي المراحل: تخطيط ذكي → توليد كود
 * مع retry تلقائي عند rate limit
 */

const { Telegraf } = require('telegraf');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ============================================================
//  إعدادات البيئة
// ============================================================
const BOT_TOKEN     = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_ID      = parseInt(process.env.TELEGRAM_OWNER_ID || '0');
const GROQ_KEY      = process.env.GROQ_API_KEY;
const GEMINI_KEY    = process.env.GEMINI_API_KEY;
const GITHUB_TOKEN  = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
const GITHUB_OWNER  = process.env.GITHUB_OWNER;
const GITHUB_REPO   = process.env.GITHUB_REPO;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

if (!BOT_TOKEN)               throw new Error('TELEGRAM_BOT_TOKEN غير موجود');
if (!GROQ_KEY && !GEMINI_KEY) throw new Error('يجب توفير GROQ_API_KEY أو GEMINI_API_KEY');

const AI_PROVIDER = GROQ_KEY ? 'groq' : 'gemini';
const FULL_REPO   = `${GITHUB_OWNER}/${GITHUB_REPO}`;
const GH_HEADERS  = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

// ============================================================
//  تخزين المسؤولين والسياق
// ============================================================
const ADMINS_FILE   = path.join(__dirname, '..', 'admins.json');
const HISTORY_LIMIT = 8;

function loadAdmins() {
  try {
    if (fs.existsSync(ADMINS_FILE))
      return new Set([OWNER_ID, ...JSON.parse(fs.readFileSync(ADMINS_FILE, 'utf8'))]);
  } catch (_) {}
  return new Set([OWNER_ID]);
}
function saveAdmins(s) {
  try { fs.writeFileSync(ADMINS_FILE, JSON.stringify([...s].filter(id => id !== OWNER_ID)), 'utf8'); }
  catch (_) {}
}

const admins = loadAdmins();
const conversationHistory = new Map();

function addToHistory(userId, role, content) {
  if (!conversationHistory.has(userId)) conversationHistory.set(userId, []);
  const h = conversationHistory.get(userId);
  h.push({ role, content: String(content).slice(0, 2500) });
  if (h.length > HISTORY_LIMIT) h.splice(0, h.length - HISTORY_LIMIT);
}
function getHistory(userId) { return conversationHistory.get(userId) || []; }

// ============================================================
//  استدعاء الذكاء الاصطناعي مع retry تلقائي
// ============================================================

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function callAI(messages, jsonMode = false, retries = 4) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (AI_PROVIDER === 'groq') {
        const body = {
          model: 'llama-3.3-70b-versatile',
          messages,
          temperature: 0.15,
          max_tokens: 8192,
        };
        if (jsonMode) body.response_format = { type: 'json_object' };
        const res = await axios.post(
          'https://api.groq.com/openai/v1/chat/completions',
          body,
          { headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' }, timeout: 60000 }
        );
        return res.data.choices[0].message.content.trim();

      } else {
        const geminiMsgs = messages
          .filter(m => m.role !== 'system')
          .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
        const sys = messages.find(m => m.role === 'system');
        if (sys && geminiMsgs.length > 0)
          geminiMsgs[0].parts[0].text = sys.content + '\n\n' + geminiMsgs[0].parts[0].text;

        const res = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
          {
            contents: geminiMsgs,
            generationConfig: {
              temperature: 0.15,
              maxOutputTokens: 8192,
              ...(jsonMode ? { responseMimeType: 'application/json' } : {}),
            },
          },
          { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
        );
        return res.data.candidates[0].content.parts[0].text.trim();
      }

    } catch (err) {
      const status = err.response?.status;
      const isRateLimit = status === 429;
      const isServerErr = status >= 500;

      if ((isRateLimit || isServerErr) && attempt < retries) {
        // انتظار أسّي: 8s, 16s, 32s, 64s
        const wait = (8000 * Math.pow(2, attempt)) + Math.random() * 2000;
        console.log(`Rate limit / server error (${status}). Retry ${attempt + 1}/${retries} after ${Math.round(wait/1000)}s`);
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
}

function parseJSON(raw) {
  const clean = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(clean);
}

// ============================================================
//  GitHub helpers
// ============================================================

async function getFileTree() {
  const url = `https://api.github.com/repos/${FULL_REPO}/git/trees/${GITHUB_BRANCH}?recursive=1`;
  const res = await axios.get(url, { headers: GH_HEADERS });
  return res.data.tree.filter(f => f.type === 'blob').map(f => f.path);
}

async function readFile(filePath) {
  try {
    const url = `https://api.github.com/repos/${FULL_REPO}/contents/${encodeURIComponent(filePath)}?ref=${GITHUB_BRANCH}`;
    const res = await axios.get(url, { headers: GH_HEADERS });
    return { content: Buffer.from(res.data.content, 'base64').toString('utf8'), sha: res.data.sha };
  } catch (e) {
    if (e.response?.status === 404) return null;
    throw e;
  }
}

async function writeFile(filePath, content, commitMsg, sha) {
  const url = `https://api.github.com/repos/${FULL_REPO}/contents/${encodeURIComponent(filePath)}`;
  const payload = {
    message: commitMsg || `Update ${filePath} via AI bot`,
    content: Buffer.from(String(content)).toString('base64'),
    branch: GITHUB_BRANCH,
  };
  if (sha) payload.sha = sha;
  const res = await axios.put(url, payload, { headers: GH_HEADERS });
  return res.data.content?.html_url || '';
}

async function deleteFile(filePath, sha, commitMsg) {
  const url = `https://api.github.com/repos/${FULL_REPO}/contents/${encodeURIComponent(filePath)}`;
  await axios.delete(url, {
    headers: GH_HEADERS,
    data: { message: commitMsg || `Delete ${filePath}`, sha, branch: GITHUB_BRANCH },
  });
}

async function readMultipleFiles(paths) {
  const result = {};
  await Promise.all(paths.map(async fp => {
    const f = await readFile(fp);
    result[fp] = f ? f.content : null;
  }));
  return result;
}

// ============================================================
//  المرحلة الأولى: تخطيط ذكي (تحليل + قراءة + خطة في استدعاء واحد)
// ============================================================

async function phase1_planWithContext(userMsg, fileTree, history) {
  // أولاً: نحدد الملفات المطلوبة بسرعة
  const quickScan = await callAI([
    {
      role: 'system',
      content: `أنت محلل كود. حدد الملفات المطلوبة للقراءة قبل التعديل.
المستودع: ${FULL_REPO}
الملفات الموجودة:
${fileTree.join('\n')}

أجب بـ JSON فقط:
{
  "task": "list" | "read" | "write" | "delete" | "unclear",
  "target_files": ["الملفات التي يجب قراءتها — كل ملف سيُعدَّل حتماً موجود هنا"],
  "is_simple": true | false
}`
    },
    ...history.slice(-4),
    { role: 'user', content: userMsg }
  ], true);

  let scan;
  try { scan = parseJSON(quickScan); }
  catch (_) { scan = { task: 'write', target_files: [], is_simple: false }; }

  // قراءة الملفات المحددة
  const validPaths = (scan.target_files || []).filter(f => fileTree.includes(f));
  const fileContents = validPaths.length > 0 ? await readMultipleFiles(validPaths) : {};

  const fileContext = Object.entries(fileContents)
    .filter(([, c]) => c !== null)
    .map(([fp, c]) => `\n=== ${fp} ===\n${c.length > 5000 ? c.slice(0, 5000) + '\n...[مقتطع]' : c}`)
    .join('\n');

  // الآن: بناء الخطة الكاملة مع كل السياق
  const systemPrompt = `أنت مطور برمجيات محترف خبير تعمل مثل ريبلت AI. لديك وعي كامل بالمشروع.

المستودع: ${FULL_REPO} | الفرع: ${GITHUB_BRANCH}
الذكاء الاصطناعي: ${AI_PROVIDER.toUpperCase()}

--- محتوى الملفات الحالية ---
${fileContext || 'لا توجد ملفات مقروءة بعد — الملفات المطلوبة جديدة'}
---

كل ملفات المستودع:
${fileTree.join('\n')}

مهمتك: بناء خطة تنفيذية دقيقة وشاملة.

أجب بـ JSON فقط (لا تضف أي نص خارجه):
{
  "explanation_ar": "اشرح ما ستفعله بالعربي بجملتين",
  "missing_info": "اكتب هنا فقط إذا كان الطلب مستحيل التنفيذ بدون معلومة معينة لا يمكن تخمينها — في كل الحالات الأخرى اترك فارغاً وخمّن بذكاء",
  "operations": [
    {
      "action": "create" | "update" | "delete" | "read" | "list",
      "file_path": "مسار الملف",
      "commit_message": "رسالة commit واضحة بالإنجليزي",
      "detailed_instructions": "تعليمات مفصّلة جداً لما يجب كتابته في هذا الملف — اذكر كل دالة، كل تغيير، كل إضافة بالتفصيل الدقيق. هذا الوصف هو ما سيُبنى عليه الكود كاملاً.",
      "must_preserve": "الأجزاء التي يجب الحفاظ عليها من الملف الحالي كما هي",
      "must_add": "ما يجب إضافته بالتفصيل",
      "must_remove": "ما يجب حذفه"
    }
  ]
}

قواعد مهمة جداً:
- missing_info يُملأ فقط عند الضرورة القصوى — لا تطلب توضيحاً إذا يمكنك التخمين المنطقي
- اذكر في detailed_instructions كل تفصيلة: أسماء الدوال، المنطق، المتغيرات
- حافظ على نمط الكود الموجود بالضبط (نفس style، نفس require/import)
- إذا احتاج الطلب تغيير package.json، أضف عملية منفصلة له`;

  const raw = await callAI([
    { role: 'system', content: systemPrompt },
    ...history.slice(-4),
    { role: 'user', content: userMsg }
  ], true);

  return { plan: parseJSON(raw), fileContents };
}

// ============================================================
//  المرحلة الثانية: توليد الكود الفعلي
// ============================================================

async function phase2_generate(op, existingContent, userMsg, history) {
  const isCode = /\.(js|ts|jsx|tsx|mjs|cjs|py|go|rs|java|cpp|c|cs|php|rb|swift|kt)$/.test(op.file_path);
  const isJson = op.file_path.endsWith('.json');

  const sysLines = [
    `أنت مطور خبير. اكتب المحتوى الكامل للملف "${op.file_path}" فقط.`,
    `لا تضع أي شرح أو markdown code fences — المحتوى الخام فقط.`,
    `الملف الكامل بعد التعديل، لا جزء منه.`,
  ];

  if (isCode) {
    sysLines.push(
      `للـ template literals: استخدم backtick (\`) عند وجود \${...} — ليس single/double quote أبداً.`,
      `تأكد من صحة جميع الـ require/import.`,
      `لا تترك TODO أو placeholder — كود حقيقي كامل.`
    );
  }
  if (isJson) sysLines.push(`JSON صحيح قابل للتحقق فقط — لا تعليقات.`);

  const ctx = existingContent
    ? `\nالملف الحالي:\n${existingContent.length > 6000 ? existingContent.slice(0, 6000) + '\n...[مقتطع]' : existingContent}`
    : '';

  const userPrompt =
    `الطلب الأصلي: ${userMsg}\n` +
    `التعليمات التفصيلية: ${op.detailed_instructions}\n` +
    (op.must_preserve ? `يجب الحفاظ على: ${op.must_preserve}\n` : '') +
    (op.must_add ? `يجب إضافته: ${op.must_add}\n` : '') +
    (op.must_remove ? `يجب حذفه: ${op.must_remove}\n` : '') +
    ctx +
    `\n\nاكتب الملف الكامل الآن:`;

  const messages = [
    { role: 'system', content: sysLines.join('\n') },
    ...history.slice(-3),
    { role: 'user', content: userPrompt },
  ];

  let result = await callAI(messages, false);
  result = result.replace(/^```[\w]*\n?/gm, '').replace(/^```$/gm, '').trim();

  if (isCode) {
    // تصحيح template literals
    result = result.replace(
      /(['"])((?:[^'"\\]|\\.)*?\$\{(?:[^}]|\{[^}]*\})*\}(?:[^'"\\]|\\.)*?)\1/g,
      (_, __, inner) => `\`${inner}\``
    );
  }

  return result;
}

// ============================================================
//  مساعدات الإرسال
// ============================================================

function splitMessage(text, limit = 4000) {
  const chunks = [];
  const lines = text.split('\n');
  let current = '';
  for (const line of lines) {
    if ((current + '\n' + line).length > limit) {
      if (current) chunks.push(current.trim());
      current = line;
    } else {
      current = current ? current + '\n' + line : line;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

async function safeSend(ctx, text, extra = {}) {
  try {
    return await ctx.reply(text, { parse_mode: 'Markdown', disable_web_page_preview: true, ...extra });
  } catch (_) {
    return await ctx.reply(text, { disable_web_page_preview: true });
  }
}

async function safeEdit(ctx, messageId, text) {
  try {
    return await ctx.telegram.editMessageText(ctx.chat.id, messageId, null, text,
      { parse_mode: 'Markdown', disable_web_page_preview: true });
  } catch (_) {
    try { return await ctx.telegram.editMessageText(ctx.chat.id, messageId, null, text); } catch (__) {}
  }
}

// ============================================================
//  البوت
// ============================================================

const bot = new Telegraf(BOT_TOKEN);

bot.use(async (ctx, next) => {
  if (!admins.has(ctx.from?.id)) return ctx.reply('🚫 هذا البوت خاص.');
  return next();
});

bot.start(ctx => safeSend(ctx,
  `مرحباً! أنا مساعدك الذكي لإدارة مستودع GitHub 🤖\n\n` +
  `*المستودع:* \`${FULL_REPO}\`\n` +
  `*الفرع:* \`${GITHUB_BRANCH}\`\n` +
  `*AI:* \`${AI_PROVIDER.toUpperCase()}\`\n\n` +
  `أرسل طلبك بأي صيغة:\n\n` +
  `📝 أضف نظام تسجيل دخول بـ JWT\n` +
  `✏️ عدّل bot.js وأضف أمر /stats\n` +
  `👁️ اقرأ ملف index.js\n` +
  `📋 اعرض كل الملفات\n` +
  `🗑️ احذف ملف old.js\n\n` +
  `أقرأ المشروع كاملاً قبل أي تعديل ✅`
));

bot.help(ctx => safeSend(ctx,
  `*دليل الاستخدام:*\n\n` +
  `أرسل طلبك بالعربي أو الإنجليزي.\n\n` +
  `*/start* — رسالة الترحيب\n` +
  `*/repo* — معلومات المستودع\n` +
  `*/files* — عرض كل الملفات\n` +
  `*/read [مسار]* — قراءة ملف\n` +
  `*/clear* — مسح سياق المحادثة\n` +
  `*/admin [ID]* — إضافة مسؤول\n` +
  `*/removeadmin [ID]* — إزالة مسؤول`
));

bot.command('repo', async ctx => {
  try {
    const res = await axios.get(`https://api.github.com/repos/${FULL_REPO}`, { headers: GH_HEADERS });
    const d = res.data;
    await safeSend(ctx,
      `*📁 ${d.full_name}*\n\n` +
      `🌿 الفرع: \`${GITHUB_BRANCH}\`\n` +
      `📝 ${d.description || 'لا يوجد وصف'}\n` +
      `🔒 ${d.private ? 'خاص' : 'عام'} | ⭐ ${d.stargazers_count}\n` +
      `🔤 ${d.language || 'متعددة'} | 🤖 ${AI_PROVIDER.toUpperCase()}`
    );
  } catch (e) { ctx.reply(`❌ ${e.message}`); }
});

bot.command('files', async ctx => {
  try {
    const tree = await getFileTree();
    const display = tree.slice(0, 80).map(f => `📄 \`${f}\``).join('\n');
    await safeSend(ctx,
      `*📋 ملفات المستودع (${tree.length}):*\n\n${display}` +
      (tree.length > 80 ? `\n\n_...و ${tree.length - 80} ملف آخر_` : '')
    );
  } catch (e) { ctx.reply(`❌ ${e.message}`); }
});

bot.command('read', async ctx => {
  const fp = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (!fp) return ctx.reply('مثال: /read src/bot.js');
  try {
    const file = await readFile(fp);
    if (!file) return ctx.reply(`❌ الملف \`${fp}\` غير موجود`);
    const preview = file.content.length > 3500 ? file.content.slice(0, 3500) + '\n_...مقتطع_' : file.content;
    const msg = `*📄 ${fp}:*\n\`\`\`\n${preview}\n\`\`\``;
    if (msg.length > 4000) {
      await ctx.reply(`📄 محتوى \`${fp}\`:`);
      for (const chunk of splitMessage(msg)) await safeSend(ctx, chunk);
    } else {
      await safeSend(ctx, msg);
    }
  } catch (e) { ctx.reply(`❌ ${e.message}`); }
});

bot.command('clear', async ctx => {
  conversationHistory.delete(ctx.from?.id);
  ctx.reply('🧹 تم مسح سياق المحادثة.');
});

bot.command('admin', async ctx => {
  if (ctx.from?.id !== OWNER_ID) return ctx.reply('🚫 فقط المالك.');
  const id = parseInt(ctx.message.text.split(' ')[1]);
  if (!id) return ctx.reply('مثال: /admin 123456789');
  if (admins.has(id)) return ctx.reply('ℹ️ مسؤول بالفعل.');
  admins.add(id); saveAdmins(admins);
  ctx.reply(`✅ تم إضافة ${id} مسؤولاً.`);
});

bot.command('removeadmin', async ctx => {
  if (ctx.from?.id !== OWNER_ID) return ctx.reply('🚫 فقط المالك.');
  const id = parseInt(ctx.message.text.split(' ')[1]);
  if (!id || id === OWNER_ID) return ctx.reply('أدخل معرف صالح (لا يمكن إزالة المالك).');
  admins.delete(id); saveAdmins(admins);
  ctx.reply(`✅ تمت إزالة ${id}.`);
});

// ============================================================
//  المعالج الرئيسي
// ============================================================

// منع تشغيل طلبين في نفس الوقت لنفس المستخدم (يحمي من rate limit)
const processingUsers = new Set();

bot.on('text', async ctx => {
  const userMsg = ctx.message.text;
  if (userMsg.startsWith('/')) return;

  const userId = ctx.from?.id;

  if (processingUsers.has(userId)) {
    return ctx.reply('⏳ جاري معالجة طلبك السابق، انتظر قليلاً...');
  }

  processingUsers.add(userId);
  let statusMsg;

  try {
    statusMsg = await ctx.reply('🔍 جاري قراءة المشروع...');

    let fileTree = [];
    try { fileTree = await getFileTree(); } catch (_) {}

    const history = getHistory(userId);

    // ─── معالجة سريعة للطلبات البسيطة ────────────────────
    const lower = userMsg.toLowerCase();
    if (/^(اعرض|عرض|list|ls|show).*(ملف|file|folder|مجلد)?/.test(lower) && lower.length < 30) {
      const display = fileTree.slice(0, 80).map(f => `📄 \`${f}\``).join('\n');
      await safeEdit(ctx, statusMsg.message_id,
        `*📋 ملفات المستودع (${fileTree.length}):*\n\n${display}` +
        (fileTree.length > 80 ? `\n\n_...و ${fileTree.length - 80} أخرى_` : '')
      );
      addToHistory(userId, 'user', userMsg);
      return;
    }

    // ─── المرحلة الأولى: تخطيط ذكي ──────────────────────
    await safeEdit(ctx, statusMsg.message_id, '🧠 جاري التخطيط وقراءة السياق...');

    let plan, fileContents;
    try {
      ({ plan, fileContents } = await phase1_planWithContext(userMsg, fileTree, history));
    } catch (err) {
      if (err.response?.status === 429) {
        await safeEdit(ctx, statusMsg.message_id,
          '⏳ تم تجاوز حد الطلبات بعد عدة محاولات. انتظر دقيقة ثم أعد المحاولة.');
        return;
      }
      throw err;
    }

    if (plan.missing_info?.trim()) {
      await safeEdit(ctx, statusMsg.message_id, `⚠️ *أحتاج توضيحاً:*\n\n${plan.missing_info}`);
      addToHistory(userId, 'user', userMsg);
      addToHistory(userId, 'assistant', plan.missing_info);
      return;
    }

    const ops = plan.operations || [];
    if (!ops.length) {
      await safeEdit(ctx, statusMsg.message_id, '🤔 لم أتمكن من فهم الطلب. حاول بصياغة أوضح.');
      return;
    }

    // عرض ملخص الخطة
    const opsSummary = ops.map(o => {
      const icon = { create: '🆕', update: '✏️', delete: '🗑️', read: '📖', list: '📋' }[o.action] || '⚙️';
      return `${icon} \`${o.file_path}\``;
    }).join('\n');
    await safeEdit(ctx, statusMsg.message_id,
      `📋 *الخطة:* ${plan.explanation_ar}\n\n${opsSummary}\n\n⏳ جاري التنفيذ...`
    );

    // ─── المرحلة الثانية: التنفيذ ─────────────────────────
    const results = [];

    for (const op of ops) {
      try {
        if (op.action === 'list') {
          const filtered = op.file_path
            ? fileTree.filter(f => f.startsWith(op.file_path))
            : fileTree;
          results.push(
            `*📋 الملفات (${filtered.length}):*\n` +
            filtered.slice(0, 60).map(f => `📄 \`${f}\``).join('\n') +
            (filtered.length > 60 ? `\n_...و ${filtered.length - 60} أخرى_` : '')
          );

        } else if (op.action === 'read') {
          const file = await readFile(op.file_path);
          if (!file) {
            results.push(`❌ الملف \`${op.file_path}\` غير موجود`);
          } else {
            const preview = file.content.length > 2500
              ? file.content.slice(0, 2500) + '\n_...مقتطع_' : file.content;
            results.push(`*📄 ${op.file_path}:*\n\`\`\`\n${preview}\n\`\`\``);
          }

        } else if (op.action === 'delete') {
          const file = await readFile(op.file_path);
          if (!file) {
            results.push(`❌ الملف \`${op.file_path}\` غير موجود`);
          } else {
            await deleteFile(op.file_path, file.sha, op.commit_message);
            results.push(`🗑️ تم حذف \`${op.file_path}\` ✅`);
          }

        } else if (op.action === 'create' || op.action === 'update') {
          // استخدم المحتوى المقروء مسبقاً أو اقرأ من جديد
          let existingContent = fileContents[op.file_path] || null;
          let sha = null;

          if (!existingContent) {
            const fresh = await readFile(op.file_path);
            if (fresh) { existingContent = fresh.content; sha = fresh.sha; }
          } else {
            // جلب sha المحدث
            const fresh = await readFile(op.file_path);
            sha = fresh?.sha || null;
          }

          const content = await phase2_generate(op, existingContent, userMsg, history);

          if (!content || content.trim() === '') {
            results.push(`❌ فشل توليد محتوى \`${op.file_path}\`. أعد المحاولة.`);
            continue;
          }

          const url = await writeFile(op.file_path, content, op.commit_message, sha);
          const verb = existingContent ? 'تعديل' : 'إنشاء';
          results.push(
            `✅ تم ${verb} \`${op.file_path}\`\n` +
            `💬 \`${op.commit_message}\`\n` +
            (url ? `🔗 [GitHub](${url})` : '')
          );
        }
      } catch (opErr) {
        const msg = opErr.response?.data?.message || opErr.message;
        results.push(`❌ خطأ في \`${op.file_path || 'العملية'}\`: ${msg}`);
      }
    }

    // حفظ في السياق
    addToHistory(userId, 'user', userMsg);
    addToHistory(userId, 'assistant',
      `نفّذت: ${plan.explanation_ar} | الملفات: ${ops.map(o => o.file_path).join(', ')}`
    );

    const finalText = results.join('\n\n---\n\n');
    if (finalText.length > 4000) {
      await safeEdit(ctx, statusMsg.message_id, '✅ اكتملت العمليات:');
      for (const chunk of splitMessage(finalText)) await safeSend(ctx, chunk);
    } else {
      await safeEdit(ctx, statusMsg.message_id, finalText);
    }

  } catch (err) {
    console.error('Error:', err.response?.data || err.message);
    const isRate = err.response?.status === 429;
    const msg = isRate
      ? '⏳ تجاوز حد الطلبات. انتظر دقيقة ثم أعد المحاولة.'
      : `❌ خطأ:\n\`${err.response?.data?.message || err.message}\``;
    if (statusMsg) await safeEdit(ctx, statusMsg.message_id, msg).catch(() => {});
    else await ctx.reply(msg);
  } finally {
    processingUsers.delete(userId);
  }
});

module.exports = bot;
