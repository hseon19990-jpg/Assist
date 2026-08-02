/**
 * بوت تيليجرام الذكي لتعديل GitHub
 * يستخدم Groq AI لفهم الطلبات وتنفيذها مباشرة
 */

const { Telegraf } = require('telegraf');
const axios = require('axios');

const BOT_TOKEN     = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_ID      = parseInt(process.env.TELEGRAM_OWNER_ID || '0');
const GROQ_KEY      = process.env.GROQ_API_KEY;
const GITHUB_TOKEN  = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
const GITHUB_OWNER  = process.env.GITHUB_OWNER;
const GITHUB_REPO   = process.env.GITHUB_REPO;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN غير موجود في متغيرات البيئة');
if (!GROQ_KEY)  throw new Error('GROQ_API_KEY غير موجود في متغيرات البيئة');

const FULL_REPO = `${GITHUB_OWNER}/${GITHUB_REPO}`;
const GH_HEADERS = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

async function getFileTree() {
  const url = `https://api.github.com/repos/${FULL_REPO}/git/trees/${GITHUB_BRANCH}?recursive=1`;
  const res = await axios.get(url, { headers: GH_HEADERS });
  return res.data.tree.filter(f => f.type === 'blob').map(f => f.path);
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

async function understandRequest(userMessage, fileTree) {
  const systemPrompt = `أنت مطور برمجيات خبير ومساعد ذكي لإدارة مستودعات GitHub.

المستودع الحالي: ${FULL_REPO} (فرع: ${GITHUB_BRANCH})

قائمة الملفات الموجودة في المستودع:
${fileTree.join('\n')}

مهمتك: تحليل طلب المستخدم وتحديد العمليات المطلوبة بدقة.

أجب حصراً بـ JSON بهذا الشكل (لا تضف أي نص خارج JSON):
{
  "operations": [
    {
      "action": "create | update | delete | read | list",
      "file_path": "مسار الملف",
      "content_instruction": "وصف دقيق لمحتوى الملف أو التعديل المطلوب",
      "commit_message": "رسالة الـ commit بالإنجليزي"
    }
  ],
  "needs_content_generation": true,
  "explanation_ar": "اشرح بالعربي ما ستفعله بجملة واحدة",
  "missing_info": ""
}

قواعد: إذا طلب المستخدم تعديل ملف موجود استخدم مساره الصحيح من القائمة. إذا الطلب غامض اطرح سؤالاً في missing_info.`;

  const res = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    },
    { headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' } }
  );
  return JSON.parse(res.data.choices[0].message.content);
}

async function generateFileContent(instruction, filePath, existingContent) {
  const prompt = existingContent
    ? `الملف الحالي (${filePath}):\n${existingContent}\n\nالتعديل المطلوب: ${instruction}\n\nأعطني الملف الكامل بعد التعديل فقط بدون شرح.`
    : `أنشئ ملف "${filePath}" بناءً على: ${instruction}\n\nأعطني المحتوى فقط بدون شرح.`;

  const res = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: 'أنت مطور خبير. أعطِ الكود فقط بدون أي نص إضافي أو backticks.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
    },
    { headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' } }
  );
  return res.data.choices[0].message.content.trim();
}

const bot = new Telegraf(BOT_TOKEN);

// حماية: فقط المالك
bot.use(async (ctx, next) => {
  if (OWNER_ID && ctx.from?.id !== OWNER_ID) return ctx.reply('🚫 هذا البوت خاص.');
  return next();
});

bot.start(ctx => ctx.replyWithMarkdown(
  `مرحباً! أنا مساعدك الذكي لإدارة مستودع GitHub 🤖\n\n` +
  `*المستودع:* \`${FULL_REPO}\`\n*الفرع:* \`${GITHUB_BRANCH}\`\n\n` +
  `فقط أخبرني ماذا تريد، مثلاً:\n\n` +
  `📝 \`أضف ملف requirements.txt فيه flask وrequests\`\n` +
  `✏️ \`عدّل index.js وأضف console.log في البداية\`\n` +
  `👁️ \`اقرأ ملف package.json\`\n` +
  `📋 \`اعرض كل الملفات\`\n` +
  `🗑️ \`احذف ملف old.js\`\n\n` +
  `لا تحتاج توكن أو رابط — كل شيء جاهز! ✅`
));

