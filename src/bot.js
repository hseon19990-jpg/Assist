/**
 * بوت تيليجرام الذكي لتعديل GitHub
 * نظام ثلاثي المراحل: تحليل → تخطيط → تنفيذ
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

if (!BOT_TOKEN)                throw new Error('TELEGRAM_BOT_TOKEN غير موجود');
if (!GROQ_KEY && !GEMINI_KEY)  throw new Error('يجب توفير GROQ_API_KEY أو GEMINI_API_KEY');

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
const HISTORY_LIMIT = 10;

function loadAdmins() {
  try {
    if (fs.existsSync(ADMINS_FILE)) {
      return new Set([OWNER_ID, ...JSON.parse(fs.readFileSync(ADMINS_FILE, 'utf8'))]);
    }
  } catch (_) {}
  return new Set([OWNER_ID]);
}

function saveAdmins(set) {
  try {
    fs.writeFileSync(ADMINS_FILE, JSON.stringify([...set].filter(id => id !== OWNER_ID)), 'utf8');
  } catch (_) {}
}

const admins = loadAdmins();

// سياق المحادثة لكل مستخدم
const conversationHistory = new Map();

function addToHistory(userId, role, content) {
  if (!conversationHistory.has(userId)) conversationHistory.set(userId, []);
  const h = conversationHistory.get(userId);
  h.push({ role, content: String(content).slice(0, 3000) }); // حد أقصى لكل رسالة
  if (h.length > HISTORY_LIMIT) h.splice(0, h.length - HISTORY_LIMIT);
}

function getHistory(userId) {
  return conversationHistory.get(userId) || [];
}

// ============================================================
//  GitHub helpers
// ============================================================

/** جلب شجرة الملفات الكاملة */
async function getFileTree() {
  const url = `https://api.github.com/repos/${FULL_REPO}/git/trees/${GITHUB_BRANCH}?recursive=1`;
  const res = await axios.get(url, { headers: GH_HEADERS });
  return res.data.tree.filter(f => f.type === 'blob').map(f => f.path);
}

/** قراءة ملف بمحتواه وـ sha */
async function readFile(filePath) {
  try {
    const url = `https://api.github.com/repos/${FULL_REPO}/contents/${encodeURIComponent(filePath)}?ref=${GITHUB_BRANCH}`;
    const res = await axios.get(url, { headers: GH_HEADERS });
    return {
      content: Buffer.from(res.data.content, 'base64').toString('utf8'),
      sha: res.data.sha,
    };
  } catch (e) {
    if (e.response?.status === 404) return null;
    throw e;
  }
}

/** كتابة أو تحديث ملف */
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

/** حذف ملف */
async function deleteFile(filePath, sha, commitMsg) {
  const url = `https://api.github.com/repos/${FULL_REPO}/contents/${encodeURIComponent(filePath)}`;
  await axios.delete(url, {
    headers: GH_HEADERS,
    data: { message: commitMsg || `Delete ${filePath}`, sha, branch: GITHUB_BRANCH },
  });
}

/** قراءة عدة ملفات دفعة واحدة */
async function readMultipleFiles(filePaths) {
  const results = {};
  await Promise.all(
    filePaths.map(async fp => {
      const f = await readFile(fp);
      results[fp] = f ? f.content : null;
    })
  );
  return results;
}

// ============================================================
//  استدعاء الذكاء الاصطناعي (Groq أو Gemini)
// ============================================================

async function callAI(messages, jsonMode = false) {
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
      { headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' } }
    );
    return res.data.choices[0].message.content.trim();

  } else {
    // Gemini
    const geminiMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    const systemMsg = messages.find(m => m.role === 'system');
    if (systemMsg && geminiMessages.length > 0) {
      geminiMessages[0].parts[0].text = systemMsg.content + '\n\n' + geminiMessages[0].parts[0].text;
    }

    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
      {
        contents: geminiMessages,
        generationConfig: {
          temperature: 0.15,
          maxOutputTokens: 8192,
          ...(jsonMode ? { responseMimeType: 'application/json' } : {}),
        },
      },
      { headers: { 'Content-Type': 'application/json' } }
    );
    return res.data.candidates[0].content.parts[0].text.trim();
  }
}

function parseJSON(raw) {
  const clean = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(clean);
}

// ============================================================
//  المرحلة الأولى: تحليل الطلب وتحديد الملفات المحتاجة
// ============================================================

