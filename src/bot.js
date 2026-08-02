```javascript
const { Client, Message } = require('discord.js');

const client = new Client();

client.on('messageCreate', (message) => {
    if (message.author.bot) return;
    message.channel.send('العفو لا يمكنك المراسلة فقط دون زيادة أو نقصان');
});

client.login('YOUR_BOT_TOKEN');
```