import type { Metadata } from "next";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { formatMinutes } from "@/lib/option-admin";
import { OPTION_SYSTEM_DEFAULT_MINUTES } from "@/lib/option-meta";
import { cn } from "@/lib/utils";
import {
  ADMIN_OPTION_ERRORS,
  type AdminOptionErrorCode,
  getOptionSettings,
} from "@/server/admin/options";
import { requireAdmin } from "@/server/admin/session";
import { listAdminGroups } from "@/server/admin/whatsapp";

import { setGlobalAction } from "../actions";
import { fmt } from "../format";
import { NOTICES } from "../labels";

export const metadata: Metadata = { title: "Opsiyon otomasyon ayarları" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

const CARD = "flex flex-col gap-4 rounded-2xl border border-border bg-white p-5 shadow-sm sm:p-6";

const OnOff = ({ on, label }: { on: boolean; label?: string }) => (
  <span
    className={cn(
      "rounded-full px-2 py-0.5 text-xs font-semibold",
      on ? "bg-amber-100 text-amber-900" : "bg-mist text-navy-900",
    )}
  >
    {label ?? (on ? "AÇIK" : "KAPALI")}
  </span>
);

/**
 * Super Admin — tek ve ortak opsiyon sistemi (0074): global anahtar (acil durum kill switch'i),
 * sabit opsiyon süresi (0076: 24 saat, ayar yok) ve bağlı WhatsApp gruplarının durumu (salt
 * okunur). Global açıkken bağlı, villası atanmış ve işletmesi aktif her grupta otomasyon
 * kendiliğinden çalışır; işletme veya grup başına açma yoktur. Mevcut WhatsApp grup sayfasına
 * dokunulmaz.
 */
export default async function AdminOptionSettingsPage({ searchParams }: Props) {
  const admin = await requireAdmin();
  const { db } = admin.ctx;
  const sp = await searchParams;
  const [settings, groups] = await Promise.all([
    getOptionSettings(db, admin.adminId),
    listAdminGroups(db, admin.adminId),
  ]);
  const linked = groups.filter((g) => g.status === "linked");
  const notice = NOTICES[one(sp.durum)];
  const code = one(sp.hata) as AdminOptionErrorCode;
  const error = code in ADMIN_OPTION_ERRORS ? ADMIN_OPTION_ERRORS[code] : null;
  const g0 = settings.global;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <Link href="/opsiyonlar" className="text-sm text-turquoise-700 hover:underline">
        ← Opsiyonlar
      </Link>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-navy-900">Opsiyon otomasyonu</h1>
        <p className="mt-1 text-[15px] text-muted-foreground">
          Tek ve ortak opsiyon sistemi: global anahtar açıkken işletmeye ve villaya bağlı her
          WhatsApp grubunda opsiyon otomasyonu kendiliğinden çalışır; işletme veya grup başına açma
          gerekmez. Global anahtar yalnız acil durumda bütün sistemi durdurmak içindir. Opsiyon
          müsaitliği kapatmaz.
        </p>
      </div>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}

      <section
        className={CARD}
        aria-labelledby="global-title"
        data-testid="admin-option-kill-switch"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="global-title" className="font-semibold text-navy-900">
            Global anahtar (kill switch) <OnOff on={g0.enabled} />
          </h2>
          <span className="text-sm text-muted-foreground">son değişiklik {fmt(g0.updatedAt)}</span>
        </div>
        <p className="text-sm text-muted-foreground">
          Kapalıyken hiçbir grupta opsiyon mesajı okunmaz ve onaylanmış işlemler de uygulanmaz
          (bekler); kapalıyken gelen mesajlar yeniden açılınca geriye dönük işlenmez. Süresi dolan
          opsiyonların kapanması ve çakışma uyarıları her durumda çalışır.
        </p>
        {g0.enabled ? (
          <form action={setGlobalAction.bind(null, false)}>
            <Button type="submit">Kill switch: otomasyonu hemen kapat</Button>
          </form>
        ) : (
          <form action={setGlobalAction.bind(null, true)} className="flex flex-col gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="confirm" value="evet" required /> Global opsiyon
              otomasyonunun açılmasını onaylıyorum (işletmeye ve villaya bağlı BÜTÜN WhatsApp
              gruplarında çalışır).
            </label>
            <div>
              <Button type="submit" variant="secondary">
                Global anahtarı aç
              </Button>
            </div>
          </form>
        )}
      </section>

      <section
        className={CARD}
        aria-labelledby="duration-title"
        data-testid="admin-option-duration"
      >
        <h2 id="duration-title" className="font-semibold text-navy-900">
          Opsiyon süresi: sabit {formatMinutes(OPTION_SYSTEM_DEFAULT_MINUTES)}
        </h2>
        <p className="text-sm text-muted-foreground">
          Villa kiralamada standart opsiyon süresi 24 saattir; ayar yoktur (işletme veya sistem
          bazında değiştirilmez). WhatsApp mesajında süre yazılmamışsa opsiyon 24 saat geçerlidir;
          mesajda açıkça yazılan süre aynen kullanılır. Süre girişi aşarsa bitiş giriş saatine
          çekilir; girişe 60 dakikadan az kalıyorsa ya da giriş geçmişse istek açıklama bekler.
          Opsiyon yönetimi yalnız WhatsApp grubundan yapılır.
        </p>
      </section>

      <section className={CARD} aria-labelledby="groups-title" data-testid="admin-option-groups">
        <div>
          <h2 id="groups-title" className="font-semibold text-navy-900">
            WhatsApp grupları
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            İşletmeye bağlı gruplar (salt okunur). Global anahtar açıkken bağlı ve villası atanmış
            her grupta opsiyon otomasyonu çalışır; grubun işletmesi askıdaysa çalışmaz. Opsiyon
            işlemini yalnız doğrulanmış sahip veya yönetici telefonu başlatabilir. Grup yönetimi
            (eşleştirme, villa değişikliği, askıya alma, engelleme) WhatsApp grupları sayfasındadır.
          </p>
        </div>
        {linked.length === 0 ? (
          <p className="text-sm text-muted-foreground">Bağlı grup yok.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
            {linked.map((g) => {
              const ready = Boolean(g.propertyId);
              return (
                <li key={g.id} className="flex flex-col gap-1 px-4 py-3 text-sm">
                  <span className="font-medium text-navy-900">
                    {g.subject ?? "Adsız grup"}{" "}
                    {!ready ? (
                      <OnOff on={false} label="VİLLA YOK" />
                    ) : g0.enabled ? (
                      <OnOff on label="ETKİN" />
                    ) : (
                      <OnOff on={false} label="GLOBAL KAPALI" />
                    )}
                  </span>
                  <span className="text-muted-foreground">
                    {g.workspaceName ?? "—"} · {g.propertyName ?? "villa yok"}
                    {g.propertyActive === false ? " · villa pasif" : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
