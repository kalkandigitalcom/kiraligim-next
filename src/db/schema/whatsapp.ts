import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { WA_CALENDAR_ACTIONS, WA_SENDER_ROLES } from "../../lib/wa-calendar-parse";
import {
  WA_DECISION_MODES,
  WA_INBOUND_STATUSES,
  WA_PROPOSAL_LIMITS as PL,
  WA_PROPOSAL_STATUSES,
  WA_REACTION_KINDS,
  WA_REACTION_STATUSES,
  WA_VILLA_RESOLUTIONS,
} from "../../lib/whatsapp-meta";
import { users } from "./auth";
import { properties } from "./properties";
import { workspaceMembers, workspaces } from "./tenancy";

/**
 * WhatsApp Asistanı — A1: grup kaydı ve kalıcı mesaj kuyruğu (yalnız okuma).
 *
 * Mevcut tablolarla bağ yalnız workspace/kullanıcı yabancı anahtarlarıdır; rezervasyon, fiyat ve
 * iCal tablolarına hiçbir referans yoktur. Elle yazılan migration'da (drizzle/0031):
 *  - ENABLE/FORCE RLS, kolon düzeyinde yetkiler;
 *  - ağ geçidinin TEK yazma yolu SECURITY DEFINER fonksiyonlardır (app_wa_*): tabloları doğrudan
 *    okuyamaz ve yazamaz;
 *  - grup bağlama (A1.1, drizzle/0034): kod GÖNDERİLMEZ. Kullanıcı WhatsApp numarasını bir kez
 *    asistana özel mesajla doğrular; asistanı gruba EKLEYEN kişinin (ya da grup kurucusunun)
 *    numarası bu doğrulanmış numarayla eşleşirse grup yalnız o kullanıcının "Bekleyen gruplar"
 *    listesinde görünür ve bir villayla eşleştirilebilir. Numaralar yalnız özet (SHA-256) saklanır.
 *  - eski kodlu bağlama (wa_link_codes, app_wa_redeem_link_code) geriye uyumluluk için durur;
 *    panel ve ağ geçidi artık kullanmaz.
 */

