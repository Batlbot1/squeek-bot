import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { SqueekApi } from './api';
import { decryptMessage, encryptMessage, publicKeyOf, verifySignature, type Recipient } from './crypto';

export { encryptMessage, decryptMessage, sealTo, openSealed, verifySignature } from './crypto';

/** The token from the app: "<bot id>:<secret key>:<login secret>". */
export type BotToken = { botId: number; secretKey: string; loginSecret: string };

export const parseToken = (token: string): BotToken => {
  const [id, secretKey, loginSecret] = String(token).trim().split(':');

  if (!/^\d+$/.test(id ?? '') || !/^[0-9a-f]{64}$/.test(secretKey ?? '') || !/^[0-9a-f]{64}$/.test(loginSecret ?? '')) {
    throw new Error('Bot token must look like "<id>:<secret key>:<login secret>", as shown in the app');
  }

  return { botId: Number(id), secretKey, loginSecret };
};

export type Chat = { id: number; type: string; name: string | null };

/** One entry of the menu people see when they type "/" in a chat with the bot. */
export type BotCommand = { command: string; description: string };

/** One message, decrypted, as the bot sees it. */
export class Message {
  constructor(
    private readonly bot: SqueekBot,
    /** The raw row from the gateway. */
    public readonly raw: any,
    public readonly chat: Chat,
    public readonly text: string,
  ) {}

  get id(): number {
    return Number(this.raw.id);
  }

  get from(): { id: number; username: string; name: string } {
    return {
      id: Number(this.raw.senderId ?? this.raw.sender?.id ?? 0),
      username: String(this.raw.senderUsername ?? this.raw.sender?.username ?? ''),
      name: String(this.raw.senderName ?? this.raw.sender?.name ?? ''),
    };
  }

  /** True when the bot itself wrote it — most bots skip those. */
  get isMine(): boolean {
    return this.from.id === this.bot.id;
  }

  /** Answers in the same chat, quoting this message; gives the new id. */
  reply(text: string): Promise<number> {
    return this.bot.send(this.chat.id, text, { replyTo: this.id });
  }

  /** Puts an emoji on this message — «seen it», without a sentence. */
  react(emoji: string): Promise<void> {
    return this.bot.react(this.id, emoji);
  }
}

export type SqueekBotOptions = {
  /** Where the API lives. Production by default. */
  apiUrl?: string;
  /** The WebSocket gateway. Production by default. */
  wsUrl?: string;
};

const PRODUCTION = {
  apiUrl: 'https://api.squeek.net',
  wsUrl: 'wss://ws.squeek.net/ws',
};

const isServerEncrypted = (type: string) => type === 'channel' || type === 'discussion';

/**
 * A Squeek bot: give it the token from the app, listen for messages, send
 * some. Everything between — the socket, the reconnects, the envelope that
 * makes a private chat private — is in here.
 *
 *   const bot = new SqueekBot(process.env.BOT_TOKEN);
 *   bot.on('message', (msg) => { if (msg.text === '/hi') msg.reply('Hi!'); });
 *   bot.start();
 */
export class SqueekBot extends EventEmitter {
  readonly id: number;
  readonly publicKey: string;

  private readonly secretKey: string;
  private readonly api: SqueekApi;
  private readonly wsUrl: string;
  private socket: WebSocket | null = null;
  private stopped = true;
  private backoff = 1000;
  private ping: NodeJS.Timeout | null = null;
  private chats = new Map<number, Chat>();
  /** Sends waiting for the gateway to echo their stored id back. */
  private pendingSends = new Map<string, (id: number) => void>();
  private recipients = new Map<number, Recipient[]>();

  constructor(token: string, options: SqueekBotOptions = {}) {
    super();

    const parsed = parseToken(token);

    this.id = parsed.botId;
    this.secretKey = parsed.secretKey;
    this.publicKey = publicKeyOf(parsed.secretKey);
    this.api = new SqueekApi(options.apiUrl ?? PRODUCTION.apiUrl, parsed.botId, parsed.loginSecret);
    this.wsUrl = options.wsUrl ?? PRODUCTION.wsUrl;
  }

