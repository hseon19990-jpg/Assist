/**
 * بوت تيليجرام الذكي لتعديل GitHub
 * مثل ريبلت: يقرأ كل الملفات أولاً ثم يخطط ثم ينفذ
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
const HISTORY_LIMIT = 6;

function loadAdmins() {
  try {
    if (fs.existsSync(ADMINS_FILE))
      return new Set([OWNER_ID, ...JSON.parse(fs.readFileSync(ADMINS_FILE, 'utf8'))]);
  } catch (_) {}
  return new Set([OWNER_ID]);
}
function saveAdmins(s) {
  try {
    fs.writeFileSync(ADMINS_FILE, JSON.stringify([...s].filter(id => id !== OWNER_ID)), 'utf8');
  } catch (_) {}
}

const admins = loadAdmins();
const conversationHistory = new Map();

// كاش شجرة الملفات ومحتوياتها
const repoCache = { tree: null, contents: {}, lastFetch: 0 };
const CACHE_TTL = 3 * 60 * 1000; // 3 دقائق

function addToHistory(userId, role, content) {
  if (!conversationHistory.has(userId)) conversationHistory.set(userId, []);
  const h = conversationHistory.get(userId);
  h.push({ role, content: String(content).slice(0, 2000) });
  if (h.length > HISTORY_LIMIT) h.splice(0, h.length - HISTORY_LIMIT);
}
function getHistory(userId) { return conversationHistory.get(userId) || []; }

// ملفات ذات أولوية دائماً
const PRIORITY_PATTERNS = [
  /^package\.json$/,
  /^index\.(js|ts|py|go)$/,
  /^main\.(js|ts|py|go)$/,
  /^app\.(js|ts|py)$/,
  /^bot\.(js|ts|py)$/,
  /^server\.(js|ts|py)$/,
  /^config\.(js|ts|json|py)$/,
  /^\.env\.example$/,
  /^requirements\.txt$/,
  /^Dockerfile$/,
  /^README\.md$/i,
  /^src\/(bot|index|main|app|handler|command)\.(js|ts|py)$/,
];

// ملفات تُتخطى
const SKIP_PATTERNS = [
  /node_modules/,
  /\.git\//,
  /dist\//,
  /build\//,
  /\.min\.(js|css)$/,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /admins\.json$/,
  /\.(png|jpg|jpeg|gif|ico|svg|pdf|zip|tar|gz|woff|ttf|mp3|mp4)$/i,
];

const shouldSkip = f => SKIP_PATTERNS.some(p => p.test(f));
const isPriority = f => PRIORITY_PATTERNS.some(p => p.test(f));

// ============================================================
//  استدعاء الذكاء الاصطناعي مع retry تلقائي
// ============================================================
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callAI(messages, jsonMode = false, retries = 4) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (AI_PROVIDER === 'groq') {
        const body = {
          model: 'llama-3.3-70b-versatile',
          messages,
          temperature: 0.1,
          max_tokens: 8192,
        };
        if (jsonMode) body.response_format = { type: 'json_object' };
        const res = await axios.post(
          'https://api.groq.com/openai/v1/chat/completions',
          body,
          { headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' }, timeout: 90000 }
        );
        return res.data.choices[0].message.content.trim();
      } else {
        const gMsgs = messages
          .filter(m => m.role !== 'system')
          .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
        const sys = messages.find(m => m.role === 'system');
        if (sys && gMsgs.length > 0)
          gMsgs[0].parts[0].text = sys.content + '\n\n' + gMsgs[0].parts[0].text;
        const res = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
          {
            contents: gMsgs,
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 8192,
              ...(jsonMode ? { responseMimeType: 'application/json' } : {}),
            },
          },
          { headers: { 'Content-Type': 'application/json' }, timeout: 90000 }
        );
        return res.data.candidates[0].content.parts[0].text.trim();
      }
    } catch (err) {
      const s = err.response?.status;
      if ((s === 429 || s >= 500) && attempt < retries) {
        const wait = 10000 * Math.pow(2, attempt) + Math.random() * 3000;
        console.log(`Retry ${attempt + 1}/${retries} after ${Math.round(wait / 1000)}s (HTTP ${s})`);
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
}

function parseJSON(raw) {
  const c = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(c);
}

// ============================================================
//  GitHub helpers
// ============================================================

async function getFileTree(force = false) {
  const now = Date.now();
  if (!force && repoCache.tree && (now - repoCache.lastFetch) < CACHE_TTL) return repoCache.tree;
  const url = `https://api.github.com/repos/${FULL_REPO}/git/trees/${GITHUB_BRANCH}?recursive=1`;
  const res = await axios.get(url, { headers: GH_HEADERS });
  repoCache.tree = res.data.tree.filter(f => f.type === 'blob').map(f => f.path);
  repoCache.lastFetch = now;
  return repoCache.tree;
}

async function readFile(filePath, useCache = true) {
  if (useCache && repoCache.contents[filePath] !== undefined) return repoCache.contents[filePath];
  try {
    const url = `https://api.github.com/repos/${FULL_REPO}/contents/${encodeURIComponent(filePath)}?ref=${GITHUB_BRANCH}`;
    const res = await axios.get(url, { headers: GH_HEADERS });
    const result = { content: Buffer.from(res.data.content, 'base64').toString('utf8'), sha: res.data.sha };
    repoCache.contents[filePath] = result;
    return result;
  } catch (e) {
    if (e.response?.status === 404) { repoCache.contents[filePath] = null; return null; }
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
  repoCache.contents[filePath] = { content: String(content), sha: res.data.content?.sha || sha };
  if (!repoCache.tree?.includes(filePath)) repoCache.tree?.push(filePath);
  return res.data.content?.html_url || '';
}

async function deleteFile(filePath, sha, commitMsg) {
  const url = `https://api.github.com/repos/${FULL_REPO}/contents/${encodeURIComponent(filePath)}`;
  await axios.delete(url, {
    headers: GH_HEADERS,
    data: { message: commitMsg || `Delete ${filePath}`, sha, branch: GITHUB_BRANCH },
  });
  delete repoCache.contents[filePath];
  if (repoCache.tree) repoCache.tree = repoCache.tree.filter(f => f !== filePath);
}

/**
 * يقرأ كل ملفات الريبو — مثل ريبلت تماماً
 * ≤ 40 ملف: يقرأ الكل
 * > 40 ملف: يقرأ ذوي الأولوية + أول 20 من الباقي
 */