async function phase1_analyze(userMsg, fileTree, history) {
  const systemPrompt = `أنت محلل كود خبير. مهمتك فقط: فهم الطلب وتحديد الملفات المحتاجة للقراءة.

المستودع: ${FULL_REPO} | الفرع: ${GITHUB_BRANCH}

قائمة الملفات:
${fileTree.join('\n')}

أجب بـ JSON فقط (بدون أي نص خارجه):
{
  "task_type": "create_file" | "modify_file" | "delete_file" | "read_file" | "list_files" | "multi_operation" | "unclear",
  "files_to_read": ["ملفات يجب قراءتها قبل التنفيذ — اقرأ كل ملف سيُعدَّل، وملفاته المرتبطة مثل package.json وملفات الإعدادات"],
  "files_to_modify": ["الملفات التي ستُنشأ أو تُعدَّل"],
  "files_to_delete": ["الملفات التي ستُحذف"],
  "explanation_ar": "اشرح بجملة واحدة ما يريد المستخدم",
  "missing_info": "إذا الطلب غامض جداً اكتب ما تحتاجه، وإلا اتركه فارغاً",
  "needs_packages": true | false,
  "complexity": "simple" | "medium" | "complex"
}

قواعد files_to_read:
- اقرأ دائماً package.json إذا كان موجوداً
- اقرأ كل ملف سيُعدَّل حتماً
- اقرأ الملفات التي يستوردها الملف المستهدف إذا كانت ذات صلة
- اقرأ README.md إذا كان الطلب عاماً أو غير محدد`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userMsg },
  ];

  const raw = await callAI(messages, true);
  return parseJSON(raw);
}

// ============================================================
//  المرحلة الثانية: بناء الخطة الكاملة مع سياق الملفات
// ============================================================

async function phase2_plan(userMsg, analysis, fileContents, fileTree, history) {
  // بناء سياق الملفات المقروءة
  const fileContext = Object.entries(fileContents)
    .filter(([, content]) => content !== null)
    .map(([fp, content]) => {
      const preview = content.length > 4000 ? content.slice(0, 4000) + '\n... [مقتطع]' : content;
      return `\n=== ${fp} ===\n${preview}`;
    })
    .join('\n');

  const systemPrompt = `أنت مطور برمجيات خبير ذو وعي كامل بالمشروع. تعمل مثل أفضل مساعد كود في العالم.

المستودع: ${FULL_REPO} | الفرع: ${GITHUB_BRANCH}

--- محتوى الملفات الحالية ---
${fileContext || 'لا توجد ملفات مقروءة'}
---

قائمة كل ملفات المستودع:
${fileTree.join('\n')}

مهمتك: بناء خطة تفصيلية كاملة لتنفيذ الطلب.

أجب بـ JSON فقط:
{
  "explanation_ar": "اشرح ما ستفعله بالتفصيل",
  "operations": [
    {
      "action": "create" | "update" | "delete" | "read" | "list",
      "file_path": "مسار الملف",
      "commit_message": "رسالة commit واضحة بالإنجليزي",
      "content_plan": "وصف تفصيلي جداً لما يجب أن يحتويه الملف — اذكر كل وظيفة وكل تغيير مطلوب بدقة",
      "preserve": ["أجزاء من الملف الحالي يجب الحفاظ عليها"],
      "add": ["ما يجب إضافته"],
      "remove": ["ما يجب حذفه"]
    }
  ],
  "missing_info": "إذا لا يمكن التنفيذ بدون معلومات إضافية",
  "new_packages": ["حزم npm جديدة مطلوبة إذا وجدت"]
}

قواعد مهمة:
- كن دقيقاً جداً في content_plan — هذا ما سيُبنى عليه الكود
- حافظ على نمط الكود الموجود (نفس style، نفس التسمية)
- إذا عدّلت ملفاً، تأكد من الحفاظ على كل الوظائف الأصلية ما لم يُطلب حذفها
- إذا احتجت package جديد، أضف عملية update لـ package.json أيضاً`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: `الطلب: ${userMsg}\n\nالتحليل الأولي: ${analysis.explanation_ar}` },
  ];

  const raw = await callAI(messages, true);
  return parseJSON(raw);
}

// ============================================================
//  المرحلة الثالثة: توليد الكود الفعلي
// ============================================================

