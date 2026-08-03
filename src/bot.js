/**
 * Replit Agent — بوت تيليجرام وكيل برمجة ذكي
 * يقرأ ويكتب الكود، يرفع على GitHub، يشغّل الكود، ويسأل عما يحتاجه
 */

'use strict';

const { Telegraf } = require('telegraf');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ============================================================
//  الإعدادات
// ============================================================
const BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_ID     = parseInt(process.env.TELEGRAM_OWNER_ID || '0');
const OR_KEY       = process.env.OPENROUTER_API_KEY;
const GH_TOKEN     = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
const GH_OWNER     = process.env.GITHUB_OWNER     || 'hseon19990-jpg';
const GH_REPO      = process.env.GITHUB_REPO      || 'Assist';
const GH_BRANCH    = process.env.GITHUB_BRANCH    || 'main';
const MODEL        = process.env.AI_MODEL         || 'anthropic/claude-3.5-sonnet';
const MAX_HISTORY  = parseInt(process.env.MAX_HISTORY || '40');
const ASK_TIMEOUT  = parseInt(process.env.ASK_TIMEOUT_MS || '300000'); // 5 دقائق

if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN غير موجود');
if (!OR_KEY)    throw new Error('OPENROUTER_API_KEY غير موجود');
if (!GH_TOKEN)  throw new Error('GITHUB_PERSONAL_ACCESS_TOKEN غير موجود');

// ============================================================
//  حالة المستخدمين (في الذاكرة)
// ============================================================
const userStates = new Map();

function getState(userId) {
  if (!userStates.has(userId)) {
    userStates.set(userId, {
      history: [],
      isProcessing: false,
      pendingQuestion: false,
      pendingResolve: null,
      pendingTimer: null,
    });
  }
  return userStates.get(userId);
}

function resetState(userId) {
  const s = getState(userId);
  if (s.pendingTimer) clearTimeout(s.pendingTimer);
  s.history = [];
  s.isProcessing = false;
  s.pendingQuestion = false;
  s.pendingResolve = null;
  s.pendingTimer = null;
}

function trimHistory(history) {
  // احتفظ بآخر MAX_HISTORY رسالة مع الحفاظ على tool_calls كاملة
  if (history.length <= MAX_HISTORY) return history;
  return history.slice(history.length - MAX_HISTORY);
}

