/**
 * A1 veritabanı erişimi. Ağ geçidi tablolara DOĞRUDAN dokunmaz: yalnız 0031'deki SECURITY DEFINER
 * fonksiyonlarını çağırır (app_user'ın bu tablolarda yazma yetkisi ve bağlamı yoktur).
 * Mesaj metni, numara ve kod günlüğe yazılmaz.
 */
import pg from "pg";

import { databaseNameProblem, type WaEnv } from "./config.ts";

export type Queryable = {
  query<R extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>;
};

export type ConnectionStatus = "connecting" | "open" | "closed" | "logged_out";
/** Numara doğrulama sonucu (yalnız "verified" için ✅). */
export type VerifyOutcome = "verified" | "invalid" | "sender_unknown";
export type IngestOutcome = "stored" | "duplicate" | "ignored";

/** A2f: gönderilecek mesaj tepkisi (kuyruktan; worker kararı, veritabanında doğrulanmış). */
export type QueuedReaction = {
  messageId: string;
  lockToken: string;
  groupJid: string;
  waMessageId: string;
  senderJid: string;
  emoji: string;
};
export type ReactionFinish = "sent" | "retry" | "failed" | "lost";

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

  /**
   * Bağlantı durumunu yazar ve bağlantı kimliğini döndürür (ilk çağrıda kaydı oluşturur).
   * accountPn: asistanın kendi numarası (panelde wa.me bağlantısı için); bilinmiyorsa null.
   */
  async heartbeat(
    status: ConnectionStatus,
    errorCode: string | null = null,
    accountPn: string | null = null,
  ): Promise<string> {
    const { rows } = await this.db.query<{ id: string }>(
      "select public.app_wa_heartbeat($1, $2, $3, $4) as id",
      [this.label, status, errorCode, accountPn],
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
    /** Asistanı gruba ekleyen kişinin numarası (yalnız katılım bildiriminde bilinir). */
    addedByPn?: string | null;
    /** Grup kurucusunun numarası. */
    ownerPn?: string | null;
  }): Promise<string> {
    const { rows } = await this.db.query<{ status: string }>(
      "select public.app_wa_sync_group($1, $2, $3, $4, $5, $6, $7, $8, $9) as status",
      [
        await this.conn(),
        g.jid,
        g.subject,
        g.participants,
        g.botIsAdmin,
        g.adminsOnly,
        g.present,
        g.addedByPn ?? null,
        g.ownerPn ?? null,
      ],
    );
    return rows[0]!.status;
  }

  /** Asistana özel mesajla gelen numara doğrulama kodu (gönderen numarası WhatsApp'tan). */
  async verifyPhone(code: string, senderPn: string | null): Promise<VerifyOutcome> {
    const { rows } = await this.db.query<{ out: VerifyOutcome }>(
      "select public.app_wa_verify_phone($1, $2) as out",
      [code, senderPn],
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

  /** A2f: bu bağlantının gönderilmeyi bekleyen tepkileri (en fazla `limit`, 1–20; kilitlenir). */
  async claimReactions(limit: number): Promise<QueuedReaction[]> {
    const { rows } = await this.db.query<{
      message_id: string;
      lock_token: string;
      group_jid: string;
      wa_message_id: string;
      sender_jid: string;
      emoji: string;
    }>(
      "select message_id, lock_token, group_jid, wa_message_id, sender_jid, emoji from public.app_wa_claim_reactions($1, $2)",
      [await this.conn(), limit],
    );
    return rows.map((r) => ({
      messageId: r.message_id,
      lockToken: r.lock_token,
      groupJid: r.group_jid,
      waMessageId: r.wa_message_id,
      senderJid: r.sender_jid,
      emoji: r.emoji,
    }));
  }

  /** A2f: gönderim sonucu (yalnız kısa hata kodu). Kilit uyuşmazsa "lost": hiçbir şey yazılmaz. */
  async finishReaction(
    r: Pick<QueuedReaction, "messageId" | "lockToken">,
    ok: boolean,
    errorCode: string | null = null,
  ): Promise<ReactionFinish> {
    const { rows } = await this.db.query<{ out: ReactionFinish }>(
      "select public.app_wa_finish_reaction($1, $2, $3, $4) as out",
      [r.messageId, r.lockToken, ok, errorCode],
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

/**
 * Bağlanılan rol ve veritabanı güvenli mi? (bağlantıdan hemen sonra, ilk iş)
 *  - süper kullanıcı, BYPASSRLS, app_migrator ve postgres her ortamda reddedilir;
 *  - production: yalnız app_wa_gateway (yalnız app_wa_* fonksiyonlarını çalıştırabilen ayrı rol);
 *  - development: app_wa_gateway veya app_user.
 * Ayrıca sunucunun bildirdiği veritabanı adı da ortam kuralına uymalı. Sorun yoksa null.
 */
export async function databaseRoleProblem(db: Queryable, env: WaEnv): Promise<string | null> {
  const { rows } = await db.query<{
    role: string;
    db: string;
    superuser: boolean;
    bypassrls: boolean;
  }>(
    `select current_user as role, current_database() as db, r.rolsuper as superuser,
            r.rolbypassrls as bypassrls
       from pg_catalog.pg_roles r where r.rolname = current_user`,
  );
  const r = rows[0];
  if (!r) return "Veritabanı rolü okunamadı.";
  if (r.superuser || r.bypassrls || r.role === "postgres" || r.role === "app_migrator") {
    return `"${r.role}" rolüyle bağlanılamaz (yetkisi gereğinden geniş).`;
  }
  const allowed = env === "production" ? ["app_wa_gateway"] : ["app_wa_gateway", "app_user"];
  if (!allowed.includes(r.role)) {
    return `WA_ENV=${env} iken veritabanı rolü ${allowed.join(" veya ")} olmalı (bulunan: "${r.role}").`;
  }
  return databaseNameProblem(`postgres://x@h/${encodeURIComponent(r.db)}`, env);
}

/** Veritabanı havuzu (en fazla 2 bağlantı). Ortama uymayan veritabanı adı reddedilir. */
export function createPool(url: string, env: WaEnv = "development"): pg.Pool {
  const problem = databaseNameProblem(url, env);
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