async function phase3_generate(op, existingContent, userMsg, history) {
  const isCode = /\.(js|ts|jsx|tsx|mjs|cjs|py|go|rs|java|cpp|c|cs|php|rb|swift|kt)$/.test(op.file_path);
  const isJson = op.file_path.endsWith('.json');
  const isYaml = op.file_path.endsWith('.yml') || op.file_path.endsWith('.yaml');

  let systemInstructions = `أنت مطور خبير محترف. مهمتك: كتابة الكود الكامل والصحيح لهذا الملف.

قواعد صارمة:
1. أعطِ المحتوى الكامل للملف فقط — بدون شرح، بدون markdown code fences، بدون أي نص قبله أو بعده
2. تأكد أن الكود صحيح ويمكن تشغيله مباشرة
3. حافظ على كل الوظائف الأصلية الموجودة ما لم يُطلب صراحةً حذفها
4. استخدم نفس أسلوب الكود الموجود (نفس const/let، نفس arrow functions، إلخ)`;

  if (isCode) {
    systemInstructions += `
5. للـ template literals: استخدم backtick (\`) عند وجود \${...} — ليس single quote أو double quote
6. تأكد من صحة كل الـ imports والـ requires
7. لا تترك TODO أو placeholder — اكتب الكود الكامل`;
  }

  if (isJson) {
    systemInstructions += `\n5. أعطِ JSON صحيحاً قابلاً للتحقق فقط`;
  }

  const contextSection = existingContent
    ? `\nالملف الحالي:\n${existingContent.length > 6000 ? existingContent.slice(0, 6000) + '\n...[مقتطع]' : existingContent}`
    : '';

  const userPrompt = `الملف المطلوب: ${op.file_path}
الطلب الأصلي: ${userMsg}
خطة التنفيذ: ${op.content_plan}
${op.add?.length ? `يجب إضافة: ${op.add.join(', ')}` : ''}
${op.remove?.length ? `يجب حذف: ${op.remove.join(', ')}` : ''}
${op.preserve?.length ? `يجب الحفاظ على: ${op.preserve.join(', ')}` : ''}
${contextSection}

اكتب المحتوى الكامل للملف الآن:`;

  const messages = [
    { role: 'system', content: systemInstructions },
    ...history.slice(-4), // آخر 4 رسائل فقط لتوفير tokens
    { role: 'user', content: userPrompt },
  ];

  let result = await callAI(messages, false);

  // تنظيف markdown code fences
  result = result.replace(/^```[\w]*\n?/gm, '').replace(/^```$/gm, '').trim();

  // تصحيح template literals في ملفات الكود
  if (isCode) {
    result = fixTemplateLiterals(result);
  }

  return result;
}

/** مصحح template literals */
function fixTemplateLiterals(code) {
  code = code.replace(
    /(['"])((?:[^'"\\]|\\.)*?\$\{(?:[^}]|\{[^}]*\})*\}(?:[^'"\\]|\\.)*?)\1/g,
    (_, __, inner) => `\`${inner}\``
  );
  code = code.replace(
    /'((?:[^'\\]|\\.|\n)*?\$\{(?:[^}]|\{[^}]*\})*\}(?:[^'\\]|\\.|\n)*?)'/g,
    (_, inner) => `\`${inner}\``
  );
  return code;
}

// ============================================================
//  إرسال رسائل طويلة بأمان
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
    return await ctx.reply(text, { disable_web_page_preview: true, ...extra });
  }
}

async function safeEdit(ctx, messageId, text) {
  try {
    return await ctx.telegram.editMessageText(
      ctx.chat.id, messageId, null, text,
      { parse_mode: 'Markdown', disable_web_page_preview: true }
    );
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
  `*الذكاء الاصطناعي:* \`${AI_PROVIDER.toUpperCase()}\`\n\n` +
  `أرسل طلبك بأي صيغة تريد:\n\n` +
  `📝 \`أضف نظام تسجيل دخول بـ JWT\`\n` +
  `✏️ \`عدّل bot.js وأضف أمر /stats\`\n` +
  `👁️ \`اقرأ ملف index.js\`\n` +
  `📋 \`اعرض كل الملفات\`\n` +
  `🗑️ \`احذف ملف old.js\`\n\n` +
  `أفهم السياق الكامل للمشروع قبل أي تعديل ✅`
));

bot.help(ctx => safeSend(ctx,
  `*دليل الاستخدام:*\n\n` +
  `أرسل طلبك بالعربي أو الإنجليزي — سأفهم المشروع كاملاً أولاً.\n\n` +
  `*/start* — رسالة الترحيب\n` +
  `*/repo* — معلومات المستودع\n` +
  `*/files* — عرض كل الملفات\n` +
  `*/clear* — مسح سياق المحادثة\n` +
  `*/admin [ID]* — إضافة مسؤول\n` +
  `*/removeadmin [ID]* — إزالة مسؤول`
));

