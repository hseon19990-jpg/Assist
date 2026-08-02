const TelegramBot = require('node-telegram-bot-api');
const fetch       = require('node-fetch');
const fs          = require('fs');
const path        = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_ID  = parseInt(process.env.TELEGRAM_OWNER_ID, 10);
const AI_KEY = process.env.GROQ_API_KEY;
    if (!AI_KEY) throw new Error('❌ GROQ_API_KEY مطلوب — احصل عليه من https://console.groq.com');

// ─── Persistent state ─────────────────────────────────────────────────────────
const STATE_FILE = path.join(__dirname, 'state.json');

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { ghToken: null, ghOwner: null, ghRepo: null, ghBranch: 'main', pendingFile: null }; }
}
function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
}

let state = loadState();

// ─── Conversation history (per user, in memory) ───────────────────────────────
const history = {}; // { userId: [ {role, content}, ... ] }

function getHistory(uid) {
  if (!history[uid]) history[uid] = [];
  return history[uid];
}
function addToHistory(uid, role, content) {
  const h = getHistory(uid);
  h.push({ role, content });
  if (h.length > 20) h.splice(0, 2); // keep last 20 messages
}

// ─── Bot ──────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ─── Owner guard ──────────────────────────────────────────────────────────────
function isOwner(msg) { return msg.from.id === OWNER_ID; }

// ─── AI call (Groq) ──────────────────────────────────────────────────────────
    async function aiCall(systemPrompt, userMessage, conversationHistory = []) {
    const messages = [{ role: 'system', content: systemPrompt }];
    for (const m of conversationHistory) messages.push({ role: m.role, content: m.content });
    messages.push({ role: 'user', content: userMessage });

    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method : 'POST',
      headers: { 'Authorization': `Bearer ${AI_KEY}`, 'Content-Type': 'application/json' },
      body   : JSON.stringify({ model: 'llama-3.3-70b-versatile', messages, temperature: 0.7 }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error?.message || `Groq error ${res.status}`);
    return d.choices?.[0]?.message?.content?.trim() || '';
    }

// ─── GitHub helpers ───────────────────────────────────────────────────────────
function ghHeaders() {
  return {
    Authorization : `token ${state.ghToken}`,
    Accept        : 'application/vnd.github.v3+json',
    'User-Agent'  : 'tg-github-bot',
    'Content-Type': 'application/json',
  };
}

async function ghGetFile(filePath) {
  if (!state.ghToken || !state.ghOwner || !state.ghRepo) return null;
  const url = `https://api.github.com/repos/${state.ghOwner}/${state.ghRepo}/contents/${filePath}?ref=${state.ghBranch}`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (!res.ok) return null;
  const data = await res.json();
  return data.message ? null : data;
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
    { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `GitHub error ${res.status}`);
  return data;
}

// ─── Detect if message is GitHub URL or token ────────────────────────────────
function detectSpecial(text) {
  if (/github\.com\/([^\/\s]+)\/([^\/\s]+)/.test(text)) return 'gh_url';
  if (/^(ghp_|github_pat_|gho_|ghs_)[A-Za-z0-9_]+$/.test(text.trim())) return 'gh_token';
  return null;
}

function parseGitHubUrl(text) {
  const m = text.match(/github\.com\/([^\/\s]+)\/([^\/\s\.]+)/);
  return m ? { owner: m[1], repo: m[2].replace(/\.git$/, '') } : null;
}

// ─── Intent detection via AI ──────────────────────────────────────────────────
async function detectIntent(text) {
  const prompt = `أنت مساعد ذكي. صنّف هذه الرسالة في فئة واحدة:

- "code_edit": المستخدم يريد تعديل كود، تغيير ملف، رفع تعديلات لـ GitHub، إنشاء ملف جديد
- "file_ask": المستخدم يسأل عن اسم ملف أو مسار فقط (رد على سؤال سابق)
- "chat": أي شيء آخر — سؤال، محادثة، طلب مساعدة، شرح، رأي

الرسالة: """${text}"""

أجب بكلمة واحدة فقط.`;

  const r = await aiCall(prompt, '');
  if (r.includes('code_edit')) return 'code_edit';
  if (r.includes('file_ask'))  return 'file_ask';
  return 'chat';
}

