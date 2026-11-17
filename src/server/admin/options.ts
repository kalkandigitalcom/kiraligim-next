/**
 * Super Admin — opsiyon yönetimi (Aşama 3c). Tüm işlemler app_admin bağlantısıyla YALNIZ veritabanı
 * fonksiyonları (app_option_admin_*, drizzle/0067, 0069, 0071) üzerinden yapılır: yönetici kimliği
 * veritabanında yeniden doğrulanır, denetim kayıtlarını fonksiyonlar yazar, her yazma sürüm kilitlidir.
 *
 * Opsiyon müsaitliği hiçbir koşulda kapatmaz: bu modül rezervasyon, blok, harici takvim, API, iCal
 * veya webhook verisine YAZMAZ. Onay yalnız işlemi "approved" yapar; uygulamayı option-maintenance
 * görevi anahtarlar açıkken yapar. Kesin rezervasyona dönüştürme 3e'ye kadar KAPALIDIR.
 */
import { sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { pgErrorInfo } from "@/db/pg-error";
import { isUuid } from "@/lib/option-admin";
import {
  OPTION_OPERATION_STATUSES,
  OPTION_STATUSES,
  type OptionOperationKind,
  type OptionOperationStatus,
  type OptionStatus,
} from "@/lib/option-meta";
import { AppError } from "@/lib/errors";

/**
 * Kesin rezervasyona dönüştürme (kesinleştirme) onayı — Aşama 3e'de açıldı. Yalnız WhatsApp kaynaklı
 * kesinleştirme işlemleri; dönüşümü onaydan sonra option-maintenance görevi yapar.
 */
export const OPTION_CONVERT_ENABLED = true;

export const ADMIN_OPTION_ERRORS = {
  not_found: "Kayıt bulunamadı.",
  not_pending: "Bu işlem artık onay beklemiyor.",
  not_open: "Opsiyon artık açık değil.",
  version_conflict: "Kayıt siz bakarken değişti. Sayfayı yenileyip yeniden deneyin.",
  incomplete: "Onay için eksik bilgi var (tarih, süre veya hedef opsiyon).",
  invalid: "Girilen değerler geçersiz.",
  dates_invalid: "Giriş ve çıkış tarihini birlikte ve çıkış girişten sonra olacak şekilde girin.",
  duration_invalid: "Süre 1 saat ile 14 gün arasında olmalı (ör. 48 veya 2g).",
  choices_invalid: "Süre seçenekleri 1 saat – 14 gün arasında, en fazla 12 değer olmalı.",
  default_not_in_choices: "Varsayılan süre, süre seçenekleri arasında olmalı.",
  guests_invalid: "Misafir sayısı geçersiz.",
  note_invalid: "Not en fazla 500 karakter olabilir.",
  convert_disabled: "Kesin rezervasyona dönüştürme şu anda kapalı.",
  guest_info_required:
    "Kesinleştirme için misafir adı, yetişkin sayısı ve çocuk sayısı (0 dahil) açıkça girilmeli.",
  not_available: "Bu grup şu anda opsiyon ayarı için uygun değil (bağlı değil veya villası yok).",
  confirm_required: "Onay kutusunu işaretleyin.",
  error: "İşlem tamamlanamadı. Yeniden deneyin.",
} as const;
export type AdminOptionErrorCode = keyof typeof ADMIN_OPTION_ERRORS;

export class AdminOptionError extends AppError {
  constructor(readonly reason: AdminOptionErrorCode) {
    super(reason === "not_found" ? "NOT_FOUND" : "CONFLICT", ADMIN_OPTION_ERRORS[reason]);
  }
}

/** Veritabanı istisnalarını kısa koda çevirir (mesaj içeriği dışarı verilmez). */
function mapDbError(err: unknown): never {
  const info = pgErrorInfo(err);
  const m = info.message ?? "";
  if (m === "option_decision_incomplete") throw new AdminOptionError("incomplete");
  if (
    m === "option_decision_invalid" ||
    m === "option_settings_invalid" ||
    m === "option_filter_invalid"
  ) {
    throw new AdminOptionError("invalid");
  }
  if (info.code === "23514") throw new AdminOptionError("invalid");
  throw err;
}

async function rows<T>(db: Database, q: ReturnType<typeof sql>): Promise<T[]> {
  try {
    return (await db.execute<T & Record<string, unknown>>(q)).rows as T[];
  } catch (err) {
    mapDbError(err);
  }
}

async function scalar(db: Database, q: ReturnType<typeof sql>): Promise<string | undefined> {
  const r = await rows<{ out: string }>(db, q);
  return r[0]?.out;
}

function outcome<T extends string>(out: string | undefined, ok: readonly T[]): T {
  if (out && (ok as readonly string[]).includes(out)) return out as T;
  const reason = (out && out in ADMIN_OPTION_ERRORS ? out : "error") as AdminOptionErrorCode;
  throw new AdminOptionError(reason);
}

const d = (v: Date | string | null): Date | null => (v === null ? null : new Date(v));
const iso = (v: Date | string | null): string | null =>
  v === null ? null : typeof v === "string" ? v.slice(0, 10) : v.toISOString().slice(0, 10);
const num = (v: number | string | null): number | null => (v === null ? null : Number(v));

// ---------------------------------------------------------------------------------------------
// Sayılar (genel bakış kartları)
// ---------------------------------------------------------------------------------------------
export type AdminOptionCounts = {
  pendingApproval: number;
  approvedWaiting: number;
  openOptions: number;
  openAlerts: number;
  globalEnabled: boolean;
};

export async function getOptionCounts(db: Database, adminId: string): Promise<AdminOptionCounts> {
  const r = await rows<{
    pending_approval: number;
    approved_waiting: number;
    open_options: number;
    open_alerts: number;
    global_enabled: boolean;
  }>(db, sql`select * from public.app_option_admin_counts(${adminId}::uuid)`);
  const x = r[0];
  return {
    pendingApproval: Number(x?.pending_approval ?? 0),
    approvedWaiting: Number(x?.approved_waiting ?? 0),
    openOptions: Number(x?.open_options ?? 0),
    openAlerts: Number(x?.open_alerts ?? 0),
    globalEnabled: Boolean(x?.global_enabled),
  };
}

// ---------------------------------------------------------------------------------------------
// Opsiyonlar
// ---------------------------------------------------------------------------------------------
type OptionRow = {
  id: string;
  workspace_id: string;
  workspace_name: string;
  property_id: string;
  property_name: string;
  source: string;
  status: OptionStatus;
  check_in: Date | string;
  check_out: Date | string;
  expires_at: Date | string | null;
  expiry_source: string | null;
  remaining_seconds: number | string | null;
  end_reason: string | null;
  guest_name: string | null;
  adults: number | null;
  children: number | null;
  converted_reservation_id: string | null;
  version: number;
  created_at: Date | string;
  ended_at: Date | string | null;
  open_alerts: number;
};

export type AdminOption = {
  id: string;
  workspaceId: string;
  workspaceName: string;
  propertyId: string;
  propertyName: string;
  source: string;
  status: OptionStatus;
  checkIn: string;
  checkOut: string;
  expiresAt: Date | null;
  expirySource: string | null;
  remainingSeconds: number | null;
  endReason: string | null;
  guestName: string | null;
  adults: number | null;
  children: number | null;
  convertedReservationId: string | null;
  version: number;
  createdAt: Date;
  endedAt: Date | null;
  openAlerts: number;
};

function mapOption(r: OptionRow): AdminOption {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    workspaceName: r.workspace_name,
    propertyId: r.property_id,
    propertyName: r.property_name,
    source: r.source,
    status: r.status,
    checkIn: iso(r.check_in)!,
    checkOut: iso(r.check_out)!,
    expiresAt: d(r.expires_at),
    expirySource: r.expiry_source,
    remainingSeconds: num(r.remaining_seconds),
    endReason: r.end_reason,
    guestName: r.guest_name,
    adults: num(r.adults),
    children: num(r.children),
    convertedReservationId: r.converted_reservation_id,
    version: Number(r.version),
    createdAt: new Date(r.created_at),
    endedAt: d(r.ended_at),
    openAlerts: Number(r.open_alerts),
  };
}

