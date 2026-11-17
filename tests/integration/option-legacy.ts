/**
 * Opsiyon Faz A (0075) öncesi biçimde Super Admin onayı bekleyen OLUŞTURMA kaydı fikstürü.
 *
 * 0075'ten sonra WhatsApp'tan gelen oluşturma Super Admin onayına düşmez: süre yoksa işletme /
 * sistem varsayılanı kullanılır, güvenle uygulanamayan oluşturma "açıklama bekliyor" (clarify)
 * olur. Production'da 0075 öncesinden kalan bekleyenler (needs_approval, süresiz,
 * duration_missing) ise eski onay / uygulama / ret akışıyla işlenmeye devam eder. Bu fikstür o
 * akışların test kapsamını korur: mesajdan oluşan clarify kaydını, test süper kullanıcısıyla
 * tetikleyicileri atlayarak (mod alanı tetikleyiciyle değişmez) birebir eski biçime çevirir.
 * YALNIZ testlerde kullanılır.
 */
import type { Client } from "pg";
import { expect } from "vitest";

export async function toLegacyPendingCreate(admin: Client, operationId: string): Promise<void> {
  const before = (
    await admin.query("select kind, mode, status from option_operations where id = $1", [
      operationId,
    ])
  ).rows[0];
  expect(before).toEqual({ kind: "create", mode: "clarify", status: "pending" });
  await admin.query("set session_replication_role = replica");
  try {
    await admin.query(
      `update option_operations
          set mode = 'needs_approval', reasons = '{duration_missing}', expires_in_minutes = null,
              expiry_source = null
        where id = $1`,
      [operationId],
    );
  } finally {
    await admin.query("set session_replication_role = origin");
  }
}
