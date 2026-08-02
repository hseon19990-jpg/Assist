/**
 * بوت تيليجرام الذكي لتعديل GitHub
 * يستخدم Groq أو Gemini AI لفهم الطلبات وتنفيذها مباشرة
 */

const { Telegraf } = require('telegraf');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ============================================================
//  إعدادات البيئة
// ============================================================
const BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_ID     = parseInt(process.env.TELEGRAM_OWNER_ID || '0');
const GROQ_KEY     = process.env.GROQ_API_KEY;
const GEMINI_KEY   = process.env.GEMINI_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO  = process.env.GITHUB_REPO;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN غير موجود في متغيرات البيئة');
if (!GROQ_KEY && !GEMINI_KEY) throw new Error('يجب توفير GROQ_API_KEY أو GEMINI_API_KEY');

const AI_PROVIDER = GROQ_KEY ? 'groq' : 'gemini';

const FULL_REPO = `${GITHUB_OWNER}/${GITHUB_REPO}`;
const GH_HEADERS = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

// ============================================================
//  تخزين المسؤولين والسياق
// ============================================================
const ADMINS_FILE = path.join(__dirname, '..', 'admins.json');
const HISTORY_LIMIT = 8; // عدد الرسائل المحفوظة في السياق لكل مستخدم

function loadAdmins() {
  try {
    if (fs.existsSync(ADMINS_FILE)) {
      const data = JSON.parse(fs.readFileSync(ADMINS_FILE, 'utf8'));
      return new Set([OWNER_ID, ...data]);
    }
  } catch (_) {}
  return new Set([OWNER_ID]);
}

function saveAdmins(adminSet) {
  try {
    const data = [...adminSet].filter(id => id !== OWNER_ID);
    fs.writeFileSync(ADMINS_FILE, JSON.stringify(data), 'utf8');
  } catch (_) {}
}

const admins = loadAdmins();

// سياق المحادثة: userId → [{role, content}, ...]
const conversationHistory = new Map();

function addToHistory(userId, role, content) {
  if (!conversationHistory.has(userId)) {
    conversationHistory.set(userId, []);
  }
  const history = conversationHistory.get(userId);
  history.push({ role, content });
  // الاحتفاظ بآخر HISTORY_LIMIT رسالة فقط
  if (history.length > HISTORY_LIMIT) {
    history.splice(0, history.length - HISTORY_LIMIT);
  }
}

function getHistory(userId) {
  return conversationHistory.get(userId) || [];
}

// ============================================================
//  GitHub helpers
// ============================================================

async function getFileTree() {
  const url = `https://api.github.com/repos/${FULL_REPO}/git/trees/${GITHUB_BRANCH}?recursive=1`;
  const res = await axios.get(url, { headers: GH_HEADERS });
  return res.data.tree
    .filter(f => f.type === 'blob')
    .map(f => f.path);
}

