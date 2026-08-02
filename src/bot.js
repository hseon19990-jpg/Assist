/**
 * بوت تيليجرام الذكي لتعديل GitHub
 * يستخدم Groq AI لفهم الطلبات وتنفيذها مباشرة
 */

const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

const BOT_TOKEN       = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_ID        = parseInt(process.env.TELEGRAM_OWNER_ID || '0');
const GROQ_KEY        = process.env.GROQ_API_KEY;
const GITHUB_TOKEN    = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
const GITHUB_OWNER    = process.env.GITHUB_OWNER;
const GITHUB_REPO     = process.env.GITHUB_REPO;
const GITHUB_BRANCH   = process.env.GITHUB_BRANCH || 'main';

if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN غير موجود في متغيرات البيئة');
if (!GROQ_KEY)  throw new Error('GROQ_API_KEY غير موجود في متغيرات البيئة');

const FULL_REPO = `${GITHUB_OWNER}/${GITHUB_REPO}`;
const GH_HEADERS = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

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
//  Groq AI — فهم الطلب
// ============================================================

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
    {
      headers: {
        Authorization: `Bearer ${GROQ_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );
  return JSON.parse(res.data.choices[0].message.content);
}

async function generateFileContent(instruction, filePath, existingContent) {
  const prompt = existingContent
    ? `الملف الحالي (${filePath}):\n\`\`\`\n${existingContent}\n\`\`\`\n\nالتعديل المطلوب: ${instruction}\n\nأعطني الملف الكامل بعد التعديل فقط، بدون شرح أو markdown.`
    : `أنشئ ملف "${filePath}" بناءً على: ${instruction}\n\nأعطني المحتوى فقط بدون شرح أو markdown.`;

  const res = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: 'أنت مطور Node.js خبير. أعطِ الكود فقط بدون شرح أو markdown. مهم جداً: استخدم دائماً backticks (`) للـ template literals وليس single quotes. حافظ على جميع backticks الموجودة في الكود.',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
    },
    {
      headers: {
        Authorization: `Bearer ${GROQ_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );
  return res.data.choices[0].message.content.trim();
}

// ============================================================
//  Bot
// ============================================================

const bot = new Telegraf(BOT_TOKEN);
let admins = [OWNER_ID];

// حماية: فقط المالك يمكنه استخدام البوت
bot.use(async (ctx, next) => {
  const uid = ctx.from?.id;
  if (!admins.includes(uid)) {
    return ctx.reply('🚫 هذا البوت خاص.');
  }
  return next();
});

bot.start(ctx => ctx.replyWithMarkdown(`مرحباً! أنا مساعدك الذكي لإدارة مستودع GitHub 🤖

*المستودع المربوط:* \`${FULL_REPO}\`
*الفرع:* \`${GITHUB_BRANCH}\`

فقط أخبرني ماذا تريد بأي صيغة، مثلاً:

📝 \`أضف ملف requirements.txt فيه flask وrequests\`
✏️ \`عدّل index.js وأضف console.log في البداية\`
👁️ \`اقرأ ملف package.json\`
📋 \`اعرض كل الملفات\`
🗑️ \`احذف ملف old.js\`

لا تحتاج توكن أو رابط — كل شيء جاهز! ✅`));

bot.help(ctx => ctx.replyWithMarkdown(`*دليل الاستخدام:*

أرسل طلبك بالعربي أو الإنجليزي بأي صيغة تريد.

*أمثلة:*
• \`أضف ملف config.py فيه الإعدادات الأساسية\`
• \`عدّل README وأضف قسم التثبيت\`
• \`اعرض الملفات في مجلد src\`
• \`احذف ملف test.js\`
• \`أضف Docker support للمشروع\`

*/start* — الرسالة الرئيسية
*/repo* — معلومات المستودع
*/admin* — أضف مسؤول`));

bot.command('repo', async ctx => {
  try {
    const res = await axios.get(
      `https://api.github.com/repos/${FULL_REPO}`,
      { headers: GH_HEADERS }
    );
    const d = res.data;
    ctx.replyWithMarkdown(
      `*📁 معلومات المستودع:*\n\n` +
      `🔗 \`${d.full_name}\`\n` +
      `🌿 الفرع: \`${GITHUB_BRANCH}\`\n` +
      `📝 الوصف: ${d.description || 'لا يوجد'}\n` +
      `🔒 ${d.private ? 'خاص' : 'عام'}\n` +
      `⭐ ${d.stargazers_count} نجمة\n` +
      `🔤 اللغة: ${d.language || 'متعددة'}`
    );
  } catch (e) {
    ctx.reply(`❌ خطأ في جلب معلومات المستودع: ${e.message}`);
  }
});

bot.command('admin', async ctx => {
  const uid = ctx.from?.id;
  if (uid !== OWNER_ID) {
    return ctx.reply('🚫 فقط المالك يمكنه إضافة مسؤولين جدد.');
  }
  const newAdmin = ctx.message.text.split(' ')[1];
  if (!newAdmin) {
    return ctx.reply('👉 يرجى ذكر معرف المستخدم الجديد.');
  }
  admins.push(parseInt(newAdmin));
  ctx.reply(`👋 تمت إضافة المستخدم ${newAdmin} كمسؤول.`);
});

// الرسائل الرئيسية
bot.on('text', async ctx => {
  const userMsg = ctx.message.text;
  let statusMsg;

  try {
    statusMsg = await ctx.reply('🔍 جاري تحليل طلبك...');

    // جلب شجرة الملفات
    let fileTree = [];
    try {
      fileTree = await getFileTree();
    } catch (e) {
      // قد تفشل إذا كان المستودع فارغاً
    }

    // تحليل الطلب بالذكاء الاصطناعي
    const analysis = await understandRequest(userMsg, fileTree);

    // إذا كانت المعلومات ناقصة
    if (analysis.missing_info) {
      await ctx.telegram.editMessageText(
        ctx.chat.id, statusMsg.message_id, null,
        `⚠️ *أحتاج توضيحاً:*\n\n${analysis.missing_info}`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const ops = analysis.operations || [];
    if (!ops.length) {
      await ctx.telegram.editMessageText(
        ctx.chat.id, statusMsg.message_id, null,
        `🤔 لم أفهم الطلب. حاول بصياغة أوضح مثل:\n\`أضف ملف x.py\` أو \`اعرض الملفات\``,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // إخبار المستخدم بما سيتم فعله
    await ctx.telegram.editMessageText(
      ctx.chat.id, statusMsg.message_id, null,
      `⚙️ ${analysis.explanation_ar}\n\nجاري التنفيذ...`
    );

    const results = [];

    for (const op of ops) {
      try {
        if (op.action === 'list') {
          // عرض الملفات
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
          // قراءة ملف
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
          // حذف ملف
          const file = await readFile(op.file_path);
          if (!file) {
            results.push(`❌ الملف \`${op.file_path}\` غير موجود`);
          } else {
            await deleteFile(op.file_path, file.sha, op.commit_message);
            results.push(`🗑️ تم حذف \`${op.file_path}\` ✅`);
          }

        } else if (op.action === 'create' || op.action === 'update') {
          // إنشاء أو تعديل ملف
          const existing = await readFile(op.file_path);
          const isUpdate = op.action === 'update' || !!existing;

          let content;
          if (analysis.needs_content_generation) {
            content = await generateFileContent(
              op.content_instruction,
              op.file_path,
              existing?.content || null
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
        results.push(`❌ خطأ في \`${op.file_path}\`: ${errMsg}`);
      }
    }

    // إرسال النتائج
    const finalText = results.join('\n\n---\n\n');
    if (finalText.length > 4000) {
      // تقسيم الرسالة إذا كانت طويلة
      await ctx.telegram.editMessageText(
        ctx.chat.id, statusMsg.message_id, null, '✅ اكتملت العمليات:'
      );
      const chunks = finalText.match(/.{1,4000}/gs) || [];
      for (const chunk of chunks) {
        await ctx.replyWithMarkdown(chunk);
      }
    } else {
      await ctx.telegram.editMessageText(
        ctx.chat.id, statusMsg.message_id, null,
        finalText,
        { parse_mode: 'Markdown', disable_web_page_preview: true }
      );
    }

  } catch (err) {
    console.error('Error:', err.response?.data || err.message);
    const errText = err.response?.data?.message || err.message;

    if (statusMsg) {
      await ctx.telegram.editMessageText(
        ctx.chat.id, statusMsg.message_id, null,
        `❌ حدث خطأ:\n\`${errText}\`\n\nتحقق من صحة المتغيرات في Railway.`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    } else {
      await ctx.reply(`❌ خطأ: ${errText}`);
    }
  }
});

module.exports = bot;