export async function listOptions(
  db: Database,
  adminId: string,
  status: OptionStatus | null,
  limit = 200,
): Promise<AdminOption[]> {
  if (status !== null && !(OPTION_STATUSES as readonly string[]).includes(status)) {
    throw new AdminOptionError("invalid");
  }
  const r = await rows<OptionRow>(
    db,
    sql`select * from public.app_option_admin_options(${adminId}::uuid, ${status}, ${limit})`,
  );
  return r.map(mapOption);
}

export type AdminOptionDetail = AdminOption & {
  groupId: string | null;
  groupSubject: string | null;
  byMessage: boolean;
};

export async function getOption(
  db: Database,
  adminId: string,
  optionId: string,
): Promise<AdminOptionDetail> {
  if (!isUuid(optionId)) throw new AdminOptionError("not_found");
  const r = await rows<
    OptionRow & { group_id: string | null; group_subject: string | null; by_message: boolean }
  >(db, sql`select * from public.app_option_admin_option(${adminId}::uuid, ${optionId}::uuid)`);
  const x = r[0];
  if (!x) throw new AdminOptionError("not_found");
  return {
    ...mapOption(x),
    groupId: x.group_id,
    groupSubject: x.group_subject,
    byMessage: Boolean(x.by_message),
  };
}