async function readFile(filePath) {
  try {
    const url = `https://api.github.com/repos/${FULL_REPO}/contents/${filePath}?ref=${GITHUB_BRANCH}`;
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

async function writeFile(filePath, content, commitMsg, sha) {
  const url = `https://api.github.com/repos/${FULL_REPO}/contents/${filePath}`;
  const payload = {
    message: commitMsg || `Update ${filePath} via AI bot`,
    content: Buffer.from(content).toString('base64'),
    branch: GITHUB_BRANCH,
  };
  if (sha) payload.sha = sha;
  const res = await axios.put(url, payload, { headers: GH_HEADERS });
  return res.data.content?.html_url || '';
}

async function deleteFile(filePath, sha, commitMsg) {
  const url = `https://api.github.com/repos/${FULL_REPO}/contents/${filePath}`;
  await axios.delete(url, {
    headers: GH_HEADERS,
    data: { message: commitMsg || `Delete ${filePath}`, sha, branch: GITHUB_BRANCH },
  });
}

// ============================================================
//  استدعاء الذكاء الاصطناعي (Groq أو Gemini)
// ============================================================

async function callAI(messages, jsonMode = false) {
  if (AI_PROVIDER === 'groq') {
    const body = {
      model: 'llama-3.3-70b-versatile',
      messages,
      temperature: 0.1,
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

    // دمج system prompt مع أول رسالة
    const systemMsg = messages.find(m => m.role === 'system');
    if (systemMsg && geminiMessages.length > 0) {
      geminiMessages[0].parts[0].text = systemMsg.content + '\n\n' + geminiMessages[0].parts[0].text;
    }

    const body = {
      contents: geminiMessages,
      generationConfig: {
        temperature: 0.1,
        ...(jsonMode ? { responseMimeType: 'application/json' } : {}),
      },
    };

    const model = 'gemini-2.0-flash';
    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
      body,
      { headers: { 'Content-Type': 'application/json' } }
    );
    return res.data.candidates[0].content.parts[0].text.trim();
  }
}

// ============================================================
//  تحليل الطلب بالذكاء الاصطناعي
// ============================================================

async function understandRequest(userMessage, fileTree, userId) {
  const systemPrompt = `أنت مطور برمجيات خبير ومساعد ذكي لإدارة مستودعات GitHub.

المستودع الحالي: ${FULL_REPO} (فرع: ${GITHUB_BRANCH})

قائمة الملفات الموجودة في المستودع:
${fileTree.join('\n')}

مهمتك: تحليل طلب المستخدم وتحديد العمليات المطلوبة بدقة.

أجب حصراً بـ JSON بهذا الشكل (لا تضف أي نص خارج JSON):
{
  "operations": [
    {
      "action": "create" | "update" | "delete" | "read" | "list",
      "file_path": "مسار الملف",
      "content_instruction": "وصف دقيق لمحتوى الملف أو التعديل المطلوب",
      "commit_message": "رسالة الـ commit بالإنجليزي"
    }
  ],
  "needs_content_generation": true | false,
  "explanation_ar": "اشرح بالعربي ما ستفعله بجملة واحدة",
  "missing_info": "اذكر هنا إذا كانت المعلومات غير كافية لتنفيذ الطلب، وإلا اترك فارغاً"
}

قواعد مهمة:
- إذا طلب المستخدم تعديل ملف موجود، اذكر مسار الملف الصحيح من القائمة
- إذا طلب محتوى وصفياً (مثل "أضف flask")، ضع وصفاً واضحاً في content_instruction
- إذا الطلب غامض جداً، اطرح سؤالاً في missing_info
- يمكن أن تكون العمليات متعددة في طلب واحد
- action "list" لعرض الملفات، "read" لقراءة محتوى ملف`;

  const history = getHistory(userId);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userMessage },
  ];

  const raw = await callAI(messages, true);

  // تنظيف أي markdown حول JSON إذا أعادها النموذج
  const jsonText = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(jsonText);
}

// ============================================================
//  مصحح تلقائي للكود
// ============================================================
function sanitizeCode(code) {
  // إزالة markdown code fences
  code = code.replace(/^```[\w]*\n?/gm, '').replace(/^```$/gm, '').trim();

  // تصحيح template literals: أي string فيها ${...} يجب أن تكون backticks
  code = code.replace(
    /(['"])((?:[^'"\\]|\\.)*?\$\{(?:[^}]|\{[^}]*\})*\}(?:[^'"\\]|\\.)*?)\1/g,
    (match, quote, inner) => `\`${inner}\``
  );

  code = code.replace(
    /'((?:[^'\\]|\\.|\n)*?\$\{(?:[^}]|\{[^}]*\})*\}(?:[^'\\]|\\.|\n)*?)'/g,
    (match, inner) => `\`${inner}\``
  );
  code = code.replace(
    /"((?:[^"\\]|\\.|\n)*?\$\{(?:[^"\\]|\\.|\n)*?\}(?:[^"\\]|\\.|\n)*?)"/g,
    (match, inner) => `\`${inner}\``
  );

  return code;
}

