/**
 * Tek kopya garantisi (PostgreSQL advisory lock). Aynı bağlantı etiketiyle (WA_CONNECTION_LABEL)
 * çalışan ikinci bir gateway — başka konteyner, eski sürüm, başka sunucu — kilidi alamaz ve
 * WhatsApp'a BAĞLANMAZ (aynı oturumu iki istemci açarsa WhatsApp ikisini de düşürür ve anahtarlar
 * bozulabilir). Kilit ayrı ve kalıcı bir oturum bağlantısında tutulur: bağlantı koparsa kilit
 * PostgreSQL tarafında kendiliğinden düşer; gateway bunu fark edip WhatsApp soketini kapatır ve
 * kilidi yeniden almadan bağlanmaz. Tablo veya migration gerekmez (pg_try_advisory_lock).
 * Bağlantı adresi ve parola hiçbir mesaja girmez.
 */
import { createHash } from "node:crypto";

import pg from "pg";

/** Kilit anahtarının ilk yarısı: "Kw" + "Ga" (Kiraligim WhatsApp GAteway). */
export const LEASE_NAMESPACE = 0x4b774761;

/** Etiketten kararlı 32 bit işaretli anahtar. */
export function leaseKey(label: string): number {
  return createHash("sha256").update(`wa-gateway:${label}`).digest().readInt32BE(0);
}

export interface Lease {
  /** true: kilit bizde (zaten bizdeyse de true). false: başka bir kopya tutuyor. Hata: fırlatır. */
  acquire(): Promise<boolean>;
  readonly held: boolean;
  /** Kilit kaybedilince (bağlantı koptu, denetim başarısız) bir kez çağrılır. */
  onLost(cb: () => void): void;
  release(): Promise<void>;
}

/** Veritabanısız (Faz 1 test) biçim: yerel kilit dosyası yeterli. */
export class NoopLease implements Lease {
  held = true;
  async acquire() {
    return true;
  }
  onLost() {}
  async release() {}
}

type ClientLike = {
  connect(): Promise<unknown>;
  query<R extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>;
  end(): Promise<void>;
  on(ev: "error" | "end", cb: (...a: unknown[]) => void): unknown;
};

export class PgLease implements Lease {
  private client: ClientLike | null = null;
  private lost: (() => void) | null = null;
  private probe: NodeJS.Timeout | null = null;
  held = false;

  constructor(
    private readonly makeClient: () => ClientLike,
    private readonly label: string,
    private readonly probeMs = 30_000,
  ) {}

  static fromUrl(url: string, label: string): PgLease {
    return new PgLease(
      () =>
        new pg.Client({
          connectionString: url,
          application_name: "kiraligim-wa-gateway-lease",
          keepAlive: true,
          statement_timeout: 10_000,
          connectionTimeoutMillis: 10_000,
        }) as unknown as ClientLike,
      label,
    );
  }

  onLost(cb: () => void) {
    this.lost = cb;
  }

  private drop() {
    const wasHeld = this.held;
    this.held = false;
    if (this.probe) clearInterval(this.probe);
    this.probe = null;
    const c = this.client;
    this.client = null;
    if (c) void c.end().catch(() => undefined);
    if (wasHeld) this.lost?.();
  }

  private pending: Promise<boolean> | null = null;

  /** Tek uçuş: eşzamanlı çağrılar (ör. zaman aşımından sonra yeni deneme) aynı denemeyi bekler. */
  acquire(): Promise<boolean> {
    if (this.held && this.client) return Promise.resolve(true);
    if (!this.pending) {
      this.pending = this.tryAcquire().finally(() => {
        this.pending = null;
      });
    }
    return this.pending;
  }

  private async tryAcquire(): Promise<boolean> {
    let c = this.client;
    if (!c) {
      const fresh = this.makeClient();
      // Bağlantı hatası/sonu: kilit PostgreSQL'de düşmüştür. Yalnız GÜNCEL istemcinin olayı sayılır
      // (bırakılmış eski bir istemcinin kapanması kilidi düşürmez).
      fresh.on("error", () => {
        if (this.client === fresh) this.drop();
      });
      fresh.on("end", () => {
        if (this.client === fresh) this.drop();
      });
      try {
        await fresh.connect();
      } catch (e) {
        void fresh.end().catch(() => undefined);
        throw e;
      }
      this.client = fresh;
      c = fresh;
    }
    const { rows } = await c.query<{ ok: boolean }>(
      "select pg_catalog.pg_try_advisory_lock($1::int4, $2::int4) as ok",
      [LEASE_NAMESPACE, leaseKey(this.label)],
    );
    if (!rows[0]?.ok) {
      // Başkası tutuyor: boşta bağlantı tutulmaz.
      if (this.client === c) this.client = null;
      void c.end().catch(() => undefined);
      return false;
    }
    this.held = true;
    if (this.probe) clearInterval(this.probe);
    this.probe = setInterval(() => {
      const cur = this.client;
      if (!cur) return;
      cur.query("select 1").catch(() => {
        if (this.client === cur) this.drop();
      });
    }, this.probeMs);
    this.probe.unref();
    return true;
  }

  async release() {
    const c = this.client;
    if (this.probe) clearInterval(this.probe);
    this.probe = null;
    this.held = false;
    this.client = null;
    if (!c) return;
    try {
      await c.query("select pg_catalog.pg_advisory_unlock($1::int4, $2::int4)", [
        LEASE_NAMESPACE,
        leaseKey(this.label),
      ]);
    } catch {
      /* bağlantı kapanınca kilit zaten düşer */
    }
    await c.end().catch(() => undefined);
  }
}
