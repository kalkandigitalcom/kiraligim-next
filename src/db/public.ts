import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type { Tx } from "./tenant";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PublicDb = NodePgDatabase<any>;

/**
 * Oturumsuz (public) okuma bağlamı: app_user bağlantısında, kullanıcı ve işletme ayarı OLMADAN,
 * SALT OKUNUR bir transaction. Bu bağlamda RLS hiçbir tenant satırını göstermez; veriye yalnız
 * drizzle/0024'teki app_public_villa* fonksiyonlarıyla (sabit kolon listeleri) erişilir.
 * Yazma denemesi veritabanında reddedilir (read only transaction).
 */
export async function withPublicRead<T>(db: PublicDb, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(
    async (tx) => {
      // Havuzdaki bağlantıda önceki bir işlemden kalmış bağlam olamaz (set_config(..., true)
      // transaction'a özeldir); yine de açıkça boşaltılır.
      await tx.execute(sql`select set_config('app.user_id', '', true),
                                  set_config('app.workspace_id', '', true)`);
      return fn(tx);
    },
    { accessMode: "read only" },
  );
}
