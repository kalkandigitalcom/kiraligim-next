import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { users } from "./auth";
import { workspaces } from "./tenancy";

/**
 * Denetim kaydı. Yalnız eklenir; güncellenemez ve silinemez (tetikleyici, 0006).
 * Tek istisna: kullanıcı silindiğinde actor_user_id'nin NULL yapılması (KVKK takma adlandırma).
 * Metadata yalnız src/server/audit üzerinden yazılır: hassas anahtarlar reddedilir, boyut sınırlıdır.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid().primaryKey(),
    occurredAt: timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow(),
    workspaceId: uuid().references(() => workspaces.id, { onDelete: "restrict" }),
    actorUserId: uuid().references(() => users.id, { onDelete: "set null" }),
    action: text().notNull(),
    targetType: text(),
    targetId: uuid(),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    index("audit_log_workspace_occurred_idx").on(t.workspaceId, t.occurredAt.desc()),
    index("audit_log_actor_user_id_idx").on(t.actorUserId),
    check("audit_log_action_format", sql`${t.action} ~ '^[a-z][a-z_]*(\\.[a-z][a-z_]*)+$'`),
    check("audit_log_target_type_format", sql`${t.targetType} ~ '^[a-z][a-z_]*$'`),
    check(
      "audit_log_metadata_object",
      sql`jsonb_typeof(${t.metadata}) = 'object' and pg_column_size(${t.metadata}) <= 4096`,
    ),
  ],
);
