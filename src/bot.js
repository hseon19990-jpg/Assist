/**
 * بوت تيليجرام — شخصية ريبلت Agent بنسبة 100%
 * يفكر بصوت عالٍ، يشرح قراراته، يلاحظ المشاكل، ويعطي خطوات واضحة
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
const HISTORY_LIMIT = 14;

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
const repoCache = { tree: null, contents: {}, lastFetch: 0 };
const CACHE_TTL = 3 * 60 * 1000;

function addToHistory(uid, role, content) {
  if (!conversationHistory.has(uid)) conversationHistory.set(uid, []);
  const h = conversationHistory.get(uid);
  h.push({ role, content: String(content).slice(0, 2500) });
  if (h.length > HISTORY_LIMIT) h.splice(0, h.length - HISTORY_LIMIT);
}
function getHistory(uid) { return conversationHistory.get(uid) || []; }

// أنماط الأولوية والتخطي
const PRIORITY_RE = [
  /^package\.json$/, /^index\.(js|ts|py|go)$/, /^main\.(js|ts|py|go)$/,
  /^app\.(js|ts|py)$/, /^bot\.(js|ts|py)$/, /^server\.(js|ts|py)$/,
  /^config\.(js|ts|json|py)$/, /^\.env\.example$/, /^requirements\.txt$/,
  /^Dockerfile$/, /^README\.md$/i,
  /^src\/(bot|index|main|app|handler|command|commands)\.(js|ts|py)$/,
];
const SKIP_RE = [
  /node_modules/, /\.git\//, /dist\//, /build\//, /\.min\.(js|css)$/,
  /package-lock\.json$/, /yarn\.lock$/, /pnpm-lock\.yaml$/, /admins\.json$/,
  /\.(png|jpg|jpeg|gif|ico|svg|pdf|zip|tar|gz|woff|ttf|mp3|mp4)$/i,
];
const shouldSkip = f => SKIP_RE.some(p => p.test(f));
const isPriority = f => PRIORITY_RE.some(p => p.test(f));

// ============================================================
//  استدعاء AI مع retry
// ============================================================
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callAI(messages, jsonMode = false, retries = 4) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (AI_PROVIDER === 'groq') {
        const body = { model: 'llama-3.3-70b-versatile', messages, temperature: 0.35, max_tokens: 8192 };
        if (jsonMode) body.response_format = { type: 'json_object' };
        const res = await axios.post(
          'https://api.groq.com/openai/v1/chat/completions', body,
          { headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' }, timeout: 90000 }
        );
        return res.data.choices[0].message.content.trim();
      } else {
        const gMsgs = messages.filter(m => m.role !== 'system')
          .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
        const sys = messages.find(m => m.role === 'system');
        if (sys && gMsgs.length > 0) gMsgs[0].parts[0].text = sys.content + '\n\n' + gMsgs[0].parts[0].text;
        const res = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
          { contents: gMsgs, generationConfig: { temperature: 0.35, maxOutputTokens: 8192, ...(jsonMode ? { responseMimeType: 'application/json' } : {}) } },
          { headers: { 'Content-Type': 'application/json' }, timeout: 90000 }
        );
        return res.data.candidates[0].content.parts[0].text.trim();
      }
    } catch (err) {
      const s = err.response?.status;
      if ((s === 429 || s >= 500) && attempt < retries) {
        const wait = 10000 * Math.pow(2, attempt) + Math.random() * 3000;
        console.log(`Retry ${attempt + 1}/${retries} in ${Math.round(wait / 1000)}s (HTTP ${s})`);
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
}

const parseJSON = raw =>
  JSON.parse(raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim());

// ============================================================
//  GitHub helpers
// ============================================================
async function getFileTree(force = false) {
  const now = Date.now();
  if (!force && repoCache.tree && (now - repoCache.lastFetch) < CACHE_TTL) return repoCache.tree;
  const res = await axios.get(
    `https://api.github.com/repos/${FULL_REPO}/git/trees/${GITHUB_BRANCH}?recursive=1`,
    { headers: GH_HEADERS }
  );
  repoCache.tree = res.data.tree.filter(f => f.type === 'blob').map(f => f.path);
  repoCache.lastFetch = now;
  return repoCache.tree;
}

async function readFile(filePath, useCache = true) {
  if (useCache && repoCache.contents[filePath] !== undefined) return repoCache.contents[filePath];
  try {
    const res = await axios.get(
      `https://api.github.com/repos/${FULL_REPO}/contents/${encodeURIComponent(filePath)}?ref=${GITHUB_BRANCH}`,
      { headers: GH_HEADERS }
    );
    const r = { content: Buffer.from(res.data.content, 'base64').toString('utf8'), sha: res.data.sha };
    repoCache.contents[filePath] = r;
    return r;
  } catch (e) {
    if (e.response?.status === 404) { repoCache.contents[filePath] = null; return null; }
    throw e;
  }
}

async function writeFile(filePath, content, commitMsg, sha) {
  const payload = {
    message: commitMsg || `Update ${filePath} via AI bot`,
    content: Buffer.from(String(content)).toString('base64'),
    branch: GITHUB_BRANCH,
  };
  if (sha) payload.sha = sha;
  const res = await axios.put(
    `https://api.github.com/repos/${FULL_REPO}/contents/${encodeURIComponent(filePath)}`,
    payload, { headers: GH_HEADERS }
  );
  repoCache.contents[filePath] = { content: String(content), sha: res.data.content?.sha || sha };
  if (!repoCache.tree?.includes(filePath)) repoCache.tree?.push(filePath);
  return res.data.content?.html_url || '';
}

async function deleteFile(filePath, sha, commitMsg) {
  await axios.delete(
    `https://api.github.com/repos/${FULL_REPO}/contents/${encodeURIComponent(filePath)}`,
    { headers: GH_HEADERS, data: { message: commitMsg || `Delete ${filePath}`, sha, branch: GITHUB_BRANCH } }
  );
  delete repoCache.contents[filePath];
  if (repoCache.tree) repoCache.tree = repoCache.tree.filter(f => f !== filePath);
}

async function readAllFiles(fileTree) {
  const all  = fileTree.filter(f => !shouldSkip(f));
  const pri  = all.filter(isPriority);
  const rest = all.filter(f => !isPriority(f));
  const toRead = all.length <= 40 ? all : [...new Set([...pri, ...rest.slice(0, 20)])];
  await Promise.all(toRead.map(fp => readFile(fp, true)));
  const sections = toRead.map(fp => {
    const c = repoCache.contents[fp]?.content;
    if (!c) return null;
    const max = isPriority(fp) ? 6000 : 3000;
    return `\n${'─'.repeat(50)}\n📄 ${fp}\n${'─'.repeat(50)}\n${c.length > max ? c.slice(0, max) + `\n...[${c.length - max} حرف محذوف]` : c}`;
  }).filter(Boolean);
  return { context: sections.join('\n'), readCount: toRead.length, totalCount: all.length };
}

// ============================================================
//  شخصية ريبلت — المحور الأساسي
// ============================================================

const REPLIT_PERSONALITY = `أنت مساعد ذكي مدمج في بوت تيليجرام يدير مستودع GitHub.

شخصيتك تماماً مثل ريبلت Agent:
- تتكلم بصوت عالٍ عن تفكيرك: "لاحظت أن..."، "سأقوم بـ..."، "المشكلة هنا هي..."
- عند إنهاء مهمة: تشرح بالتفصيل ما فعلته وتعطي خطوات ما بعد التنفيذ
- تلاحظ مشاكل إضافية وتذكرها حتى لو لم تُطلب
- تسأل سؤالاً واحداً محدداً مع مثال عند الحاجة للتوضيح
- ردودك منظّمة: نقطة للمعلومات، نقطة للخطوات، نقطة للتحذيرات
- لا تقول فقط "تم" — دائماً تشرح ماذا تغيّر ولماذا
- تكلّم بنفس لغة المستخدم (عربي أو إنجليزي) وبأسلوب طبيعي مريح`;

// ============================================================
//  تصنيف الرسالة
// ============================================================
async function classifyMessage(msg, history) {
  try {
    const raw = await callAI([
      {
        role: 'system',
        content: `صنّف رسالة المستخدم. أجب بـ JSON فقط:
{"type": "chat" | "question" | "task"}

chat: تحية، كلام عادي، شكر، انتقاد، سؤال شخصي عن البوت، "من أنت"
  أمثلة: "هلو"، "شلونك"، "شكراً"، "أنت غبي"، "ما اسمك"، "كيف حالك"
question: سؤال يحتاج شرحاً دون تنفيذ فعلي
  أمثلة: "كيف أضيف أدمن"، "ماذا يفعل هذا الأمر"، "ما الفرق بين X وY"
task: طلب تنفيذ عمل فعلي على الكود أو الملفات
  أمثلة: "عدّل bot.js"، "أضف ميزة"، "احذف ملف"، "أنشئ"، "غيّر"`,
      },
      ...history.slice(-4),
      { role: 'user', content: msg },
    ], true);
    return parseJSON(raw);
  } catch (_) {
    return { type: 'task' };
  }
}

// ============================================================
//  ردود المحادثة الطبيعية (شخصية ريبلت)
// ============================================================
async function chatReply(msg, history) {
  const sys = `${REPLIT_PERSONALITY}

معلوماتك الحالية:
- المستودع المربوط: ${FULL_REPO} (فرع: ${GITHUB_BRANCH})
- الذكاء الاصطناعي: ${AI_PROVIDER.toUpperCase()}
- قدراتك: قراءة وتعديل وإنشاء وحذف ملفات المستودع على GitHub

تعليمات إضافية:
- إذا سألك أحد "من أنت": عرّف نفسك كمساعد ذكي لإدارة GitHub، اذكر المستودع والقدرات
- إذا شكرك: رد بشكل طبيعي واسأل إذا يحتاج شيئاً آخر
- إذا انتقدك: تقبّل النقد بشكل إيجابي واسأل كيف تتحسّن
- اجعل ردودك قصيرة ومباشرة — لا تطوّل بلا داعٍ`;

  return await callAI([
    { role: 'system', content: sys },
    ...history,
    { role: 'user', content: msg },
  ], false);
}

// ============================================================
//  ردود الأسئلة (شرح + توجيه بأسلوب ريبلت)
// ============================================================
async function questionReply(msg, history, fileTree) {
  const sys = `${REPLIT_PERSONALITY}

المستودع: ${FULL_REPO} | الفرع: ${GITHUB_BRANCH}
ملفات المستودع:
${fileTree.filter(f => !shouldSkip(f)).slice(0, 25).join('\n')}${fileTree.length > 25 ? `\n...و ${fileTree.length - 25} آخر` : ''}

أسلوبك في الإجابة:
1. ابدأ بـ "لاحظت سؤالك عن..." أو "بخصوص..." أو ادخل مباشرة للإجابة
2. اشرح الموضوع بوضوح مع مثال من مستودعه إذا أمكن
3. إذا كان السؤال قابلاً للتطبيق، اختم بـ "هل تريد مني تنفيذ هذا مباشرة؟"
4. إذا لاحظت مشكلة محتملة، نبّه عليها
5. كن موجزاً — لا تكرر المعلومات`;

  return await callAI([
    { role: 'system', content: sys },
    ...history.slice(-6),
    { role: 'user', content: msg },
  ], false);
}

// ============================================================
//  تخطيط المهام
// ============================================================
async function planTask(msg, fileTree, repoCtx, history) {
  const sys = `${REPLIT_PERSONALITY}

أنت تخطط لتنفيذ مهمة برمجية بعد قراءة كل ملفات المشروع.

المستودع: ${FULL_REPO} | الفرع: ${GITHUB_BRANCH}

━━━━ محتوى الملفات (${repoCtx.readCount}/${repoCtx.totalCount} ملف) ━━━━
${repoCtx.context || '[مستودع فارغ]'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

جميع الملفات:
${fileTree.join('\n')}

أجب بـ JSON فقط:
{
  "understood": "ما فهمته من الطلب بكلامك أنت — جملة واحدة",
  "approach": "كيف ستنفذ — جملة أو جملتان",
  "notices": ["أشياء لاحظتها في الكود قد تكون مهمة للمستخدم — اذكر 0-2 ملاحظات"],
  "needs_clarification": false,
  "clarification_question": "إذا needs_clarification=true: سؤال واحد محدد مع مثال",
  "operations": [
    {
      "action": "create" | "update" | "delete" | "read" | "list",
      "file_path": "المسار الكامل",
      "commit_message": "رسالة واضحة بالإنجليزي",
      "detailed_instructions": "تعليمات مفصّلة جداً — كل دالة تُضاف، كل منطق، كل تغيير. هذا الوصف هو أساس الكود.",
      "must_preserve": "أجزاء تبقى كما هي",
      "must_add": "ما يُضاف",
      "must_remove": "ما يُحذف"
    }
  ],
  "next_steps": ["ما يجب على المستخدم فعله بعد التنفيذ — مثل: أعد تشغيل البوت، اختبر الأمر /x"]
}

قواعد التخطيط:
• needs_clarification=true: فقط عند التعارض الحقيقي — تصرّف بذكاء في كل الحالات الأخرى
• حافظ على نمط الكود القائم بالضبط (نفس require/import، نفس الأسلوب)
• إذا التعديل يؤثر على ملفات أخرى، أضفها كعمليات منفصلة`;

  const raw = await callAI([
    { role: 'system', content: sys },
    ...history.slice(-4),
    { role: 'user', content: msg },
  ], true);
  return parseJSON(raw);
}

// ============================================================
//  توليد الكود الفعلي
// ============================================================
async function generateCode(op, existingContent, userMsg, history) {
  const isCode = /\.(js|ts|jsx|tsx|mjs|cjs|py|go|rs|java|cpp|c|cs|php|rb|swift|kt)$/.test(op.file_path);
  const isJson = op.file_path.endsWith('.json');

  const sys = [
    `أنت مطور خبير. اكتب المحتوى الكامل للملف "${op.file_path}" فقط.`,
    `بدون شرح، بدون markdown fences. الملف الكامل — ليس جزءاً منه.`,
    isCode ? `استخدم backtick للـ template literals عند \${...}. تحقق من كل require/import. لا TODO.` : '',
    isJson ? `JSON صحيح فقط — لا تعليقات.` : '',
  ].filter(Boolean).join('\n');

  const existingSection = existingContent
    ? `\nالملف الحالي:\n${existingContent.length > 8000 ? existingContent.slice(0, 8000) + '\n...[مقتطع]' : existingContent}`
    : '\n[ملف جديد]';

  const prompt = [
    `الطلب: ${userMsg}`,
    `الملف: ${op.file_path}`,
    `التعليمات:\n${op.detailed_instructions}`,
    op.must_preserve ? `يجب الحفاظ على:\n${op.must_preserve}` : '',
    op.must_add      ? `يجب إضافة:\n${op.must_add}` : '',
    op.must_remove   ? `يجب حذف:\n${op.must_remove}` : '',
    existingSection,
    `\nاكتب الملف الكامل الآن:`,
  ].filter(Boolean).join('\n');

  let result = await callAI([
    { role: 'system', content: sys },
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
//  ملخص ما بعد التنفيذ — بأسلوب ريبلت
// ============================================================
async function generateSummary(userMsg, plan, executedOps, history) {
  const sys = `${REPLIT_PERSONALITY}

أنت الآن تكتب ملخص ما بعد التنفيذ للمستخدم، بأسلوب ريبلت Agent تماماً.

الأسلوب المطلوب:
- ابدأ بـ "تمام!" أو "خلصت!" أو "جاهز!" أو ما يناسب السياق — جملة افتتاحية طبيعية
- اشرح ماذا فعلت بالتفصيل: "أضفت [X] في [ملف]"، "عدّلت [دالة] لتفعل [Y]"
- إذا لاحظت مشاكل أثناء العمل، اذكرها
- اذكر الخطوات التالية التي يحتاجها المستخدم
- تكلّم بنفس لغة المستخدم
- اجعل الرد منظّماً لكن طبيعياً — مش رسمي جداً`;

  const opsStr = executedOps.map(o => `${o.action}: ${o.file_path} — ${o.result}`).join('\n');
  const noticesStr = plan.notices?.length ? `\nملاحظات أثناء العمل:\n${plan.notices.join('\n')}` : '';
  const nextStr = plan.next_steps?.length ? `\nخطوات مقترحة بعد التنفيذ:\n${plan.next_steps.join('\n')}` : '';

  const prompt = `الطلب الأصلي: ${userMsg}
ما فهمته: ${plan.understood}
طريقة التنفيذ: ${plan.approach}
العمليات المنفذة:
${opsStr}${noticesStr}${nextStr}

اكتب الملخص الآن:`;

  try {
    return await callAI([
      { role: 'system', content: sys },
      ...history.slice(-3),
      { role: 'user', content: prompt },
    ], false);
  } catch (_) {
    return executedOps.map(o => o.result).join('\n');
  }
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
  `أهلاً! 👋 أنا مساعدك لإدارة مستودع GitHub.\n\n` +
  `*المستودع:* \`${FULL_REPO}\`\n` +
  `*الفرع:* \`${GITHUB_BRANCH}\` | *AI:* \`${AI_PROVIDER.toUpperCase()}\`\n\n` +
  `تكلّم معي بشكل طبيعي — أفهم ما تريد:\n\n` +
  `💬 "هلو" ← أرد طبيعي\n` +
  `🤔 "كيف أضيف أدمن؟" ← أشرح لك\n` +
  `⚙️ "عدّل bot.js وأضف /stats" ← أنفذ مباشرة\n\n` +
  `ما الذي تحتاجه؟`
));

bot.help(ctx => safeSend(ctx,
  `*الأوامر:*\n\n` +
  `*/repo* — معلومات المستودع\n` +
  `*/files* — عرض كل الملفات\n` +
  `*/read [مسار]* — قراءة ملف\n` +
  `*/refresh* — إعادة تحميل الملفات\n` +
  `*/clear* — مسح سياق المحادثة\n` +
  `*/admin [ID]* — إضافة مسؤول\n` +
  `*/removeadmin [ID]* — إزالة مسؤول\n\n` +
  `أو فقط كلّمني بشكل طبيعي! 💬`
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
      `*📋 ملفات المستودع (${usable.length} / ${tree.length}):*\n\n` +
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
  repoCache.tree = null; repoCache.contents = {}; repoCache.lastFetch = 0;
  ctx.reply('🔄 تم مسح الكاش — سيُعاد تحميل الملفات في الطلب التالي.');
});

bot.command('clear', async ctx => {
  conversationHistory.delete(ctx.from?.id);
  ctx.reply('🧹 تم مسح سياق المحادثة. نبدأ من جديد!');
});

bot.command('admin', async ctx => {
  if (ctx.from?.id !== OWNER_ID) return ctx.reply('🚫 فقط المالك يمكنه إضافة مسؤولين.');
  const id = parseInt(ctx.message.text.split(' ')[1]);
  if (!id) return ctx.reply('مثال: /admin 123456789\nاحصل على ID من @userinfobot');
  if (admins.has(id)) return ctx.reply('ℹ️ هذا المستخدم مسؤول بالفعل.');
  admins.add(id); saveAdmins(admins);
  ctx.reply(`✅ تم إضافة ${id} كمسؤول — محفوظ بشكل دائم.`);
});

bot.command('removeadmin', async ctx => {
  if (ctx.from?.id !== OWNER_ID) return ctx.reply('🚫 فقط المالك.');
  const id = parseInt(ctx.message.text.split(' ')[1]);
  if (!id || id === OWNER_ID) return ctx.reply('أدخل معرف صالح (لا يمكن إزالة المالك).');
  admins.delete(id); saveAdmins(admins);
  ctx.reply(`✅ تمت إزالة ${id} من المسؤولين.`);
});

// ============================================================
//  المعالج الرئيسي — ريبلت Agent بنسبة 100%
// ============================================================
bot.on('text', async ctx => {
  const userMsg = ctx.message.text;
  if (userMsg.startsWith('/')) return;

  const userId = ctx.from?.id;
  if (processingUsers.has(userId)) {
    return ctx.reply('⏳ لا تزال عندي مهمة جارية، انتظر لحظة...');
  }
  processingUsers.add(userId);

  let statusMsg;
  try {
    const history = getHistory(userId);

    // ── تصنيف الرسالة ─────────────────────────────────────
    const { type } = await classifyMessage(userMsg, history);

    // ── محادثة عادية ─────────────────────────────────────
    if (type === 'chat') {
      await ctx.sendChatAction('typing');
      const reply = await chatReply(userMsg, history);
      addToHistory(userId, 'user', userMsg);
      addToHistory(userId, 'assistant', reply);
      return await safeSend(ctx, reply);
    }

    // ── سؤال → شرح بأسلوب ريبلت ─────────────────────────
    if (type === 'question') {
      await ctx.sendChatAction('typing');
      let fileTree = [];
      try { fileTree = await getFileTree(); } catch (_) {}
      const reply = await questionReply(userMsg, history, fileTree);
      addToHistory(userId, 'user', userMsg);
      addToHistory(userId, 'assistant', reply);
      return await safeSend(ctx, reply);
    }

    // ── مهمة → قراءة كل الملفات ثم التخطيط ثم التنفيذ ──
    statusMsg = await ctx.reply('📂 جاري قراءة المشروع...');

    let fileTree = [];
    try { fileTree = await getFileTree(); } catch (_) {}

    const readableCount = fileTree.filter(f => !shouldSkip(f)).length;
    await safeEdit(ctx, statusMsg.message_id, `📖 أقرأ ${readableCount} ملف للفهم الكامل...`);

    const repoCtx = await readAllFiles(fileTree);

    await safeEdit(ctx, statusMsg.message_id,
      `✅ قرأت ${repoCtx.readCount} ملف\n🧠 أحلّل وأخطط...`
    );

    // ── التخطيط ───────────────────────────────────────────
    let plan;
    try {
      plan = await planTask(userMsg, fileTree, repoCtx, history);
    } catch (err) {
      if (err.response?.status === 429) {
        await safeEdit(ctx, statusMsg.message_id, '⏳ تجاوز حد الطلبات. انتظر دقيقة ثم أعد.');
        return;
      }
      throw err;
    }

    // يسأل إذا يحتاج توضيحاً — بأسلوب طبيعي
    if (plan.needs_clarification && plan.clarification_question?.trim()) {
      await safeEdit(ctx, statusMsg.message_id, plan.clarification_question);
      addToHistory(userId, 'user', userMsg);
      addToHistory(userId, 'assistant', plan.clarification_question);
      return;
    }

    const ops = plan.operations || [];
    if (!ops.length) {
      const confused = await chatReply(`المستخدم قال: "${userMsg}" ولم أفهم ماذا يريد بالضبط. أخبره بلطف أنني لم أفهم واسأله يوضح`, history);
      await safeEdit(ctx, statusMsg.message_id, confused);
      return;
    }

    // عرض الخطة بأسلوب ريبلت
    const icons = { create: '🆕', update: '✏️', delete: '🗑️', read: '📖', list: '📋' };
    const opsList = ops.map(o => `${icons[o.action] || '⚙️'} \`${o.file_path}\``).join('\n');
    await safeEdit(ctx, statusMsg.message_id,
      `🔍 *فهمت:* ${plan.understood}\n\n` +
      `📋 *الخطة:* ${plan.approach}\n\n` +
      `${opsList}\n\n⏳ أبدأ التنفيذ...`
    );

    // ── التنفيذ ───────────────────────────────────────────
    const executedOps = [];

    for (const op of ops) {
      try {
        if (op.action === 'list') {
          const filtered = op.file_path
            ? fileTree.filter(f => f.startsWith(op.file_path))
            : fileTree.filter(f => !shouldSkip(f));
          executedOps.push({ action: 'list', file_path: op.file_path || '/', result: `عرضت ${filtered.length} ملف` });

        } else if (op.action === 'read') {
          const f = await readFile(op.file_path);
          if (!f) { executedOps.push({ action: 'read', file_path: op.file_path, result: 'الملف غير موجود' }); continue; }
          executedOps.push({ action: 'read', file_path: op.file_path, result: `قرأت ${f.content.length} حرف` });

        } else if (op.action === 'delete') {
          const f = await readFile(op.file_path, false);
          if (!f) { executedOps.push({ action: 'delete', file_path: op.file_path, result: 'الملف غير موجود' }); continue; }
          await deleteFile(op.file_path, f.sha, op.commit_message);
          executedOps.push({ action: 'delete', file_path: op.file_path, result: 'حُذف بنجاح' });

        } else if (op.action === 'create' || op.action === 'update') {
          const fresh = await readFile(op.file_path, false);
          const existingContent = fresh?.content || null;
          const sha = fresh?.sha || null;

          const content = await generateCode(op, existingContent, userMsg, history);
          if (!content?.trim()) {
            executedOps.push({ action: op.action, file_path: op.file_path, result: 'فشل التوليد' });
            continue;
          }

          const url = await writeFile(op.file_path, content, op.commit_message, sha);
          executedOps.push({
            action: op.action,
            file_path: op.file_path,
            result: `${existingContent ? 'تم التعديل' : 'تم الإنشاء'} — ${op.commit_message}`,
            url,
          });
        }
      } catch (opErr) {
        executedOps.push({
          action: op.action,
          file_path: op.file_path || '?',
          result: `خطأ: ${opErr.response?.data?.message || opErr.message}`,
        });
      }
    }

    addToHistory(userId, 'user', userMsg);

    // ── الملخص النهائي بأسلوب ريبلت ─────────────────────
    // عرض ملفات للقراءة بشكل منفصل إذا وجدت
    const readOps = executedOps.filter(o => o.action === 'read');
    const taskOps = executedOps.filter(o => o.action !== 'read');

    // الملخص الطبيعي
    const summary = await generateSummary(userMsg, plan, taskOps.length ? taskOps : executedOps, history);
    addToHistory(userId, 'assistant', summary);

    // إرسال محتوى الملفات المقروءة أولاً
    for (const ro of readOps) {
      const f = repoCache.contents[ro.file_path];
      if (f?.content) {
        const preview = f.content.length > 2500 ? f.content.slice(0, 2500) + '\n_...مقتطع_' : f.content;
        await safeSend(ctx, `*📄 ${ro.file_path}:*\n\`\`\`\n${preview}\n\`\`\``);
      }
    }

    // عرض روابط GitHub إذا وجدت
    const links = executedOps.filter(o => o.url).map(o => `🔗 [${o.file_path}](${o.url})`).join('\n');

    const finalMsg = summary + (links ? `\n\n${links}` : '');

    if (finalMsg.length > 4000) {
      await safeEdit(ctx, statusMsg.message_id, '✅ اكتملت العمليات:');
      for (const chunk of splitMessage(finalMsg)) await safeSend(ctx, chunk);
    } else {
      await safeEdit(ctx, statusMsg.message_id, finalMsg);
    }

    // list results
    const listOps = executedOps.filter(o => o.action === 'list');
    for (const lo of listOps) {
      const filtered = lo.file_path !== '/'
        ? fileTree.filter(f => f.startsWith(lo.file_path))
        : fileTree.filter(f => !shouldSkip(f));
      const display = filtered.slice(0, 60).map(f => `📄 \`${f}\``).join('\n');
      await safeSend(ctx,
        `*📋 الملفات (${filtered.length}):*\n${display}` +
        (filtered.length > 60 ? `\n_...و ${filtered.length - 60} أخرى_` : '')
      );
    }

  } catch (err) {
    console.error('Bot error:', err.response?.data || err.message);
    const isRate = err.response?.status === 429;
    const msg = isRate
      ? '⏳ تجاوز حد الطلبات. انتظر دقيقة ثم أعد.'
      : `❌ خطأ غير متوقع:\n\`${err.response?.data?.message || err.message}\``;
    if (statusMsg) await safeEdit(ctx, statusMsg.message_id, msg).catch(() => {});
    else await ctx.reply(msg);
  } finally {
    processingUsers.delete(userId);
  }
});

module.exports = bot;