// ============================================================
//  GitHub API
// ============================================================
const GH_API = 'https://api.github.com';
const GH_HEADERS = {
  Authorization: `Bearer ${GH_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

let repoCache = { tree: null, fetchedAt: 0 };
const CACHE_TTL = 3 * 60 * 1000;

async function getRepoTree(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && repoCache.tree && now - repoCache.fetchedAt < CACHE_TTL) {
    return repoCache.tree;
  }
  const res = await axios.get(
    `${GH_API}/repos/${GH_OWNER}/${GH_REPO}/git/trees/${GH_BRANCH}?recursive=1`,
    { headers: GH_HEADERS, timeout: 15000 }
  );
  const tree = res.data.tree
    .filter(f => f.type === 'blob')
    .map(f => f.path);
  repoCache = { tree, fetchedAt: now };
  return tree;
}

async function ghReadFile(filePath) {
  const res = await axios.get(
    `${GH_API}/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(filePath)}?ref=${GH_BRANCH}`,
    { headers: GH_HEADERS, timeout: 15000 }
  );
  return {
    content: Buffer.from(res.data.content, 'base64').toString('utf8'),
    sha: res.data.sha,
  };
}

async function ghWriteFile(filePath, content, commitMsg) {
  let sha;
  try {
    const existing = await ghReadFile(filePath);
    sha = existing.sha;
  } catch (_) { /* ملف جديد */ }

  const body = {
    message: commitMsg || `🤖 Update ${filePath}`,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch: GH_BRANCH,
  };
  if (sha) body.sha = sha;

  const res = await axios.put(
    `${GH_API}/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(filePath)}`,
    body,
    { headers: GH_HEADERS, timeout: 20000 }
  );

  repoCache.fetchedAt = 0; // تحديث الكاش
  return res.data.commit.sha;
}

async function ghDeleteFile(filePath, commitMsg) {
  const { sha } = await ghReadFile(filePath);
  await axios.delete(
    `${GH_API}/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(filePath)}`,
    {
      headers: GH_HEADERS,
      timeout: 15000,
      data: {
        message: commitMsg || `🤖 Delete ${filePath}`,
        sha,
        branch: GH_BRANCH,
      },
    }
  );
  repoCache.fetchedAt = 0;
}

// ============================================================
//  Piston — تنفيذ الكود
// ============================================================
const LANG_MAP = {
  py: 'python', python: 'python', python3: 'python',
  js: 'javascript', javascript: 'javascript', node: 'javascript', nodejs: 'javascript',
  ts: 'typescript', typescript: 'typescript',
  bash: 'bash', sh: 'bash', shell: 'bash',
  go: 'go', golang: 'go',
  rs: 'rust', rust: 'rust',
  java: 'java',
  cpp: 'c++', 'c++': 'c++', cxx: 'c++',
  c: 'c',
  rb: 'ruby', ruby: 'ruby',
  php: 'php',
  cs: 'csharp', csharp: 'csharp',
};

async function runCode(language, code, stdin = '') {
  const lang = LANG_MAP[language.toLowerCase().trim()] || language.toLowerCase().trim();
  const res = await axios.post(
    'https://emkc.org/api/v2/piston/execute',
    {
      language: lang,
      version: '*',
      files: [{ content: code }],
      stdin: stdin || '',
    },
    { timeout: 30000 }
  );
  const run = res.data.run;
  return {
    stdout: (run.stdout || '').trim(),
    stderr: (run.stderr || '').trim(),
    exitCode: run.code ?? 0,
  };
}

// ============================================================
//  DuckDuckGo — بحث
// ============================================================
async function searchWeb(query) {
  try {
    const res = await axios.get(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
      { timeout: 10000 }
    );
    const d = res.data;
    const parts = [];
    if (d.AbstractText) parts.push(`📌 ${d.AbstractText}\n🔗 ${d.AbstractURL}`);
    (d.RelatedTopics || []).slice(0, 5).forEach(t => {
      if (t.Text) parts.push(`• ${t.Text}`);
    });
    return parts.length ? parts.join('\n') : 'لم أجد نتائج واضحة.';
  } catch (e) {
    return `فشل البحث: ${e.message}`;
  }
}

// ============================================================
//  تعريف الأدوات (OpenAI tool calling)
// ============================================================
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_repo_files',
      description: 'عرض قائمة كل الملفات في المستودع. ابدأ بها دائماً لفهم هيكل المشروع قبل أي تعديل.',
      parameters: {
        type: 'object',
        properties: {
          directory: {
            type: 'string',
            description: 'اختياري — عرض ملفات مجلد معين فقط مثل: src/',
          },
          refresh: {
            type: 'boolean',
            description: 'اجبر تحديث القائمة من GitHub',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'قراءة محتوى ملف من المستودع. اقرأ الملف قبل تعديله دائماً.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'مسار الملف مثل: src/bot.js أو package.json',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'إنشاء أو تعديل ملف في المستودع ورفعه على GitHub تلقائياً.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'مسار الملف مثل: src/commands/stats.js',
          },
          content: {
            type: 'string',
            description: 'المحتوى الكامل للملف. لا تختصر أبداً.',
          },
          commit_message: {
            type: 'string',
            description: 'رسالة commit واضحة تصف التغيير',
          },
        },
        required: ['path', 'content', 'commit_message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'حذف ملف من المستودع.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'مسار الملف المراد حذفه' },
          commit_message: { type: 'string' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_code',
      description: 'تشغيل كود واختبار نتيجته. استخدمها قبل رفع الكود للتأكد من أنه يعمل.',
      parameters: {
        type: 'object',
        properties: {
          language: {
            type: 'string',
            description: 'لغة البرمجة: python, javascript, typescript, bash, go, rust, java, c++, ruby, php',
          },
          code: { type: 'string', description: 'الكود المراد تشغيله' },
          stdin: { type: 'string', description: 'مدخلات stdin اختيارية' },
        },
        required: ['language', 'code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description: 'سؤال المستخدم عن معلومة لا يمكن الاستنتاج منها ولا بد منها لإتمام المهمة. استخدمها بحكمة — لا تسأل عن شيء واضح أو يمكن الاستنتاج من الكود.',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'السؤال بوضوح، مع شرح لماذا تحتاج هذه المعلومة',
          },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: 'خيارات اختيارية للمستخدم',
          },
        },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_web',
      description: 'البحث في الإنترنت عن مكتبة أو مفهوم أو حل لمشكلة برمجية.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'نص البحث' },
        },
        required: ['query'],
      },
    },
  },
];

// ============================================================
//  System Prompt
// ============================================================
const SYSTEM_PROMPT = `أنت **Replit Agent** — وكيل برمجة ذكي مدمج في تيليجرام.

