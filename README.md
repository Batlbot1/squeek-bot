# squeek-bot

Write a [Squeek](https://squeek.net) bot in a few lines. The library keeps the
socket open and does the end-to-end encryption; you write what the bot says.

```bash
npm install squeek-bot
```

```js
const { SqueekBot } = require('squeek-bot');

const bot = new SqueekBot(process.env.BOT_TOKEN);

bot.on('message', async (msg) => {
  if (msg.text === '/hi') await msg.reply('Hi there! 🐀');
});

bot.start();
```

## Getting a token

In the Squeek app: Profile → My bots → Create. The app makes the bot's
keys on your phone and shows the token **once** — copy it into your program.
The token is `<id>:<secret key>:<login secret>`. Keep it like a password:
whoever has it is the bot.

## What a bot can do

- Answer in private chats: a person writes first, the bot replies. A bot
  cannot start a chat with someone.
- Be a member or an admin of groups and channels, and post there.
- Post up to 30 messages a minute.

It cannot make calls, and it cannot read what was said before it was added —
messages are sealed to the people in the chat at the time.

## API

```ts
new SqueekBot(token, { apiUrl?, wsUrl? })   // production by default

bot.start()                       // sign in, connect; resolves when connected
bot.stop()

bot.on('message', (msg) => …)     // every message in every chat the bot is in
bot.on('connected' | 'disconnected' | 'error', …)

bot.send(chatId, text, { replyTo? })
bot.sendFile(chatId, { name, data, mimeType }, caption?)   // channels and discussions
bot.editMessage(chatId, messageId, text)   // rewrite one of its own
bot.deleteMessage(messageId)               // for everyone
bot.react(messageId, emoji)                // toggle its own reaction
bot.setCommands([{ command, description }])  // the menu people see after "/"
bot.setDescription(text)                     // the line under its name
bot.reloadChats()                 // forget cached members; the next send asks again

msg.text        // decrypted
msg.chat        // { id, type, name }
msg.from        // { id, username, name }
msg.id
msg.raw         // the row as the gateway sent it
msg.reply(text)
msg.react(emoji)
```

## Commands

Tell people what the bot answers to. The list shows on the bot's profile and
drops down in the composer as soon as someone types `/`:

```js
bot.on('connected', async () => {
  await bot.setDescription('Tells you the weather. Ask it with /weather.');
  await bot.setCommands([
    { command: 'weather', description: 'Forecast for tomorrow' },
    { command: 'rain', description: 'Will it rain today' },
  ]);
});
```

A chat with a bot opens with a **Start** button, which sends `/start` — answer
it with what the bot is for:

```js
bot.on('message', async (msg) => {
  if (msg.text === '/start') await msg.reply('Hi! /weather tells you the forecast.');
});
```

Declaring commands is the same call the owner makes in the app, so a bot may
do it for itself; either way the menu is only a menu — what a command *does*
is this program's business.

## Posting to a channel without this library

Channels and discussions are encrypted by the server, so a post there is one
HTTP request in any language:

```bash
TOKENS=$(curl -s https://api.squeek.net/auth/bot -H 'content-type: application/json' \
  -d '{"botId":42,"secret":"<login secret>"}')
ACCESS=$(echo "$TOKENS" | jq -r .accessToken)

curl https://api.squeek.net/messages -H "authorization: Bearer $ACCESS" \
  -H 'content-type: application/json' \
  -d '{"chatId":17,"content":"Reminder: meeting at 19:00"}'
```

Private chats and groups are end-to-end encrypted and need the envelope this
library builds; there is no way around that, and that is the point.

## Not yet

Files into private chats and groups (the chunked file format is not ported
yet), inline mode, keyboards.
