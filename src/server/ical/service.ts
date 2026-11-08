/**
 * Harici takvim (iCal) panel servisi. TÜM fonksiyonlar withTenant içinden (tx + ctx) çağrılır:
 * workspace yalnız transaction bağlamından gelir, RLS (FORCE) başka işletmenin mülkünü/kaynağını
 * gizler, yazma yalnız owner/manager (hem burada hem politikada).
 *
 *  - Kaynak ekle / düzenle / etkinleştir-pasifleştir / sil. Silme yalnız o kaynağın olaylarını
 *    siler (ON DELETE CASCADE); başka kaynakların aynı tarihleri kapatan olayları etkilenmez.
 *  - Takvim için harici dolulukların güvenli DTO'su (kaynak adı, tarih, durum; UID yok).
 *  - Çakışma mesajı için etkin harici olaylar.
 *  - Dışa aktarma belirteci: owner/manager sayfayı açınca oluşur; yenilenince eski adres geçersiz.
 * Kaynak adresi (erişim anahtarı içerebilir) yalnız owner/manager'a döner; log ve denetime yazılmaz.
 */
import { randomBytes } from "node:crypto";

import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { z } from "zod";

import { PG, pgErrorInfo } from "@/db/pg-error";
import type { TenantContext, Tx } from "@/db/tenant";
import { AppError, forbidden, limitReached, validationError } from "@/lib/errors";
import {
  ICAL_LIMITS as L,
  type IcalErrorCode,
  type IcalSourceStatus,
  type IcalSyncTrigger,
  isIcalErrorCode,
  maskIcalUrl,
  normalizeIcalUrl,
} from "@/lib/ical-meta";
import { zodFieldErrors } from "@/lib/result";
import { type ICAL_SOURCE_AUDIT_FIELDS, recordAudit } from "@/server/audit/record";
import { isBlockedHost } from "@/server/ical/fetch";
import { canManageProperties, isUuid } from "@/server/properties/service";

export const canManageIcal = canManageProperties;

const notFoundSource = () => new AppError("NOT_FOUND", "Takvim kaynağı bulunamadı.");
const notFoundProperty = () => new AppError("NOT_FOUND", "Mülk bulunamadı.");

/* ── Kaynaklar ───────────────────────────────────────────────────────────── */

export type IcalSource = {
  id: string;
  propertyId: string;
  name: string;
  /** Tam adres yalnız owner/manager için; diğer üyelerde null. */
  url: string | null;
  maskedUrl: string;
  isActive: boolean;
  status: IcalSourceStatus;
  lastSyncedAt: Date | null;
  lastSuccessAt: Date | null;
  lastErrorCode: IcalErrorCode | null;
  eventCount: number;
  conflictCount: number;
  consecutiveFailures: number;
  /** Şu an senkron sürüyor (kilit geçerli). */
  syncing: boolean;
  createdAt: Date;
};

type SourceRow = {
  id: string;
  property_id: string;
  name: string;
  url: string;
  is_active: boolean;
  status: IcalSourceStatus;
  last_synced_at: Date | string | null;
  last_success_at: Date | string | null;
  last_error_code: string | null;
  event_count: number;
  conflict_count: number;
  consecutive_failures: number;
  syncing: boolean;
  created_at: Date | string;
};

const toDate = (v: Date | string | null) => (v === null ? null : new Date(v));

const toSource = (r: SourceRow, includeUrl: boolean): IcalSource => ({
  id: r.id,
  propertyId: r.property_id,
  name: r.name,
  url: includeUrl ? r.url : null,
  maskedUrl: maskIcalUrl(r.url),
  isActive: r.is_active,
  status: r.status,
  lastSyncedAt: toDate(r.last_synced_at),
  lastSuccessAt: toDate(r.last_success_at),
  lastErrorCode: isIcalErrorCode(r.last_error_code) ? r.last_error_code : null,
  eventCount: r.event_count,
  conflictCount: r.conflict_count,
  consecutiveFailures: r.consecutive_failures,
  syncing: r.syncing,
  createdAt: new Date(r.created_at),
});