## هويتك وقدراتك
لديك صلاحية كاملة على مستودع GitHub: **${GH_OWNER}/${GH_REPO}** (فرع: ${GH_BRANCH})
يمكنك: قراءة الملفات، كتابتها، حذفها، تشغيل الكود، والبحث في الإنترنت.
عندما تعدّل نفسك (ملف src/bot.js)، Railway ستعيد النشر تلقائياً.

## أسلوب عملك (مثل Replit Agent)
1. **فهم الطلب** — اقرأ الطلب جيداً وحدد ما هو المطلوب بالضبط
2. **استكشف الكود أولاً** — ابدأ دائماً بـ list_repo_files ثم اقرأ الملفات ذات الصلة
3. **فكّر بصوت عالٍ** — أخبر المستخدم بما ستفعله: "سأقرأ src/bot.js أولاً..."
4. **اسأل قبل ما تبني** — إذا محتاج معلومة أساسية، استخدم ask_user قبل البدء
5. **نفّذ بدقة** — اكتب كوداً كاملاً ونظيفاً، لا تختصر، لا تكتب "..."
6. **اختبر** — استخدم run_code للتحقق من الكود إذا أمكن
7. **أكّد** — أخبر المستخدم بما تم بالتحديد

## قواعد ثابتة
- **أجب دائماً بالعربية** ما لم يتكلم المستخدم بالإنجليزي
- **اقرأ الملف قبل تعديله** — لا تفترض محتواه أبداً
- **الكود دائماً كامل** — لا "...(باقي الكود)" ولا اختصارات
- **رسائل commit واضحة** بالعربية أو الإنجليزي
- **نبّه على المخاطر** — إذا التعديل قد يكسر شيئاً، حذّر المستخدم أولاً
- **لا إيموجي مبالغ** — استخدمها باعتدال فقط للوضوح

## صياغة ردودك
- ابدأ بخطة موجزة: "**الخطة:** سأعمل على X ثم Y"
- أثناء التنفيذ: "قرأت الملف... لاحظت... سأضيف..."
- عند الانتهاء: "✅ تم رفع X على GitHub. الميزة جاهزة."

## مثال على تدفق العمل الصحيح
المستخدم: "أضف أمر /stats"
أنت:
1. list_repo_files → لفهم البنية
2. read_file("src/bot.js") → لفهم كيف الأوامر الموجودة
3. ask_user إذا محتاج توضيح (ماذا يعرض stats؟)
4. write_file → رفع التعديل
5. "✅ أضفت أمر /stats — يعرض X و Y"`;

// ============================================================
//  OpenRouter API
// ============================================================
async function callAI(messages, withTools = true) {
  const body = {
    model: MODEL,
    messages,
    temperature: 0.25,
    max_tokens: 8192,
  };
  if (withTools) {
    body.tools = TOOLS;
    body.tool_choice = 'auto';
  }

  const res = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    body,
    {
      headers: {
        Authorization: `Bearer ${OR_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': `https://github.com/${GH_OWNER}/${GH_REPO}`,
        'X-Title': 'Telegram Replit Agent',
      },
      timeout: 120000,
    }
  );

  if (res.data.error) throw new Error(res.data.error.message || JSON.stringify(res.data.error));
  return res.data.choices[0];
}

// ============================================================
//  تنفيذ الأدوات
// ============================================================
const SKIP_PATTERNS = [
  /node_modules/, /\.git\//, /dist\//, /build\//, /\.min\.(js|css)$/,
  /package-lock\.json$/, /yarn\.lock$/, /pnpm-lock\.yaml$/, /admins\.json$/,
  /\.(png|jpg|jpeg|gif|ico|svg|pdf|zip|tar|gz|woff|ttf|mp3|mp4|webp)$/i,
];