export type AdminOptionEvent = {
  event: string;
  fromStatus: string | null;
  toStatus: string | null;
  reason: string | null;
  byAdmin: boolean;
  byMessage: boolean;
  version: number;
  createdAt: Date;
};

export async function listOptionEvents(
  db: Database,
  adminId: string,
  optionId: string,
): Promise<AdminOptionEvent[]> {
  if (!isUuid(optionId)) throw new AdminOptionError("not_found");
  const r = await rows<{
    event: string;
    from_status: string | null;
    to_status: string | null;
    reason: string | null;
    actor_admin_id: string | null;
    by_message: boolean;
    version: number;
    created_at: Date | string;
  }>(
    db,
    sql`select * from public.app_option_admin_option_events(${adminId}::uuid, ${optionId}::uuid)`,
  );
  return r.map((e) => ({
    event: e.event,
    fromStatus: e.from_status,
    toStatus: e.to_status,
    reason: e.reason,
    byAdmin: e.actor_admin_id !== null,
    byMessage: Boolean(e.by_message),
    version: Number(e.version),
    createdAt: new Date(e.created_at),
  }));
}

export type AdminOptionLinkedOperation = {
  id: string;
  role: "result" | "target";
  kind: OptionOperationKind;
  mode: string;
  status: OptionOperationStatus;
  source: string;
  failureCode: string | null;
  decidedAt: Date | null;
  appliedAt: Date | null;
  createdAt: Date;
};

export async function listOptionOperations(
  db: Database,
  adminId: string,
  optionId: string,
): Promise<AdminOptionLinkedOperation[]> {
  if (!isUuid(optionId)) throw new AdminOptionError("not_found");
  const r = await rows<{
    id: string;
    role: "result" | "target";
    kind: OptionOperationKind;
    mode: string;
    status: OptionOperationStatus;
    source: string;
    failure_code: string | null;
    decided_at: Date | string | null;
    applied_at: Date | string | null;
    created_at: Date | string;
  }>(
    db,
    sql`select * from public.app_option_admin_option_operations(${adminId}::uuid, ${optionId}::uuid)`,
  );
  return r.map((o) => ({
    id: o.id,
    role: o.role,
    kind: o.kind,
    mode: o.mode,
    status: o.status,
    source: o.source,
    failureCode: o.failure_code,
    decidedAt: d(o.decided_at),
    appliedAt: d(o.applied_at),
    createdAt: new Date(o.created_at),
  }));
}

/** Faz B (0077): tarih değişikliği zinciri — önceki (yerini aldığı) ve sonraki (yerine açılan). */
export type AdminOptionLink = {
  relation: "previous" | "next";
  id: string;
  status: OptionStatus;
  checkIn: string;
  checkOut: string;
  endReason: string | null;
  createdAt: Date;
};

