import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { z } from "zod";

import type { Tx } from "@/db/tenant";
import { AppError } from "@/lib/errors";

/**
 * Denetim kaydı yazımı. Kurallar:
 *  - Yalnız aşağıda tanımlı işlem türleri yazılabilir; her türün metadata şeması sabittir (strict).
 *  - İşlemi yapan (actor) ve workspace, istemciden değil transaction bağlamından alınır
 *    (app_current_user_id / app_current_workspace_id) — başkası adına kayıt yazılamaz.
 *  - Hassas anahtar adları (parola, belirteç, e-posta, telefon, TC kimlik, kart, IP...) reddedilir;
 *    ad-soyad, e-posta gibi kişisel bilgi metadata'ya yazılmaz, yalnız kimlikler (UUID) yazılır.
 *  - Metadata en fazla 2 KB (veritabanı sınırı 4 KB).
 *  - Kayıt değiştirilemez ve silinemez (veritabanı tetikleyicisi).
 */

const role = z.enum(["owner", "manager", "staff"]);
const slug = z.string().max(48);

export const AUDIT_ACTIONS = {
  "workspace.created": z.strictObject({ slug }),
  "workspace.updated": z.strictObject({ fields: z.array(z.enum(["name", "slug"])).min(1) }),
  "workspace.member_added": z.strictObject({ role }),
  "workspace.member_role_changed": z.strictObject({ from: role, to: role }),
  "workspace.member_removed": z.strictObject({ role }),
} as const;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

export type AuditEntry<A extends AuditAction = AuditAction> = {
  action: A;
  targetType?: "workspace" | "workspace_member" | "user";
  targetId?: string;
  metadata: z.input<(typeof AUDIT_ACTIONS)[A]>;
};

const SENSITIVE_KEY =
  /pass(word)?|secret|token|cookie|auth|api[-_]?key|e-?mail|phone|telefon|tc_?kimlik|identity|passport|iban|card|kart|ip_?address|^ip$|user_?agent|name$|^ad$|soyad/i;
const MAX_METADATA_BYTES = 2048;

function findSensitiveKey(value: unknown, path = ""): string | null {
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) {
      const hit = findSensitiveKey(v, `${path}[${i}]`);
      if (hit) return hit;
    }
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(k)) return `${path}${path ? "." : ""}${k}`;
      const hit = findSensitiveKey(v, `${path}${path ? "." : ""}${k}`);
      if (hit) return hit;
    }
  }
  return null;
}

/** Yazmadan önceki doğrulama (birim testlerinde ayrıca sınanır). */
export function validateAuditEntry(entry: AuditEntry): Record<string, unknown> {
  const schema = AUDIT_ACTIONS[entry.action];
  if (!schema)
    throw new AppError("INTERNAL", `Bilinmeyen denetim işlemi: ${entry.action}`, { expose: false });
  const sensitive = findSensitiveKey(entry.metadata);
  if (sensitive) {
    throw new AppError("INTERNAL", `Denetim metadata'sında hassas alan: ${sensitive}`, {
      expose: false,
    });
  }
  const parsed = schema.safeParse(entry.metadata);
  if (!parsed.success) {
    throw new AppError("INTERNAL", `Denetim metadata'sı geçersiz: ${entry.action}`, {
      expose: false,
    });
  }
  const metadata = parsed.data as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > MAX_METADATA_BYTES) {
    throw new AppError("INTERNAL", "Denetim metadata'sı çok büyük", { expose: false });
  }
  return metadata;
}

/**
 * Bağlamdaki transaction'a denetim kaydı ekler. withTenant içinde çağrılırsa workspace'e,
 * withUser içinde (workspace bağlamı yokken) çağrılırsa workspace'siz kayıt olur.
 */
export async function recordAudit(tx: Tx, entry: AuditEntry): Promise<string> {
  const metadata = validateAuditEntry(entry);
  const id = uuidv7();
  await tx.execute(sql`
    insert into audit_log (id, workspace_id, actor_user_id, action, target_type, target_id, metadata)
    values (${id}, app_current_workspace_id(), app_current_user_id(), ${entry.action},
            ${entry.targetType ?? null}, ${entry.targetId ?? null}, ${JSON.stringify(metadata)}::jsonb)`);
  return id;
}
