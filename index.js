const TelegramBot = require('node-telegram-bot-api');
const fetch       = require('node-fetch');

// ─── Config ───────────────────────────────────────────────────────────────────
const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_ID   = parseInt(process.env.TELEGRAM_OWNER_ID, 10);
const GH_TOKEN   = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
const GH_OWNER   = process.env.GITHUB_OWNER;
const GH_REPO    = process.env.GITHUB_REPO;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
let   GH_BRANCH  = process.env.GITHUB_BRANCH || 'main';

['TELEGRAM_BOT_TOKEN','TELEGRAM_OWNER_ID','GITHUB_PERSONAL_ACCESS_TOKEN',
 'GITHUB_OWNER','GITHUB_REPO','OPENAI_API_KEY']
  .forEach(k => { if (!process.env[k]) throw new Error(`❌ المتغير ${k} مطلوب`); });

// ─── Bot Init ─────────────────────────────────────────────────────────────────
const bot          = new TelegramBot(BOT_TOKEN, { polling: true });
const pendingFiles = {};   // waiting for repo path after file upload
const pendingAI    = {};   // waiting for file path after /ai instruction

// ─── Owner guard ──────────────────────────────────────────────────────────────
const isOwner = (msg) => msg.from.id === OWNER_ID;

function ownerOnly(handler) {
  return (msg, match) => {
    if (!isOwner(msg)) {
      return bot.sendMessage(msg.chat.id,
        '⛔ هذا البوت خاص.\nلا يُسمح لك باستخدامه.');
    }
    return handler(msg, match);
  };
}

// ─── GitHub helpers ───────────────────────────────────────────────────────────
function ghHeaders() {
  return {
    Authorization: `token ${GH_TOKEN}`,
    Accept       : 'application/vnd.github.v3+json',
    'User-Agent' : 'tg-github-bot',
    'Content-Type': 'application/json',
  };
}

async function ghGetFile(filePath) {
  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${filePath}?ref=${GH_BRANCH}`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (res.status === 404) return null;
  const data = await res.json();
  return data; // { sha, content (base64), encoding }
}

async function ghPushFile(filePath, contentBuffer, commitMsg, sha) {
  if (!sha) {
    // fetch sha if not provided
    const existing = await ghGetFile(filePath);
    sha = existing ? existing.sha : undefined;
  }
  const body = {
    message: commitMsg,
    content: contentBuffer.toString('base64'),
    branch : GH_BRANCH,
  };
  if (sha) body.sha = sha;

  const res = await fetch(
    `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${filePath}`,
    { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `GitHub error ${res.status}`);
  return data;
}

// ─── OpenAI helper ────────────────────────────────────────────────────────────
async function applyAIEdit(currentCode, arabicInstruction, filePath) {
  const ext  = filePath.split('.').pop();
  const lang = { js:'JavaScript', py:'Python', ts:'TypeScript',
                 json:'JSON', md:'Markdown' }[ext] || ext;

  const systemPrompt = `أنت مساعد مبرمج محترف.
المستخدم سيعطيك كود ${lang} موجود وتعليمات تعديل باللغة العربية.
قم بتطبيق التعديلات المطلوبة وأعد الكود الكامل المعدّل فقط بدون أي شرح أو تعليق خارج الكود.
لا تضع الكود داخل \`\`\` - فقط الكود الخام مباشرة.`;

  const userPrompt = `الملف: ${filePath}

الكود الحالي:
${currentCode}

التعديل المطلوب:
${arabicInstruction}`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method : 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_KEY}`,
      'Content-Type' : 'application/json',
    },
    body: JSON.stringify({
      model      : 'gpt-4o',
      messages   : [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
      temperature: 0.2,
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `OpenAI error ${res.status}`);
  return data.choices[0].message.content.trim();
}

// ─── /start ───────────────────────────────────────────────────────────────────
bot.onText(/\/start/, ownerOnly((msg) => {
  bot.sendMessage(msg.chat.id, [
    '👋 *مرحباً! أنا بوتك لتعديل الكود على GitHub*',
    '',
    '━━━━━━━━━━━━━━━━━━━',
    '🤖 *تعديل بالعربي (الجديد!)*',
    'اكتب `/ai` ثم اسم الملف وتعليماتك:',
    '```',
    '/ai',
    'ملف: src/index.js',
    'غير رسالة الترحيب لتقول: أهلاً بك!',
    '```',
    'سيفهم GPT-4 تعليماتك ويعدّل الكود تلقائياً ✨',
    '',
    '━━━━━━━━━━━━━━━━━━━',
    '📁 *رفع ملف مباشر*',
    'أرسل أي ملف وسأسألك عن مساره.',
    '',
    '✏️ *رفع محتوى نصي*',
    '```',
    '/push',
    'path: src/file.js',
    'message: وصف التعديل',
    '---',
    'محتوى الملف هنا',
    '```',
    '',
    '📊 */status* | 🌿 */branch <اسم>* | ❌ */cancel*',
  ].join('\n'), { parse_mode: 'Markdown' });
}));

