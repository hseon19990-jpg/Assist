const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');

// ─── Config ───────────────────────────────────────────────────────────────────
const BOT_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_ID    = parseInt(process.env.TELEGRAM_OWNER_ID, 10);
const GH_TOKEN    = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
const GH_OWNER    = process.env.GITHUB_OWNER;   // مثال: hseon19990-jpg
const GH_REPO     = process.env.GITHUB_REPO;    // مثال: Assist
let   GH_BRANCH   = process.env.GITHUB_BRANCH || 'main';

['TELEGRAM_BOT_TOKEN','TELEGRAM_OWNER_ID','GITHUB_PERSONAL_ACCESS_TOKEN','GITHUB_OWNER','GITHUB_REPO']
  .forEach(k => { if (!process.env[k]) throw new Error(`❌ المتغير ${k} مطلوب`); });

// ─── Bot Init ─────────────────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const pendingFiles = {}; // fileId waiting for path reply

// ─── Helpers ──────────────────────────────────────────────────────────────────
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

async function ghGetSha(filePath) {
  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${filePath}?ref=${GH_BRANCH}`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (res.status === 404) return null;
  const data = await res.json();
  return data.sha || null;
}

async function ghPushFile(filePath, contentBuffer, commitMsg) {
  const sha = await ghGetSha(filePath);
  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${filePath}`;
  const body = {
    message : commitMsg,
    content : contentBuffer.toString('base64'),
    branch  : GH_BRANCH,
  };
  if (sha) body.sha = sha;

  const res = await fetch(url, {
    method  : 'PUT',
    headers : { ...ghHeaders(), 'Content-Type': 'application/json' },
    body    : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `GitHub error ${res.status}`);
  return data;
}

function ghHeaders() {
  return {
    Authorization: `token ${GH_TOKEN}`,
    Accept       : 'application/vnd.github.v3+json',
    'User-Agent' : 'tg-github-bot',
  };
}

// ─── Commands ─────────────────────────────────────────────────────────────────

bot.onText(/\/start/, ownerOnly((msg) => {
  bot.sendMessage(msg.chat.id, [
    '👋 *مرحباً! أنا بوت رفع الملفات إلى GitHub*',
    '',
    '━━━━━━━━━━━━━━━━━━━',
    '📁 *رفع ملف مباشرة*',
    'أرسل أي ملف وسأسألك عن مساره في الريبو.',
    '',
    '✏️ *رفع محتوى نصي*',
    'أرسل الأمر `/push` بالتنسيق التالي:',
    '```',
    '/push',
    'path: src/bot.js',
    'message: تحديث دالة البداية',
    '---',
    'محتوى الملف كاملاً هنا',
    '```',
    '',
    '🌿 */branch <اسم>* — تغيير الفرع مؤقتاً',
    '📊 */status* — عرض الإعدادات',
    '❌ */cancel* — إلغاء العملية الحالية',
  ].join('\n'), { parse_mode: 'Markdown' });
}));

bot.onText(/\/status/, ownerOnly((msg) => {
  bot.sendMessage(msg.chat.id, [
    '📊 *الإعدادات الحالية:*',
    '',
    `🔗 الريبو: \`${GH_OWNER}/${GH_REPO}\``,
    `🌿 Branch: \`${GH_BRANCH}\``,
    `✅ GitHub Token: موجود`,
  ].join('\n'), { parse_mode: 'Markdown' });
}));

bot.onText(/\/branch (.+)/, ownerOnly((msg, match) => {
  GH_BRANCH = match[1].trim();
  bot.sendMessage(msg.chat.id,
    `✅ تم تغيير الفرع إلى: \`${GH_BRANCH}\`\n_(مؤقت حتى إعادة التشغيل — لتثبيته غيّر GITHUB\\_BRANCH في Railway)_`,
    { parse_mode: 'Markdown' });
}));

bot.onText(/\/cancel/, ownerOnly((msg) => {
  if (pendingFiles[msg.from.id]) {
    delete pendingFiles[msg.from.id];
    bot.sendMessage(msg.chat.id, '✅ تم إلغاء العملية.');
  } else {
    bot.sendMessage(msg.chat.id, 'لا توجد عملية جارية.');
  }
}));

// ─── /push: text-based file upload ────────────────────────────────────────────
bot.onText(/^\/push(\n[\s\S]*)?$/, ownerOnly(async (msg) => {
  const text  = msg.text || '';
  const lines = text.split('\n');

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
      '❌ لم أجد مسار الملف.\nأضف سطر: `path: src/file.js`', { parse_mode: 'Markdown' });
  }
  if (contentStart === -1) {
    return bot.sendMessage(msg.chat.id,
      '❌ لم أجد المحتوى.\nأضف سطر `---` ثم المحتوى بعده.', { parse_mode: 'Markdown' });
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
      `✅ *تم الرفع بنجاح!*\n\n📄 \`${filePath}\`\n🌿 \`${GH_BRANCH}\`\n💬 ${cm}`,
      { chat_id: msg.chat.id, message_id: statusMsg.message_id, parse_mode: 'Markdown' });
  } catch (err) {
    await bot.editMessageText(`❌ فشل الرفع: ${err.message}`,
      { chat_id: msg.chat.id, message_id: statusMsg.message_id });
  }
}));

// ─── Document: file upload ─────────────────────────────────────────────────────
bot.on('document', ownerOnly((msg) => {
  const doc = msg.document;
  pendingFiles[msg.from.id] = { fileId: doc.file_id, fileName: doc.file_name };
  bot.sendMessage(msg.chat.id,
    `📁 استلمت: \`${doc.file_name}\`\n\nأرسل المسار الكامل في الريبو:\n_(مثال: \`src/commands/start.js\`)_\n\nأو /cancel للإلغاء`,
    { parse_mode: 'Markdown' });
}));

// ─── Text reply: path for pending file ────────────────────────────────────────
bot.on('message', ownerOnly(async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  if (!pendingFiles[msg.from.id]) return;

  const { fileId, fileName } = pendingFiles[msg.from.id];
  const targetPath = msg.text.trim();
  delete pendingFiles[msg.from.id];

  const statusMsg = await bot.sendMessage(msg.chat.id, '⏳ جاري تحميل الملف ورفعه...');
  try {
    const link   = await bot.getFileLink(fileId);
    const res    = await fetch(link);
    const buffer = Buffer.from(await res.arrayBuffer());
    await ghPushFile(targetPath, buffer, `upload ${fileName} via Telegram`);
    await bot.editMessageText(
      `✅ *تم الرفع بنجاح!*\n\n📄 \`${targetPath}\`\n🌿 \`${GH_BRANCH}\``,
      { chat_id: msg.chat.id, message_id: statusMsg.message_id, parse_mode: 'Markdown' });
  } catch (err) {
    await bot.editMessageText(`❌ فشل الرفع: ${err.message}`,
      { chat_id: msg.chat.id, message_id: statusMsg.message_id });
  }
}));

// ─── Error handling ───────────────────────────────────────────────────────────
bot.on('polling_error', (err) => console.error('Polling error:', err.message));

console.log(`🤖 البوت يعمل | ${GH_OWNER}/${GH_REPO} @ ${GH_BRANCH}`);
