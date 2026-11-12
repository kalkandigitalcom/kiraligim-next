import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, SelectField } from "@/components/ui/field";
import { isAppError } from "@/lib/errors";
import {
  ADMIN_API_ERRORS,
  type AdminApiErrorCode,
  getApiClient,
  listApiConnections,
  listApiGrants,
  listApiKeys,
  listApiUsage,
} from "@/server/admin/api-clients";
import { requireAdmin } from "@/server/admin/session";
import { listAdminProperties, searchAdminWorkspaces } from "@/server/admin/whatsapp";

import { ago, fmt } from "../../whatsapp/format";
import {
  createAccessCodeAction,
  createKeyAction,
  grantAction,
  revokeGrantAction,
  revokeKeyAction,
  setClientActiveAction,
} from "../actions";
import { AccessCodeForm, CreateKeyForm } from "../secret-forms";

export const metadata: Metadata = { title: "API hesabı" };

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

const CARD = "flex flex-col gap-4 rounded-2xl border border-border bg-white p-5 shadow-sm sm:p-6";

const NOTICES: Record<string, string> = {
  olusturuldu: "API hesabı oluşturuldu. Şimdi bir anahtar ve erişim kodu oluşturabilirsiniz.",
  etkin: "Hesap etkinleştirildi.",
  pasif: "Hesap pasifleştirildi; anahtarları bir sonraki istekte reddedilir.",
  "anahtar-geri-alindi": "Anahtar geri alındı; bir sonraki istekte reddedilir.",
  "izin-verildi": "Villa erişimi verildi.",
  "izin-kaldirildi": "Villa erişimi kaldırıldı; bir sonraki istekte geçerlidir.",
};

const CONNECTION_LABELS = {
  active: "etkin",
  paused: "duraklatıldı (villa, işletme veya hesap etkin değil)",
  disconnected: "acente kesti",
  revoked: "izin kaldırıldı",
} as const;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
      <dt className="text-sm text-muted-foreground sm:w-44 sm:shrink-0">{label}</dt>
      <dd className="min-w-0 text-[15px] break-words text-navy-900">{children}</dd>
    </div>
  );
}