  /** Signs in and keeps a socket open until stop(). Resolves once connected. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.api.signIn();
    await this.reloadChats();
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.closeSocket();
  }

  /**
   * Sends text into a chat the bot is in. A private chat or group is sealed
   * to every member; a channel or discussion goes as it is, the server seals
   * those. Bots may post thirty messages a minute.
   */
  async send(chatId: number, text: string, options: { replyTo?: number } = {}): Promise<number> {
    const chat = await this.chatOf(chatId);

    if (isServerEncrypted(chat.type)) {
      const stored = await this.api.postToChannel(chatId, text, options.replyTo);
      return Number(stored.id);
    }

    // The gateway answers nothing to a send; it echoes the stored message
    // back with this label on it, which is how the id gets here.
    const clientId = randomUUID();
    const stored = this.awaitEcho(clientId);
    const envelope = encryptMessage(text, await this.recipientsOf(chatId));

    try {
      await this.sendFrame({
        type: 'new_message',
        token: this.api.accessToken,
        chatId,
        clientId,
        content: envelope.content,
        encryptedSymmetricKeys: envelope.encryptedSymmetricKeys,
        replyToMessageId: options.replyTo,
      });
    } catch (error) {
      // The member list has moved under us: fetch it again and retry once.
      this.recipients.delete(chatId);
      const fresh = encryptMessage(text, await this.recipientsOf(chatId));

      await this.sendFrame({
        type: 'new_message',
        token: this.api.accessToken,
        chatId,
        clientId,
        content: fresh.content,
        encryptedSymmetricKeys: fresh.encryptedSymmetricKeys,
        replyToMessageId: options.replyTo,
      });
    }

    return stored;
  }