async function generateFileContent(instruction, filePath, existingContent, userId) {
  const isJs = /\.(js|ts|jsx|tsx|mjs|cjs)$/.test(filePath);

  const systemMsg = isJs
    ? `أنت مطور Node.js خبير. أعطِ الكود فقط بدون شرح أو markdown code fences.
قواعد صارمة جداً:
- استخدم backtick (\`) للـ template literals التي فيها \${...} — وليس single quote أو double quote أبداً
- مثال صحيح: const x = \`hello \${name}\`;
- مثال خاطئ: const x = 'hello \${name}';
- حافظ على كل backtick موجود في الكود الأصلي كما هو`
    : 'أنت مطور خبير. أعطِ المحتوى فقط بدون شرح أو markdown.';

  const prompt = existingContent
    ? `الملف الحالي (${filePath}):\n${existingContent}\n\n---\nالتعديل المطلوب: ${instruction}\n\nأعطني الملف الكامل بعد التعديل فقط.`
    : `أنشئ ملف "${filePath}" بناءً على: ${instruction}\n\nأعطني المحتوى فقط.`;

  const history = getHistory(userId);
  const messages = [
    { role: 'system', content: systemMsg },
    ...history,
    { role: 'user', content: prompt },
  ];

  const raw = await callAI(messages, false);
  return isJs ? sanitizeCode(raw) : raw.replace(/^```[\w]*\n?/gm, '').replace(/^```$/gm, '').trim();
}

// ============================================================
//  إرسال رسائل طويلة بأمان
// ============================================================

/**
 * يقسم النص عند حدود الأسطر بدلاً من القطع العشوائي
 * لتفادي كسر صياغة Markdown
 */
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

/**
 * إرسال رسالة مع fallback لـ plain text إذا فشل Markdown
 */
async function safeSend(ctx, text, extra = {}) {
  try {
    return await ctx.reply(text, { parse_mode: 'Markdown', disable_web_page_preview: true, ...extra });
  } catch (_) {
    // إذا فشل Markdown، أرسل بدونه
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
    try {
      return await ctx.telegram.editMessageText(ctx.chat.id, messageId, null, text);
    } catch (__) {}
  }
}

// ============================================================
//  البوت
// ============================================================

const bot = new Telegraf(BOT_TOKEN);

// حماية: فقط المسؤولون يمكنهم استخدام البوت
bot.use(async (ctx, next) => {
  const uid = ctx.from?.id;
  if (!admins.has(uid)) {
    return ctx.reply('🚫 هذا البوت خاص.');
  }
  return next();
});

bot.start(ctx => safeSend(ctx,
  `مرحباً\\! أنا مساعدك الذكي لإدارة مستودع GitHub 🤖\n\n` +
  `*المستودع المربوط:* \`${FULL_REPO}\`\n` +
  `*الفرع:* \`${GITHUB_BRANCH}\`\n` +
  `*الذكاء الاصطناعي:* \`${AI_PROVIDER.toUpperCase()}\`\n\n` +
  `فقط أخبرني ماذا تريد بأي صيغة، مثلاً:\n\n` +
  `📝 \`أضف ملف requirements.txt فيه flask وrequests\`\n` +
  `✏️ \`عدّل index.js وأضف console.log في البداية\`\n` +
  `👁️ \`اقرأ ملف package.json\`\n` +
  `📋 \`اعرض كل الملفات\`\n` +
  `🗑️ \`احذف ملف old.js\`\n\n` +
  `لا تحتاج توكن أو رابط — كل شيء جاهز! ✅`
));

bot.help(ctx => safeSend(ctx,
  `*دليل الاستخدام:*\n\n` +
  `أرسل طلبك بالعربي أو الإنجليزي بأي صيغة تريد.\n\n` +
  `*أمثلة:*\n` +
  `• \`أضف ملف config.py فيه الإعدادات الأساسية\`\n` +
  `• \`عدّل README وأضف قسم التثبيت\`\n` +
  `• \`اعرض الملفات في مجلد src\`\n` +
  `• \`احذف ملف test.js\`\n` +
  `• \`أضف Docker support للمشروع\`\n\n` +
  `*/start* — الرسالة الرئيسية\n` +
  `*/repo* — معلومات المستودع\n` +
  `*/clear* — مسح سياق المحادثة\n` +
  `*/admin [ID]* — أضف مسؤول`
));

