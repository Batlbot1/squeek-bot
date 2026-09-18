/** The few REST calls a bot needs, with the token refreshed when it expires. */
export type Tokens = { accessToken: string; refreshToken: string };

export class SqueekApi {
  private tokens: Tokens | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly botId: number,
    private readonly secret: string,
  ) {}

  get accessToken(): string | null {
    return this.tokens?.accessToken ?? null;
  }

  /** Signs the bot in; the answer is the same pair a person gets. */
  async signIn(): Promise<Tokens> {
    this.tokens = await this.call<Tokens>('POST', '/auth/bot', {
      botId: this.botId,
      secret: this.secret,
    }, false);

    return this.tokens;
  }

  async refresh(): Promise<Tokens> {
    if (!this.tokens) return this.signIn();

    try {
      this.tokens = await this.call<Tokens>('POST', '/auth/refresh', undefined, false, {
        Authorization: `Bearer ${this.tokens.refreshToken}`,
      });
    } catch {
      this.tokens = await this.signIn();
    }

    return this.tokens;
  }

  /** My chats, with their type: which of them need an envelope. */
  chats(): Promise<{ chat: { id: number; type: string; name: string | null } }[]> {
    return this.get('/chats/messages');
  }

  /** Every member of a chat, page by page: their public keys seal the message. */
  async participants(chatId: number): Promise<{ user: { id: number; publicKey: string | null } }[]> {
    const all: { user: { id: number; publicKey: string | null } }[] = [];
    const limit = 500;

    for (let offset = 0; ; offset += limit) {
      const page = await this.get<typeof all>(
        `/chats/${chatId}/participants?offset=${offset}&limit=${limit}`,
      );

      all.push(...page);
      if (page.length < limit) break;
    }

    return all;
  }

  /** A post to a channel or discussion; the server seals it. */
  postToChannel(chatId: number, content: string, replyToMessageId?: number) {
    return this.post<{ id: number }>('/messages', { chatId, content, replyToMessageId });
  }

  get<T>(path: string): Promise<T> {
    return this.authed<T>('GET', path);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.authed<T>('POST', path, body);
  }

  /** Multipart upload: a file into a chat. The server encrypts it for channels. */
  async upload(form: FormData): Promise<unknown> {
    if (!this.tokens) await this.signIn();

    const send = () =>
      fetch(this.baseUrl + '/attachments', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.tokens!.accessToken}`, 'x-client-type': 'bot' },
        body: form,
      });

    let response = await send();

    if (response.status === 401) {
      await this.refresh();
      response = await send();
    }

    if (!response.ok) throw new Error(await describe(response));

    return response.json();
  }

  private async authed<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.tokens) await this.signIn();

    try {
      return await this.call<T>(method, path, body, true);
    } catch (error: any) {
      if (error?.status !== 401) throw error;

      await this.refresh();

      return this.call<T>(method, path, body, true);
    }
  }

  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
    authed = true,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const response = await fetch(this.baseUrl + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-client-type': 'bot',
        ...(authed && this.tokens ? { Authorization: `Bearer ${this.tokens.accessToken}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!response.ok) {
      const error = new Error(await describe(response)) as Error & { status: number };
      error.status = response.status;
      throw error;
    }

    return response.json() as Promise<T>;
  }
}

const describe = async (response: Response): Promise<string> => {
  try {
    const data = await response.json();
    const message = data?.message;

    return `${response.status}: ${Array.isArray(message) ? message.join(', ') : message || response.statusText}`;
  } catch {
    return `${response.status}: ${response.statusText}`;
  }
};
