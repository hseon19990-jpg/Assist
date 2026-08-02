const TelegramBot = require('node-telegram-bot-api');
const fetch       = require('node-fetch');
const fs          = require('fs');
const path        = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_ID  = parseInt(process.env.TELEGRAM_OWNER_ID, 10);
const AI_KEY = process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY;
const AI_TYPE = process.env.GEMINI_API_KEY ? 'gemini' : 'groq';

['TELEGRAM_BOT_TOKEN','TELEGRAM_OWNER_ID']
  .forEach(k => { if (!process.env[k]) throw new Error(`❌ المتغير ${k} مطلوب`); });
if (!AI_KEY) throw new Error('❌ يجب توفير GEMINI_API_KEY أو GROQ_API_KEY');

// ─── Persistent state (saved to state.json) ───────────────────────────────────
const STATE_FILE = path.join(__dirname, 'state.json');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { ghToken: null, ghOwner: null, ghRepo: null, ghBranch: 'main', pendingFile: null };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

let state = loadState();

// ─── Bot ──────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ─── Owner guard ──────────────────────────────────────────────────────────────
function isOwner(msg) { return msg.from.id === OWNER_ID; }

// ─── GitHub helpers ───────────────────────────────────────────────────────────
function ghHeaders(token) {
  return {
    Authorization : `token ${token}`,
    Accept        : 'application/vnd.github.v3+json',
    'User-Agent'  : 'tg-github-bot',
    'Content-Type': 'application/json',
  };
}

async function ghGetFile(filePath) {
  if (!state.ghToken || !state.ghOwner || !state.ghRepo) return null;
  const url = `https://api.github.com/repos/${state.ghOwner}/${state.ghRepo}/contents/${filePath}?ref=${state.ghBranch}`;
  const res = await fetch(url, { headers: ghHeaders(state.ghToken) });
  if (res.status === 404) return null;
  const data = await res.json();
  if (data.message) return null;
  return data;
}

async function ghListFiles(dir = '') {
  if (!state.ghToken || !state.ghOwner || !state.ghRepo) return [];
  const url = `https://api.github.com/repos/${state.ghOwner}/${state.ghRepo}/contents/${dir}?ref=${state.ghBranch}`;
  const res = await fetch(url, { headers: ghHeaders(state.ghToken) });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data.map(f => f.path) : [];
}

async function ghPushFile(filePath, contentBuffer, commitMsg, sha) {
  const body = {
    message: commitMsg,
    content: contentBuffer.toString('base64'),
    branch : state.ghBranch,
  };
  if (sha) body.sha = sha;

  const res = await fetch(
    `https://api.github.com/repos/${state.ghOwner}/${state.ghRepo}/contents/${filePath}`,
    { method: 'PUT', headers: ghHeaders(state.ghToken), body: JSON.stringify(body) }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `GitHub error ${res.status}`);
  return data;
}

// ─── AI helper (Gemini أو Groq تلقائياً) ─────────────────────────────────────
async function geminiChat(systemPrompt, userMessage) {
  if (AI_TYPE === 'gemini') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${AI_KEY}`;
    const res = await fetch(url, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({
        contents: [{ parts: [{ text: `${systemPrompt}\n\n${userMessage}` }] }],
        generationConfig: { temperature: 0.2 },
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `Gemini error ${res.status}`);
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
  } else {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method : 'POST',
      headers: { 'Authorization': `Bearer ${AI_KEY}`, 'Content-Type': 'application/json' },
      body   : JSON.stringify({
        model   : 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userMessage  },
        ],
        temperature: 0.2,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `Groq error ${res.status}`);
    return data.choices?.[0]?.message?.content?.trim() || '';
  }
}

// ─── Detect input type ────────────────────────────────────────────────────────
function detectInputType(text) {
  // GitHub token
  if (/^(ghp_|github_pat_|gho_|ghs_)[A-Za-z0-9_]+$/.test(text.trim())) {
    return 'gh_token';
  }
  // GitHub URL
  if (/github\.com\/([^\/]+)\/([^\/\s]+)/.test(text)) {
    return 'gh_url';
  }
  return 'arabic_instruction';
}

function parseGitHubUrl(text) {
  const match = text.match(/github\.com\/([^\/]+)\/([^\/\s\.]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/, '') };
}

// ─── Extract file path from Arabic text ───────────────────────────────────────
async function extractFileFromInstruction(instruction) {
  const prompt = `أنت مساعد ذكي. المستخدم أرسل تعليمات تعديل كود بالعربية.
استخرج اسم الملف أو المسار المذكور في التعليمات إن وُجد.
أجب فقط بمسار الملف مثل: index.js أو src/bot.js
إذا لم يُذكر ملف محدد، أجب بكلمة: لا_يوجد`;

  const result = await geminiChat(prompt, instruction);
  if (result === 'لا_يوجد' || result.includes('لا_يوجد')) return null;
  // clean up
  return result.replace(/[`\s]/g, '').split('\n')[0] || null;
}