const SOURCE_SELECT = sql`
  select s.id, s.property_id, s.name, s.url, s.is_active, s.status, s.last_synced_at,
         s.last_success_at, s.last_error_code, s.event_count, s.conflict_count,
         s.consecutive_failures, coalesce(s.locked_until > now(), false) as syncing, s.created_at
    from external_calendar_sources s`;

export async function listSources(
  tx: Tx,
  ctx: TenantContext,
  propertyId: string,
): Promise<IcalSource[]> {
  if (!isUuid(propertyId)) return [];
  const res = await tx.execute<SourceRow>(sql`${SOURCE_SELECT}
    where s.workspace_id = app_current_workspace_id() and s.property_id = ${propertyId}
    order by s.created_at, s.id`);
  return res.rows.map((r) => toSource(r, canManageIcal(ctx.role)));
}

export async function getSource(
  tx: Tx,
  ctx: TenantContext,
  id: string,
): Promise<IcalSource | null> {
  if (!isUuid(id)) return null;
  const res = await tx.execute<SourceRow>(sql`${SOURCE_SELECT}
    where s.workspace_id = app_current_workspace_id() and s.id = ${id}`);
  const row = res.rows[0];
  return row ? toSource(row, canManageIcal(ctx.role)) : null;
}

export type IcalRun = {
  sourceId: string;
  trigger: IcalSyncTrigger;
  finishedAt: Date;
  outcome: "ok" | "error";
  errorCode: IcalErrorCode | null;
  total: number;
  added: number;
  updated: number;
  deactivated: number;
};

/** Mülkün kaynaklarının son senkron kayıtları (kaynak başına en fazla `perSource`). */
export async function listRecentRuns(
  tx: Tx,
  propertyId: string,
  perSource = 5,
): Promise<IcalRun[]> {
  if (!isUuid(propertyId)) return [];
  const res = await tx.execute<{
    source_id: string;
    trigger: IcalSyncTrigger;
    finished_at: Date | string;
    outcome: "ok" | "error";
    error_code: string | null;
    events_total: number;
    events_added: number;
    events_updated: number;
    events_deactivated: number;
  }>(sql`
    select source_id, trigger, finished_at, outcome, error_code, events_total, events_added,
           events_updated, events_deactivated
      from (select r.*, row_number() over (partition by r.source_id
                                           order by r.finished_at desc, r.id desc) as n
              from external_calendar_sync_runs r
              join external_calendar_sources s on s.id = r.source_id
             where r.workspace_id = app_current_workspace_id() and s.property_id = ${propertyId}) x
     where n <= ${perSource}
     order by finished_at desc`);
  return res.rows.map((r) => ({
    sourceId: r.source_id,
    trigger: r.trigger,
    finishedAt: new Date(r.finished_at),
    outcome: r.outcome,
    errorCode: isIcalErrorCode(r.error_code) ? r.error_code : null,
    total: r.events_total,
    added: r.events_added,
    updated: r.events_updated,
    deactivated: r.events_deactivated,
  }));
}

const checkbox = z.preprocess(
  (v) => v === true || v === "on" || v === "true" || v === "1",
  z.boolean(),
);

export const sourceInput = z.object({
  name: z
    .string({ error: "Takvim adı gerekli." })
    .trim()
    .min(L.nameMin, "Takvim adı gerekli.")
    .max(L.nameMax, `Takvim adı en fazla ${L.nameMax} karakter olabilir.`),
  url: z
    .string({ error: "iCal adresi gerekli." })
    .trim()
    .min(1, { error: "iCal adresi gerekli.", abort: true })
    .transform((s, ctx) => {
      const n = normalizeIcalUrl(s);
      if (!n) {
        ctx.addIssue({
          code: "custom",
          message: "Geçerli bir iCal adresi girin (https:// veya webcal:// ile başlayan).",
        });
        return z.NEVER;
      }
      // SSRF: yerel/özel adresler kayıttan önce reddedilir (indirme anındaki denetim ayrıca sürer).
      if (isBlockedHost(new URL(n).hostname)) {
        ctx.addIssue({
          code: "custom",
          message:
            "Yerel veya özel ağ adresleri (localhost, 127.0.0.1, 192.168.x.x vb.) eklenemez; platformun herkese açık iCal bağlantısını girin.",
        });
        return z.NEVER;
      }
      return n;
    }),
  isActive: checkbox.default(true),
});

