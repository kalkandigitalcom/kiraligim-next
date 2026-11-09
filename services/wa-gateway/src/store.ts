/**
 * A1 veritabanı erişimi. Ağ geçidi tablolara DOĞRUDAN dokunmaz: yalnız 0031'deki SECURITY DEFINER
 * fonksiyonlarını çağırır (app_user'ın bu tablolarda yazma yetkisi ve bağlamı yoktur).
 * Mesaj metni, numara ve kod günlüğe yazılmaz.
 */
import pg from "pg";

import { databaseNameProblem } from "./config.ts";

export type Queryable = {
  query<R extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>;
};

export type ConnectionStatus = "connecting" | "open" | "closed" | "logged_out";
export type RedeemOutcome =
  | "linked"
  | "invalid"
  | "sender_unknown"
  | "sender_mismatch"
  | "not_permitted"
  | "already_linked"
  | "linked_elsewhere"
  | "throttled"
  | "unknown_group";
export type IngestOutcome = "stored" | "duplicate" | "ignored";

export type InboundRecord = {
  groupJid: string;
  messageId: string;
  senderJid: string;
  senderPn: string | null;
  senderLid: string | null;
  body: string;
  sentAt: string;
  kind: "live" | "backlog";
};

export class WaStore {
  private connectionId: string | null = null;

  constructor(
    private readonly db: Queryable,
    private readonly label: string,
  ) {}

  /** Bağlantı durumunu yazar ve bağlantı kimliğini döndürür (ilk çağrıda kaydı oluşturur). */
  async heartbeat(status: ConnectionStatus, errorCode: string | null = null): Promise<string> {
    const { rows } = await this.db.query<{ id: string }>(
      "select public.app_wa_heartbeat($1, $2, $3) as id",
      [this.label, status, errorCode],
    );
    this.connectionId = rows[0]!.id;
    return this.connectionId;
  }

  private async conn(): Promise<string> {
    return this.connectionId ?? (await this.heartbeat("connecting"));
  }

  async syncGroup(g: {
    jid: string;
    subject: string | null;
    participants: number;
    botIsAdmin: boolean;
    adminsOnly: boolean;
    present: boolean;
  }): Promise<string> {
    const { rows } = await this.db.query<{ status: string }>(
      "select public.app_wa_sync_group($1, $2, $3, $4, $5, $6, $7) as status",
      [await this.conn(), g.jid, g.subject, g.participants, g.botIsAdmin, g.adminsOnly, g.present],
    );
    return rows[0]!.status;
  }

  async redeemLinkCode(groupJid: string, code: string, senderPn: string | null) {
    const { rows } = await this.db.query<{ out: RedeemOutcome }>(
      "select public.app_wa_redeem_link_code($1, $2, $3, $4) as out",
      [await this.conn(), groupJid, code, senderPn],
    );
    return rows[0]!.out;
  }

  async ingest(m: InboundRecord): Promise<IngestOutcome> {
    const { rows } = await this.db.query<{ out: IngestOutcome }>(
      "select public.app_wa_ingest_message($1, $2, $3, $4, $5, $6, $7, $8, $9) as out",
      [
        await this.conn(),
        m.groupJid,
        m.messageId,
        m.senderJid,
        m.senderPn,
        m.senderLid,
        m.body,
        m.sentAt,
        m.kind,
      ],
    );
    return rows[0]!.out;
  }

  async purge(days: number): Promise<number> {
    const { rows } = await this.db.query<{ n: number }>(
      "select public.app_wa_purge_messages($1) as n",
      [days],
    );
    return Number(rows[0]?.n ?? 0);
  }
}

/** Geliştirme veritabanı havuzu (en fazla 2 bağlantı). Üretim adına benzeyen veritabanı reddedilir. */
export function createPool(url: string): pg.Pool {
  const problem = databaseNameProblem(url);
  if (problem) throw new Error(problem);
  const pool = new pg.Pool({
    connectionString: url,
    max: 2,
    application_name: "kiraligim-wa-gateway",
    statement_timeout: 10_000,
    idleTimeoutMillis: 30_000,
  });
  // Bağlantı adresi ve parolası hata mesajına girmez.
  pool.on("error", (e) => console.error(`[wa] veritabanı havuz hatası: ${e.name}`));
  return pool;
}