bot.command('repo', async ctx => {
  try {
    const res = await axios.get(`https://api.github.com/repos/${FULL_REPO}`, { headers: GH_HEADERS });
    const d = res.data;
    await safeSend(ctx,
      `*📁 معلومات المستودع:*\n\n` +
      `🔗 \`${d.full_name}\`\n` +
      `🌿 الفرع: \`${GITHUB_BRANCH}\`\n` +
      `📝 ${d.description || 'لا يوجد وصف'}\n` +
      `🔒 ${d.private ? 'خاص' : 'عام'} | ⭐ ${d.stargazers_count}\n` +
      `🔤 ${d.language || 'متعددة اللغات'}\n` +
      `🤖 ${AI_PROVIDER.toUpperCase()}`
    );
  } catch (e) {
    ctx.reply(`❌ خطأ: ${e.message}`);
  }
});

bot.command('files', async ctx => {
  try {
    const tree = await getFileTree();
    const display = tree.slice(0, 80).map(f => `📄 \`${f}\``).join('\n');
    const text = `*📋 ملفات المستودع (${tree.length}):*\n\n${display}` +
      (tree.length > 80 ? `\n\n_...و ${tree.length - 80} ملف آخر_` : '');
    await safeSend(ctx, text);
  } catch (e) {
    ctx.reply(`❌ خطأ: ${e.message}`);
  }
});

bot.command('clear', async ctx => {
  conversationHistory.delete(ctx.from?.id);
  ctx.reply('🧹 تم مسح سياق المحادثة. ابدأ من جديد!');
});

bot.command('admin', async ctx => {
  if (ctx.from?.id !== OWNER_ID) return ctx.reply('🚫 فقط المالك.');
  const id = parseInt(ctx.message.text.split(' ')[1]);
  if (!id) return ctx.reply('مثال: /admin 123456789');
  if (admins.has(id)) return ctx.reply('ℹ️ مسؤول بالفعل.');
  admins.add(id);
  saveAdmins(admins);
  ctx.reply(`✅ تم إضافة ${id} مسؤولاً.`);
});

bot.command('removeadmin', async ctx => {
  if (ctx.from?.id !== OWNER_ID) return ctx.reply('🚫 فقط المالك.');
  const id = parseInt(ctx.message.text.split(' ')[1]);
  if (!id || id === OWNER_ID) return ctx.reply('أدخل معرف صالح (لا يمكن إزالة المالك).');
  admins.delete(id);
  saveAdmins(admins);
  ctx.reply(`✅ تمت إزالة ${id}.`);
});

// ============================================================
//  المعالج الرئيسي — نظام ثلاثي المراحل
// ============================================================