export async function listOptionLinks(
  db: Database,
  adminId: string,
  optionId: string,
): Promise<AdminOptionLink[]> {
  if (!isUuid(optionId)) throw new AdminOptionError("not_found");
  const r = await rows<{
    relation: "previous" | "next";
    id: string;
    status: OptionStatus;
    check_in: Date | string;
    check_out: Date | string;
    end_reason: string | null;
    created_at: Date | string;
  }>(
    db,
    sql`select * from public.app_option_admin_option_links(${adminId}::uuid, ${optionId}::uuid)`,
  );
  return r.map((x) => ({
    relation: x.relation,
    id: x.id,
    status: x.status,
    checkIn: iso(x.check_in)!,
    checkOut: iso(x.check_out)!,
    endReason: x.end_reason,
    createdAt: new Date(x.created_at),
  }));
}

// ---------------------------------------------------------------------------------------------
// İşlemler (onay / ret)
// ---------------------------------------------------------------------------------------------
type OperationRow = {
  id: string;
  workspace_id: string;
  workspace_name: string;
  property_id: string;
  property_name: string;
  kind: OptionOperationKind;
  mode: string;
  status: OptionOperationStatus;
  source: string;
  check_in: Date | string | null;
  check_out: Date | string | null;
  expires_in_minutes: number | null;
  end_reason: string | null;
  target_option_id: string | null;
  result_option_id: string | null;
  reasons: string[] | null;
  failure_code: string | null;
  guest_name: string | null;
  adults: number | null;
  children: number | null;
  decided_at: Date | string | null;
  decision_note: string | null;
  version: number;
  created_at: Date | string;
  calendar_changed: boolean | null;
};

export type AdminOptionOperation = {
  id: string;
  workspaceId: string;
  workspaceName: string;
  propertyId: string;
  propertyName: string;
  kind: OptionOperationKind;
  mode: string;
  status: OptionOperationStatus;
  source: string;
  checkIn: string | null;
  checkOut: string | null;
  expiresInMinutes: number | null;
  endReason: string | null;
  targetOptionId: string | null;
  resultOptionId: string | null;
  reasons: string[];
  failureCode: string | null;
  guestName: string | null;
  adults: number | null;
  children: number | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  version: number;
  createdAt: Date;
  calendarChanged: boolean;
};

function mapOperation(r: OperationRow): AdminOptionOperation {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    workspaceName: r.workspace_name,
    propertyId: r.property_id,
    propertyName: r.property_name,
    kind: r.kind,
    mode: r.mode,
    status: r.status,
    source: r.source,
    checkIn: iso(r.check_in),
    checkOut: iso(r.check_out),
    expiresInMinutes: num(r.expires_in_minutes),
    endReason: r.end_reason,
    targetOptionId: r.target_option_id,
    resultOptionId: r.result_option_id,
    reasons: r.reasons ?? [],
    failureCode: r.failure_code,
    guestName: r.guest_name,
    adults: num(r.adults),
    children: num(r.children),
    decidedAt: d(r.decided_at),
    decisionNote: r.decision_note,
    version: Number(r.version),
    createdAt: new Date(r.created_at),
    calendarChanged: Boolean(r.calendar_changed),
  };
}

/** status null: onay bekleyenler (pending + needs_approval). */
export async function listOperations(
  db: Database,
  adminId: string,
  status: OptionOperationStatus | null,
  limit = 200,
): Promise<AdminOptionOperation[]> {
  if (status !== null && !(OPTION_OPERATION_STATUSES as readonly string[]).includes(status)) {
    throw new AdminOptionError("invalid");
  }
  const r = await rows<OperationRow>(
    db,
    sql`select * from public.app_option_admin_operations(${adminId}::uuid, ${status}, ${limit})`,
  );
  return r.map(mapOperation);
}