async function executeTool(name, args, ctx, state) {
  switch (name) {

    case 'list_repo_files': {
      const tree = await getRepoTree(args.refresh === true);
      let files = tree.filter(f => !SKIP_PATTERNS.some(p => p.test(f)));
      if (args.directory) files = files.filter(f => f.startsWith(args.directory));
      return `الملفات في المستودع (${files.length}):\n${files.join('\n')}`;
    }

    case 'read_file': {
      const { content } = await ghReadFile(args.path);
      const truncated = content.length > 10000;
      const preview = truncated ? content.slice(0, 10000) : content;
      return `محتوى ${args.path}${truncated ? ' (أول 10000 حرف)' : ''}:\n\`\`\`\n${preview}\n\`\`\``;
    }

    case 'write_file': {
      await ctx.sendChatAction('upload_document').catch(() => {});
      const sha = await ghWriteFile(args.path, args.content, args.commit_message);
      await ctx.reply(
        `📝 *رُفع:* \`${args.path}\`\n` +
        `💬 *commit:* ${args.commit_message}\n` +
        `🔗 \`${sha.slice(0, 7)}\``,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
      return `✅ تم رفع الملف "${args.path}" بنجاح. Commit SHA: ${sha.slice(0, 7)}`;
    }

    case 'delete_file': {
      await ghDeleteFile(args.path, args.commit_message);
      return `✅ تم حذف الملف "${args.path}" بنجاح`;
    }

    case 'run_code': {
      await ctx.reply(`⚙️ أشغّل الكود...`).catch(() => {});
      const result = await runCode(args.language, args.code, args.stdin);
      let display = '';
      if (result.stdout) display += `\`\`\`\n${result.stdout.slice(0, 2000)}\n\`\`\`\n`;
      if (result.stderr) display += `⚠️ stderr:\n\`\`\`\n${result.stderr.slice(0, 800)}\n\`\`\`\n`;
      display += `Exit code: ${result.exitCode}`;
      await ctx.reply(display, { parse_mode: 'Markdown' }).catch(() => ctx.reply(`Exit: ${result.exitCode}`));
      return JSON.stringify({
        stdout: result.stdout.slice(0, 4000),
        stderr: result.stderr.slice(0, 1000),
        exitCode: result.exitCode,
      });
    }

    case 'ask_user': {
      let msg = `❓ *سؤال:*\n${args.question}`;
      if (args.options?.length) {
        msg += '\n\n' + args.options.map((o, i) => `${i + 1}. ${o}`).join('\n');
      }
      await ctx.reply(msg, { parse_mode: 'Markdown' });

      return new Promise((resolve, reject) => {
        state.pendingQuestion = true;
        state.pendingResolve = (answer) => resolve(`إجابة المستخدم: ${answer}`);

        // timeout بعد 5 دقائق
        state.pendingTimer = setTimeout(() => {
          state.pendingQuestion = false;
          state.pendingResolve = null;
          state.pendingTimer = null;
          reject(new Error('انتهت مهلة الانتظار (5 دقائق). أعد الطلب.'));
        }, ASK_TIMEOUT);
      });
    }

    case 'search_web': {
      const result = await searchWeb(args.query);
      return `نتائج البحث عن "${args.query}":\n${result}`;
    }

    default:
      return `أداة غير معروفة: ${name}`;
  }
}

// ============================================================
//  Agent Loop
// ============================================================
const MAX_ITERATIONS = 25;

async function runAgent(ctx, state, userMessage) {
  state.isProcessing = true;

  if (userMessage) {
    state.history.push({ role: 'user', content: userMessage });
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...trimHistory(state.history),
  ];

  let iterations = 0;

  try {
    while (iterations < MAX_ITERATIONS) {
      iterations++;
      await ctx.sendChatAction('typing').catch(() => {});

      const choice = await callAI(messages, true);
      const msg = choice.message;
      messages.push(msg);
      state.history = messages.slice(1); // حذف system

      // رد نصي مع أدوات أو بدون
      if (msg.content && msg.content.trim()) {
        const parts = splitText(msg.content, 4000);
        for (const part of parts) {
          await ctx.reply(part, { parse_mode: 'Markdown' })
            .catch(() => ctx.reply(part));
        }
      }

      // انتهى؟
      if (choice.finish_reason === 'stop' || !msg.tool_calls?.length) break;

      // تنفيذ الأدوات
      for (const tc of msg.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments); } catch (_) {}

        let result;
        try {
          result = await executeTool(tc.function.name, args, ctx, state);
        } catch (err) {
          result = `❌ خطأ في الأداة ${tc.function.name}: ${err.message}`;
          // إذا كان خطأ ask_user timeout، أوقف اللوب
          if (err.message.includes('مهلة')) {
            await ctx.reply(`⏰ ${err.message}`).catch(() => {});
            return;
          }
        }

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: String(result),
        });
        state.history = messages.slice(1);

        // إذا ask_user — اللوب يتوقف حتى يرد المستخدم
        if (state.pendingQuestion) {
          state.isProcessing = false;
          // اللوب محلوق في الخلفية — سيكمل بعد resolveUserAnswer
          // نحتاج نحفظ الـ messages لاستكمال اللوب
          state._pendingMessages = messages;
          state._pendingIterations = iterations;
          return;
        }
      }
    }

    if (iterations >= MAX_ITERATIONS) {
      await ctx.reply('⚠️ وصلت للحد الأقصى من العمليات (25). قل لي "كمّل" إذا تريد الاستمرار.');
    }

  } catch (err) {
    console.error('[Agent Error]', err.response?.data || err.message);
    const errMsg = err.response?.data?.error?.message || err.message;
    await ctx.reply(`❌ خطأ:\n\`${errMsg}\``, { parse_mode: 'Markdown' }).catch(() => {});
  } finally {
    state.isProcessing = false;
  }
}

