import type { Metadata } from "next";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { durationInput, formatMinutes } from "@/lib/option-admin";
import { cn } from "@/lib/utils";
import {
  ADMIN_OPTION_ERRORS,
  type AdminOptionErrorCode,
  getOptionSettings,
  getSystemDefaultDuration,
} from "@/server/admin/options";
import { requireAdmin } from "@/server/admin/session";
import { listAdminGroups, searchAdminWorkspaces } from "@/server/admin/whatsapp";

import { setGlobalAction, setSystemDefaultAction, setWorkspaceAction } from "../actions";
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
 * işletmelerin varsayılan süre ve süre seçenekleri, bağlı WhatsApp gruplarının durumu (salt
 * okunur). Global açıkken bağlı, villası atanmış ve işletmesi aktif her grupta otomasyon
 * kendiliğinden çalışır; işletme veya grup başına açma yoktur. Mevcut WhatsApp grup sayfasına
 * dokunulmaz.
 */
export default async function AdminOptionSettingsPage({ searchParams }: Props) {
  const admin = await requireAdmin();
  const { db } = admin.ctx;
  const sp = await searchParams;
  const query = one(sp.ara).slice(0, 100);
  const [settings, systemDefault, groups, found] = await Promise.all([
    getOptionSettings(db, admin.adminId),
    getSystemDefaultDuration(db, admin.adminId),
    listAdminGroups(db, admin.adminId),
    query ? searchAdminWorkspaces(db, admin.adminId, query) : Promise.resolve([]),
  ]);
  const linked = groups.filter((g) => g.status === "linked");
  // İşletme adları: bağlı gruplardan ve aramadan; ayarı olup adı bilinmeyenler için tek arama.
  const names = new Map<string, string>();
  for (const g of groups)
    if (g.workspaceId && g.workspaceName) names.set(g.workspaceId, g.workspaceName);
  for (const w of found) names.set(w.id, w.name);
  if ([...settings.workspaces.keys()].some((id) => !names.has(id))) {
    for (const w of await searchAdminWorkspaces(db, admin.adminId, "")) names.set(w.id, w.name);
  }
  const workspaceIds = [
    ...new Set([
      ...settings.workspaces.keys(),
      ...linked.map((g) => g.workspaceId).filter((x): x is string => Boolean(x)),
      ...found.map((w) => w.id),
    ]),
  ].sort((a, b) => (names.get(a) ?? a).localeCompare(names.get(b) ?? b, "tr"));
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
        aria-labelledby="system-default-title"
        data-testid="admin-option-system-default"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="system-default-title" className="font-semibold text-navy-900">
            Sistem varsayılan süresi: {formatMinutes(systemDefault.minutes)}
          </h2>
          <span className="text-sm text-muted-foreground">
            son değişiklik {fmt(systemDefault.updatedAt)}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          WhatsApp mesajında süre yazılmamışsa ve işletmenin kendi varsayılanı yoksa bu süre
          kullanılır (öncelik: mesajdaki süre → işletme varsayılanı → sistem varsayılanı).
          Varsayılan süre girişi aşarsa bitiş giriş saatine çekilir; girişe 60 dakikadan az
          kalıyorsa işlem açıklama bekler. Mesajda yazılı süre hiçbir zaman kısaltılmaz. Değişiklik
          mevcut opsiyonların bitişini etkilemez.
        </p>
        <form
          action={setSystemDefaultAction}
          className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end"
        >
          <Field
            id="system-default"
            name="systemDefault"
            label="Sistem varsayılanı (saat, ör. 24 veya 2g)"
            defaultValue={durationInput(systemDefault.minutes)}
            required
            maxLength={8}
          />
          <Button type="submit" variant="secondary" size="sm">
            Kaydet
          </Button>
        </form>
      </section>

      <section className={CARD} aria-labelledby="ws-title" data-testid="admin-option-workspaces">
        <div>
          <h2 id="ws-title" className="font-semibold text-navy-900">
            İşletmeler
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Her işletmenin kendi varsayılan opsiyon süresi. Süreler saat (ör. 48) ya da gün (ör. 2g)
            olarak, 1 saat – 14 gün arasında. Süre seçenekleri virgülle ayrılır (en fazla 12);
            varsayılan seçeneklerden biri olmalı. İşletme sahibi de kendi varsayılanını işletme
            panelinden değiştirebilir. Varsayılan yoksa sistem varsayılanı kullanılır.
          </p>
        </div>
        <form method="get" className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Field
              id="ara"
              name="ara"
              label="İşletme ekle (ara)"
              defaultValue={query}
              maxLength={100}
            />
          </div>
          <Button type="submit" variant="secondary">
            Ara
          </Button>
        </form>
        {workspaceIds.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Henüz süre ayarı olan veya WhatsApp grubu bağlı işletme yok.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
            {workspaceIds.map((wid) => {
              const s = settings.workspaces.get(wid);
              return (
                <li key={wid} className="flex flex-col gap-3 px-4 py-4">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium text-navy-900">{names.get(wid) ?? wid}</span>
                    {s ? (
                      <span className="text-muted-foreground">
                        varsayılan {formatMinutes(s.defaultMinutes)} · seçenekler{" "}
                        {s.choices.length ? s.choices.map(formatMinutes).join(", ") : "—"} · son
                        değişiklik {fmt(s.updatedAt)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">varsayılan süre yok</span>
                    )}
                  </div>
                  <form
                    action={setWorkspaceAction.bind(null, wid)}
                    className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
                  >
                    <Field
                      id={`def-${wid}`}
                      name="defaultDuration"
                      label="Varsayılan süre"
                      defaultValue={durationInput(s?.defaultMinutes ?? null)}
                      placeholder="yok"
                      maxLength={8}
                    />
                    <Field
                      id={`ch-${wid}`}
                      name="choices"
                      label="Süre seçenekleri (saat)"
                      defaultValue={s?.choices.map((m) => durationInput(m)).join(", ") ?? ""}
                      placeholder="ör. 24, 48, 3g"
                      maxLength={120}
                    />
                    <Button type="submit" variant="secondary" size="sm">
                      Kaydet
                    </Button>
                  </form>
                </li>
              );
            })}
          </ul>
        )}
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