export type AdminOptionOperationDetail = AdminOptionOperation & {
  groupId: string | null;
  groupSubject: string | null;
  expirySource: string | null;
  sentAt: Date | null;
  targetOptionVersion: number | null;
  targetStatus: string | null;
  targetVersion: number | null;
  resultReservationId: string | null;
  decidedByName: string | null;
  appliedAt: Date | null;
  attempts: number;
};

export async function getOperation(
  db: Database,
  adminId: string,
  operationId: string,
): Promise<AdminOptionOperationDetail> {
  if (!isUuid(operationId)) throw new AdminOptionError("not_found");
  const r = await rows<
    OperationRow & {
      group_id: string | null;
      group_subject: string | null;
      expiry_source: string | null;
      sent_at: Date | string | null;
      target_option_version: number | null;
      target_status: string | null;
      target_version: number | null;
      result_reservation_id: string | null;
      decided_by_name: string | null;
      applied_at: Date | string | null;
      attempts: number;
    }
  >(
    db,
    sql`select * from public.app_option_admin_operation(${adminId}::uuid, ${operationId}::uuid)`,
  );
  const x = r[0];
  if (!x) throw new AdminOptionError("not_found");
  return {
    ...mapOperation(x),
    groupId: x.group_id,
    groupSubject: x.group_subject,
    expirySource: x.expiry_source,
    sentAt: d(x.sent_at),
    targetOptionVersion: num(x.target_option_version),
    targetStatus: x.target_status,
    targetVersion: num(x.target_version),
    resultReservationId: x.result_reservation_id,
    decidedByName: x.decided_by_name,
    appliedAt: d(x.applied_at),
    attempts: Number(x.attempts),
  };
}

export type AdminRangeEntry = {
  kind: "reservation" | "block" | "external" | "option";
  refId: string;
  status: string;
  checkIn: string;
  checkOut: string;
  label: string;
};

/** İşlemin aralığındaki GÜNCEL takvim (misafir bilgisi içermez). */
export async function getOperationRange(
  db: Database,
  adminId: string,
  operationId: string,
): Promise<AdminRangeEntry[]> {
  if (!isUuid(operationId)) throw new AdminOptionError("not_found");
  const r = await rows<{
    kind: AdminRangeEntry["kind"];
    ref_id: string;
    status: string;
    check_in: Date | string;
    check_out: Date | string;
    label: string;
  }>(
    db,
    sql`select * from public.app_option_admin_range_context(${adminId}::uuid, ${operationId}::uuid)`,
  );
  return r.map((x) => ({
    kind: x.kind,
    refId: x.ref_id,
    status: x.status,
    checkIn: iso(x.check_in)!,
    checkOut: iso(x.check_out)!,
    label: x.label,
  }));
}

export type DecisionInput = {
  operationId: string;
  version: number;
  approve: boolean;
  note: string | null;
  checkIn: string | null;
  checkOut: string | null;
  expiresMinutes: number | null;
  guestName: string | null;
  adults: number | null;
  children: number | null;
};

export type DecisionOutcome = "approved" | "rejected";

/**
 * Onay / ret. Kesinleştirme (convert) ONAYI Aşama 3e'ye kadar reddedilir; reddetmek serbesttir.
 * Sürüm kilidi: eski sürüm "version_conflict".
 */
export async function decideOperation(
  db: Database,
  adminId: string,
  input: DecisionInput,
): Promise<DecisionOutcome> {
  if (!isUuid(input.operationId)) throw new AdminOptionError("not_found");
  if (!Number.isInteger(input.version) || input.version < 1) throw new AdminOptionError("invalid");
  if (input.approve) {
    const op = await getOperation(db, adminId, input.operationId);
    if (op.kind === "convert") {
      if (!OPTION_CONVERT_ENABLED) throw new AdminOptionError("convert_disabled");
      // Misafir bilgisi otomatik tamamlanmaz: ad, yetişkin ve çocuk (0 dahil) açıkça girilmeli.
      const name = input.guestName?.trim() ?? "";
      if (
        name.length < 2 ||
        name.length > 120 ||
        input.adults === null ||
        !Number.isInteger(input.adults) ||
        input.adults < 1 ||
        input.children === null ||
        !Number.isInteger(input.children) ||
        input.children < 0
      ) {
        throw new AdminOptionError("guest_info_required");
      }
    }
  }
  const out = await scalar(
    db,
    sql`select public.app_option_admin_decide(${adminId}::uuid, ${input.operationId}::uuid,
          ${input.version}::integer, ${input.approve}, ${input.note}, ${input.checkIn}::date,
          ${input.checkOut}::date, ${input.expiresMinutes}::integer, ${input.guestName},
          ${input.adults}::integer, ${input.children}::integer) as out`,
  );
  return outcome(out, ["approved", "rejected"] as const);
}