// استكمال اللوب بعد إجابة ask_user
async function resumeAgent(ctx, state, userAnswer) {
  if (!state._pendingMessages) {
    // لا يوجد لوب معلّق، ابدأ من جديد
    return runAgent(ctx, state, userAnswer);
  }

  const messages = state._pendingMessages;
  let iterations = state._pendingIterations || 0;

  state._pendingMessages = null;
  state._pendingIterations = null;

  // أضف إجابة المستخدم كـ user message في التاريخ
  state.history.push({ role: 'user', content: userAnswer });
  messages.push({ role: 'user', content: userAnswer });

  state.isProcessing = true;

  try {
    while (iterations < MAX_ITERATIONS) {
      iterations++;
      await ctx.sendChatAction('typing').catch(() => {});

      const choice = await callAI(messages, true);
      const msg = choice.message;
      messages.push(msg);
      state.history = messages.slice(1);

      if (msg.content && msg.content.trim()) {
        const parts = splitText(msg.content, 4000);
        for (const part of parts) {
          await ctx.reply(part, { parse_mode: 'Markdown' }).catch(() => ctx.reply(part));
        }
      }

      if (choice.finish_reason === 'stop' || !msg.tool_calls?.length) break;

      for (const tc of msg.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments); } catch (_) {}

        let result;
        try {
          result = await executeTool(tc.function.name, args, ctx, state);
        } catch (err) {
          result = `❌ خطأ في الأداة ${tc.function.name}: ${err.message}`;
          if (err.message.includes('مهلة')) {
            await ctx.reply(`⏰ ${err.message}`).catch(() => {});
            return;
          }
        }

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: String(result),
        });
        state.history = messages.slice(1);

        if (state.pendingQuestion) {
          state.isProcessing = false;
          state._pendingMessages = messages;
          state._pendingIterations = iterations;
          return;
        }
      }
    }

    if (iterations >= MAX_ITERATIONS) {
      await ctx.reply('⚠️ وصلت للحد الأقصى. قل "كمّل" للاستمرار.');
    }
  } catch (err) {
    console.error('[Resume Error]', err.response?.data || err.message);
    await ctx.reply(`❌ خطأ:\n\`${err.response?.data?.error?.message || err.message}\``, { parse_mode: 'Markdown' }).catch(() => {});
  } finally {
    state.isProcessing = false;
  }
}

// ============================================================
//  مساعدات
// ============================================================
function splitText(text, maxLen = 4000) {
  if (text.length <= maxLen) return [text];
  const parts = [];
  const lines = text.split('\n');
  let chunk = '';
  for (const line of lines) {
    if (chunk.length + line.length + 1 > maxLen) {
      if (chunk) parts.push(chunk.trim());
      chunk = line;
    } else {
      chunk += (chunk ? '\n' : '') + line;
    }
  }
  if (chunk.trim()) parts.push(chunk.trim());
  return parts;
}

// ============================================================
//  Bot
// ============================================================
const bot = new Telegraf(BOT_TOKEN, {
  telegram: { webhookReply: false },
});

// مصادقة
bot.use(async (ctx, next) => {
  if (!ctx.from) return;
  if (OWNER_ID && ctx.from.id !== OWNER_ID) {
    await ctx.reply('⛔ غير مصرح لك باستخدام هذا البوت.');
    return;
  }
  return next();
});

