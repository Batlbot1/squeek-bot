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

bot.send(chatId, text, { replyTo? })   // resolves with the new message id
bot.sendFile(chatId, { name, data, mimeType }, caption?)   // channels and discussions
bot.editMessage(chatId, messageId, text)   // rewrite one of its own
bot.deleteMessage(messageId)               // for everyone
bot.react(messageId, emoji)                // toggle its own reaction
bot.setCommands([{ command, description }])  // the menu people see after "/"
bot.setDescription(text)                     // the line under its name
bot.setWebhook(url)                          // deliver to a URL instead of this socket
bot.dropWebhook()                            // back to the socket
bot.readWebhook(rawBody, signature, secret)  // one delivery, verified and opened
bot.reloadChats()                 // forget cached members; the next send asks again

msg.text        // decrypted
msg.chat        // { id, type, name }
msg.from        // { id, username, name }
msg.id
msg.raw         // the row as the gateway sent it
msg.reply(text)   // resolves with the new message id
msg.react(emoji)
```

## Editing what it already said

`send()` and `reply()` resolve with the id of the stored message, so a bot can
rewrite one line instead of sending five:

```js
bot.on('message', async (msg) => {
  if (msg.text !== '/backup') return;

  await msg.react('👀');
  const id = await bot.send(msg.chat.id, 'Backup: running…');

  await makeBackup();
  await bot.editMessage(msg.chat.id, id, 'Backup: done ✅');
});
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

## Without a socket

A bot that has nowhere to run day and night can name a URL instead. The server
then POSTs every message it would have delivered over the socket, signed:

```js
const { url, secret } = await bot.setWebhook('https://my-bot.example/squeek');
// keep `secret` — it signs every delivery
```

```js
// your http handler, e.g. express
app.post('/squeek', express.raw({ type: '*/*' }), async (req, res) => {
  const msg = await bot.readWebhook(req.body.toString(), req.get('x-squeek-signature'), SECRET);

  res.sendStatus(200);           // answer first, work after

  if (msg?.text === '/hi') await msg.reply('Hi there! 🐀');
});
```

`readWebhook` throws when the signature does not match, so an unsigned request
never reaches your code. The body of a private chat or group is still the
ciphertext sealed to the bot — this library opens it with the bot's key, and
the server never could. Replying still needs `bot.start()` to have signed in;
call it once when your process boots.

## Not yet

Files into private chats and groups (the chunked file format is not ported
yet), inline mode, keyboards.
