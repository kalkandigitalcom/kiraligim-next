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
} from "@/server/admin/options";
import { requireAdmin } from "@/server/admin/session";
import { listAdminGroups, searchAdminWorkspaces } from "@/server/admin/whatsapp";

import { setGlobalAction, setGroupAction, setWorkspaceAction } from "../actions";
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
 * Super Admin — opsiyon otomasyonu: global anahtar (kill switch), işletme ve WhatsApp grubu
 * anahtarları, varsayılan süre ve süre seçenekleri. Bir grupta otomasyon ancak ÜÇ anahtar birlikte
 * açıkken çalışır; varsayılan hepsi KAPALI. Mevcut WhatsApp grup sayfasına dokunulmaz.
 */
export default async function AdminOptionSettingsPage({ searchParams }: Props) {
  const admin = await requireAdmin();
  const { db } = admin.ctx;
  const sp = await searchParams;
  const query = one(sp.ara).slice(0, 100);
  const [settings, groups, found] = await Promise.all([
    getOptionSettings(db, admin.adminId),
    listAdminGroups(db, admin.adminId),
    query ? searchAdminWorkspaces(db, admin.adminId, query) : Promise.resolve([]),
  ]);
  const linked = groups.filter((g) => g.status === "linked" || settings.groups.has(g.id));
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
          Bir WhatsApp grubunda opsiyon otomasyonu ancak global, işletme ve grup anahtarlarının üçü
          birlikte açıkken çalışır. Varsayılan hepsi kapalı. Opsiyon müsaitliği kapatmaz.
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
          (bekler). Süresi dolan opsiyonların kapanması ve çakışma uyarıları her durumda çalışır.
        </p>
        {g0.enabled ? (
          <form action={setGlobalAction.bind(null, false)}>
            <Button type="submit">Kill switch: otomasyonu hemen kapat</Button>
          </form>
        ) : (
          <form action={setGlobalAction.bind(null, true)} className="flex flex-col gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="confirm" value="evet" required /> Global opsiyon
              otomasyonunun açılmasını onaylıyorum (yalnız işletme ve grup anahtarı açık olan
              gruplarda çalışır).
            </label>
            <div>
              <Button type="submit" variant="secondary">
                Global anahtarı aç
              </Button>
            </div>
          </form>
        )}
      </section>

      <section className={CARD} aria-labelledby="ws-title" data-testid="admin-option-workspaces">
        <div>
          <h2 id="ws-title" className="font-semibold text-navy-900">
            İşletmeler
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Süreler saat (ör. 48) ya da gün (ör. 2g) olarak, 1 saat – 14 gün arasında. Süre
            seçenekleri virgülle ayrılır (en fazla 12); varsayılan seçeneklerden biri olmalı. Süre
            yazılmamış mesaj, varsayılan yoksa Super Admin onayına düşer.
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
            Henüz ayarı olan veya WhatsApp grubu bağlı işletme yok.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
            {workspaceIds.map((wid) => {
              const s = settings.workspaces.get(wid);
              return (
                <li key={wid} className="flex flex-col gap-3 px-4 py-4">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium text-navy-900">{names.get(wid) ?? wid}</span>
                    <OnOff on={Boolean(s?.enabled)} />
                    {s ? (
                      <span className="text-muted-foreground">
                        varsayılan {formatMinutes(s.defaultMinutes)} · seçenekler{" "}
                        {s.choices.length ? s.choices.map(formatMinutes).join(", ") : "—"} · son
                        değişiklik {fmt(s.updatedAt)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">ayar yok (kapalı)</span>
                    )}
                  </div>
                  <form
                    action={setWorkspaceAction.bind(null, wid)}
                    className="grid gap-3 sm:grid-cols-[auto_1fr_1fr_auto] sm:items-end"
                  >
                    <label className="flex items-center gap-2 text-sm sm:pb-3">
                      <input type="checkbox" name="enabled" defaultChecked={Boolean(s?.enabled)} />{" "}
                      Otomasyon açık
                    </label>
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
                    <div className="flex flex-col gap-2">
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <input type="checkbox" name="confirm" value="evet" /> Açmayı onaylıyorum
                      </label>
                      <Button type="submit" variant="secondary" size="sm">
                        Kaydet
                      </Button>
                    </div>
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
            Yalnız işletmeye ve villaya bağlı gruplar. Grubun bağlantısı kaldırılıp yeniden
            bağlanırsa grup anahtarı geçersiz olur ve yeniden açılmalıdır. Grup yönetimi
            (eşleştirme, villa değişikliği) WhatsApp grupları sayfasındadır.
          </p>
        </div>
        {linked.length === 0 ? (
          <p className="text-sm text-muted-foreground">Bağlı grup yok.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
            {linked.map((g) => {
              const s = settings.groups.get(g.id);
              const on = Boolean(s?.enabled);
              return (
                <li
                  key={g.id}
                  className="flex flex-col gap-2 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
                >
                  <span className="min-w-0">
                    <span className="block font-medium text-navy-900">
                      {g.subject ?? "Adsız grup"} <OnOff on={on} />{" "}
                      {s?.effective ? <OnOff on label="ETKİN" /> : null}
                    </span>
                    <span className="block text-muted-foreground">
                      {g.workspaceName ?? "—"} · {g.propertyName ?? "villa yok"}
                      {g.status !== "linked" ? " · bağlı değil" : ""}
                      {s ? ` · son değişiklik ${fmt(s.updatedAt)}` : ""}
                    </span>
                  </span>
                  {on ? (
                    <form action={setGroupAction.bind(null, g.id, false)}>
                      <Button type="submit" variant="secondary" size="sm">
                        Kapat
                      </Button>
                    </form>
                  ) : g.status === "linked" && g.propertyId ? (
                    <form
                      action={setGroupAction.bind(null, g.id, true)}
                      className="flex items-center gap-3"
                    >
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <input type="checkbox" name="confirm" value="evet" required /> Onaylıyorum
                      </label>
                      <Button type="submit" variant="secondary" size="sm">
                        Aç
                      </Button>
                    </form>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