/** Telefon özeti biçimi: sha256("wa-phone:" + rakamlar), küçük harf hex. */
const PHONE_HASH = "^[0-9a-f]{64}$";

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
    /** Platformun (asistan) WhatsApp numarası; panelde wa.me bağlantısı için. Müşteri numarası değil. */
    accountPn: text(),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts().notNull().defaultNow(),
  },
  (t) => [
    unique("wa_connections_label_key").on(t.label),
    check(
      "wa_connections_account_pn_format",
      sql`${t.accountPn} is null or ${t.accountPn} ~ '^[1-9][0-9]{6,19}$'`,
    ),
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
    /** Eşleştirilen villa (aynı işletmenin mülkü; bileşik yabancı anahtar). Eski kodlu bağlamada boş. */
    propertyId: uuid(),
    linkedAt: ts(),
    linkedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    /** Asistanı gruba ekleyen kişinin numarasının özeti (WhatsApp "author"). */
    addedByHash: text(),
    /** Grup kurucusunun numarasının özeti (WhatsApp "owner"). */
    ownerHash: text(),
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
    foreignKey({
      name: "wa_groups_property_fk",
      columns: [t.propertyId, t.workspaceId],
      foreignColumns: [properties.id, properties.workspaceId],
    }).onDelete("restrict"),
    index("wa_groups_property_idx").on(t.propertyId),
    index("wa_groups_added_by_idx")
      .on(t.addedByHash)
      .where(sql`${t.status} = 'discovered'`),
    index("wa_groups_owner_hash_idx")
      .on(t.ownerHash)
      .where(sql`${t.status} = 'discovered'`),
    check(
      "wa_groups_phone_hash_format",
      sql`(${t.addedByHash} is null or ${t.addedByHash} ~ ${sql.raw(`'${PHONE_HASH}'`)})
        and (${t.ownerHash} is null or ${t.ownerHash} ~ ${sql.raw(`'${PHONE_HASH}'`)})`,
    ),
    check(
      "wa_groups_property_workspace",
      sql`${t.propertyId} is null or ${t.workspaceId} is not null`,
    ),
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
    /** Kuyruk durumu (A2): received → processing → processed | ignored | failed. */
    status: text({ enum: WA_INBOUND_STATUSES }).notNull().default("received"),
    attempts: integer().notNull().default(0),
    lockedUntil: ts(),
    lockToken: uuid(),
    /** Worker'ın mesajı sonuçlandırdığı an (processed / ignored / failed). */
    processedAt: ts(),
    /** Son hatanın kodu (yalnız kısa kod; mesaj içeriği veya kişisel veri yazılmaz). */
    lastError: text(),
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
    check(
      "wa_inbound_messages_status_check",
      sql`${t.status} in (${sql.raw(WA_INBOUND_STATUSES.map((s) => `'${s}'`).join(", "))})`,
    ),
    check(
      "wa_inbound_messages_last_error_format",
      sql`${t.lastError} is null or ${t.lastError} ~ '^[a-z0-9_]{1,60}$'`,
    ),
    check("wa_inbound_messages_attempts", sql`${t.attempts} >= 0`),
    // Worker'ın bekleyen işleri: yalnız received ve (kilidi dolmuş olabilecek) processing.
    index("wa_inbound_messages_pending_idx")
      .on(t.receivedAt)
      .where(sql`${t.status} in ('received', 'processing')`),
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

/**
 * Kullanıcının doğrulanmış WhatsApp numarası (kullanıcı başına bir; numara başına bir kullanıcı).
 * Numara düz metin saklanmaz: özet + maskeli gösterim ("+90 532 *** ** 33").
 */
export const waVerifiedPhones = pgTable(
  "wa_verified_phones",
  {
    userId: uuid()
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    phoneHash: text().notNull(),
    phoneMasked: text().notNull(),
    verifiedAt: ts().notNull().defaultNow(),
  },
  (t) => [
    unique("wa_verified_phones_phone_key").on(t.phoneHash),
    check("wa_verified_phones_hash_format", sql`${t.phoneHash} ~ ${sql.raw(`'${PHONE_HASH}'`)}`),
    check("wa_verified_phones_masked_length", sql`length(${t.phoneMasked}) between 3 and 32`),
  ],
);

/**
 * Numara doğrulama kodu: panelde üretilir, kullanıcı asistana ÖZEL mesajla gönderir (gruba değil).
 * 10 dk geçerli, tek kullanım; kod düz metin saklanmaz (koda özel tuzla SHA-256).
 */
export const waPhoneChallenges = pgTable(
  "wa_phone_challenges",
  {
    id: uuid().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Kodun üretildiği işletme (denetim kaydı için). */
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    codeSalt: text().notNull(),
    codeHash: text().notNull(),
    expiresAt: ts().notNull(),
    usedAt: ts(),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => [
    index("wa_phone_challenges_user_idx").on(t.userId),
    index("wa_phone_challenges_workspace_idx").on(t.workspaceId),
    index("wa_phone_challenges_active_idx")
      .on(t.expiresAt)
      .where(sql`${t.usedAt} is null`),
    check("wa_phone_challenges_salt_format", sql`${t.codeSalt} ~ '^[0-9a-f]{32}$'`),
    check("wa_phone_challenges_hash_format", sql`${t.codeHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "wa_phone_challenges_ttl",
      sql`${t.expiresAt} > ${t.createdAt} and ${t.expiresAt} <= ${t.createdAt} + interval '15 minutes'`,
    ),
  ],
);

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));
/** text[] öğeleri kısa kodlardır ("year_inferred", "action_requires_review"). */
const codeArray = (col: unknown) =>
  sql`cardinality(${col}) <= ${sql.raw(String(PL.arrayMax))} and array_position(${col}, null) is null
    and (cardinality(${col}) = 0 or array_to_string(${col}, ',') ~ '^[a-z_]{1,40}(,[a-z_]{1,40})*$')`;

/**
 * WhatsApp mesajından çıkarılan takvim İŞLEM ÖNERİSİ (A2). Takvim DEĞİLDİR: rezervasyonlara
 * yalnız panelde, oturumdaki yönetici onayıyla ve rezervasyon servisiyle yazılır.
 *
 * Elle yazılan migration'da (drizzle/0036):
 *  - ENABLE/FORCE RLS; app_user yalnız kendi işletmesinde owner/manager iken okur ve düzenlenebilir
 *    kolonları günceller; INSERT/DELETE yok (öneriyi yalnız worker fonksiyonu yazar);
 *  - durum makinesi tetikleyicisi: karar verilmiş öneri değişmez; applied/rejected yalnız oturumdaki
 *    kullanıcıyla; her değişiklikte version + 1 (iyimser kilit);
 *  - worker fonksiyonları (app_wa_claim_messages, app_wa_store_proposals, …): rezervasyonları
 *    yalnız OKUR.
 *
 * Gönderen numarası saklanmaz (yalnız özet). Mesaj alıntısı 90 gün sonra boşaltılır.
 */
export const waCalendarProposals = pgTable(
  "wa_calendar_proposals",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    /** Kaynak mesaj; 90 günlük temizlikte silinince boşalır (öneri kalır). */
    messageId: uuid().references(() => waInboundMessages.id, { onDelete: "set null" }),
    groupId: uuid()
      .notNull()
      .references(() => waGroups.id, { onDelete: "restrict" }),
    /** Mesaj içindeki sıra (0..9). */
    itemNo: smallint().notNull(),
    parserVersion: smallint().notNull(),
    messageExcerpt: text().notNull(),
    sentAt: ts().notNull(),
    /** Gönderen numarasının özeti (ham numara saklanmaz). */
    senderHash: text().notNull(),
    /**
     * Gönderenin öneri anındaki rolü (doğrulanmış numarasından): owner/manager doğrulanmış
     * gönderendir; staff önerisi her zaman elle incelenir. Kayıtsız numara öneri oluşturamaz.
     */
    senderRole: text({ enum: WA_SENDER_ROLES }).notNull(),
    /** sender_role in (owner, manager) — veritabanı CHECK'i ile eş tutulur. */
    senderVerified: boolean().notNull(),
    action: text({ enum: WA_CALENDAR_ACTIONS }),
    villaNameRaw: text(),
    propertyId: uuid(),
    villaResolution: text({ enum: WA_VILLA_RESOLUTIONS }).notNull(),
    candidatePropertyIds: uuid()
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    checkIn: date({ mode: "string" }),
    checkOut: date({ mode: "string" }),
    reservationStatus: text({ enum: ["confirmed", "pending"] }),
    flags: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Öneri anındaki çakışma özeti (yalnız bilgi; onayda yeniden denetlenir). */
    conflicts: jsonb().$type<unknown[]>().notNull().default([]),
    score: smallint().notNull(),
    band: text({ enum: ["high", "medium", "low"] }).notNull(),
    reviewReasons: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** open/cancel: yöneticinin seçtiği kayıtlar (onayda yeniden doğrulanır). */
    targetReservationIds: uuid()
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    status: text({ enum: WA_PROPOSAL_STATUSES }).notNull().default("pending"),
    version: integer().notNull().default(1),
    edited: boolean().notNull().default(false),
    appliedReservationIds: uuid()
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    supersededBy: uuid(),
    decidedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    decidedAt: ts(),
    decisionNote: text(),
    decisionMode: text({ enum: WA_DECISION_MODES }),
    /** Onay anında sunucuda yeniden hesaplanan inceleme nedenleri (yöneticinin onayladıkları). */
    decisionReasons: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts().notNull().defaultNow(),
  },
  (t) => [
    unique("wa_calendar_proposals_message_item_key").on(t.messageId, t.itemNo),
    // Rezervasyonun kaynak önerisi aynı işletmeden olmalı (reservations_origin_proposal_fk).
    unique("wa_calendar_proposals_scope_key").on(t.id, t.workspaceId),
    foreignKey({
      name: "wa_calendar_proposals_property_fk",
      columns: [t.propertyId, t.workspaceId],
      foreignColumns: [properties.id, properties.workspaceId],
    }).onDelete("restrict"),
    foreignKey({
      name: "wa_calendar_proposals_superseded_by_fk",
      columns: [t.supersededBy],
      foreignColumns: [t.id],
    }).onDelete("restrict"),
    index("wa_calendar_proposals_pending_idx")
      .on(t.workspaceId, t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    index("wa_calendar_proposals_property_pending_idx")
      .on(t.propertyId, t.checkIn)
      .where(sql`${t.status} = 'pending'`),
    index("wa_calendar_proposals_workspace_idx").on(t.workspaceId, t.createdAt),
    index("wa_calendar_proposals_group_idx").on(t.groupId),
    index("wa_calendar_proposals_property_idx").on(t.propertyId),
    index("wa_calendar_proposals_decided_by_idx").on(t.decidedBy),
    index("wa_calendar_proposals_superseded_by_idx").on(t.supersededBy),
    check(
      "wa_calendar_proposals_action_check",
      sql`${t.action} is null or ${t.action} in (${inList(WA_CALENDAR_ACTIONS)})`,
    ),
    check(
      "wa_calendar_proposals_status_check",
      sql`${t.status} in (${inList(WA_PROPOSAL_STATUSES)})`,
    ),
    check(
      "wa_calendar_proposals_villa_resolution_check",
      sql`${t.villaResolution} in (${inList(WA_VILLA_RESOLUTIONS)})`,
    ),
    check("wa_calendar_proposals_band_check", sql`${t.band} in ('high', 'medium', 'low')`),
    check(
      "wa_calendar_proposals_decision_mode_check",
      sql`${t.decisionMode} is null or ${t.decisionMode} in (${inList(WA_DECISION_MODES)})`,
    ),
    check(
      "wa_calendar_proposals_reservation_status",
      sql`(${t.action} = 'reserve') = (${t.reservationStatus} is not null)
        and (${t.reservationStatus} is null or ${t.reservationStatus} in ('confirmed', 'pending'))`,
    ),
    check(
      "wa_calendar_proposals_dates",
      sql`${t.checkOut} is null or (${t.checkIn} is not null and ${t.checkOut} > ${t.checkIn})`,
    ),
    check(
      "wa_calendar_proposals_numbers",
      sql`${t.itemNo} between 0 and ${sql.raw(String(PL.itemsPerMessage - 1))}
        and ${t.parserVersion} >= 1 and ${t.score} between 0 and 100 and ${t.version} >= 1`,
    ),
    check(
      "wa_calendar_proposals_lengths",
      sql`length(${t.messageExcerpt}) between 1 and ${sql.raw(String(PL.excerptMax))}
        and (${t.villaNameRaw} is null or length(${t.villaNameRaw}) between 1 and ${sql.raw(String(PL.villaNameMax))})
        and (${t.decisionNote} is null or length(${t.decisionNote}) <= ${sql.raw(String(PL.decisionNoteMax))})`,
    ),
    check(
      "wa_calendar_proposals_sender_hash_format",
      sql`${t.senderHash} ~ ${sql.raw(`'${PHONE_HASH}'`)}`,
    ),
    // GÜVENLİK (gönderen politikası): yalnız owner/manager doğrulanmış gönderendir; staff önerisi
    // "staff_review_required" nedeni taşımadan kaydedilemez.
    check(
      "wa_calendar_proposals_sender_role",
      sql`${t.senderRole} in (${inList(WA_SENDER_ROLES)})
        and ${t.senderVerified} = (${t.senderRole} in ('owner', 'manager'))
        and (${t.senderRole} <> 'staff' or 'staff_review_required' = any(${t.reviewReasons}))`,
    ),
    check("wa_calendar_proposals_flags", codeArray(t.flags)),
    check("wa_calendar_proposals_review_reasons", codeArray(t.reviewReasons)),
    check("wa_calendar_proposals_decision_reasons", codeArray(t.decisionReasons)),
    check(
      "wa_calendar_proposals_id_arrays",
      sql`cardinality(${t.candidatePropertyIds}) <= ${sql.raw(String(PL.arrayMax))}
        and cardinality(${t.targetReservationIds}) <= ${sql.raw(String(PL.arrayMax))}
        and cardinality(${t.appliedReservationIds}) <= ${sql.raw(String(PL.arrayMax))}`,
    ),
    check(
      "wa_calendar_proposals_conflicts",
      sql`jsonb_typeof(${t.conflicts}) = 'array' and jsonb_array_length(${t.conflicts}) <= ${sql.raw(String(PL.arrayMax))}`,
    ),
    // Karar verilmiş öneri: karar zamanı ve (onaylıysa) uygulanabilir alanlar dolu.
    check(
      "wa_calendar_proposals_decision",
      sql`(${t.status} in ('applied', 'rejected')) = (${t.decidedAt} is not null)
        and (${t.status} = 'applied') = (${t.decisionMode} is not null)
        and (${t.status} <> 'applied' or (${t.action} is not null and ${t.propertyId} is not null
             and ${t.checkIn} is not null and ${t.checkOut} is not null))`,
    ),
    // GÜVENLİK: "tek tık" yalnız nedensiz kapatma; rezervasyon, iptal ve açma her zaman incelenir.
    // Güven puanı bu kuralı aşamaz (uygulama kodu atlansa bile veritabanı reddeder).
    // Staff önerisi de "tek tık" olamaz (staff WhatsApp'tan takvimi doğrudan değiştiremez).
    check(
      "wa_calendar_proposals_quick_only_close",
      sql`${t.decisionMode} is distinct from 'quick'
        or (${t.action} = 'close' and cardinality(${t.decisionReasons}) = 0
            and ${t.senderRole} in ('owner', 'manager'))`,
    ),
    check(
      "wa_calendar_proposals_superseded",
      sql`(${t.status} = 'superseded') = (${t.supersededBy} is not null) and ${t.supersededBy} is distinct from ${t.id}`,
    ),
  ],
);

/**
 * WhatsApp Asistanı — A2c: takvim worker'ının tek satırlık durumu (drizzle/0037).
 *
 * activatedAt: worker'ın İLK iş almasında (app_wa_claim_messages) atomik olarak doldurulur; o ana
 * kadar kuyruktaki tüm mesajlar "ignored" (before_activation) yapılır ve yalnız bu andan SONRA
 * alınan ve gönderilen mesajlar işlenir. Kimseye tablo yetkisi verilmez; yalnız worker
 * fonksiyonları (app_migrator, app.wa_calendar bayrağı) okur ve yazar.
 */
export const waCalendarWorkerState = pgTable(
  "wa_calendar_worker_state",
  {
    id: smallint().primaryKey().default(1),
    activatedAt: ts(),
    updatedAt: ts().notNull().defaultNow(),
  },
  (t) => [check("wa_calendar_worker_state_singleton", sql`${t.id} = 1`)],
);

/**
 * WhatsApp Asistanı — A2f: mesaj tepkisi kuyruğu (outbox; drizzle/0039, 0040).
 *
 * Worker mesajı işledikten (ve varsa otomatik bloğu tamamladıktan) SONRA mesaj başına EN FAZLA BİR
 * satır yazar (birincil anahtar = mesaj; ikinci tepki yok). Ağ geçidi kendi bağlantısının
 * satırlarını alır, mesajın üzerine reaction gönderir ve sonucu yazar (yeniden deneme + süre sonu).
 * Tablo yetkisi kimsede yoktur; yalnız SECURITY DEFINER fonksiyonları (0040) yazar/okur.
 * Mesaj silinince (saklama, bağlantı kesme) tepki satırı da silinir.
 */
export const waMessageReactions = pgTable(
  "wa_message_reactions",
  {
    messageId: uuid()
      .primaryKey()
      .references(() => waInboundMessages.id, { onDelete: "cascade" }),
    workspaceId: uuid().notNull(),
    kind: text({ enum: WA_REACTION_KINDS }).notNull(),
    emoji: text().notNull(),
    status: text({ enum: WA_REACTION_STATUSES }).notNull().default("pending"),
    attempts: integer().notNull().default(0),
    nextAttemptAt: ts().notNull().defaultNow(),
    lockedUntil: ts(),
    lockToken: uuid(),
    /** Yalnız kısa hata kodu (mesaj içeriği veya kişisel veri yazılmaz). */
    lastError: text(),
    createdAt: ts().notNull().defaultNow(),
    sentAt: ts(),
  },
  (t) => [
    index("wa_message_reactions_queue_idx").on(t.status, t.nextAttemptAt),
    index("wa_message_reactions_workspace_idx").on(t.workspaceId),
    check("wa_message_reactions_kind_check", sql`${t.kind} in ('done', 'submitted', 'warning')`),
    check(
      "wa_message_reactions_emoji_check",
      sql`(${t.kind} = 'done' and ${t.emoji} = U&'\\2705')
        or (${t.kind} = 'submitted' and ${t.emoji} = U&'\\2611\\FE0F')
        or (${t.kind} = 'warning' and ${t.emoji} = U&'\\26A0\\FE0F')`,
    ),
    check(
      "wa_message_reactions_status_check",
      sql`${t.status} in ('pending', 'sending', 'sent', 'failed', 'expired')`,
    ),
    check(
      "wa_message_reactions_state",
      sql`${t.attempts} >= 0 and (${t.status} = 'sent') = (${t.sentAt} is not null)
        and (${t.status} = 'sending') = (${t.lockToken} is not null and ${t.lockedUntil} is not null)`,
    ),
    check(
      "wa_message_reactions_last_error_format",
      sql`${t.lastError} is null or ${t.lastError} ~ '^[a-z0-9_]{1,60}$'`,
    ),
  ],
);