// ─── Apply AI edit ────────────────────────────────────────────────────────────
async function applyEdit(chatId, filePath, instruction) {
  const statusMsg = await bot.sendMessage(chatId,
    `🔍 جاري جلب \`${filePath}\`...`, { parse_mode: 'Markdown' });

  try {
    const fileData   = await ghGetFile(filePath);
    const currentCode = fileData
      ? Buffer.from(fileData.content, 'base64').toString('utf8')
      : '';

    await bot.editMessageText('🤖 Gemini يفهم تعليماتك ويعدّل الكود...',
      { chat_id: chatId, message_id: statusMsg.message_id });

    const ext  = filePath.split('.').pop();
    const lang = { js:'JavaScript', py:'Python', ts:'TypeScript',
                   json:'JSON', md:'Markdown', html:'HTML', css:'CSS' }[ext] || ext;

    const systemPrompt = `أنت مبرمج محترف. ستعدّل كود ${lang}.
المستخدم سيعطيك الكود الحالي وتعليمات تعديل بالعربية.
طبّق التعديلات وأعد الكود الكامل المعدّل فقط بدون أي شرح أو ماركداون أو \`\`\`.
فقط الكود الخام مباشرة.`;

    const userMsg = currentCode
      ? `الكود الحالي:\n${currentCode}\n\nالتعديل المطلوب:\n${instruction}`
      : `أنشئ ملف ${filePath} جديد بناءً على التعليمات التالية:\n${instruction}`;

    const newCode = await geminiChat(systemPrompt, userMsg);

    await bot.editMessageText('📤 جاري الرفع على GitHub...',
      { chat_id: chatId, message_id: statusMsg.message_id });

    await ghPushFile(
      filePath,
      Buffer.from(newCode, 'utf8'),
      `✏️ ${instruction.slice(0, 72)} — via Telegram`,
      fileData?.sha
    );

    await bot.editMessageText(
      `✅ *تم التعديل!*\n\n📄 \`${filePath}\`\n🌿 \`${state.ghBranch}\``,
      { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' });

    // معاينة
    const preview = newCode.slice(0, 600);
    await bot.sendMessage(chatId,
      `\`\`\`\n${preview}${newCode.length > 600 ? '\n...' : ''}\n\`\`\``,
      { parse_mode: 'Markdown' });

  } catch (err) {
    await bot.editMessageText(`❌ ${err.message}`,
      { chat_id: chatId, message_id: statusMsg.message_id });
  }
}

// ─── /start ───────────────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  if (!isOwner(msg)) {
    return bot.sendMessage(msg.chat.id, '⛔ هذا البوت خاص.');
  }

  const repoStatus = state.ghOwner && state.ghRepo
    ? `✅ ${state.ghOwner}/${state.ghRepo} @ ${state.ghBranch}`
    : '❌ لم يُضبط بعد';

  bot.sendMessage(msg.chat.id, [
    '👋 *مرحباً!*',
    '',
    `🔗 الريبو الحالي: ${repoStatus}`,
    `🔑 GitHub Token: ${state.ghToken ? '✅ موجود' : '❌ غير موجود'}`,
    '',
    '━━━━━━━━━━━━━━━━━━━',
    '📌 *كيف أعمل:*',
    '',
    '1️⃣ أرسل *رابط الريبو* مثل:',
    '`https://github.com/username/repo`',
    '',
    '2️⃣ أرسل *توكن GitHub* يبدأ بـ `ghp_`',
    '',
    '3️⃣ اكتب أي *تعليمات بالعربي* وسأعدّل الكود تلقائياً ✨',
    '_مثال: في ملف index.js غير رسالة البداية لتقول أهلاً_',
  ].join('\n'), { parse_mode: 'Markdown' });
});