bot.on('text', async ctx => {
  const userMsg = ctx.message.text;
  if (userMsg.startsWith('/')) return;

  const userId = ctx.from?.id;
  let statusMsg;

  try {
    statusMsg = await ctx.reply('🔍 جاري قراءة المشروع...');

    // جلب شجرة الملفات
    let fileTree = [];
    try { fileTree = await getFileTree(); } catch (_) {}

    const history = getHistory(userId);

    // ─── المرحلة الأولى: تحليل الطلب ──────────────────────
    await safeEdit(ctx, statusMsg.message_id, '🧠 المرحلة 1/3: تحليل الطلب...');
    const analysis = await phase1_analyze(userMsg, fileTree, history);

    if (analysis.missing_info?.trim()) {
      await safeEdit(ctx, statusMsg.message_id, `⚠️ *أحتاج توضيحاً:*\n\n${analysis.missing_info}`);
      addToHistory(userId, 'user', userMsg);
      addToHistory(userId, 'assistant', analysis.missing_info);
      return;
    }

    // action بسيطة لا تحتاج تخطيطاً عميقاً
    if (analysis.task_type === 'list_files') {
      const filtered = fileTree.slice(0, 80).map(f => `📄 \`${f}\``).join('\n');
      await safeEdit(ctx, statusMsg.message_id,
        `*📋 ملفات المستودع (${fileTree.length}):*\n\n${filtered}` +
        (fileTree.length > 80 ? `\n\n_...و ${fileTree.length - 80} آخر_` : '')
      );
      addToHistory(userId, 'user', userMsg);
      return;
    }

    if (analysis.task_type === 'read_file') {
      const fp = analysis.files_to_read[0] || analysis.files_to_modify[0];
      if (!fp) {
        await safeEdit(ctx, statusMsg.message_id, '❌ لم أستطع تحديد الملف. حدده بالاسم.');
        return;
      }
      const file = await readFile(fp);
      if (!file) {
        await safeEdit(ctx, statusMsg.message_id, `❌ الملف \`${fp}\` غير موجود.`);
        return;
      }
      const preview = file.content.length > 3000
        ? file.content.slice(0, 3000) + '\n\n_...تم اقتصار المحتوى (الملف أطول)_'
        : file.content;
      const msg = `*📄 ${fp}:*\n\`\`\`\n${preview}\n\`\`\``;
      if (msg.length > 4000) {
        await safeEdit(ctx, statusMsg.message_id, '📄 محتوى الملف:');
        for (const chunk of splitMessage(msg)) await safeSend(ctx, chunk);
      } else {
        await safeEdit(ctx, statusMsg.message_id, msg);
      }
      addToHistory(userId, 'user', userMsg);
      return;
    }

    // ─── المرحلة الثانية: قراءة الملفات وبناء الخطة ──────
    await safeEdit(ctx, statusMsg.message_id, '📖 المرحلة 2/3: قراءة السياق وبناء الخطة...');

    const filesToRead = [
      ...new Set([
        ...(analysis.files_to_read || []),
        ...(analysis.files_to_modify || []),
      ])
    ].filter(f => fileTree.includes(f));

    const fileContents = filesToRead.length > 0 ? await readMultipleFiles(filesToRead) : {};

    const plan = await phase2_plan(userMsg, analysis, fileContents, fileTree, history);

    if (plan.missing_info?.trim()) {
      await safeEdit(ctx, statusMsg.message_id, `⚠️ *أحتاج توضيحاً:*\n\n${plan.missing_info}`);
      addToHistory(userId, 'user', userMsg);
      addToHistory(userId, 'assistant', plan.missing_info);
      return;
    }

    const ops = plan.operations || [];
    if (!ops.length) {
      await safeEdit(ctx, statusMsg.message_id,
        '🤔 لم أتمكن من بناء خطة واضحة. حاول بصياغة أوضح.'
      );
      return;
    }

    // إخبار المستخدم بالخطة
    const opsSummary = ops.map(o => {
      const icon = o.action === 'create' ? '🆕' : o.action === 'update' ? '✏️' : o.action === 'delete' ? '🗑️' : '📖';
      return `${icon} \`${o.file_path}\``;
    }).join('\n');
    await safeEdit(ctx, statusMsg.message_id,
      `⚙️ *الخطة:* ${plan.explanation_ar}\n\n${opsSummary}\n\n⏳ المرحلة 3/3: التنفيذ...`
    );

    // ─── المرحلة الثالثة: التنفيذ ──────────────────────────
    const results = [];

    for (const op of ops) {
      try {
        if (op.action === 'list') {
          const filtered = op.file_path ? fileTree.filter(f => f.startsWith(op.file_path)) : fileTree;
          const display = filtered.slice(0, 60).map(f => `📄 \`${f}\``).join('\n');
          results.push(
            `*📋 الملفات (${filtered.length}):*\n${display}` +
            (filtered.length > 60 ? `\n_...و ${filtered.length - 60} أخرى_` : '')
          );

        } else if (op.action === 'read') {
          const file = await readFile(op.file_path);
          if (!file) {
            results.push(`❌ الملف \`${op.file_path}\` غير موجود`);
          } else {
            const preview = file.content.length > 2500
              ? file.content.slice(0, 2500) + '\n_...مقتطع_'
              : file.content;
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
          // استخدم المحتوى المقروء مسبقاً إذا توفر
          const existingData = fileContents[op.file_path]
            ? { content: fileContents[op.file_path], sha: null }
            : await readFile(op.file_path);

          const isUpdate = op.action === 'update' || !!existingData;

          // توليد المحتوى مع كامل السياق
          const content = await phase3_generate(
            op,
            existingData?.content || null,
            userMsg,
            history
          );

          if (!content || content.trim() === '') {
            results.push(`❌ فشل توليد محتوى \`${op.file_path}\`. أعد المحاولة.`);
            continue;
          }

          // إذا sha غير معروف، اجلبه
          let sha = existingData?.sha || null;
          if (!sha && existingData) {
            const fresh = await readFile(op.file_path);
            sha = fresh?.sha || null;
          }

          const url = await writeFile(op.file_path, content, op.commit_message, sha);
          const verb = isUpdate ? 'تعديل' : 'إضافة';
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
      `نفّذت: ${plan.explanation_ar}. الملفات: ${ops.map(o => o.file_path).join(', ')}`
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
    const isRateLimit = err.response?.status === 429;
    const msg = isRateLimit
      ? '⏳ تم تجاوز حد الطلبات. انتظر لحظة ثم أعد المحاولة.'
      : `❌ حدث خطأ:\n\`${err.response?.data?.message || err.message}\``;

    if (statusMsg) await safeEdit(ctx, statusMsg.message_id, msg).catch(() => {});
    else await ctx.reply(msg);
  }
});

module.exports = bot;
