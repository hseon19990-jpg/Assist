const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// الإعدادات البيئية (ضعها في متغيرات البيئة في ريلواي/ريبلت)
const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY; // مفتاح Groq الخاص بك
const GITHUB_TOKEN = process.env.GITHUB_TOKEN; // توكن جيت هاب
const GITHUB_REPO = process.env.GITHUB_REPO;   // مثال: username/repo-name
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

// نقطة استقبال الأوامر منك (أو من تيلجرام)
app.post('/update-bot', async (req, res) => {
    const userPrompt = req.body.prompt; // الأمر أو التعديل الذي تطلبه

    if (!userPrompt) {
        return res.status(400).json({ error: 'الرجاء إرسال الطلب (prompt)' });
    }

    try {
        // 1. جلب شجرة الملفات الحالية من جيت هاب لمعرفة محتوى البوت
        const treeUrl = `https://api.github.com/repos/${GITHUB_REPO}/git/trees/${GITHUB_BRANCH}?recursive=1`;
        const treeRes = await axios.get(treeUrl, {
            headers: { Authorization: `Bearer ${GITHUB_TOKEN}` }
        });

        // تصفية الملفات النصية فقط (مثل .js و .py و .json)
        const files = treeRes.data.tree.filter(f => f.type === 'blob' && (f.path.endsWith('.js') || f.path.endsWith('.py') || f.path.endsWith('.json')));
        
        let repoFilesContent = {};
        for (let file of files.slice(0, 10)) { // جلب أول 10 ملفات لتجنب تجاوز الحد الأقصى للـ Tokens
            const fileRes = await axios.get(`https://api.github.com/repos/${GITHUB_REPO}/contents/${file.path}`, {
                headers: { Authorization: `Bearer ${GITHUB_TOKEN}` }
            });
            const content = Buffer.from(fileRes.data.content, 'base64').toString('utf8');
            repoFilesContent[file.path] = content;
        }

        // 2. إرسال الكود والطلب إلى ذكاء Groq لتحليله وفهمه بذكاء فائق
        const systemInstruction = `
أنت مطور برمجيات خبير وذكاء اصطناعي متقدم جداً لتعديل أكواد البرمجة.
لديك هيكل ومحتوى مشروع بوت تيلجرام الخاص بالمستخدم الحالي.
المستخدم سيطلب منك تعديلاً باللغة العامية أو الفصحى (مثل: "أضف أمر كذا" أو "عدل الملف الفلاني").
عليك أن تفهم الطلب بدقة، وتحدد أي ملف يجب تعديله، وما هو الكود الجديد الذي يجب وضعه في المكان الصحيح تماماً دون الإضرار بباقي الكود.
أجب حصرياً بصيغة JSON تحتوي على اسم الملف المراد تعديله ومحتواه الكامل الجديد بعد التعديل، بهذا الشكل:
{
  "file_path": "مسار_الملف.js",
  "updated_content": "الكود الكامل المحدث للملف هنا",
  "commit_message": "رسالة وصفية للتعديل"
}
        `;

        const groqResponse = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model: "llama-3.3-70b-versatile",
            messages: [
                { role: "system", content: systemInstruction },
                { role: "user", content: `ملفات المشروع الحالية:\n${JSON.stringify(repoFilesContent)}\n\nطلب المستخدم لتعديل البوت هو: ${userPrompt}` }
            ],
            response_format: { type: "json_object" }
        }, {
            headers: { 
                'Authorization': `Bearer ${GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        const result = JSON.parse(groqResponse.data.choices[0].message.content);

        // 3. رفع التعديل تلقائياً إلى GitHub
        // أولاً: نحتاج لجلب الـ SHA الخاص بالملف المراد تحديثه
        const fileGetUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${result.file_path}`;
        const currentFile = await axios.get(fileGetUrl, {
            headers: { Authorization: `Bearer ${GITHUB_TOKEN}` }
        });

        // ثانياً: رفع الملف المحدث
        const updateRes = await axios.put(fileGetUrl, {
            message: result.commit_message || "Update via AI Assistant",
            content: Buffer.from(result.updated_content).toString('base64'),
            sha: currentFile.data.sha,
            branch: GITHUB_BRANCH
        }, {
            headers: { Authorization: `Bearer ${GITHUB_TOKEN}` }
        });

        res.json({
            status: "success",
            message: "تم تعديل وفهم الكود ورفعه بنجاح إلى جيت هاب!",
            file: result.file_path,
            commit: updateRes.data.commit.sha
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message }); // تم تصحيح الأقواس هنا
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