// ─── Main message handler ─────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  if (!isOwner(msg)) {
    return bot.sendMessage(msg.chat.id, '⛔ هذا البوت خاص.');
  }

  const text = msg.text.trim();
  const type = detectInputType(text);

  // ── GitHub Token ────────────────────────────────────────────────────────────
  if (type === 'gh_token') {
    state.ghToken = text.trim();
    saveState(state);
    return bot.sendMessage(msg.chat.id, '✅ تم حفظ توكن GitHub!');
  }

  // ── GitHub URL ──────────────────────────────────────────────────────────────
  if (type === 'gh_url') {
    const parsed = parseGitHubUrl(text);
    if (parsed) {
      state.ghOwner = parsed.owner;
      state.ghRepo  = parsed.repo;
      saveState(state);
      return bot.sendMessage(msg.chat.id,
        `✅ تم حفظ الريبو: \`${parsed.owner}/${parsed.repo}\``,
        { parse_mode: 'Markdown' });
    }
    return bot.sendMessage(msg.chat.id, '❌ لم أتعرف على الرابط، تأكد أنه رابط GitHub صحيح.');
  }

  // ── Arabic instruction ───────────────────────────────────────────────────────
  if (!state.ghToken || !state.ghOwner || !state.ghRepo) {
    return bot.sendMessage(msg.chat.id, [
      '⚠️ أرسل أولاً:',
      '1️⃣ رابط الريبو: `https://github.com/username/repo`',
      '2️⃣ توكن GitHub يبدأ بـ `ghp_`',
    ].join('\n'), { parse_mode: 'Markdown' });
  }

  // Waiting for file path?
  if (state.pendingFile) {
    const instruction  = state.pendingFile;
    state.pendingFile  = null;
    saveState(state);
    const filePath = text.trim();
    return applyEdit(msg.chat.id, filePath, instruction);
  }

  // Try to extract file from instruction
  const thinking = await bot.sendMessage(msg.chat.id, '🤔 أفهم تعليماتك...');
  let filePath = null;
  try {
    filePath = await extractFileFromInstruction(text);
  } catch (e) {
    // ignore
  }
  await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});

  if (filePath) {
    return applyEdit(msg.chat.id, filePath, text);
  }

  // Ask for file path
  state.pendingFile = text;
  saveState(state);
  return bot.sendMessage(msg.chat.id,
    '📄 أي ملف تريد تعديله؟\n_(مثال: `index.js` أو `src/bot.js`)_',
    { parse_mode: 'Markdown' });
});

// ─── Document upload ──────────────────────────────────────────────────────────
bot.on('document', async (msg) => {
  if (!isOwner(msg)) return;

  const doc = msg.document;
  if (!state.ghToken || !state.ghOwner) {
    return bot.sendMessage(msg.chat.id, '⚠️ أرسل رابط الريبو والتوكن أولاً.');
  }

  bot.sendMessage(msg.chat.id,
    `📁 استلمت: \`${doc.file_name}\`\n\nأرسل المسار في الريبو:\n_(مثال: \`src/bot.js\`)_`,
    { parse_mode: 'Markdown' });

  // store pending upload
  state.pendingUpload = { fileId: doc.file_id, fileName: doc.file_name };
  saveState(state);
});

// Handle path reply for uploads — integrated in main message handler above
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/') || !isOwner(msg)) return;
  if (!state.pendingUpload) return;

  const { fileId, fileName } = state.pendingUpload;
  const targetPath = msg.text.trim();
  if (detectInputType(targetPath) !== 'arabic_instruction') return; // not a path reply

  state.pendingUpload = null;
  saveState(state);

  const statusMsg = await bot.sendMessage(msg.chat.id, '⏳ جاري الرفع...');
  try {
    const link   = await bot.getFileLink(fileId);
    const res    = await fetch(link);
    const buffer = Buffer.from(await res.arrayBuffer());
    await ghPushFile(targetPath, buffer, `upload ${fileName} via Telegram`);
    await bot.editMessageText(
      `✅ *تم الرفع!*\n\n📄 \`${targetPath}\`\n🌿 \`${state.ghBranch}\``,
      { chat_id: msg.chat.id, message_id: statusMsg.message_id, parse_mode: 'Markdown' });
  } catch (err) {
    await bot.editMessageText(`❌ ${err.message}`,
      { chat_id: msg.chat.id, message_id: statusMsg.message_id });
  }
});

// ─── Errors ───────────────────────────────────────────────────────────────────
bot.on('polling_error', (err) => console.error('Polling:', err.message));

console.log('🤖 البوت يعمل');
