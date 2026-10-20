// Rate-limit и защита авторизации dirigo (задача V2-6.1).
// Ноль зависимостей: память процесса + env-настройка. Ограничитель:
//   - /api/auth/login  — защита от перебора токена (по IP)
//   - /api/*  (опц.)   — общий потолок запросов с IP, включается env'ом
// Плюс сравнение секретов за постоянное время (timing-safe).

export type LimitCheck = { ok: boolean; remaining: number; retryAfterMs: number };

type Bucket = { hits: number[] };

const now = () => Date.now();

/** Скользящее окно: ключ → времена попаданий. Память ограничена (LRU-вытеснение). */
export class SlidingWindow {
  private buckets = new Map<string, Bucket>();
  private lastTouch = new Map<string, number>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly maxKeys = 5000,
  ) {}

  get enabled(): boolean {
    return this.max > 0 && this.windowMs > 0;
  }

  check(key: string, cost = 1): LimitCheck {
    const t = now();
    if (!this.enabled) return { ok: true, remaining: Number.POSITIVE_INFINITY, retryAfterMs: 0 };

    const b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.evict(t);
      const fresh: Bucket = { hits: [t] };
      this.buckets.set(key, fresh);
      this.lastTouch.set(key, t);
      return { ok: true, remaining: this.max - cost, retryAfterMs: 0 };
    }

    const from = t - this.windowMs;
    b.hits = b.hits.filter((h) => h > from);
    if (b.hits.length + cost > this.max) {
      const oldest = b.hits[0] ?? t;
      this.lastTouch.set(key, t);
      return { ok: false, remaining: 0, retryAfterMs: Math.max(1, oldest + this.windowMs - t) };
    }
    b.hits.push(t);
    this.lastTouch.set(key, t);
    return { ok: true, remaining: this.max - b.hits.length, retryAfterMs: 0 };
  }

  reset(key?: string): void {
    if (key === undefined) { this.buckets.clear(); this.lastTouch.clear(); return; }
    this.buckets.delete(key);
    this.lastTouch.delete(key);
  }

  /** Вытеснение самых старых ключей, когда карта переполнилась. */
  private evict(t: number): void {
    const staleCutoff = t - this.windowMs;
    for (const [k, ts] of this.lastTouch) {
      if (ts < staleCutoff) { this.buckets.delete(k); this.lastTouch.delete(k); }
    }
    while (this.buckets.size >= this.maxKeys) {
      let oldestKey: string | null = null;
      let oldestTs = Number.POSITIVE_INFINITY;
      for (const [k, ts] of this.lastTouch) {
        if (ts < oldestTs) { oldestTs = ts; oldestKey = k; }
      }
      if (oldestKey === null) break;
      this.buckets.delete(oldestKey);
      this.lastTouch.delete(oldestKey);
    }
  }
}

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** Лимит попыток входа /api/auth/login (по IP). */
export const loginLimiter = new SlidingWindow(
  envNum("DIRIGO_RL_LOGIN_MAX", 5),
  envNum("DIRIGO_RL_LOGIN_WIN_MS", 60_000),
);

/** Общий лимит /api/* с IP; 0 — выключен (по умолчанию, loopback-режим). */
export const apiLimiter = new SlidingWindow(
  envNum("DIRIGO_RL_API_MAX", 0),
  envNum("DIRIGO_RL_API_WIN_MS", 60_000),
);

/** IP клиента: первый элемент x-forwarded-for, иначе адрес сокета (Bun: server request ip). */
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  // Bun.serve отдаёт адрес через объект запроса (свойство ip) — но в типах его нет.
  const anyReq = req as unknown as { ip?: string };
  return anyReq.ip ?? "unknown";
}

/** Сравнение строк за постоянное время (защита от timing-атаки на токен). */
export function safeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/** Сброс всех счётчиков (для тестов). */
export function resetLimiters(): void {
  loginLimiter.reset();
  apiLimiter.reset();
}