export type SourceValues = z.output<typeof sourceInput>;

function parseSource(input: unknown): SourceValues {
  const parsed = sourceInput.safeParse(input);
  if (!parsed.success) throw validationError(zodFieldErrors(parsed.error));
  return parsed.data;
}

async function assertProperty(tx: Tx, propertyId: string) {
  if (!isUuid(propertyId)) throw notFoundProperty();
  const res = await tx.execute<{ id: string }>(sql`
    select id from properties where id = ${propertyId} and workspace_id = app_current_workspace_id()`);
  if (!res.rows[0]) throw notFoundProperty();
}

async function duplicateUrl(tx: Tx, propertyId: string, url: string, exceptId?: string) {
  const res = await tx.execute<{ id: string }>(sql`
    select id from external_calendar_sources
     where workspace_id = app_current_workspace_id() and property_id = ${propertyId}
       and url = ${url} ${exceptId ? sql`and id <> ${exceptId}` : sql``}
     limit 1`);
  return res.rows.length > 0;
}

function mapSourceWriteError(err: unknown): never {
  const pg = pgErrorInfo(err);
  if (
    pg.code === PG.UNIQUE_VIOLATION &&
    pg.constraint === "external_calendar_sources_property_name_key"
  ) {
    throw validationError({ name: ["Bu mülkte aynı adla bir takvim zaten var."] });
  }
  if (pg.message === "ical_source_limit_reached") {
    throw limitReached(`Bir mülke en fazla ${L.sourcesPerProperty} harici takvim eklenebilir.`);
  }
  if (pg.code === PG.INSUFFICIENT_PRIVILEGE) throw forbidden();
  if (pg.code === PG.FOREIGN_KEY_VIOLATION) throw notFoundProperty();
  if (pg.code === PG.CHECK_VIOLATION) {
    throw validationError({}, "Girilen değerlerden biri geçerli değil.");
  }
  throw err;
}

async function savepoint<T>(tx: Tx, name: string, fn: () => Promise<T>): Promise<T> {
  await tx.execute(sql.raw(`savepoint ${name}`));
  try {
    const out = await fn();
    await tx.execute(sql.raw(`release savepoint ${name}`));
    return out;
  } catch (err) {
    await tx.execute(sql.raw(`rollback to savepoint ${name}`));
    throw err;
  }
}

export async function addSource(
  tx: Tx,
  ctx: TenantContext,
  propertyId: string,
  input: unknown,
): Promise<string> {
  if (!canManageIcal(ctx.role)) throw forbidden();
  const v = parseSource(input);
  await assertProperty(tx, propertyId);
  if (await duplicateUrl(tx, propertyId, v.url)) {
    throw validationError({ url: ["Bu iCal adresi bu mülke zaten eklenmiş."] });
  }
  const id = uuidv7();
  try {
    await savepoint(tx, "ical_source_add", () =>
      tx.execute(sql`
        insert into external_calendar_sources (id, workspace_id, property_id, name, url, is_active,
                                               created_by)
        values (${id}, app_current_workspace_id(), ${propertyId}, ${v.name}, ${v.url},
                ${v.isActive}, app_current_user_id())`),
    );
  } catch (err) {
    mapSourceWriteError(err);
  }
  await recordAudit(tx, {
    action: "property.ical_source_added",
    targetType: "external_calendar_source",
    targetId: id,
    metadata: { property: propertyId },
  });
  return id;
}