  /**
   * The id of the message just sent, from the echo the gateway addresses
   * back to the sender. Ten seconds is generous for a round trip; past
   * that the message is sent and its id simply is not known, which is
   * worth an error only if the caller wanted to edit it.
   */
  private awaitEcho(clientId: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingSends.delete(clientId);
        reject(new Error('The message was sent, but the server did not echo its id'));
      }, 10_000);

      this.pendingSends.set(clientId, (id) => {
        clearTimeout(timer);
        this.pendingSends.delete(clientId);
        resolve(id);
      });
    });
  }

  /**
   * Sends a file into a channel or discussion. Private chats and groups
   * seal files chunk by chunk on the device; that part of the format is
   * not in this library yet, so it says so instead of sending something a
   * phone could not open.
   */
  async sendFile(
    chatId: number,
    file: { name: string; data: Uint8Array | Buffer; mimeType: string },
    caption = '',
  ): Promise<void> {
    const chat = await this.chatOf(chatId);

    if (!isServerEncrypted(chat.type)) {
      throw new Error('Files to private chats and groups are not supported yet; channels and discussions are');
    }

    const form = new FormData();

    form.append('chatId', String(chatId));
    form.append('content', caption);
    form.append('encryptedSymmetricKeys', '{}');
    form.append('fileEncryptedSymmetricKeys', '{}');
    const bytes = new Uint8Array(file.data.byteLength);

    bytes.set(file.data);
    form.append('file', new Blob([bytes], { type: file.mimeType }), file.name);

    await this.api.upload(form);
  }

  /**
   * Rewrites one of the bot's own messages. A channel or discussion is
   * sealed by the server; elsewhere the new text is sealed here, to the
   * same members the original went to.
   */
  async editMessage(chatId: number, messageId: number, text: string): Promise<void> {
    const chat = await this.chatOf(chatId);

    if (isServerEncrypted(chat.type)) {
      await this.sendFrame({
        type: 'edit_message',
        token: this.api.accessToken,
        messageId,
        content: text,
      });
      return;
    }

    const envelope = encryptMessage(text, await this.recipientsOf(chatId));

    await this.sendFrame({
      type: 'edit_message',
      token: this.api.accessToken,
      messageId,
      content: envelope.content,
      encryptedSymmetricKeys: envelope.encryptedSymmetricKeys,
    });
  }

  /** Deletes one of the bot's own messages for everyone. */
  async deleteMessage(messageId: number): Promise<void> {
    await this.sendFrame({
      type: 'delete_message',
      token: this.api.accessToken,
      messageId,
    });
  }

  /** Puts an emoji on a message, or takes the bot's own off again. */
  async react(messageId: number, emoji: string): Promise<void> {
    await this.sendFrame({
      type: 'message_reaction',
      token: this.api.accessToken,
      messageId,
      emoji,
    });
  }

  /**
   * Declares what the bot answers to. People see the list on its profile
   * and in the composer when they type a slash; what a command does is
   * still this program's business. Usually called once, after start().
   */
  async setCommands(commands: BotCommand[]): Promise<void> {
    await this.api.patch(`/bots/${this.id}`, { commands });
  }

  /** The line under the bot's name on its profile. */
  async setDescription(bio: string): Promise<void> {
    await this.api.patch(`/bots/${this.id}`, { bio });
  }

  /**
   * Points the server at a URL of yours instead of this socket: from then
   * on every message the bot would have received is POSTed there, signed.
   * The signing secret comes back once — keep it to verify deliveries.
   */
  async setWebhook(url: string): Promise<{ url: string; secret: string }> {
    return this.api.post(`/bots/${this.id}/outgoing-webhook`, { url });
  }

  /** Back to the socket: the server forgets the URL. */
  async dropWebhook(): Promise<void> {
    await this.api.delete(`/bots/${this.id}/outgoing-webhook`);
  }

  /**
   * Opens one delivery that arrived at your webhook. Verify the signature
   * first — `verifyWebhook` does both:
   *
   *   const msg = bot.readWebhook(rawBody, headers['x-squeek-signature'], secret);
   *   if (msg) await msg.reply('got it');
   */
  readWebhook(body: string, signature: string, secret: string): Promise<Message | null> {
    if (!verifySignature(body, signature, secret)) {
      throw new Error('The signature does not match; this did not come from Squeek');
    }

    const payload = JSON.parse(body);

    if (payload?.type !== 'message') return Promise.resolve(null);

    return this.messageOf(Number(payload.chatId), payload.message);
  }

  /** Forgets what it knows about chats and members; the next send asks again. */
  async reloadChats(): Promise<void> {
    const rows = await this.api.chats();

    this.chats.clear();
    this.recipients.clear();

    for (const row of rows) {
      this.chats.set(Number(row.chat.id), {
        id: Number(row.chat.id),
        type: String(row.chat.type),
        name: row.chat.name ?? null,
      });
    }
  }

  // --------------------------------------------------------------- wiring

  private async chatOf(chatId: number): Promise<Chat> {
    let chat = this.chats.get(chatId);

    if (!chat) {
      await this.reloadChats();
      chat = this.chats.get(chatId);
    }

    if (!chat) throw new Error(`The bot is not in chat ${chatId}`);

    return chat;
  }

  private async recipientsOf(chatId: number): Promise<Recipient[]> {
    const cached = this.recipients.get(chatId);

    if (cached) return cached;

    const members = await this.api.participants(chatId);
    const recipients = members
      .filter((member) => /^[0-9a-f]{64}$/.test(member.user.publicKey ?? ''))
      .map((member) => ({ userId: member.user.id, publicKey: member.user.publicKey as string }));

    this.recipients.set(chatId, recipients);

    return recipients;
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.wsUrl);
      let settled = false;

      this.socket = socket;

      socket.on('open', () => {
        socket.send(JSON.stringify({ type: 'global_connection', token: this.api.accessToken }));
        this.ping = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
        }, 30_000);
      });

      socket.on('message', (raw) => {
        let data: any;

        try {
          data = JSON.parse(String(raw));
        } catch {
          return;
        }

        if (data?.type === 'global_connected') {
          this.backoff = 1000;
          this.emit('connected');
          if (!settled) {
            settled = true;
            resolve();
          }
          return;
        }

        if (data?.type === 'error' && data.message === 'Invalid token') {
          void this.api.refresh().then(() => this.closeSocket());
          return;
        }

        if (data?.type === 'error') {
          this.emit('error', new Error(String(data.message ?? 'gateway error')));
          return;
        }

        if (data?.type === 'chats_changed') {
          this.chats.delete(Number(data.chatId));
          this.recipients.delete(Number(data.chatId));
          return;
        }

        if (data?.type === 'new_message') {
          const echo = typeof data.clientId === 'string' ? this.pendingSends.get(data.clientId) : undefined;

          if (echo) echo(Number(data.message?.id));

          void this.handleMessage(Number(data.chatId), data.message);
        }
      });

      socket.on('close', () => {
        if (this.ping) clearInterval(this.ping);
        this.ping = null;
        this.socket = null;
        this.emit('disconnected');

        if (this.stopped) return;

        const wait = this.backoff;
        this.backoff = Math.min(this.backoff * 2, 30_000);
        setTimeout(() => void this.connect().catch(() => undefined), wait);
      });

      socket.on('error', (error) => {
        this.emit('error', error);
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
    });
  }

  /**
   * One stored row as a Message: the chat it belongs to, and the text,
   * opened with the bot's key unless the server sealed it. Null for a
   * system line, a deleted message, or one not sealed to this bot.
   */
  private async messageOf(chatId: number, raw: any): Promise<Message | null> {
    if (!raw || raw.deletedAt || raw.system) return null;

    const chat = await this.chatOf(chatId);
    let text = '';

    if (raw.encryption === 'server') {
      text = String(raw.content ?? '');
    } else {
      const sealedKey = raw.encryptedSymmetricKeys?.[String(this.id)] ?? raw.encryptedKey ?? null;

      if (!sealedKey) return null;

      text = decryptMessage(String(raw.content ?? ''), sealedKey, this.secretKey);
    }

    return new Message(this, raw, chat, text);
  }

  private async handleMessage(chatId: number, raw: any): Promise<void> {
    try {
      const message = await this.messageOf(chatId, raw);

      if (!message || message.isMine) return;

      this.emit('message', message);
    } catch (error) {
      this.emit('error', error);
    }
  }

  private sendFrame(frame: Record<string, unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = this.socket;

      if (!socket || socket.readyState !== WebSocket.OPEN) {
        reject(new Error('Not connected; call start() first'));
        return;
      }

      socket.send(JSON.stringify(frame), (error) => (error ? reject(error) : resolve()));
    });
  }

  private closeSocket(): void {
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
    this.socket?.close();
    this.socket = null;
  }
}
