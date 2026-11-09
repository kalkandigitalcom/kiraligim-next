import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./auth";
import { workspaceMembers, workspaces } from "./tenancy";

/**
 * WhatsApp Asistanı — A1: grup kaydı ve kalıcı mesaj kuyruğu (yalnız okuma).
 *
 * Mevcut tablolarla bağ yalnız workspace/kullanıcı yabancı anahtarlarıdır; rezervasyon, fiyat ve
 * iCal tablolarına hiçbir referans yoktur. Elle yazılan migration'da (drizzle/0031):
 *  - ENABLE/FORCE RLS, kolon düzeyinde yetkiler;
 *  - ağ geçidinin TEK yazma yolu SECURITY DEFINER fonksiyonlardır (app_wa_*): tabloları doğrudan
 *    okuyamaz ve yazamaz;
 *  - grup bağlama: kod + kodu üreten kişinin WhatsApp numarası doğrulanır, audit yazılır.
 */

const ts = () => timestamp({ withTimezone: true, mode: "date" });

/** Platformun WhatsApp bağlantısı (işletmeye ait değil). Numara saklanmaz. */
export const waConnections = pgTable(
  "wa_connections",
  {
    id: uuid().primaryKey(),
    label: text().notNull(),
    status: text({ enum: ["connecting", "open", "closed", "logged_out"] })
      .notNull()
      .default("connecting"),
    lastSeenAt: ts(),
    lastConnectedAt: ts(),
    lastErrorCode: text(),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts().notNull().defaultNow(),
  },
  (t) => [
    unique("wa_connections_label_key").on(t.label),
    check("wa_connections_label_format", sql`${t.label} ~ '^[a-z0-9_-]{1,40}$'`),
    check(
      "wa_connections_status_check",
      sql`${t.status} in ('connecting', 'open', 'closed', 'logged_out')`,
    ),
    check(
      "wa_connections_error_format",
      sql`${t.lastErrorCode} is null or ${t.lastErrorCode} ~ '^[a-z0-9_]{1,40}$'`,
    ),
  ],
);

/** Ağ geçidinin bulunduğu gruplar. Bağlanana kadar hiçbir işletmeye görünmez. */
export const waGroups = pgTable(
  "wa_groups",
  {
    id: uuid().primaryKey(),
    connectionId: uuid()
      .notNull()
      .references(() => waConnections.id, { onDelete: "cascade" }),
    jid: text().notNull(),
    subject: text(),
    participantCount: integer().notNull().default(0),
    botIsAdmin: boolean().notNull().default(false),
    /** "Yalnız yöneticiler mesaj gönderebilir" ayarı. */
    adminsOnly: boolean().notNull().default(false),
    status: text({ enum: ["discovered", "linked", "suspended", "left"] })
      .notNull()
      .default("discovered"),
    workspaceId: uuid().references(() => workspaces.id, { onDelete: "restrict" }),
    linkedAt: ts(),
    linkedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    /** Kod denemesi sınırı: pencere içindeki hatalı deneme sayısı. */
    linkFailCount: integer().notNull().default(0),
    linkFailWindowAt: ts(),
    firstSeenAt: ts().notNull().defaultNow(),
    lastSeenAt: ts().notNull().defaultNow(),
    lastMessageAt: ts(),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts().notNull().defaultNow(),
  },
  (t) => [
    unique("wa_groups_connection_jid_key").on(t.connectionId, t.jid),
    unique("wa_groups_scope_key").on(t.id, t.workspaceId),
    index("wa_groups_workspace_idx").on(t.workspaceId),
    index("wa_groups_linked_by_idx").on(t.linkedBy),
    check("wa_groups_jid_format", sql`${t.jid} ~ '^[0-9]{6,40}(-[0-9]{6,20})?@g\\.us$'`),
    check(
      "wa_groups_status_check",
      sql`${t.status} in ('discovered', 'linked', 'suspended', 'left')`,
    ),
    check(
      "wa_groups_status_workspace",
      sql`(${t.status} = 'discovered' and ${t.workspaceId} is null)
        or (${t.status} in ('linked', 'suspended') and ${t.workspaceId} is not null)
        or ${t.status} = 'left'`,
    ),
    check("wa_groups_subject_length", sql`${t.subject} is null or length(${t.subject}) <= 200`),
    check("wa_groups_counts", sql`${t.participantCount} >= 0 and ${t.linkFailCount} >= 0`),
  ],
);

