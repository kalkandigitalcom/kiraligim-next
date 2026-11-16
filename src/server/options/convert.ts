/**
 * Opsiyon Aşama 3e — Super Admin onaylı kesinleştirme: opsiyon → kesin rezervasyon.
 *
 * option-maintenance görevinin "kesinleştirme" adımı her alınmış işlem için bunu çağırır. Dönüşüm
 * işletme SAHİBİNİN oturum bağlamında (withTenant) TEK transaction'da yapılır:
 *   1. app_option_convert_begin (drizzle/0073): kilitler; anahtarları, grubun villasını, takvim
 *      parmak izini, opsiyonun açık / süresi dolmamış / sürümünün onaydakiyle aynı olduğunu, giriş
 *      tarihini ve misafir bilgisinin TAM olduğunu (ad, yetişkin, çocuk) yeniden doğrular. Uygun
 *      değilse işlemi kapatır (stale / failed) ya da anahtar kapalıysa kilidi bırakır; rezervasyon
 *      OLUŞTURULMAZ.
 *   2. createReservation (src/server/reservations/service.ts) DEĞİŞTİRİLMEDEN çağrılır: tarih
 *      kuralları, kapasite, pasif villa, çakışma kısıtı ve harici takvim koruması aynen geçerli;
 *      reservation.created denetim kaydı, API değişiklik / webhook ve iCal kayıtları panelden
 *      girilen rezervasyonla aynı yoldan oluşur.
 *   3. app_option_convert_finish: kayıt işlemle birebir aynı mı; opsiyon converted
 *      (payment_received, geçmişte onaylayan Super Admin) ve işlem applied.
 * Herhangi bir adım hata verirse transaction (rezervasyon dahil) geri alınır; işlem ayrı bir
 * çağrıyla kısa bir nedenle kapatılır (çakışma, kapasite, tarih) ya da geçici hatada kilidi
 * bırakılır (en fazla 5 deneme). Misafir bilgisi tamamlanmaz; log'a misafir bilgisi yazılmaz.
 */
import { sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { pgErrorInfo } from "@/db/pg-error";
import { withTenant } from "@/db/tenant";
import { isAppError } from "@/lib/errors";
import type { Logger } from "@/lib/logger";
import { createReservation } from "@/server/reservations/service";

/** Kesin rezervasyonun notu (kişisel bilgi içermez). */
export const OPTION_CONVERT_NOTE = "WhatsApp opsiyonundan Super Admin onayıyla kesinleştirildi.";

export type ConvertOutcome = "applied" | "stale" | "failed" | "automation_off" | "lost" | "retry";

export type ClaimedConversion = { id: string; lockToken: string; workspaceId: string };

export type OptionConverter = (op: ClaimedConversion) => Promise<ConvertOutcome>;

const iso = (v: Date | string): string =>
  typeof v === "string" ? v.slice(0, 10) : v.toISOString().slice(0, 10);

/** Rezervasyon servisinin hatasını işlemin kapanış nedenine çevirir (null: geçici, yeniden dene). */
export function conversionFailure(
  err: unknown,
): { outcome: "stale" | "failed"; code: string } | null {
  if (isAppError(err)) {
    if (err.code === "CONFLICT") {
      return {
        outcome: "failed",
        code: /pasif/i.test(err.message) ? "property_inactive" : "calendar_conflict",
      };
    }
    if (err.code === "VALIDATION") {
      const fields = err.fieldErrors ?? {};
      return { outcome: "failed", code: "adults" in fields ? "capacity" : "invalid" };
    }
    if (err.code === "FORBIDDEN" || err.code === "NOT_FOUND") {
      return { outcome: "stale", code: "owner_unavailable" };
    }
    return null;
  }
  const pg = pgErrorInfo(err);
  if (pg.message === "option_convert_mismatch")
    return { outcome: "failed", code: "reservation_mismatch" };
  if (pg.code === "23P01") return { outcome: "failed", code: "calendar_conflict" };
  return null;
}

export function createOptionConverter(db: Database, deps: { log?: Logger } = {}): OptionConverter {
  const finish = async (
    op: ClaimedConversion,
    outcome: "stale" | "failed" | "release",
    code: string | null,
  ) => {
    const r = await db.execute<{ out: string }>(
      sql`select public.app_option_finish_operation(${op.id}::uuid, ${op.lockToken}::uuid, ${outcome}, ${code}) as out`,
    );
    return r.rows[0]?.out;
  };

  return async (op) => {
    const owner = (
      await db.execute<{ u: string | null }>(
        sql`select public.app_option_convert_owner(${op.id}::uuid, ${op.lockToken}::uuid) as u`,
      )
    ).rows[0]?.u;
    if (!owner) {
      const out = await finish(op, "stale", "owner_unavailable");
      return out === "stale" ? "stale" : "lost";
    }
    try {
      return await withTenant(
        db,
        { userId: owner, workspaceId: op.workspaceId },
        async (tx, ctx): Promise<ConvertOutcome> => {
          const b = (
            await tx.execute<{
              outcome: ConvertOutcome | "ok";
              code: string | null;
              property_id: string | null;
              check_in: Date | string | null;
              check_out: Date | string | null;
              guest_name: string | null;
              adults: number | null;
              children: number | null;
            }>(
              sql`select * from public.app_option_convert_begin(${op.id}::uuid, ${op.lockToken}::uuid)`,
            )
          ).rows[0];
          if (!b || b.outcome !== "ok") {
            // İşlem begin içinde kapatıldı / kilidi bırakıldı: transaction COMMIT edilir (kalıcı),
            // rezervasyon oluşturulmaz.
            return (b?.outcome as ConvertOutcome | undefined) ?? "lost";
          }
          const reservationId = await createReservation(tx, ctx, {
            kind: "reservation",
            propertyId: b.property_id!,
            checkIn: iso(b.check_in!),
            checkOut: iso(b.check_out!),
            status: "confirmed",
            source: "whatsapp",
            guestName: b.guest_name!,
            adults: String(b.adults),
            children: String(b.children),
            note: OPTION_CONVERT_NOTE,
          });
          await tx.execute(
            sql`select public.app_option_convert_finish(${op.id}::uuid, ${op.lockToken}::uuid, ${reservationId}::uuid)`,
          );
          return "applied";
        },
      );
    } catch (err) {
      // Transaction geri alındı: rezervasyon yok. İşlemi kapat ya da kilidi bırak.
      const f = conversionFailure(err);
      deps.log?.warn("option_convert_failed", {
        operation: op.id,
        code: f?.code ?? (err instanceof Error ? err.name : "error"),
      });
      if (f) {
        const out = await finish(op, f.outcome, f.code);
        return out === f.outcome ? f.outcome : "lost";
      }
      await finish(op, "release", null).catch(() => undefined);
      return "retry";
    }
  };
}