async function readAllFiles(fileTree) {
  const allUsable = fileTree.filter(f => !shouldSkip(f));
  const priority  = allUsable.filter(isPriority);
  const others    = allUsable.filter(f => !isPriority(f));

  const toRead = allUsable.length <= 40
    ? allUsable
    : [...new Set([...priority, ...others.slice(0, 20)])];

  // قراءة متوازية
  await Promise.all(toRead.map(fp => readFile(fp, true)));

  const sections = toRead.map(fp => {
    const cached = repoCache.contents[fp];
    if (!cached?.content) return null;
    const maxChars = isPriority(fp) ? 6000 : 3000;
    const body = cached.content.length > maxChars
      ? cached.content.slice(0, maxChars) + `\n... [${cached.content.length - maxChars} حرف محذوف]`
      : cached.content;
    return `\n${'─'.repeat(50)}\n📄 ${fp}\n${'─'.repeat(50)}\n${body}`;
  }).filter(Boolean);

  return {
    context: sections.join('\n'),
    readCount: toRead.length,
    totalCount: allUsable.length,
  };
}

// ============================================================
//  التخطيط — استدعاء واحد بكل السياق
// ============================================================

async function planWithFullContext(userMsg, fileTree, repoCtx, history) {
  const sys = `أنت مطور برمجيات محترف تعمل مثل ريبلت Agent. قرأت كل ملفات المشروع وأنت الآن تخطط التعديلات بدقة.

المستودع: ${FULL_REPO} | الفرع: ${GITHUB_BRANCH} | AI: ${AI_PROVIDER.toUpperCase()}

━━━━ محتوى ملفات المستودع (${repoCtx.readCount}/${repoCtx.totalCount} ملف) ━━━━
${repoCtx.context || '[المستودع فارغ — سيتم إنشاء ملفات جديدة]'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

جميع الملفات في المستودع:
${fileTree.join('\n')}

أجب بـ JSON فقط:
{
  "explanation_ar": "اشرح ما ستفعله بوضوح (جملتان)",
  "missing_info": "فقط إذا كان الطلب مستحيل تماماً بدون معلومة لا يمكن تخمينها — وإلا اتركه فارغاً تماماً",
  "operations": [
    {
      "action": "create" | "update" | "delete" | "read" | "list",
      "file_path": "المسار الكامل",
      "commit_message": "وصف واضح بالإنجليزي",
      "detailed_instructions": "تعليمات مفصّلة جداً — كل دالة تُضاف، كل منطق، كل تغيير. هذا هو الوصف الوحيد الذي سيُبنى عليه الكود.",
      "must_preserve": "الأجزاء الأساسية التي تبقى كما هي",
      "must_add": "ما يُضاف تحديداً",
      "must_remove": "ما يُحذف تحديداً"
    }
  ]
}

قواعد ذهبية:
• missing_info: للمستحيل فقط — تصرّف بذكاء في كل الحالات الأخرى
• حافظ على نمط الكود القائم بالضبط: نفس require/import، نفس الأسلوب
• إذا التعديل يؤثر على ملفات أخرى، أضفها كعمليات منفصلة
• detailed_instructions يجب أن يكون وافياً تماماً`;

  const raw = await callAI([
    { role: 'system', content: sys },
    ...history.slice(-4),
    { role: 'user', content: userMsg },
  ], true);

  return parseJSON(raw);
}