// /start
bot.command('start', async (ctx) => {
  resetState(ctx.from.id);
  await ctx.reply(
    `🤖 *مرحباً! أنا Replit Agent*\n\n` +
    `وكيل برمجة ذكي يعمل على مستودع:\n\`${GH_OWNER}/${GH_REPO}\`\n\n` +
    `*أقدر أساعدك بـ:*\n` +
    `📁 قراءة وتعديل الكود مباشرة على GitHub\n` +
    `✍️ بناء ميزات جديدة ورفعها\n` +
    `▶️ تشغيل الكود واختباره\n` +
    `🔍 البحث في الإنترنت\n` +
    `🤔 السؤال عما يحتاجه قبل البدء\n` +
    `♻️ تعديل نفسه إذا طلبت منه\n\n` +
    `فقط أخبرني ماذا تريد بشكل طبيعي.`,
    { parse_mode: 'Markdown' }
  );
});

// /new
bot.command('new', async (ctx) => {
  const state = getState(ctx.from.id);
  if (state.isProcessing) {
    return ctx.reply('⏳ انتظر حتى أنهي الطلب الحالي، ثم استخدم /new');
  }
  resetState(ctx.from.id);
  await ctx.reply('🔄 بدأت محادثة جديدة. الذاكرة السابقة مسحت.');
});

// /cancel
bot.command('cancel', async (ctx) => {
  const state = getState(ctx.from.id);
  state.isProcessing = false;
  if (state.pendingTimer) clearTimeout(state.pendingTimer);
  state.pendingQuestion = false;
  state.pendingResolve = null;
  state.pendingTimer = null;
  state._pendingMessages = null;
  await ctx.reply('🛑 تم إلغاء العملية الحالية.');
});

// /status
bot.command('status', async (ctx) => {
  const state = getState(ctx.from.id);
  await ctx.reply(
    `📊 *الحالة:*\n` +
    `• في المعالجة: ${state.isProcessing ? '✅' : '❌'}\n` +
    `• ينتظر إجابة: ${state.pendingQuestion ? '✅' : '❌'}\n` +
    `• الرسائل المحفوظة: ${state.history.length}\n` +
    `• المستودع: \`${GH_OWNER}/${GH_REPO}:${GH_BRANCH}\`\n` +
    `• النموذج: \`${MODEL}\``,
    { parse_mode: 'Markdown' }
  );
});

// /help
bot.command('help', async (ctx) => {
  await ctx.reply(
    `📚 *الأوامر:*\n` +
    `/start — بدء جديد وتعريف بالبوت\n` +
    `/new — محادثة جديدة (مسح الذاكرة)\n` +
    `/cancel — إلغاء العملية الحالية\n` +
    `/status — حالة البوت\n` +
    `/help — هذه الرسالة\n\n` +
    `*أمثلة على الطلبات:*\n` +
    `• "أضف أمر /stats للبوت"\n` +
    `• "اصلح الخطأ في ملف bot.js"\n` +
    `• "اشرح لي كيف يعمل الكود"\n` +
    `• "أنشئ ميزة X"\n` +
    `• "عدّل نفسك وأضف ميزة Y"`,
    { parse_mode: 'Markdown' }
  );
});

// رسائل الكتابة العادية
bot.on('message', async (ctx) => {
  if (!ctx.message?.text || ctx.message.text.startsWith('/')) return;

  const userId = ctx.from.id;
  const state = getState(userId);
  const text = ctx.message.text.trim();

  // إجابة على ask_user
  if (state.pendingQuestion && state.pendingResolve) {
    if (state.pendingTimer) clearTimeout(state.pendingTimer);
    state.pendingTimer = null;
    state.pendingQuestion = false;
    const resolve = state.pendingResolve;
    state.pendingResolve = null;
    resolve(text); // هذا يُكمل الـ Promise الموجودة داخل اللوب
    // إذا اللوب توقف (pending messages)، استكملنا
    if (state._pendingMessages) {
      setTimeout(() => resumeAgent(ctx, state, text), 100);
    }
    return;
  }

  // إذا لا يزال يعالج
  if (state.isProcessing) {
    await ctx.reply('⏳ لا أزال أعمل على الطلب السابق...\nاستخدم /cancel للإلغاء.');
    return;
  }

  // ابدأ اللوب
  await runAgent(ctx, state, text);
});

module.exports = bot;