/** API hesabı: durum, anahtarlar, erişim kodu, villa izinleri ve son 30 günlük kullanım. */
export default async function AdminApiClientPage({ params, searchParams }: Props) {
  const admin = await requireAdmin();
  const { id } = await params;
  const sp = await searchParams;
  const { db } = admin.ctx;
  let c;
  try {
    c = await getApiClient(db, admin.adminId, id);
  } catch (err) {
    if (isAppError(err) && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const [keys, grants, usage, connections] = await Promise.all([
    listApiKeys(db, admin.adminId, c.id),
    listApiGrants(db, admin.adminId, c.id),
    listApiUsage(db, admin.adminId, c.id),
    listApiConnections(db, admin.adminId, c.id),
  ]);
  const query = one(sp.ara).slice(0, 100);
  const chosenWs = one(sp.isletme);
  const workspaces = query || chosenWs ? await searchAdminWorkspaces(db, admin.adminId, query) : [];
  const chosen = workspaces.find((w) => w.id === chosenWs) ?? null;
  const villas = chosen ? await listAdminProperties(db, admin.adminId, chosen.id) : [];
  const notice = NOTICES[one(sp.durum)];
  const errorCode = one(sp.hata) as AdminApiErrorCode;
  const error = errorCode in ADMIN_API_ERRORS ? ADMIN_API_ERRORS[errorCode] : null;
  const active = c.status === "active";
  const activeKeys = keys.filter((k) => k.status === "active").length;
  const errors: Record<string, string> = { ...ADMIN_API_ERRORS };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <Link href="/api-musterileri" className="text-sm text-turquoise-700 hover:underline">
        ← API müşterileri
      </Link>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-navy-900">{c.name}</h1>
        <p className="mt-1 text-sm text-muted-foreground" data-testid="admin-api-status">
          {active ? "Etkin" : "Pasif"}
        </p>
      </div>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}

      <section className={CARD}>
        <dl className="flex flex-col gap-3">
          <Row label="Hesap kimliği">
            <span className="font-mono text-sm">{c.id}</span>
          </Row>
          <Row label="Oluşturulma">{fmt(c.createdAt)}</Row>
          <Row label="İstek sınırı">Anahtar başına dakikada {c.rateLimitPerMinute}</Row>
        </dl>
        <form action={setClientActiveAction.bind(null, c.id, !active)}>
          <Button type="submit" variant="secondary" size="sm">
            {active ? "Hesabı pasifleştir" : "Hesabı etkinleştir"}
          </Button>
        </form>
      </section>

      <section className={CARD} aria-labelledby="keys-title" data-testid="admin-api-keys">
        <div>
          <h2 id="keys-title" className="font-semibold text-navy-900">
            API anahtarları{" "}
            <span className="font-normal text-muted-foreground">({activeKeys} etkin)</span>
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Anahtar yalnız oluşturulduğu anda bir kez gösterilir; veritabanında yalnız özeti
            tutulur.
          </p>
        </div>
        {keys.length > 0 ? (
          <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
            {keys.map((k) => (
              <li
                key={k.id}
                className="flex flex-col gap-2 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="min-w-0">
                  <span className="block font-mono text-navy-900">kg_live_{k.prefix}_…</span>
                  <span className="block text-muted-foreground">
                    {k.label ? `${k.label} · ` : ""}
                    {k.status === "active"
                      ? `oluşturma ${fmt(k.createdAt)} · son kullanım ${ago(k.lastUsedAt)}`
                      : `geri alındı ${fmt(k.revokedAt)}`}
                  </span>
                </span>
                {k.status === "active" ? (
                  <form action={revokeKeyAction.bind(null, c.id, k.id)}>
                    <Button type="submit" variant="secondary" size="sm">
                      Geri al
                    </Button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        <CreateKeyForm
          action={createKeyAction.bind(null, c.id)}
          errors={errors}
          disabled={!active}
        />
      </section>

      <section className={CARD} aria-labelledby="code-title">
        <div>
          <h2 id="code-title" className="font-semibold text-navy-900">
            Acente erişim kodu
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {c.accessCodeHint
              ? `Geçerli kod …${c.accessCodeHint} ile biter (oluşturma ${fmt(c.accessCodeCreatedAt)}). Kodun tamamı saklanmaz.`
              : "Henüz kod yok."}
          </p>
        </div>
        <AccessCodeForm
          action={createAccessCodeAction.bind(null, c.id)}
          errors={errors}
          disabled={!active}
          hasCode={c.accessCodeHint !== null}
        />
      </section>

      <section className={CARD} aria-labelledby="grants-title" data-testid="admin-api-grants">
        <h2 id="grants-title" className="font-semibold text-navy-900">
          Villa izinleri{" "}
          <span className="font-normal text-muted-foreground">
            ({grants.filter((g) => g.status === "active").length} etkin)
          </span>
        </h2>
        {grants.length === 0 ? (
          <p className="text-sm text-muted-foreground">Henüz villa izni yok.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
            {grants.map((g) => (
              <li
                key={g.id}
                className="flex flex-col gap-2 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="min-w-0">
                  <span className="block font-medium text-navy-900">
                    {g.propertyName}
                    {g.propertyActive ? "" : " (pasif — API'de görünmez)"}
                  </span>
                  <span className="block text-muted-foreground">
                    {g.workspaceName} · {g.grantedVia === "owner" ? "ev sahibi onayı" : "platform"}{" "}
                    · {g.status === "active" ? fmt(g.createdAt) : `kaldırıldı ${fmt(g.revokedAt)}`}
                  </span>
                </span>
                {g.status === "active" ? (
                  <form action={revokeGrantAction.bind(null, c.id, g.id)}>
                    <Button type="submit" variant="secondary" size="sm">
                      Kaldır
                    </Button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-col gap-3 border-t border-border pt-4">
          <h3 className="text-sm font-semibold text-navy-900">Villa izni ekle</h3>
          <form method="get" className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1">
              <Field id="ara" name="ara" label="İşletme ara" defaultValue={query} maxLength={100} />
            </div>
            <Button type="submit" variant="secondary">
              Ara
            </Button>
          </form>
          {query || chosenWs ? (
            workspaces.length === 0 ? (
              <p className="text-sm text-muted-foreground">İşletme bulunamadı.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
                {workspaces.map((w) => (
                  <li key={w.id}>
                    <Link
                      href={`/api-musterileri/${c.id}?ara=${encodeURIComponent(query)}&isletme=${w.id}`}
                      aria-current={chosen?.id === w.id ? "true" : undefined}
                      className={`flex justify-between gap-3 px-4 py-2 text-sm hover:bg-mist/60 ${chosen?.id === w.id ? "bg-mist font-semibold" : ""}`}
                    >
                      <span>{w.name}</span>
                      <span className="text-muted-foreground">{w.active ? "" : "pasif"}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )
          ) : null}
          {chosen ? (
            <form
              action={grantAction.bind(null, c.id)}
              className="flex flex-col gap-3 sm:flex-row sm:items-end"
              data-testid="admin-api-grant-form"
            >
              <div className="flex-1">
                <SelectField
                  id="propertyId"
                  name="propertyId"
                  label={`${chosen.name} villaları`}
                  placeholder="Villa seçin"
                  options={villas.map((v) => ({
                    value: v.id,
                    label: v.active ? v.name : `${v.name} (pasif)`,
                  }))}
                  required
                />
              </div>
              <Button type="submit">İzin ver</Button>
            </form>
          ) : null}
        </div>
      </section>

      <section
        className={CARD}
        aria-labelledby="connections-title"
        data-testid="admin-api-connections"
      >
        <h2 id="connections-title" className="font-semibold text-navy-900">
          Takvim bağlantıları{" "}
          <span className="font-normal text-muted-foreground">
            ({connections.filter((x) => x.status === "active" || x.status === "paused").length}{" "}
            güncel)
          </span>
        </h2>
        {connections.length === 0 ? (
          <p className="text-sm text-muted-foreground">Henüz takvim bağlantısı yok.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
            {connections.map((x) => (
              <li key={x.id} className="flex flex-col gap-0.5 px-4 py-3 text-sm">
                <span className="font-medium text-navy-900">
                  {x.propertyName}{" "}
                  <span className="font-normal text-muted-foreground">
                    → acente kimliği <span className="font-mono">{x.externalPropertyId}</span>
                  </span>
                </span>
                <span className="text-muted-foreground">
                  {x.workspaceName} · {CONNECTION_LABELS[x.status]} · bağlantı {fmt(x.createdAt)}
                  {x.endedAt ? ` · bitiş ${fmt(x.endedAt)}` : ""} · son senkron{" "}
                  {x.lastSyncedAt ? fmt(x.lastSyncedAt) : "henüz yok"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={CARD} aria-labelledby="usage-title" data-testid="admin-api-usage">
        <h2 id="usage-title" className="font-semibold text-navy-900">
          Kullanım (son 30 gün)
        </h2>
        {usage.length === 0 ? (
          <p className="text-sm text-muted-foreground">Bu dönemde istek yok.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 pr-4 font-medium">Gün</th>
                  <th className="py-1 pr-4 text-right font-medium">İstek</th>
                  <th className="py-1 pr-4 text-right font-medium">Sınır aşımı</th>
                  <th className="py-1 text-right font-medium">Hata (4xx)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {usage.map((u) => (
                  <tr key={u.day}>
                    <td className="py-1 pr-4 text-navy-900">{u.day}</td>
                    <td className="py-1 pr-4 text-right">{u.requests.toLocaleString("tr-TR")}</td>
                    <td className="py-1 pr-4 text-right">
                      {u.rateLimited.toLocaleString("tr-TR")}
                    </td>
                    <td className="py-1 text-right">{u.errors.toLocaleString("tr-TR")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