// ============================================================
//  توليد الكود الفعلي
// ============================================================

async function generateCode(op, existingContent, userMsg, history) {
  const isCode = /\.(js|ts|jsx|tsx|mjs|cjs|py|go|rs|java|cpp|c|cs|php|rb|swift|kt)$/.test(op.file_path);
  const isJson = op.file_path.endsWith('.json');

  const sysLines = [
    `أنت مطور خبير. اكتب المحتوى الكامل للملف "${op.file_path}" فقط.`,
    `بدون شرح، بدون markdown code fences، بدون أي نص قبله أو بعده.`,
    `الملف الكامل بعد التعديل — ليس جزءاً منه.`,
  ];
  if (isCode) sysLines.push(
    `template literals: استخدم backtick عند \${...} — ليس single/double quote أبداً.`,
    `تحقق من صحة جميع الـ require/import. لا TODO، لا placeholder.`
  );
  if (isJson) sysLines.push(`JSON صحيح فقط — لا تعليقات.`);

  const existingSection = existingContent
    ? `\nالملف الحالي:\n${existingContent.length > 8000 ? existingContent.slice(0, 8000) + '\n...[مقتطع]' : existingContent}`
    : '\n[ملف جديد]';

  const prompt =
    `الطلب: ${userMsg}\n` +
    `الملف: ${op.file_path}\n` +
    `التعليمات:\n${op.detailed_instructions}\n` +
    (op.must_preserve ? `\nيجب الحفاظ على:\n${op.must_preserve}` : '') +
    (op.must_add      ? `\nيجب إضافة:\n${op.must_add}`           : '') +
    (op.must_remove   ? `\nيجب حذف:\n${op.must_remove}`          : '') +
    existingSection +
    `\n\nاكتب الملف الكامل الآن:`;

  let result = await callAI([
    { role: 'system', content: sysLines.join('\n') },
    ...history.slice(-3),
    { role: 'user', content: prompt },
  ], false);

  result = result.replace(/^```[\w]*\n?/gm, '').replace(/^```$/gm, '').trim();

  if (isCode) {
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
    try { return await ctx.reply(text.slice(0, 4096)); } catch (__) {}
  }
}

async function safeEdit(ctx, msgId, text) {
  try {
    return await ctx.telegram.editMessageText(ctx.chat.id, msgId, null, text,
      { parse_mode: 'Markdown', disable_web_page_preview: true });
  } catch (_) {
    try { return await ctx.telegram.editMessageText(ctx.chat.id, msgId, null, text.slice(0, 4096)); }
    catch (__) {}
  }
}

// ============================================================
//  البوت
// ============================================================

const bot = new Telegraf(BOT_TOKEN);
const processingUsers = new Set();

bot.use(async (ctx, next) => {
  if (!admins.has(ctx.from?.id)) return ctx.reply('🚫 هذا البوت خاص.');
  return next();
});

bot.start(ctx => safeSend(ctx,
  `مرحباً! أنا مساعدك الذكي لإدارة مستودع GitHub 🤖\n\n` +
  `*المستودع:* \`${FULL_REPO}\`\n` +
  `*الفرع:* \`${GITHUB_BRANCH}\`\n` +
  `*AI:* \`${AI_PROVIDER.toUpperCase()}\`\n\n` +
  `أقرأ *كل ملفات المشروع* قبل أي تعديل — مثل ريبلت تماماً ✅\n\n` +
  `أرسل طلبك بأي صيغة:\n` +
  `📝 أضف أمر /stats للبوت\n` +
  `✏️ عدّل bot.js وأضف inline keyboard\n` +
  `🗑️ احذف ملف old.js\n` +
  `📋 اعرض كل الملفات\n` +
  `👁️ /read src/bot.js`
));