// ─── /status ──────────────────────────────────────────────────────────────────
bot.onText(/\/status/, ownerOnly((msg) => {
  bot.sendMessage(msg.chat.id, [
    '📊 *الإعدادات الحالية:*',
    '',
    `🔗 الريبو: \`${GH_OWNER}/${GH_REPO}\``,
    `🌿 Branch: \`${GH_BRANCH}\``,
    `✅ GitHub Token: موجود`,
    `✅ OpenAI: موجود`,
  ].join('\n'), { parse_mode: 'Markdown' });
}));

// ─── /branch ──────────────────────────────────────────────────────────────────
bot.onText(/\/branch (.+)/, ownerOnly((msg, match) => {
  GH_BRANCH = match[1].trim();
  bot.sendMessage(msg.chat.id,
    `✅ تم تغيير الفرع إلى: \`${GH_BRANCH}\`\n_(مؤقت — لتثبيته غيّر GITHUB\\_BRANCH في Railway)_`,
    { parse_mode: 'Markdown' });
}));

// ─── /cancel ──────────────────────────────────────────────────────────────────
bot.onText(/\/cancel/, ownerOnly((msg) => {
  const uid = msg.from.id;
  if (pendingFiles[uid] || pendingAI[uid]) {
    delete pendingFiles[uid];
    delete pendingAI[uid];
    bot.sendMessage(msg.chat.id, '✅ تم إلغاء العملية.');
  } else {
    bot.sendMessage(msg.chat.id, 'لا توجد عملية جارية.');
  }
}));

// ─── /ai : Arabic natural-language edit ───────────────────────────────────────
bot.onText(/^\/ai(\n[\s\S]*)?$/, ownerOnly(async (msg) => {
  const lines = (msg.text || '').split('\n');

  let filePath    = null;
  let instruction = '';
  let bodyStart   = 1;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.toLowerCase().startsWith('ملف:') || line.toLowerCase().startsWith('file:')) {
      filePath  = line.split(':').slice(1).join(':').trim();
      bodyStart = i + 1;
    }
  }

  instruction = lines.slice(bodyStart).join('\n').trim();

  // ── Case 1: no file path → ask ────────────────────────────────────────────
  if (!filePath) {
    if (!instruction) {
      return bot.sendMessage(msg.chat.id, [
        '📝 اكتب تعليماتك بهذا الشكل:',
        '```',
        '/ai',
        'ملف: src/index.js',
        'التعديل الذي تريده بالعربي',
        '```',
      ].join('\n'), { parse_mode: 'Markdown' });
    }
    pendingAI[msg.from.id] = { instruction };
    return bot.sendMessage(msg.chat.id,
      `✏️ فهمت التعليمات.\n\nأرسل الآن *مسار الملف* الذي تريد تعديله:\n_(مثال: \`src/index.js\`)_\n\nأو /cancel للإلغاء`,
      { parse_mode: 'Markdown' });
  }

  // ── Case 2: have both file + instruction ──────────────────────────────────
  if (!instruction) {
    return bot.sendMessage(msg.chat.id,
      '❌ لم أجد التعليمات! اكتب ما تريد تغييره بعد اسم الملف.');
  }

  await runAIEdit(msg.chat.id, filePath, instruction);
}));