bot.command('repo', async ctx => {
  try {
    const res = await axios.get(
      `https://api.github.com/repos/${FULL_REPO}`,
      { headers: GH_HEADERS }
    );
    const d = res.data;
    await safeSend(ctx,
      `*📁 معلومات المستودع:*\n\n` +
      `🔗 \`${d.full_name}\`\n` +
      `🌿 الفرع: \`${GITHUB_BRANCH}\`\n` +
      `📝 الوصف: ${d.description || 'لا يوجد'}\n` +
      `🔒 ${d.private ? 'خاص' : 'عام'}\n` +
      `⭐ ${d.stargazers_count} نجمة\n` +
      `🔤 اللغة: ${d.language || 'متعددة'}\n` +
      `🤖 الذكاء الاصطناعي: ${AI_PROVIDER.toUpperCase()}`
    );
  } catch (e) {
    ctx.reply(`❌ خطأ في جلب معلومات المستودع: ${e.message}`);
  }
});

bot.command('clear', async ctx => {
  const uid = ctx.from?.id;
  conversationHistory.delete(uid);
  ctx.reply('🧹 تم مسح سياق المحادثة. ابدأ من جديد!');
});

bot.command('admin', async ctx => {
  const uid = ctx.from?.id;
  if (uid !== OWNER_ID) {
    return ctx.reply('🚫 فقط المالك يمكنه إضافة مسؤولين جدد.');
  }
  const newAdmin = ctx.message.text.split(' ')[1];
  if (!newAdmin || isNaN(parseInt(newAdmin))) {
    return ctx.reply('👉 يرجى ذكر معرف المستخدم الرقمي.\nمثال: /admin 123456789');
  }
  const newId = parseInt(newAdmin);
  if (admins.has(newId)) {
    return ctx.reply(`ℹ️ المستخدم ${newAdmin} مسؤول بالفعل.`);
  }
  admins.add(newId);
  saveAdmins(admins);
  ctx.reply(`✅ تمت إضافة المستخدم ${newAdmin} كمسؤول (محفوظ بشكل دائم).`);
});

bot.command('removeadmin', async ctx => {
  const uid = ctx.from?.id;
  if (uid !== OWNER_ID) {
    return ctx.reply('🚫 فقط المالك يمكنه إزالة المسؤولين.');
  }
  const targetId = parseInt(ctx.message.text.split(' ')[1]);
  if (!targetId || targetId === OWNER_ID) {
    return ctx.reply('👉 أدخل معرف المسؤول المراد إزالته (لا يمكن إزالة المالك).');
  }
  admins.delete(targetId);
  saveAdmins(admins);
  ctx.reply(`✅ تمت إزالة المستخدم ${targetId} من المسؤولين.`);
});

// ============================================================
//  معالجة الرسائل الرئيسية
// ============================================================