bot.help(ctx => safeSend(ctx,
  `*الأوامر المتاحة:*\n\n` +
  `*/start* — رسالة الترحيب\n` +
  `*/repo* — معلومات المستودع\n` +
  `*/files* — عرض كل الملفات\n` +
  `*/read [مسار]* — قراءة ملف مباشرة\n` +
  `*/refresh* — إعادة تحميل كاش الملفات\n` +
  `*/clear* — مسح سياق المحادثة\n` +
  `*/admin [ID]* — إضافة مسؤول\n` +
  `*/removeadmin [ID]* — إزالة مسؤول`
));

bot.command('repo', async ctx => {
  try {
    const res = await axios.get(`https://api.github.com/repos/${FULL_REPO}`, { headers: GH_HEADERS });
    const d = res.data;
    await safeSend(ctx,
      `*📁 ${d.full_name}*\n` +
      `🌿 \`${GITHUB_BRANCH}\` | 🔒 ${d.private ? 'خاص' : 'عام'} | ⭐ ${d.stargazers_count}\n` +
      `📝 ${d.description || 'لا يوجد وصف'}\n` +
      `🔤 ${d.language || 'متعددة'} | 🤖 ${AI_PROVIDER.toUpperCase()}`
    );
  } catch (e) { ctx.reply(`❌ ${e.message}`); }
});

bot.command('files', async ctx => {
  try {
    const tree = await getFileTree();
    const usable = tree.filter(f => !shouldSkip(f));
    await safeSend(ctx,
      `*📋 ملفات المستودع (${usable.length} / ${tree.length} إجمالي):*\n\n` +
      usable.slice(0, 80).map(f => `📄 \`${f}\``).join('\n') +
      (usable.length > 80 ? `\n\n_...و ${usable.length - 80} آخر_` : '')
    );
  } catch (e) { ctx.reply(`❌ ${e.message}`); }
});

bot.command('read', async ctx => {
  const fp = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (!fp) return ctx.reply('مثال: /read src/bot.js');
  try {
    const file = await readFile(fp, false);
    if (!file) return ctx.reply(`❌ الملف \`${fp}\` غير موجود`);
    const preview = file.content.length > 3500 ? file.content.slice(0, 3500) + '\n_...مقتطع_' : file.content;
    const msg = `*📄 ${fp}:*\n\`\`\`\n${preview}\n\`\`\``;
    if (msg.length > 4000) {
      await ctx.reply(`📄 محتوى \`${fp}\`:`);
      for (const chunk of splitMessage(msg)) await safeSend(ctx, chunk);
    } else await safeSend(ctx, msg);
  } catch (e) { ctx.reply(`❌ ${e.message}`); }
});

bot.command('refresh', async ctx => {
  repoCache.tree = null;
  repoCache.contents = {};
  repoCache.lastFetch = 0;
  ctx.reply('🔄 تم مسح الكاش — سيُعاد تحميل الملفات في الطلب التالي.');
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
  ctx.reply(`✅ تم إضافة ${id}.`);
});

bot.command('removeadmin', async ctx => {
  if (ctx.from?.id !== OWNER_ID) return ctx.reply('🚫 فقط المالك.');
  const id = parseInt(ctx.message.text.split(' ')[1]);
  if (!id || id === OWNER_ID) return ctx.reply('أدخل معرف صالح (لا يمكن إزالة المالك).');
  admins.delete(id); saveAdmins(admins);
  ctx.reply(`✅ تمت إزالة ${id}.`);
});