/** Panelden iptal (panel_cancel). Kesin rezervasyon ve bloklara dokunulmaz. */
export async function cancelOption(
  db: Database,
  adminId: string,
  optionId: string,
  version: number,
  note: string | null,
): Promise<"cancelled"> {
  if (!isUuid(optionId)) throw new AdminOptionError("not_found");
  if (!Number.isInteger(version) || version < 1) throw new AdminOptionError("invalid");
  const out = await scalar(
    db,
    sql`select public.app_option_admin_cancel(${adminId}::uuid, ${optionId}::uuid, ${version}::integer, ${note}) as out`,
  );
  return outcome(out, ["cancelled"] as const);
}

// ---------------------------------------------------------------------------------------------
// Çakışma uyarıları
// ---------------------------------------------------------------------------------------------
export type AdminOptionAlert = {
  id: string;
  workspaceId: string;
  workspaceName: string;
  optionId: string;
  optionStatus: OptionStatus;
  propertyId: string;
  propertyName: string;
  optionCheckIn: string;
  optionCheckOut: string;
  sourceKind: "reservation" | "external_event";
  sourceId: string;
  sourceStatus: string | null;
  sourceCheckIn: string | null;
  sourceCheckOut: string | null;
  sourceLabel: string | null;
  detectedAt: Date;
  acknowledgedAt: Date | null;
  acknowledgedByName: string | null;
};

export async function listAlerts(
  db: Database,
  adminId: string,
  opts: { optionId?: string | null; includeAcknowledged?: boolean; limit?: number } = {},
): Promise<AdminOptionAlert[]> {
  const optionId = opts.optionId ?? null;
  if (optionId !== null && !isUuid(optionId)) throw new AdminOptionError("not_found");
  const r = await rows<{
    id: string;
    workspace_id: string;
    workspace_name: string;
    option_id: string;
    option_status: OptionStatus;
    property_id: string;
    property_name: string;
    option_check_in: Date | string;
    option_check_out: Date | string;
    source_kind: "reservation" | "external_event";
    source_id: string;
    source_status: string | null;
    source_check_in: Date | string | null;
    source_check_out: Date | string | null;
    source_label: string | null;
    detected_at: Date | string;
    acknowledged_at: Date | string | null;
    acknowledged_by_name: string | null;
  }>(
    db,
    sql`select * from public.app_option_admin_alert_list(${adminId}::uuid, ${optionId}::uuid,
          ${opts.includeAcknowledged ?? false}, ${opts.limit ?? 200})`,
  );
  return r.map((a) => ({
    id: a.id,
    workspaceId: a.workspace_id,
    workspaceName: a.workspace_name,
    optionId: a.option_id,
    optionStatus: a.option_status,
    propertyId: a.property_id,
    propertyName: a.property_name,
    optionCheckIn: iso(a.option_check_in)!,
    optionCheckOut: iso(a.option_check_out)!,
    sourceKind: a.source_kind,
    sourceId: a.source_id,
    sourceStatus: a.source_status,
    sourceCheckIn: iso(a.source_check_in),
    sourceCheckOut: iso(a.source_check_out),
    sourceLabel: a.source_label,
    detectedAt: new Date(a.detected_at),
    acknowledgedAt: d(a.acknowledged_at),
    acknowledgedByName: a.acknowledged_by_name,
  }));
}