/**
 * Grup bağlama yetkisi verilen yöneticiler (owner her zaman yetkili). Üyelik silinirse yetki de
 * silinir; yönetici rolü düşürülürse kayıt kalsa da yetki yok sayılır (rol ayrıca denetlenir).
 */
export const waLinkManagers = pgTable(
  "wa_link_managers",
  {
    workspaceId: uuid().notNull(),
    userId: uuid().notNull(),
    grantedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "wa_link_managers_pkey", columns: [t.workspaceId, t.userId] }),
    foreignKey({
      name: "wa_link_managers_member_fk",
      columns: [t.workspaceId, t.userId],
      foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId],
    }).onDelete("cascade"),
    index("wa_link_managers_user_idx").on(t.userId),
    index("wa_link_managers_granted_by_idx").on(t.grantedBy),
  ],
);

/**
 * Grup bağlama kodları. Kod ve telefon düz metin saklanmaz: koda özel rastgele tuzla SHA-256.
 * Yalnız kodu üreten kişinin numarasından gruba yazılan kod kabul edilir.
 */
export const waLinkCodes = pgTable(
  "wa_link_codes",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    createdBy: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeSalt: text().notNull(),
    codeHash: text().notNull(),
    phoneHash: text().notNull(),
    expiresAt: ts().notNull(),
    usedAt: ts(),
    usedGroupId: uuid().references(() => waGroups.id, { onDelete: "set null" }),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => [
    index("wa_link_codes_workspace_idx").on(t.workspaceId),
    index("wa_link_codes_created_by_idx").on(t.createdBy),
    index("wa_link_codes_used_group_idx").on(t.usedGroupId),
    index("wa_link_codes_active_idx")
      .on(t.expiresAt)
      .where(sql`${t.usedAt} is null`),
    check("wa_link_codes_salt_format", sql`${t.codeSalt} ~ '^[0-9a-f]{32}$'`),
    check(
      "wa_link_codes_hash_format",
      sql`${t.codeHash} ~ '^[0-9a-f]{64}$' and ${t.phoneHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "wa_link_codes_ttl",
      sql`${t.expiresAt} > ${t.createdAt} and ${t.expiresAt} <= ${t.createdAt} + interval '15 minutes'`,
    ),
  ],
);

/** Kalıcı mesaj kuyruğu: yalnız bağlı grupların metin mesajları; 90 gün sonra silinir. */
export const waInboundMessages = pgTable(
  "wa_inbound_messages",
  {
    id: uuid().primaryKey(),
    connectionId: uuid()
      .notNull()
      .references(() => waConnections.id, { onDelete: "cascade" }),
    groupId: uuid().notNull(),
    workspaceId: uuid().notNull(),
    waMessageId: text().notNull(),
    senderJid: text().notNull(),
    senderPn: text(),
    senderLid: text(),
    body: text().notNull(),
    sentAt: ts().notNull(),
    receivedAt: ts().notNull().defaultNow(),
    /** live: gerçek zamanlı; backlog: bağlantı kesintisinden sonra gelen birikim. */
    kind: text({ enum: ["live", "backlog"] }).notNull(),
    /** A3'te worker durumları eklenir; A1'de yalnız "received". */
    status: text({ enum: ["received"] })
      .notNull()
      .default("received"),
    attempts: integer().notNull().default(0),
    lockedUntil: ts(),
    lockToken: uuid(),
  },
  (t) => [
    foreignKey({
      name: "wa_inbound_messages_group_fk",
      columns: [t.groupId, t.workspaceId],
      foreignColumns: [waGroups.id, waGroups.workspaceId],
    }).onDelete("cascade"),
    unique("wa_inbound_messages_dedupe_key").on(t.groupId, t.waMessageId),
    index("wa_inbound_messages_queue_idx").on(t.status, t.receivedAt),
    index("wa_inbound_messages_workspace_idx").on(t.workspaceId, t.receivedAt),
    index("wa_inbound_messages_connection_idx").on(t.connectionId),
    index("wa_inbound_messages_received_idx").on(t.receivedAt),
    check("wa_inbound_messages_kind_check", sql`${t.kind} in ('live', 'backlog')`),
    check("wa_inbound_messages_status_check", sql`${t.status} in ('received')`),
    check(
      "wa_inbound_messages_lengths",
      sql`length(${t.body}) between 1 and 4000 and length(${t.waMessageId}) between 1 and 128
        and length(${t.senderJid}) between 3 and 128`,
    ),
    check(
      "wa_inbound_messages_sender_pn_format",
      sql`${t.senderPn} is null or ${t.senderPn} ~ '^[1-9][0-9]{6,19}$'`,
    ),
  ],
);
