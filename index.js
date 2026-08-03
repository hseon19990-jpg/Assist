'use strict';

require('dotenv').config();

const bot = require('./src/bot');

console.log('🤖 Replit Agent — جاري التشغيل...');

bot.launch({
  dropPendingUpdates: true,
  allowedUpdates: ['message', 'callback_query'],
})
  .then(() => console.log('✅ البوت يعمل بنجاح!'))
  .catch(err => {
    console.error('❌ فشل التشغيل:', err.message);
    process.exit(1);
  });

// إيقاف نظيف
process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