export async function updateSource(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  input: unknown,
): Promise<{ changed: number }> {
  if (!canManageIcal(ctx.role)) throw forbidden();
  const before = await getSource(tx, ctx, id);
  if (!before || before.url === null) throw notFoundSource();
  const v = parseSource(input);
  const fields: (typeof ICAL_SOURCE_AUDIT_FIELDS)[number][] = [];
  if (v.name !== before.name) fields.push("name");
  if (v.url !== before.url) fields.push("url");
  if (v.isActive !== before.isActive) fields.push("is_active");
  if (fields.length === 0) return { changed: 0 };
  if (fields.includes("url") && (await duplicateUrl(tx, before.propertyId, v.url, id))) {
    throw validationError({ url: ["Bu iCal adresi bu mülke zaten eklenmiş."] });
  }
  try {
    await savepoint(tx, "ical_source_update", () =>
      tx.execute(sql`
        update external_calendar_sources
           set name = ${v.name}, url = ${v.url}, is_active = ${v.isActive}
         where id = ${id} and workspace_id = app_current_workspace_id()`),
    );
  } catch (err) {
    mapSourceWriteError(err);
  }
  await recordAudit(tx, {
    action: "property.ical_source_updated",
    targetType: "external_calendar_source",
    targetId: id,
    metadata: { property: before.propertyId, fields },
  });
  return { changed: fields.length };
}

/** Yalnız etkin/pasif değişikliği (liste düğmesi). */
export async function setSourceActive(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  active: boolean,
): Promise<{ changed: number }> {
  if (!canManageIcal(ctx.role)) throw forbidden();
  const before = await getSource(tx, ctx, id);
  if (!before || before.url === null) throw notFoundSource();
  return updateSource(tx, ctx, id, { name: before.name, url: before.url, isActive: active });
}

export async function deleteSource(tx: Tx, ctx: TenantContext, id: string): Promise<void> {
  if (!canManageIcal(ctx.role)) throw forbidden();
  const before = await getSource(tx, ctx, id);
  if (!before) throw notFoundSource();
  const res = await savepoint(tx, "ical_source_delete", () =>
    tx.execute(sql`
      delete from external_calendar_sources
       where id = ${id} and workspace_id = app_current_workspace_id()`),
  ).catch((err: unknown) => mapSourceWriteError(err));
  if ((res.rowCount ?? 0) === 0) throw notFoundSource();
  await recordAudit(tx, {
    action: "property.ical_source_removed",
    targetType: "external_calendar_source",
    targetId: id,
    metadata: { property: before.propertyId },
  });
}

/* ── Takvim ve çakışma ───────────────────────────────────────────────────── */

/** Takvime giden harici doluluk (UID ve akış içeriği yok). */
export type ExternalBlock = {
  id: string;
  sourceId: string;
  sourceName: string;
  checkIn: string;
  checkOut: string;
  sourceStatus: IcalSourceStatus;
  lastSuccessAt: string | null;
  lastSyncedAt: string | null;
};

/** Mülkün [from, to) ile kesişen ETKİN kaynaklarının ETKİN olayları. */
export async function listExternalBlocks(
  tx: Tx,
  propertyId: string,
  from: string,
  to: string,
): Promise<ExternalBlock[]> {
  if (!isUuid(propertyId)) return [];
  const res = await tx.execute<{
    id: string;
    source_id: string;
    source_name: string;
    check_in: string;
    check_out: string;
    status: IcalSourceStatus;
    last_success_at: Date | string | null;
    last_synced_at: Date | string | null;
  }>(sql`
    select e.id, e.source_id, s.name as source_name,
           to_char(e.start_date, 'YYYY-MM-DD') as check_in,
           to_char(e.end_date, 'YYYY-MM-DD') as check_out,
           s.status, s.last_success_at, s.last_synced_at
      from external_calendar_events e
      join external_calendar_sources s on s.id = e.source_id and s.workspace_id = e.workspace_id
     where e.workspace_id = app_current_workspace_id()
       and e.property_id = ${propertyId}
       and e.is_active and s.is_active
       and daterange(e.start_date, e.end_date, '[)') && daterange(${from}::date, ${to}::date, '[)')
     order by e.start_date, s.name, e.id`);
  const iso = (v: Date | string | null) => (v === null ? null : new Date(v).toISOString());
  return res.rows.map((r) => ({
    id: r.id,
    sourceId: r.source_id,
    sourceName: r.source_name,
    checkIn: r.check_in,
    checkOut: r.check_out,
    sourceStatus: r.status,
    lastSuccessAt: iso(r.last_success_at),
    lastSyncedAt: iso(r.last_synced_at),
  }));
}

