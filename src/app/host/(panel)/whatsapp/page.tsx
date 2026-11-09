import type { Metadata } from "next";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import {
  maskPhone,
  WA_CONNECTION_STATUS_LABELS,
  WA_GROUP_STATUS_LABELS,
  WA_RETENTION_DAYS,
  type WaGroupStatus,
} from "@/lib/whatsapp-meta";
import {
  canManageWhatsapp,
  canViewWhatsappMessages,
  getConnectionStatus,
  listGroups,
  listManagers,
  listRecentMessages,
} from "@/server/whatsapp/service";
import { withPanelTenant } from "@/server/workspaces/panel-tenant";

import { setGroupSuspendedAction, setManagerAuthorizedAction, unlinkGroupAction } from "./actions";
import { ActionButton, LinkGroupPanel, UnlinkButton } from "./whatsapp-components";

export const metadata: Metadata = { title: "WhatsApp Asistanı" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

const NOTICES: Record<string, { tone: "success" | "info"; text: string }> = {
  "askiya-alindi": {
    tone: "success",
    text: "Grup askıya alındı; mesajları kaydedilmeyecek.",
  },
  etkinlestirildi: { tone: "success", text: "Grup yeniden etkinleştirildi." },
  "baglanti-kesildi": {
    tone: "success",
    text: "Grubun bağlantısı kesildi ve kayıtlı mesajları silindi.",
  },
  "yetki-verildi": { tone: "success", text: "Yöneticiye grup bağlama yetkisi verildi." },
  "yetki-kaldirildi": { tone: "success", text: "Yöneticinin grup bağlama yetkisi kaldırıldı." },
};

const TIME_FMT = new Intl.DateTimeFormat("tr-TR", {
  timeZone: "Europe/Istanbul",
  dateStyle: "short",
  timeStyle: "short",
});
const fmt = (d: Date | null) => (d ? TIME_FMT.format(d) : "—");

const STATUS_BADGE: Record<WaGroupStatus, string> = {
  discovered: "bg-muted text-muted-foreground",
  linked: "bg-turquoise-50 text-turquoise-700",
  suspended: "bg-amber-50 text-amber-800",
  left: "bg-destructive/10 text-destructive",
};

function minutesAgo(d: Date | null): string {
  if (!d) return "hiç";
  const m = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
  if (m < 1) return "az önce";
  if (m < 60) return `${m} dk önce`;
  return fmt(d);
}

/**
 * WhatsApp Asistanı — A1: grup kaydı ve mesaj kuyruğu (yalnız okuma). Takvim, fiyat veya
 * rezervasyon işlemi yapılmaz. Tüm üyeler grupları görür; mesajları owner ve manager görür;
 * bağlama/askıya alma/bağlantı kesme owner ve owner'ın yetkilendirdiği manager'dadır.
 */
export default async function WhatsAppPage({ searchParams }: Props) {
  const sp = await searchParams;
  const view = await withPanelTenant(async (tx, ctx) => {
    const groups = await listGroups(tx, ctx);
    const canView = canViewWhatsappMessages(ctx);
    const selected = canView
      ? groups.find((g) => g.id === one(sp.grup) && g.status !== "discovered")
      : undefined;
    return {
      role: ctx.role,
      canManage: await canManageWhatsapp(tx, ctx),
      canView,
      connection: await getConnectionStatus(tx),
      groups,
      selected,
      messages: selected ? await listRecentMessages(tx, ctx, selected.id) : [],
      managers: ctx.role === "owner" ? await listManagers(tx) : [],
    };
  });
  const { role, canManage, canView, connection, groups, selected, messages, managers } = view;
  const notice = NOTICES[one(sp.durum) ?? ""];
  const online = connection.status === "open" && !connection.stale;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-navy-900 sm:text-3xl">
          WhatsApp Asistanı
        </h1>
        <p className="mt-1 text-[15px] text-muted-foreground">
          Kiraligim asistan numarasının bulunduğu WhatsApp gruplarını işletmenize bağlayın. Bu
          aşamada mesajlar yalnız kaydedilir; takvim veya fiyat işlemi yapılmaz.
        </p>
      </div>

      {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}

      {/* ── Bağlantı durumu ── */}
      <section
        aria-label="Bağlantı durumu"
        data-testid="wa-connection"
        className={cn(
          "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl border px-5 py-3 text-sm",
          online
            ? "border-turquoise-200 text-turquoise-800 bg-turquoise-50/60"
            : "border-amber-300 bg-amber-50 text-amber-900",
        )}
      >
        <span className="font-semibold">
          Kiraligim asistanı:{" "}
          {connection.status === "none"
            ? "Henüz bağlanmadı"
            : online
              ? WA_CONNECTION_STATUS_LABELS.open
              : connection.status === "open"
                ? "Bağlantı yok"
                : WA_CONNECTION_STATUS_LABELS[connection.status]}
        </span>
        <span className="text-current/80">Son görülme: {minutesAgo(connection.lastSeenAt)}</span>
      </section>

      {/* ── Gruplar ── */}
      <section
        aria-labelledby="wa-groups-title"
        className="flex flex-col gap-4 rounded-2xl border border-border bg-white p-5 shadow-sm sm:p-6"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="wa-groups-title" className="font-semibold text-navy-900">
              Gruplar <span className="font-normal text-muted-foreground">({groups.length})</span>
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Yalnız bağlı ve aktif grupların metin mesajları kaydedilir ve {WA_RETENTION_DAYS} gün
              sonra silinir. Bağlı olmayan grupların mesajları hiç saklanmaz.
            </p>
          </div>
        </div>

        {canManage ? (
          <LinkGroupPanel />
        ) : (
          <Alert tone="info">
            Grupları görüntüleyebilirsiniz; grup bağlama ve yönetme işletme sahibinde ve onun
            yetkilendirdiği yöneticilerdedir.
          </Alert>
        )}

        {groups.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border px-5 py-8 text-center">
            <p className="font-semibold text-navy-900">Henüz bağlı grup yok.</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-3" aria-label="Gruplar" data-testid="wa-groups">
            {groups.map((g) => {
              const name = g.subject ?? "(adsız grup)";
              return (
                <li
                  key={g.id}
                  data-testid="wa-group"
                  className="flex flex-col gap-3 rounded-xl border border-border p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-navy-900">{name}</p>
                      <p className="mt-0.5 text-sm text-muted-foreground">
                        {g.participantCount} katılımcı
                        {g.messages7d != null ? ` · son 7 gün ${g.messages7d} mesaj` : ""}
                        {` · son mesaj ${fmt(g.lastMessageAt)}`}
                      </p>
                    </div>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold",
                        STATUS_BADGE[g.status],
                      )}
                      data-testid="wa-group-status"
                    >
                      {WA_GROUP_STATUS_LABELS[g.status]}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2 text-xs">
                    {g.adminsOnly ? (
                      <span className="rounded-md bg-mist px-2 py-0.5 text-navy-900">
                        Yalnız yöneticiler yazar
                      </span>
                    ) : null}
                    <span className="rounded-md bg-mist px-2 py-0.5 text-navy-900">
                      {g.botIsAdmin ? "Kiraligim yönetici" : "Kiraligim yönetici değil"}
                    </span>
                  </div>
                  {canView || canManage ? (
                    <div className="flex flex-wrap items-center gap-2">
                      {canView && g.status !== "discovered" ? (
                        <Link
                          href={`/whatsapp?grup=${g.id}#mesajlar`}
                          className="text-sm font-medium text-turquoise-700 hover:underline"
                          data-testid="wa-group-messages-link"
                        >
                          Mesajları gör
                        </Link>
                      ) : null}
                      {canManage && (g.status === "linked" || g.status === "suspended") ? (
                        <ActionButton
                          action={setGroupSuspendedAction.bind(null, g.id, g.status === "linked")}
                          label={g.status === "linked" ? "Askıya al" : "Devam ettir"}
                          pendingLabel="Kaydediliyor…"
                          ariaLabel={`${g.status === "linked" ? "Askıya al" : "Devam ettir"}: ${name}`}
                          testId="wa-group-toggle"
                        />
                      ) : null}
                      {canManage ? (
                        <UnlinkButton name={name} action={unlinkGroupAction.bind(null, g.id)} />
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ── Son mesajlar (owner / manager) ── */}
      {canView && selected ? (
        <section
          id="mesajlar"
          aria-labelledby="wa-messages-title"
          className="flex flex-col gap-4 rounded-2xl border border-border bg-white p-5 shadow-sm sm:p-6"
        >
          <div>
            <h2 id="wa-messages-title" className="font-semibold text-navy-900">
              Son mesajlar · {selected.subject ?? "(adsız grup)"}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Son 50 kayıtlı mesaj. Bu aşamada mesajlar işlenmez; yalnız kaydedilir.
            </p>
          </div>
          {messages.length === 0 ? (
            <p className="text-sm text-muted-foreground">Henüz kayıtlı mesaj yok.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border" data-testid="wa-messages">
              {messages.map((m) => (
                <li key={m.id} className="flex flex-col gap-1 py-3" data-testid="wa-message">
                  <p className="text-xs text-muted-foreground">
                    {fmt(m.sentAt)} · {maskPhone(m.senderPn)}
                    {m.kind === "backlog" ? " · bağlantı kesintisinden sonra geldi" : ""}
                  </p>
                  <p className="text-sm break-words whitespace-pre-wrap text-navy-900">{m.body}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {/* ── Yönetici yetkileri (yalnız owner) ── */}
      {role === "owner" ? (
        <section
          aria-labelledby="wa-managers-title"
          className="flex flex-col gap-4 rounded-2xl border border-border bg-white p-5 shadow-sm sm:p-6"
        >
          <div>
            <h2 id="wa-managers-title" className="font-semibold text-navy-900">
              Grup bağlama yetkisi
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              İşletme sahibi her zaman yetkilidir. Yöneticiler ancak burada yetkilendirilirse grup
              bağlayabilir, askıya alabilir veya bağlantıyı kesebilir.
            </p>
          </div>
          {managers.length === 0 ? (
            <p className="text-sm text-muted-foreground">İşletmede yönetici yok.</p>
          ) : (
            <ul className="flex flex-col gap-2" data-testid="wa-managers">
              {managers.map((m) => (
                <li
                  key={m.userId}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border px-4 py-3"
                  data-testid="wa-manager"
                >
                  <span className="text-sm text-navy-900">
                    {m.name}{" "}
                    <span className="text-muted-foreground">
                      · {m.authorized ? "yetkili" : "yetkisiz"}
                    </span>
                  </span>
                  <ActionButton
                    action={setManagerAuthorizedAction.bind(null, m.userId, !m.authorized)}
                    label={m.authorized ? "Yetkiyi kaldır" : "Yetki ver"}
                    pendingLabel="Kaydediliyor…"
                    ariaLabel={`${m.authorized ? "Yetkiyi kaldır" : "Yetki ver"}: ${m.name}`}
                    testId="wa-manager-toggle"
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}
