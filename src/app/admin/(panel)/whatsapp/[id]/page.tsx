import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, SelectField } from "@/components/ui/field";
import { isAppError } from "@/lib/errors";
import { requireAdmin } from "@/server/admin/session";
import {
  ADMIN_WA_ERRORS,
  type AdminWaErrorCode,
  getAdminGroup,
  listAdminGroupHistory,
  listAdminProperties,
  searchAdminWorkspaces,
} from "@/server/admin/whatsapp";

import {
  archiveGroupAction,
  linkGroupAction,
  setActiveAction,
  setPropertyAction,
  unlinkGroupAction,
} from "../actions";
import { ago, fmt } from "../format";
import { HISTORY_LABELS, NOTICES, STATUS_LABELS } from "../labels";

export const metadata: Metadata = { title: "WhatsApp grubu" };

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
      <dt className="text-sm text-muted-foreground sm:w-44 sm:shrink-0">{label}</dt>
      <dd className="min-w-0 text-[15px] break-words text-navy-900">{children}</dd>
    </div>
  );
}

const CARD = "flex flex-col gap-4 rounded-2xl border border-border bg-white p-5 shadow-sm sm:p-6";

/** Grup detayı: eşleştirme (işletme → villa), villa değişikliği, aktif/pasif, kaldırma, arşiv, geçmiş. */
export default async function AdminWhatsAppGroupPage({ params, searchParams }: Props) {
  const admin = await requireAdmin();
  const { id } = await params;
  const sp = await searchParams;
  const { db } = admin.ctx;
  let g;
  try {
    g = await getAdminGroup(db, admin.adminId, id);
  } catch (err) {
    if (isAppError(err) && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const history = await listAdminGroupHistory(db, g.id);
  const pending = g.workspaceId === null && g.status === "discovered" && !g.archivedAt;
  const query = one(sp.ara).slice(0, 100);
  const chosenWs = one(sp.isletme);
  const workspaces = pending ? await searchAdminWorkspaces(db, admin.adminId, query) : [];
  const chosen = workspaces.find((w) => w.id === chosenWs) ?? null;
  const linkVillas =
    pending && chosen ? await listAdminProperties(db, admin.adminId, chosen.id) : [];
  const ownVillas = g.workspaceId
    ? await listAdminProperties(db, admin.adminId, g.workspaceId)
    : [];
  const notice = NOTICES[one(sp.durum)];
  const errorCode = one(sp.hata) as AdminWaErrorCode;
  const error = errorCode in ADMIN_WA_ERRORS ? ADMIN_WA_ERRORS[errorCode] : null;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <Link href="/whatsapp" className="text-sm text-turquoise-700 hover:underline">
        ← WhatsApp grupları
      </Link>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-navy-900">
          {g.subject ?? "(adsız grup)"}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground" data-testid="admin-wa-status">
          {g.archivedAt ? "Arşivde (yok sayılıyor)" : (STATUS_LABELS[g.status] ?? g.status)}
        </p>
      </div>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}

      <section className={CARD}>
        <dl className="flex flex-col gap-3">
          <Row label="Grup kimliği (JID)">
            <span className="font-mono text-sm">{g.jid}</span>
          </Row>
          <Row label="İşletme">{g.workspaceName ?? "—"}</Row>
          <Row label="Villa">
            {g.propertyName ?? "—"}
            {g.propertyActive === false ? " (pasif villa)" : ""}
          </Row>
          <Row label="Katılımcı">{g.participantCount}</Row>
          <Row label="Keşif / son görülme">
            {fmt(g.firstSeenAt)} / {ago(g.lastSeenAt)}
          </Row>
          <Row label="Son mesaj">{ago(g.lastMessageAt)}</Row>
          <Row label="Eşleştirme">{fmt(g.linkedAt)}</Row>
          <Row label="Gateway bağlantısı">{g.connectionLabel}</Row>
          {g.sameJidCount > 1 ? (
            <Row label="Uyarı">
              Bu grup {g.sameJidCount} ayrı bağlantı kaydıyla keşfedilmiş (mükerrer). Yalnız biri
              bağlanabilir; diğerini arşivleyin.
            </Row>
          ) : null}
        </dl>
      </section>

      {pending ? (
        <section className={CARD} data-testid="admin-wa-link">
          <h2 className="font-semibold text-navy-900">İşletme ve villayla eşleştir</h2>
          <form method="get" className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1">
              <Field id="ara" name="ara" label="İşletme ara" defaultValue={query} maxLength={100} />
            </div>
            <Button type="submit" variant="secondary">
              Ara
            </Button>
          </form>
          {workspaces.length === 0 ? (
            <p className="text-sm text-muted-foreground">İşletme bulunamadı.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
              {workspaces.map((w) => (
                <li key={w.id}>
                  <Link
                    href={`/whatsapp/${g.id}?ara=${encodeURIComponent(query)}&isletme=${w.id}`}
                    aria-current={chosen?.id === w.id ? "true" : undefined}
                    className={`flex justify-between gap-3 px-4 py-2 text-sm hover:bg-mist/60 ${chosen?.id === w.id ? "bg-mist font-semibold" : ""}`}
                  >
                    <span>{w.name}</span>
                    <span className="text-muted-foreground">
                      {w.slug}
                      {w.active ? "" : " · aktif değil"}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {chosen ? (
            <form action={linkGroupAction.bind(null, g.id)} className="flex flex-col gap-4">
              <input type="hidden" name="workspaceId" value={chosen.id} />
              <SelectField
                id="propertyId"
                name="propertyId"
                label={`${chosen.name} — villa`}
                placeholder="Villa seçin"
                options={linkVillas
                  .filter((v) => v.active)
                  .map((v) => ({ value: v.id, label: v.name }))}
                required
              />
              <div>
                <Button type="submit">Eşleştir ve aktif et</Button>
              </div>
            </form>
          ) : null}
          <form action={archiveGroupAction.bind(null, g.id, true)}>
            <Button type="submit" variant="ghost" size="sm">
              Bu grubu yok say / arşivle
            </Button>
          </form>
        </section>
      ) : null}

      {g.archivedAt ? (
        <section className={CARD}>
          <p className="text-sm text-muted-foreground">Arşivlendi: {fmt(g.archivedAt)}</p>
          <form action={archiveGroupAction.bind(null, g.id, false)}>
            <Button type="submit" variant="secondary">
              Arşivden çıkar
            </Button>
          </form>
        </section>
      ) : null}

      {g.workspaceId ? (
        <>
          <section className={CARD} data-testid="admin-wa-manage">
            <h2 className="font-semibold text-navy-900">Villa ve durum</h2>
            <form
              action={setPropertyAction.bind(null, g.id)}
              className="flex flex-col gap-3 sm:flex-row sm:items-end"
            >
              <div className="flex-1">
                <SelectField
                  id="setPropertyId"
                  name="propertyId"
                  label="Villa (yalnız bu işletmenin aktif villaları)"
                  defaultValue={g.propertyId ?? ""}
                  options={ownVillas
                    .filter((v) => v.active)
                    .map((v) => ({ value: v.id, label: v.name }))}
                  required
                />
              </div>
              <Button type="submit" variant="secondary">
                Villayı kaydet
              </Button>
            </form>
            {g.status === "linked" ? (
              <form action={setActiveAction.bind(null, g.id, false)}>
                <Button type="submit" variant="secondary">
                  Pasife al
                </Button>
                <p className="mt-1 text-sm text-muted-foreground">
                  Pasif grubun yeni mesajları kaydedilmez; otomatik takvim işlemi yapılmaz.
                </p>
              </form>
            ) : g.status === "suspended" ? (
              <form action={setActiveAction.bind(null, g.id, true)}>
                <Button type="submit">Yeniden aktif et</Button>
              </form>
            ) : null}
          </section>
          <section className={CARD}>
            <h2 className="font-semibold text-destructive">Bağlantıyı kaldır</h2>
            <p className="text-sm text-muted-foreground">
              Grup işletmeden ayrılır; grubun kayıtlı mesaj içerikleri silinir, bekleyen öneriler
              kapanır. Denetim kayıtları, eşleştirme geçmişi ve oluşmuş takvim kayıtları korunur.
            </p>
            <form action={unlinkGroupAction.bind(null, g.id)} className="flex flex-col gap-3">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="confirm" value="evet" required /> Bağlantının
                kaldırılmasını ve mesajların silinmesini onaylıyorum.
              </label>
              <div>
                <Button type="submit" variant="secondary">
                  Bağlantıyı kaldır
                </Button>
              </div>
            </form>
          </section>
        </>
      ) : null}

      <section className={CARD} data-testid="admin-wa-history">
        <h2 className="font-semibold text-navy-900">Eşleştirme geçmişi</h2>
        {history.length === 0 ? (
          <p className="text-sm text-muted-foreground">Kayıt yok.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {history.map((h) => (
              <li key={h.id} className="flex flex-wrap gap-x-2">
                <span className="text-muted-foreground">{fmt(h.occurredAt)}</span>
                <span className="text-navy-900">{HISTORY_LABELS[h.action] ?? h.action}</span>
                <span className="text-muted-foreground">· {h.adminName ?? "—"}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