// ============================================================
//  المعالج الرئيسي — قراءة كل الملفات ثم التخطيط ثم التنفيذ
// ============================================================

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
    statusMsg = await ctx.reply('📂 جاري قراءة المشروع كاملاً...');

    // ── 1: جلب شجرة الملفات ────────────────────────────────
    let fileTree = [];
    try { fileTree = await getFileTree(); } catch (_) {}

    const readableCount = fileTree.filter(f => !shouldSkip(f)).length;
    await safeEdit(ctx, statusMsg.message_id,
      `📖 جاري قراءة ${readableCount} ملف...\n_مثل ريبلت — فهم كامل قبل أي تعديل_`
    );

    // ── 2: قراءة كل الملفات المهمة دفعة واحدة ─────────────
    const repoCtx = await readAllFiles(fileTree);

    await safeEdit(ctx, statusMsg.message_id,
      `✅ تمت قراءة ${repoCtx.readCount}/${repoCtx.totalCount} ملف\n🧠 جاري التحليل والتخطيط...`
    );

    const history = getHistory(userId);

    // ── 3: التخطيط الكامل ──────────────────────────────────
    let plan;
    try {
      plan = await planWithFullContext(userMsg, fileTree, repoCtx, history);
    } catch (err) {
      if (err.response?.status === 429) {
        await safeEdit(ctx, statusMsg.message_id,
          '⏳ تجاوز حد الطلبات بعد عدة محاولات. انتظر دقيقة ثم أعد المحاولة.'
        );
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
      await safeEdit(ctx, statusMsg.message_id, '🤔 لم أفهم الطلب. حاول بصياغة أوضح.');
      return;
    }

    // عرض الخطة
    const icons = { create: '🆕', update: '✏️', delete: '🗑️', read: '📖', list: '📋' };
    const opsList = ops.map(o => `${icons[o.action] || '⚙️'} \`${o.file_path}\``).join('\n');
    await safeEdit(ctx, statusMsg.message_id,
      `📋 *الخطة:* ${plan.explanation_ar}\n\n${opsList}\n\n⏳ جاري التنفيذ...`
    );

    // ── 4: التنفيذ ──────────────────────────────────────────
    const results = [];

    for (const op of ops) {
      try {
        if (op.action === 'list') {
          const filtered = op.file_path
            ? fileTree.filter(f => f.startsWith(op.file_path))
            : fileTree.filter(f => !shouldSkip(f));
          results.push(
            `*📋 الملفات (${filtered.length}):*\n` +
            filtered.slice(0, 60).map(f => `📄 \`${f}\``).join('\n') +
            (filtered.length > 60 ? `\n_...و ${filtered.length - 60} أخرى_` : '')
          );

        } else if (op.action === 'read') {
          const f = await readFile(op.file_path);
          if (!f) { results.push(`❌ \`${op.file_path}\` غير موجود`); continue; }
          const preview = f.content.length > 2500 ? f.content.slice(0, 2500) + '\n_...مقتطع_' : f.content;
          results.push(`*📄 ${op.file_path}:*\n\`\`\`\n${preview}\n\`\`\``);

        } else if (op.action === 'delete') {
          const f = await readFile(op.file_path, false);
          if (!f) { results.push(`❌ \`${op.file_path}\` غير موجود`); continue; }
          await deleteFile(op.file_path, f.sha, op.commit_message);
          results.push(`🗑️ تم حذف \`${op.file_path}\` ✅`);

        } else if (op.action === 'create' || op.action === 'update') {
          // جلب sha المحدث دائماً قبل الكتابة لتفادي 409
          const fresh = await readFile(op.file_path, false);
          const existingContent = fresh?.content || null;
          const sha = fresh?.sha || null;

          const content = await generateCode(op, existingContent, userMsg, history);

          if (!content?.trim()) {
            results.push(`❌ فشل توليد محتوى \`${op.file_path}\`. أعد المحاولة.`);
            continue;
          }

          const url = await writeFile(op.file_path, content, op.commit_message, sha);
          results.push(
            `✅ ${existingContent ? 'تم تعديل' : 'تم إنشاء'} \`${op.file_path}\`\n` +
            `💬 \`${op.commit_message}\`\n` +
            (url ? `🔗 [GitHub](${url})` : '')
          );
        }
      } catch (opErr) {
        results.push(`❌ خطأ في \`${op.file_path || 'العملية'}\`: ${opErr.response?.data?.message || opErr.message}`);
      }
    }

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
    console.error('Bot error:', err.response?.data || err.message);
    const isRate = err.response?.status === 429;
    const msg = isRate
      ? '⏳ تجاوز حد الطلبات. انتظر دقيقة ثم أعد.'
      : `❌ خطأ:\n\`${err.response?.data?.message || err.message}\``;
    if (statusMsg) await safeEdit(ctx, statusMsg.message_id, msg).catch(() => {});
    else await ctx.reply(msg);
  } finally {
    processingUsers.delete(userId);
  }
});

module.exports = bot;
