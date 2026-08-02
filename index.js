/**
 * نقطة الدخول الرئيسية
 */
require('dotenv').config();

const bot = require('./src/bot');

bot.launch()
  .then(() => console.log('🤖 البوت يعمل بنجاح!'))
  .catch(err => {
    console.error('❌ فشل تشغيل البوت:', err.message);
    process.exit(1);
  });

// إيقاف نظيف
process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
