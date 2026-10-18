/**
 * Tiny fetch-based client for the MyBeauty+ API — no dependencies, works in the browser and in React Native.
 *  - adds the access token, refreshes it once on 401 (concurrent calls share one refresh)
 *  - throws ApiError { status, code, message, details, fields } for every non-2xx response
 */
export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

export interface TokenStore {
  get(): Tokens | null | Promise<Tokens | null>;
  set(t: Tokens | null): void | Promise<void>;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
    public fields?: Record<string, string[]>,
  ) {
    super(message);
  }
}

export interface Api {
  baseUrl: string;
  get<T = unknown>(path: string): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  put<T = unknown>(path: string, body?: unknown): Promise<T>;
  patch<T = unknown>(path: string, body?: unknown): Promise<T>;
  del<T = unknown>(path: string): Promise<T>;
  upload<T = unknown>(path: string, form: FormData): Promise<T>;
  setTokens(t: Tokens | null): Promise<void>;
  hasSession(): Promise<boolean>;
}

export function createApi(opts: { baseUrl: string; tokens: TokenStore; onSessionExpired?: () => void; timeoutMs?: number; getLang?: () => 'it' | 'en' }): Api {
  const base = opts.baseUrl.replace(/\/$/, '');
  let refreshing: Promise<boolean> | null = null;

  async function refresh(): Promise<boolean> {
    const t = await opts.tokens.get();
    if (!t?.refreshToken) return false;
    try {
      const r = await fetch(`${base}/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: t.refreshToken }) });
      if (!r.ok) throw new Error('refresh failed');
      const j = (await r.json()) as Tokens;
      await opts.tokens.set({ accessToken: j.accessToken, refreshToken: j.refreshToken });
      return true;
    } catch {
      await opts.tokens.set(null);
      opts.onSessionExpired?.();
      return false;
    }
  }

  async function call<T>(method: string, path: string, body?: unknown, isForm = false, retry = true): Promise<T> {
    const t = await opts.tokens.get();
    const lang = opts.getLang?.() ?? 'it';
    const headers: Record<string, string> = { Accept: 'application/json', 'X-Lang': lang };
    if (!isForm && body !== undefined) headers['Content-Type'] = 'application/json';
    if (t?.accessToken) headers.Authorization = `Bearer ${t.accessToken}`;
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30000) : null;
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, { method, headers, body: isForm ? (body as FormData) : body !== undefined ? JSON.stringify(body) : undefined, signal: ctrl?.signal });
    } catch (e) {
      throw new ApiError(0, 'network', lang === 'en' ? 'Could not reach the server. Check your connection and try again.' : 'Connessione al server non riuscita. Controlla la rete e riprova.', String(e));
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (res.status === 401 && retry && t?.refreshToken && !path.startsWith('/auth/')) {
      refreshing ??= refresh().finally(() => (refreshing = null));
      if (await refreshing) return call<T>(method, path, body, isForm, false);
    }
    const text = await res.text();
    const json = text ? safeJson(text) : null;
    if (!res.ok) {
      const e = (json as { error?: { code?: string; message?: string; details?: unknown; fields?: Record<string, string[]> } } | null)?.error;
      throw new ApiError(res.status, e?.code ?? `http_${res.status}`, e?.message ?? `${lang === 'en' ? 'Error' : 'Errore'} ${res.status}`, e?.details, e?.fields);
    }
    return json as T;
  }

  return {
    baseUrl: base,
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b ?? {}),
    put: (p, b) => call('PUT', p, b ?? {}),
    patch: (p, b) => call('PATCH', p, b ?? {}),
    del: (p) => call('DELETE', p),
    upload: (p, f) => call('POST', p, f, true),
    setTokens: async (tk) => {
      await opts.tokens.set(tk);
    },
    hasSession: async () => !!(await opts.tokens.get())?.refreshToken,
  };
}

function safeJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return { error: { code: 'bad_response', message: s.slice(0, 200) } };
  }
}

/** First field error or the message — for toasts. */
export const errorText = (e: unknown) => {
  if (e instanceof ApiError) {
    const f = e.fields && Object.values(e.fields).flat()[0];
    const missing = (e.details as { missing?: string[] } | undefined)?.missing;
    if (missing?.length) return `${e.message}: ${missing.join(', ')}`;
    return f ? `${e.message}: ${f}` : e.message;
  }
  return (e as Error)?.message ?? String(e);
};