// ─── Core AI edit function ────────────────────────────────────────────────────
async function runAIEdit(chatId, filePath, instruction) {
  const statusMsg = await bot.sendMessage(chatId,
    `🔍 جاري جلب الملف \`${filePath}\`...`, { parse_mode: 'Markdown' });

  try {
    // 1. Fetch current file
    const fileData = await ghGetFile(filePath);
    let currentCode = '';
    if (fileData) {
      currentCode = Buffer.from(fileData.content, 'base64').toString('utf8');
    } else {
      currentCode = '// ملف جديد';
    }

    await bot.editMessageText(
      `🤖 GPT-4 يقرأ التعليمات ويعدّل الكود...`,
      { chat_id: chatId, message_id: statusMsg.message_id });

    // 2. Apply AI edit
    const newCode = await applyAIEdit(currentCode, instruction, filePath);

    await bot.editMessageText(
      `📤 جاري الرفع على GitHub...`,
      { chat_id: chatId, message_id: statusMsg.message_id });

    // 3. Push to GitHub
    const sha = fileData ? fileData.sha : undefined;
    await ghPushFile(
      filePath,
      Buffer.from(newCode, 'utf8'),
      `✏️ ${instruction.slice(0, 60)} — via Telegram AI`,
      sha
    );

    await bot.editMessageText(
      `✅ *تم التعديل بنجاح!*\n\n📄 \`${filePath}\`\n🌿 \`${GH_BRANCH}\`\n\n💬 *التعديل:*\n${instruction}`,
      { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' });

    // Show preview of change
    const preview = newCode.slice(0, 800);
    await bot.sendMessage(chatId,
      `👁 *معاينة الكود المعدّل:*\n\`\`\`\n${preview}${newCode.length > 800 ? '\n...' : ''}\n\`\`\``,
      { parse_mode: 'Markdown' });

  } catch (err) {
    await bot.editMessageText(
      `❌ فشل التعديل: ${err.message}`,
      { chat_id: chatId, message_id: statusMsg.message_id });
  }
}

// ─── /push : text-based file upload ───────────────────────────────────────────
bot.onText(/^\/push(\n[\s\S]*)?$/, ownerOnly(async (msg) => {
  const lines = (msg.text || '').split('\n');

  let filePath     = null;
  let commitMsg    = null;
  let contentStart = -1;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.toLowerCase().startsWith('path:'))    filePath  = line.slice(5).trim();
    else if (line.toLowerCase().startsWith('message:')) commitMsg = line.slice(8).trim();
    else if (line === '---') { contentStart = i + 1; break; }
  }

  if (!filePath) {
    return bot.sendMessage(msg.chat.id,
      '❌ لم أجد مسار الملف.\nأضف: `path: src/file.js`', { parse_mode: 'Markdown' });
  }
  if (contentStart === -1) {
    return bot.sendMessage(msg.chat.id,
      '❌ أضف سطر `---` ثم المحتوى بعده.', { parse_mode: 'Markdown' });
  }

  const content = lines.slice(contentStart).join('\n');
  if (!content.trim()) {
    return bot.sendMessage(msg.chat.id, '❌ المحتوى فارغ!');
  }

  const cm = commitMsg || `update ${filePath} via Telegram`;
  const statusMsg = await bot.sendMessage(msg.chat.id, '⏳ جاري الرفع...');
  try {
    await ghPushFile(filePath, Buffer.from(content, 'utf8'), cm);
    await bot.editMessageText(
      `✅ *تم الرفع!*\n\n📄 \`${filePath}\`\n🌿 \`${GH_BRANCH}\`\n💬 ${cm}`,
      { chat_id: msg.chat.id, message_id: statusMsg.message_id, parse_mode: 'Markdown' });
  } catch (err) {
    await bot.editMessageText(`❌ فشل: ${err.message}`,
      { chat_id: msg.chat.id, message_id: statusMsg.message_id });
  }
}));

// ─── Document upload ──────────────────────────────────────────────────────────
bot.on('document', ownerOnly((msg) => {
  const doc = msg.document;
  pendingFiles[msg.from.id] = { fileId: doc.file_id, fileName: doc.file_name };
  bot.sendMessage(msg.chat.id,
    `📁 استلمت: \`${doc.file_name}\`\n\nأرسل المسار في الريبو:\n_(مثال: \`src/commands/start.js\`)_\n\nأو /cancel`,
    { parse_mode: 'Markdown' });
}));

// ─── Text messages: handle pending states ─────────────────────────────────────
bot.on('message', ownerOnly(async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const uid = msg.from.id;

  // State: waiting for file path after /ai instruction
  if (pendingAI[uid]) {
    const { instruction } = pendingAI[uid];
    const filePath = msg.text.trim();
    delete pendingAI[uid];
    return runAIEdit(msg.chat.id, filePath, instruction);
  }

  // State: waiting for repo path after file upload
  if (pendingFiles[uid]) {
    const { fileId, fileName } = pendingFiles[uid];
    const targetPath = msg.text.trim();
    delete pendingFiles[uid];

    const statusMsg = await bot.sendMessage(msg.chat.id, '⏳ جاري تحميل الملف ورفعه...');
    try {
      const link   = await bot.getFileLink(fileId);
      const res    = await fetch(link);
      const buffer = Buffer.from(await res.arrayBuffer());
      await ghPushFile(targetPath, buffer, `upload ${fileName} via Telegram`);
      await bot.editMessageText(
        `✅ *تم الرفع!*\n\n📄 \`${targetPath}\`\n🌿 \`${GH_BRANCH}\``,
        { chat_id: msg.chat.id, message_id: statusMsg.message_id, parse_mode: 'Markdown' });
    } catch (err) {
      await bot.editMessageText(`❌ فشل: ${err.message}`,
        { chat_id: msg.chat.id, message_id: statusMsg.message_id });
    }
  }
}));

// ─── Error handling ───────────────────────────────────────────────────────────
bot.on('polling_error', (err) => console.error('Polling error:', err.message));

console.log(`🤖 البوت يعمل | ${GH_OWNER}/${GH_REPO} @ ${GH_BRANCH}`);