// ─── Extract file path from Arabic instruction ────────────────────────────────
async function extractFile(instruction) {
  const r = await aiCall(
    `استخرج مسار الملف المذكور في التعليمات. أجب بمسار الملف فقط مثل index.js أو src/bot.js. إذا لم يُذكر ملف أجب بـ: لا_يوجد`,
    instruction
  );
  return r.includes('لا_يوجد') ? null : r.replace(/[`\s]/g, '').split('\n')[0] || null;
}

// ─── Apply code edit ──────────────────────────────────────────────────────────
async function applyEdit(chatId, filePath, instruction) {
  const statusMsg = await bot.sendMessage(chatId, `⏳ جاري تعديل \`${filePath}\`...`, { parse_mode: 'Markdown' });
  try {
    const fileData    = await ghGetFile(filePath);
    const currentCode = fileData ? Buffer.from(fileData.content, 'base64').toString('utf8') : '';
    const ext  = filePath.split('.').pop();
    const lang = { js:'JavaScript', py:'Python', ts:'TypeScript', json:'JSON', md:'Markdown', html:'HTML', css:'CSS' }[ext] || ext;

    const newCode = await aiCall(
      `أنت مبرمج محترف. عدّل كود ${lang} بناءً على التعليمات. أعد الكود الكامل المعدّل فقط بدون أي شرح أو \`\`\`.`,
      currentCode
        ? `الكود الحالي:\n${currentCode}\n\nالتعديل:\n${instruction}`
        : `أنشئ ملف ${filePath} جديد بناءً على: ${instruction}`
    );

    await ghPushFile(filePath, Buffer.from(newCode, 'utf8'),
      `✏️ ${instruction.slice(0, 60)} — via Telegram`, fileData?.sha);

    await bot.editMessageText(
      `✅ تم تعديل \`${filePath}\` ورفعه على GitHub!`,
      { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' });

    const preview = newCode.slice(0, 500);
    await bot.sendMessage(chatId,
      `\`\`\`\n${preview}${newCode.length > 500 ? '\n...' : ''}\n\`\`\``,
      { parse_mode: 'Markdown' });
  } catch (err) {
    await bot.editMessageText(`❌ ${err.message}`,
      { chat_id: chatId, message_id: statusMsg.message_id });
  }
}

// ─── /start ───────────────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  if (!isOwner(msg)) return bot.sendMessage(msg.chat.id, '⛔ هذا البوت خاص.');

  const repoInfo = state.ghOwner
    ? `✅ ${state.ghOwner}/${state.ghRepo} @ ${state.ghBranch}`
    : '❌ لم يُضبط بعد';

  bot.sendMessage(msg.chat.id, [
    '👋 *مرحباً! كيف يمكنني مساعدتك؟*',
    '',
    'تكلّم معي بالعربي بشكل طبيعي 💬',
    'وعندما تريد تعديل كود أو رفعه على GitHub، فقط أخبرني.',
    '',
    `🔗 الريبو الحالي: ${repoInfo}`,
    `🤖 الذكاء الاصطناعي: Groq (Llama 3.3) ✅`,
    '',
    '_لتغيير الريبو: أرسل رابط GitHub الجديد_',
    '_لتغيير التوكن: أرسل توكن ghp\\_ الجديد_',
  ].join('\n'), { parse_mode: 'Markdown' });
});

// ─── /clear — reset conversation ──────────────────────────────────────────────
bot.onText(/\/clear/, (msg) => {
  if (!isOwner(msg)) return;
  history[msg.from.id] = [];
  bot.sendMessage(msg.chat.id, '🗑️ تم مسح سجل المحادثة.');
});

// ─── Main message handler ─────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  if (!isOwner(msg)) return bot.sendMessage(msg.chat.id, '⛔ هذا البوت خاص.');

  const uid  = msg.from.id;
  const text = msg.text.trim();

  // ── GitHub URL ──────────────────────────────────────────────────────────────
  const special = detectSpecial(text);
  if (special === 'gh_url') {
    const parsed = parseGitHubUrl(text);
    if (parsed) {
      state.ghOwner = parsed.owner;
      state.ghRepo  = parsed.repo;
      saveState(state);
      return bot.sendMessage(msg.chat.id,
        `✅ تم حفظ الريبو: \`${parsed.owner}/${parsed.repo}\``, { parse_mode: 'Markdown' });
    }
  }

  // ── GitHub Token ────────────────────────────────────────────────────────────
  if (special === 'gh_token') {
    state.ghToken = text;
    saveState(state);
    return bot.sendMessage(msg.chat.id, '✅ تم حفظ توكن GitHub!');
  }

  // ── Waiting for file path (from previous code_edit without file) ──────────
  if (state.pendingInstruction) {
    const instruction      = state.pendingInstruction;
    state.pendingInstruction = null;
    saveState(state);
    // treat this message as the file path
    if (text.includes('.') && !text.includes(' ')) {
      return applyEdit(msg.chat.id, text, instruction);
    }
  }

  // ── Detect intent ───────────────────────────────────────────────────────────
  await bot.sendChatAction(msg.chat.id, 'typing');

  let intent = 'chat';
  try { intent = await detectIntent(text); } catch {}

  // ── Code edit ───────────────────────────────────────────────────────────────
  if (intent === 'code_edit') {
    if (!state.ghToken || !state.ghOwner) {
      return bot.sendMessage(msg.chat.id,
        '⚠️ أرسل رابط الريبو وتوكن GitHub أولاً لأتمكن من رفع التعديلات.');
    }
    let filePath = null;
    try { filePath = await extractFile(text); } catch {}

    if (filePath) {
      return applyEdit(msg.chat.id, filePath, text);
    } else {
      state.pendingInstruction = text;
      saveState(state);
      return bot.sendMessage(msg.chat.id,
        '📄 أي ملف تريد تعديله؟ _(مثال: index.js)_', { parse_mode: 'Markdown' });
    }
  }

  // ── General chat ────────────────────────────────────────────────────────────
  try {
    const h = getHistory(uid);
    const reply = await aiCall(
      `أنت مساعد ذكي ومفيد. تتحدث باللغة العربية بشكل طبيعي ومريح.
تجيب على الأسئلة، تشرح المفاهيم، تساعد في البرمجة، وتتحاور بشكل ودي.
اجعل ردودك مختصرة وواضحة إلا إذا طُلب منك التفصيل.`,
      text,
      h
    );
    addToHistory(uid, 'user', text);
    addToHistory(uid, 'assistant', reply);
    await bot.sendMessage(msg.chat.id, reply, { parse_mode: 'Markdown' }).catch(() =>
      bot.sendMessage(msg.chat.id, reply) // fallback without markdown
    );
  } catch (err) {
    bot.sendMessage(msg.chat.id, `❌ خطأ: ${err.message}`);
  }
});

// ─── Document upload ──────────────────────────────────────────────────────────
bot.on('document', async (msg) => {
  if (!isOwner(msg)) return;
  const doc = msg.document;
  if (!state.ghToken || !state.ghOwner) {
    return bot.sendMessage(msg.chat.id, '⚠️ أرسل رابط الريبو والتوكن أولاً.');
  }
  state.pendingUpload = { fileId: doc.file_id, fileName: doc.file_name };
  saveState(state);
  bot.sendMessage(msg.chat.id,
    `📁 استلمت: \`${doc.file_name}\`\n\nأرسل المسار في الريبو:`,
    { parse_mode: 'Markdown' });
});

// ─── Errors ───────────────────────────────────────────────────────────────────
bot.on('polling_error', (err) => console.error('Polling:', err.message));
process.on('unhandledRejection', (err) => console.error('Unhandled:', err.message));

console.log('🤖 البوت يعمل — AI: Groq (llama-3.3-70b)');