export async function acknowledgeAlert(
  db: Database,
  adminId: string,
  alertId: string,
): Promise<"acknowledged" | "already"> {
  if (!isUuid(alertId)) throw new AdminOptionError("not_found");
  const out = await scalar(
    db,
    sql`select public.app_option_admin_ack_alert(${adminId}::uuid, ${alertId}::uuid) as out`,
  );
  return outcome(out, ["acknowledged", "already"] as const);
}

// ---------------------------------------------------------------------------------------------
// Otomasyon ayarları ve kill switch
// ---------------------------------------------------------------------------------------------
export type AdminOptionSettings = {
  global: { enabled: boolean; updatedAt: Date | null };
  workspaces: Map<
    string,
    {
      enabled: boolean;
      effective: boolean;
      defaultMinutes: number | null;
      choices: number[];
      updatedAt: Date;
    }
  >;
  groups: Map<
    string,
    { workspaceId: string; enabled: boolean; effective: boolean; updatedAt: Date }
  >;
};

export async function getOptionSettings(
  db: Database,
  adminId: string,
): Promise<AdminOptionSettings> {
  const r = await rows<{
    scope: "global" | "workspace" | "group";
    target_id: string | null;
    workspace_id: string | null;
    enabled: boolean;
    effective: boolean;
    default_minutes: number | null;
    choices: number[] | null;
    updated_at: Date | string;
  }>(db, sql`select * from public.app_option_admin_settings(${adminId}::uuid)`);
  const out: AdminOptionSettings = {
    global: { enabled: false, updatedAt: null },
    workspaces: new Map(),
    groups: new Map(),
  };
  for (const s of r) {
    if (s.scope === "global") {
      out.global = { enabled: Boolean(s.enabled), updatedAt: new Date(s.updated_at) };
    } else if (s.scope === "workspace" && s.target_id) {
      out.workspaces.set(s.target_id, {
        enabled: Boolean(s.enabled),
        effective: Boolean(s.effective),
        defaultMinutes: num(s.default_minutes),
        choices: (s.choices ?? []).map(Number),
        updatedAt: new Date(s.updated_at),
      });
    } else if (s.scope === "group" && s.target_id && s.workspace_id) {
      out.groups.set(s.target_id, {
        workspaceId: s.workspace_id,
        enabled: Boolean(s.enabled),
        effective: Boolean(s.effective),
        updatedAt: new Date(s.updated_at),
      });
    }
  }
  return out;
}

export type SettingOutcome = "changed" | "unchanged";

/** Global anahtar / kill switch. */
export async function setOptionGlobal(
  db: Database,
  adminId: string,
  enabled: boolean,
): Promise<SettingOutcome> {
  const out = await scalar(
    db,
    sql`select public.app_option_admin_set_global(${adminId}::uuid, ${enabled}) as out`,
  );
  return outcome(out, ["changed", "unchanged"] as const);
}

/**
 * İşletme ayar satırı (0067). Opsiyon süresi 0076'dan beri SABİT 24 saattir; bu fonksiyonun
 * yazdığı varsayılan süre ve seçenekler artık okunmaz ve panelde düzenlenmez (yalnız eski kayıt
 * akışlarının testleri için korunur; temizlik migration'ında kaldırılacak).
 */
export async function setOptionWorkspace(
  db: Database,
  adminId: string,
  input: {
    workspaceId: string;
    enabled: boolean;
    defaultMinutes: number | null;
    choices: number[];
  },
): Promise<SettingOutcome> {
  if (!isUuid(input.workspaceId)) throw new AdminOptionError("not_found");
  if (
    input.defaultMinutes !== null &&
    input.choices.length > 0 &&
    !input.choices.includes(input.defaultMinutes)
  ) {
    throw new AdminOptionError("default_not_in_choices");
  }
  const choices = sql`${`{${input.choices.join(",")}}`}::integer[]`;
  const out = await scalar(
    db,
    sql`select public.app_option_admin_set_workspace(${adminId}::uuid, ${input.workspaceId}::uuid,
          ${input.enabled}, ${input.defaultMinutes}::integer, ${choices}) as out`,
  );
  return outcome(out, ["changed", "unchanged"] as const);
}