bot.command('repo', async ctx => {
  try {
    const res = await axios.get(`https://api.github.com/repos/${FULL_REPO}`, { headers: GH_HEADERS });
    const d = res.data;
    ctx.replyWithMarkdown(
      `*📁 المستودع:* \`${d.full_name}\`\n` +
      `🌿 الفرع: \`${GITHUB_BRANCH}\`\n` +
      `🔒 ${d.private ? 'خاص' : 'عام'} | ⭐ ${d.stargazers_count} | 🔤 ${d.language || 'متعدد'}`
    );
  } catch (e) { ctx.reply(`❌ ${e.message}`); }
});

bot.on('text', async ctx => {
  const userMsg = ctx.message.text;
  let statusMsg;

  try {
    statusMsg = await ctx.reply('🔍 جاري تحليل طلبك...');

    let fileTree = [];
    try { fileTree = await getFileTree(); } catch (e) {}

    const analysis = await understandRequest(userMsg, fileTree);

    if (analysis.missing_info) {
      return ctx.telegram.editMessageText(
        ctx.chat.id, statusMsg.message_id, null,
        `⚠️ *أحتاج توضيحاً:*\n\n${analysis.missing_info}`,
        { parse_mode: 'Markdown' }
      );
    }

    const ops = analysis.operations || [];
    if (!ops.length) {
      return ctx.telegram.editMessageText(
        ctx.chat.id, statusMsg.message_id, null,
        `🤔 لم أفهم الطلب. مثال: \`أضف ملف x.py\` أو \`اعرض الملفات\``,
        { parse_mode: 'Markdown' }
      );
    }

    await ctx.telegram.editMessageText(
      ctx.chat.id, statusMsg.message_id, null,
      `⚙️ ${analysis.explanation_ar}\n\nجاري التنفيذ...`
    );

    const results = [];

    for (const op of ops) {
      try {
        if (op.action === 'list') {
          const tree = fileTree.length ? fileTree : await getFileTree();
          const filtered = op.file_path ? tree.filter(f => f.startsWith(op.file_path)) : tree;
          const display = filtered.slice(0, 60).map(f => `📄 \`${f}\``).join('\n');
          results.push(`*📋 الملفات (${filtered.length}):*\n${display}` +
            (filtered.length > 60 ? `\n_...و ${filtered.length - 60} ملف آخر_` : ''));

        } else if (op.action === 'read') {
          const file = await readFile(op.file_path);
          if (!file) { results.push(`❌ الملف \`${op.file_path}\` غير موجود`); continue; }
          const preview = file.content.length > 2500 ? file.content.slice(0, 2500) + '\n_...تم الاقتصار_' : file.content;
          results.push(`*📄 ${op.file_path}:*\n\`\`\`\n${preview}\n\`\`\``);

        } else if (op.action === 'delete') {
          const file = await readFile(op.file_path);
          if (!file) { results.push(`❌ الملف \`${op.file_path}\` غير موجود`); continue; }
          await deleteFile(op.file_path, file.sha, op.commit_message);
          results.push(`🗑️ تم حذف \`${op.file_path}\` ✅`);

        } else if (op.action === 'create' || op.action === 'update') {
          const existing = await readFile(op.file_path);
          let content;
          if (analysis.needs_content_generation) {
            content = await generateFileContent(op.content_instruction, op.file_path, existing?.content || null);
          } else {
            content = op.content_instruction;
          }
          const url = await writeFile(op.file_path, content, op.commit_message, existing?.sha || null);
          const verb = existing ? 'تعديل' : 'إضافة';
          results.push(`✅ تم ${verb} \`${op.file_path}\`\n💬 \`${op.commit_message}\`\n` + (url ? `🔗 [GitHub](${url})` : ''));
        }
      } catch (opErr) {
        results.push(`❌ خطأ في \`${op.file_path}\`: ${opErr.response?.data?.message || opErr.message}`);
      }
    }

    const finalText = results.join('\n\n---\n\n');
    await ctx.telegram.editMessageText(
      ctx.chat.id, statusMsg.message_id, null,
      finalText.slice(0, 4096),
      { parse_mode: 'Markdown', disable_web_page_preview: true }
    );

  } catch (err) {
    const errText = err.response?.data?.message || err.message;
    if (statusMsg) {
      await ctx.telegram.editMessageText(
        ctx.chat.id, statusMsg.message_id, null,
        `❌ خطأ:\n\`${errText}\``,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    }
  }
});

module.exports = bot;
