import type { Metadata } from "next";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import {
  ADMIN_API_ERRORS,
  type AdminApiErrorCode,
  listApiClients,
} from "@/server/admin/api-clients";
import { requireAdmin } from "@/server/admin/session";

import { ago } from "../whatsapp/format";
import { createClientAction } from "./actions";

export const metadata: Metadata = { title: "API müşterileri" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

const CARD = "flex flex-col gap-4 rounded-2xl border border-border bg-white p-5 shadow-sm sm:p-6";

/**
 * Super Admin — API müşterileri (acente okuma API'si, 1. aşama). Hesap oluşturma burada; anahtar,
 * villa izinleri ve kullanım hesap detayında.
 */
export default async function AdminApiClientsPage({ searchParams }: Props) {
  const admin = await requireAdmin();
  const sp = await searchParams;
  const clients = await listApiClients(admin.ctx.db, admin.adminId);
  const errorCode = one(sp.hata) as AdminApiErrorCode;
  const error = errorCode in ADMIN_API_ERRORS ? ADMIN_API_ERRORS[errorCode] : null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-navy-900">API müşterileri</h1>
        <p className="mt-1 text-[15px] text-muted-foreground">
          Acenteler, ev sahibinin izin verdiği villaların yalnız adını ve dolu tarihlerini API ile
          okur. Fiyat, misafir, adres ve rezervasyon ayrıntısı paylaşılmaz.
        </p>
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}

      <section className={CARD} aria-labelledby="new-client">
        <h2 id="new-client" className="font-semibold text-navy-900">
          Yeni API hesabı
        </h2>
        <form
          action={createClientAction}
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
          data-testid="admin-api-create"
        >
          <div className="flex-1">
            <Field
              id="client-name"
              name="name"
              label="Acente adı"
              maxLength={100}
              required
              autoComplete="off"
              hint="Ev sahibi erişim verirken bu adı görür."
            />
          </div>
          <Button type="submit">Hesap oluştur</Button>
        </form>
      </section>

      <section
        className="rounded-2xl border border-border bg-white shadow-sm"
        data-testid="admin-api-clients"
      >
        {clients.length === 0 ? (
          <p className="p-5 text-sm text-muted-foreground">Henüz API hesabı yok.</p>
        ) : (
          <ul className="divide-y divide-border">
            {clients.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/api-musterileri/${c.id}`}
                  className="flex flex-col gap-1 px-5 py-3 hover:bg-mist/60 sm:flex-row sm:items-center sm:justify-between"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-navy-900">{c.name}</span>
                    <span className="block text-sm text-muted-foreground">
                      {c.status === "active" ? "Etkin" : "Pasif"} · {c.activeKeys} anahtar ·{" "}
                      {c.activeGrants} villa
                    </span>
                  </span>
                  <span className="flex flex-col text-sm sm:items-end">
                    <span className="text-navy-900">
                      {c.requests30d.toLocaleString("tr-TR")} istek (30 gün)
                    </span>
                    <span className="text-muted-foreground">son kullanım {ago(c.lastUsedAt)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