export type ExternalConflict = { sourceName: string; checkIn: string; checkOut: string };

/** [checkIn, checkOut) ile çakışan etkin harici olaylar (hata ve ön denetim mesajı için). */
export async function findExternalConflicts(
  tx: Tx,
  propertyId: string,
  checkIn: string,
  checkOut: string,
): Promise<ExternalConflict[]> {
  if (!isUuid(propertyId)) return [];
  const res = await tx.execute<{ source_name: string; check_in: string; check_out: string }>(sql`
    select s.name as source_name, to_char(e.start_date, 'YYYY-MM-DD') as check_in,
           to_char(e.end_date, 'YYYY-MM-DD') as check_out
      from external_calendar_events e
      join external_calendar_sources s on s.id = e.source_id and s.workspace_id = e.workspace_id
     where e.workspace_id = app_current_workspace_id()
       and e.property_id = ${propertyId}
       and e.is_active and s.is_active
       and e.start_date < ${checkOut}::date and e.end_date > ${checkIn}::date
     order by e.start_date
     limit 5`);
  return res.rows.map((r) => ({
    sourceName: r.source_name,
    checkIn: r.check_in,
    checkOut: r.check_out,
  }));
}

/* ── Dışa aktarma belirteci ──────────────────────────────────────────────── */

export type IcalExport = {
  token: string;
  createdAt: Date;
  rotatedAt: Date | null;
  lastFetchedAt: Date | null;
};

const newToken = () => randomBytes(32).toString("base64url");

type ExportRow = {
  token: string;
  created_at: Date | string;
  rotated_at: Date | string | null;
  last_fetched_at: Date | string | null;
};
const toExport = (r: ExportRow): IcalExport => ({
  token: r.token,
  createdAt: new Date(r.created_at),
  rotatedAt: toDate(r.rotated_at),
  lastFetchedAt: toDate(r.last_fetched_at),
});

/** Owner/manager: mülkün akış belirteci (yoksa oluşturulur). Diğer roller: null. */
export async function ensureExport(
  tx: Tx,
  ctx: TenantContext,
  propertyId: string,
): Promise<IcalExport | null> {
  if (!canManageIcal(ctx.role)) return null;
  await assertProperty(tx, propertyId);
  const read = async () =>
    (
      await tx.execute<ExportRow>(sql`
        select token, created_at, rotated_at, last_fetched_at from property_ical_exports
         where property_id = ${propertyId} and workspace_id = app_current_workspace_id()`)
    ).rows[0];
  const existing = await read();
  if (existing) return toExport(existing);
  await tx.execute(sql`
    insert into property_ical_exports (property_id, workspace_id, token, created_by)
    values (${propertyId}, app_current_workspace_id(), ${newToken()}, app_current_user_id())
    on conflict (property_id) do nothing`);
  const row = await read();
  if (!row) throw notFoundProperty();
  return toExport(row);
}

/** Yeni belirteç: eski adres hemen geçersiz olur (platformlara yeni adres eklenmelidir). */
export async function rotateExport(
  tx: Tx,
  ctx: TenantContext,
  propertyId: string,
): Promise<IcalExport> {
  if (!canManageIcal(ctx.role)) throw forbidden();
  await ensureExport(tx, ctx, propertyId);
  const res = await tx.execute<ExportRow>(sql`
    update property_ical_exports set token = ${newToken()}, rotated_at = now()
     where property_id = ${propertyId} and workspace_id = app_current_workspace_id()
     returning token, created_at, rotated_at, last_fetched_at`);
  const row = res.rows[0];
  if (!row) throw notFoundProperty();
  await recordAudit(tx, {
    action: "property.ical_export_rotated",
    targetType: "property",
    targetId: propertyId,
    metadata: { property: propertyId },
  });
  return toExport(row);
}