bot.on('text', async ctx => {
  const userMsg = ctx.message.text;
  // تجاهل الأوامر (لأن Telegraf قد يمررها هنا أيضاً)
  if (userMsg.startsWith('/')) return;

  const userId = ctx.from?.id;
  let statusMsg;

  try {
    statusMsg = await ctx.reply('🔍 جاري تحليل طلبك...');

    // جلب شجرة الملفات
    let fileTree = [];
    try {
      fileTree = await getFileTree();
    } catch (_) {
      // المستودع قد يكون فارغاً
    }

    // تحليل الطلب بالذكاء الاصطناعي
    const analysis = await understandRequest(userMsg, fileTree, userId);

    // حفظ رسالة المستخدم في السياق
    addToHistory(userId, 'user', userMsg);

    // إذا كانت المعلومات ناقصة
    if (analysis.missing_info && analysis.missing_info.trim()) {
      await safeEdit(ctx, statusMsg.message_id,
        `⚠️ *أحتاج توضيحاً:*\n\n${analysis.missing_info}`
      );
      addToHistory(userId, 'assistant', analysis.missing_info);
      return;
    }

    const ops = analysis.operations || [];
    if (!ops.length) {
      await safeEdit(ctx, statusMsg.message_id,
        `🤔 لم أفهم الطلب. حاول بصياغة أوضح مثل:\n\`أضف ملف x.py\` أو \`اعرض الملفات\``
      );
      return;
    }

    // إخبار المستخدم بما سيتم فعله
    await safeEdit(ctx, statusMsg.message_id,
      `⚙️ ${analysis.explanation_ar}\n\nجاري التنفيذ...`
    );

    const results = [];

    for (const op of ops) {
      try {
        if (op.action === 'list') {
          const tree = fileTree.length ? fileTree : await getFileTree();
          const filtered = op.file_path
            ? tree.filter(f => f.startsWith(op.file_path))
            : tree;
          const display = filtered.slice(0, 60).map(f => `📄 \`${f}\``).join('\n');
          results.push(
            `*📋 الملفات (${filtered.length}):*\n${display}` +
            (filtered.length > 60 ? `\n_...و ${filtered.length - 60} ملف آخر_` : '')
          );

        } else if (op.action === 'read') {
          const file = await readFile(op.file_path);
          if (!file) {
            results.push(`❌ الملف \`${op.file_path}\` غير موجود`);
          } else {
            const preview = file.content.length > 2500
              ? file.content.slice(0, 2500) + '\n\n_...تم اقتصار المحتوى_'
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
          const existing = await readFile(op.file_path);
          const isUpdate = op.action === 'update' || !!existing;

          let content;
          if (analysis.needs_content_generation) {
            content = await generateFileContent(
              op.content_instruction,
              op.file_path,
              existing?.content || null,
              userId
            );
          } else {
            content = op.content_instruction;
          }

          const url = await writeFile(
            op.file_path,
            content,
            op.commit_message,
            existing?.sha || null
          );

          const verb = isUpdate ? 'تعديل' : 'إضافة';
          results.push(
            `✅ تم ${verb} \`${op.file_path}\`\n` +
            `💬 Commit: \`${op.commit_message}\`\n` +
            (url ? `🔗 [فتح على GitHub](${url})` : '')
          );
        }
      } catch (opErr) {
        const errMsg = opErr.response?.data?.message || opErr.message;
        results.push(`❌ خطأ في \`${op.file_path || 'العملية'}\`: ${errMsg}`);
      }
    }

    // حفظ رد الذكاء الاصطناعي في السياق
    const summaryForHistory = results.map(r => r.replace(/\`\`\`[\s\S]*?\`\`\`/g, '[كود]')).join(' | ');
    addToHistory(userId, 'assistant', `${analysis.explanation_ar} — النتيجة: ${summaryForHistory}`);

    // إرسال النتائج
    const finalText = results.join('\n\n---\n\n');

    if (finalText.length > 4000) {
      await safeEdit(ctx, statusMsg.message_id, '✅ اكتملت العمليات:');
      const chunks = splitMessage(finalText);
      for (const chunk of chunks) {
        await safeSend(ctx, chunk);
      }
    } else {
      await safeEdit(ctx, statusMsg.message_id, finalText);
    }

  } catch (err) {
    console.error('Error:', err.response?.data || err.message);
    const errText = err.response?.data?.message || err.message;

    const isRateLimit = err.response?.status === 429;
    const userFriendly = isRateLimit
      ? '⏳ تم تجاوز حد الطلبات. انتظر لحظة ثم أعد المحاولة.'
      : `❌ حدث خطأ:\n\`${errText}\``;

    if (statusMsg) {
      await safeEdit(ctx, statusMsg.message_id, userFriendly).catch(() => {});
    } else {
      await ctx.reply(userFriendly);
    }
  }
});

module.exports = bot;
