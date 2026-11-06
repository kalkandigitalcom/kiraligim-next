import { diffSchema, getExpectedSchema } from "@better-auth/core/db/internal";
import { getAuthTables } from "better-auth/db";
import { getTableColumns, is, Table } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { authSchema } from "@/db/schema/auth";
import { buildHostAuthOptions } from "@/server/auth/host-auth";

import { offlineDb, testAuthDeps } from "./helpers/auth-deps";

/**
 * Better Auth'un yazdığı tablo/alanlar ile Drizzle şemasının birebir eşleştiğini, Better Auth'un
 * kendi tablo tanımından (getAuthTables) türeterek doğrular. Better Auth sürümü değişip yeni alan
 * eklerse bu test kırılır ve migration gerektiğini gösterir.
 */
const options = buildHostAuthOptions(testAuthDeps());
const tables = getAuthTables(options);
const schema = authSchema as Record<string, unknown>;

const snake = (s: string) => s.replace(/([a-z\d])([A-Z])/g, "$1_$2").toLowerCase();

describe("Better Auth ↔ Drizzle şeması", () => {
  it("yapılandırma beş tablo üretir; rateLimit yalnız veritabanı depolamasından gelir", () => {
    expect(Object.keys(tables).sort()).toEqual(
      ["account", "rateLimit", "session", "user", "verification"].sort(),
    );
    expect(options.rateLimit.storage).toBe("database");
    expect(tables.rateLimit?.modelName).toBe("rateLimit");
  });

  it("Better Auth'un kendi şema karşılaştırması sorun bulmaz", () => {
    const actual = Object.entries(schema)
      .filter(([, t]) => is(t, Table))
      .map(([name, t]) => ({
        name,
        columns: Object.entries(getTableColumns(t as Table)).map(([key, c]) => ({
          name: key,
          nullable: !c.notNull,
          hasDefault: c.hasDefault,
        })),
      }));
    expect(diffSchema(getExpectedSchema(options, { usePlural: true }), actual)).toEqual([]);
  });

  for (const [model, table] of Object.entries(tables)) {
    const exportName = `${table.modelName}s`;

    describe(`${model} → ${exportName}`, () => {
      const drizzleTable = schema[exportName] as Table;
      const cfg = getTableConfig(drizzleTable);
      const columns = getTableColumns(drizzleTable);

      it("SQL tablo adı çoğul snake_case", () => {
        expect(cfg.name).toBe(snake(exportName));
      });

      it("id: UUID birincil anahtar", () => {
        expect(columns.id?.columnType).toBe("PgUUID");
        expect(columns.id?.primary).toBe(true);
      });

      for (const [key, field] of Object.entries(table.fields)) {
        const name = field.fieldName || key;
        it(`${name}: tip, zorunluluk, benzersizlik, ilişki`, () => {
          const col = columns[name];
          expect(col, `${exportName}.${name} kolonu yok`).toBeDefined();
          if (!col) return;

          const expectedType = field.references
            ? "PgUUID"
            : field.type === "boolean"
              ? "PgBoolean"
              : field.type === "date"
                ? "PgTimestamp"
                : field.type === "number"
                  ? field.bigint
                    ? "PgBigInt53"
                    : "PgInteger"
                  : "PgText";
          expect(col.columnType).toBe(expectedType);
          if (col.columnType === "PgTimestamp") {
            expect((col as unknown as { withTimezone: boolean }).withTimezone).toBe(true);
          }
          expect(col.notNull).toBe(field.required !== false);

          const uniqueInDb =
            col.isUnique ||
            cfg.uniqueConstraints.some(
              (u) => u.columns.length === 1 && u.columns[0]?.name === col.name,
            );
          expect(uniqueInDb).toBe(field.unique === true);

          if (field.references) {
            const fk = cfg.foreignKeys.find((f) => f.reference().columns[0]?.name === col.name);
            expect(fk).toBeDefined();
            expect(getTableConfig(fk!.reference().foreignTable).name).toBe(
              snake(`${tables[field.references.model]!.modelName}s`),
            );
            expect(fk!.onDelete).toBe(field.references.onDelete);
          }
        });
      }

      it("Better Auth'un yazmadığı zorunlu kolon yok", () => {
        const written = new Set([
          "id",
          ...Object.values(table.fields).map(
            (f, i) => f.fieldName || Object.keys(table.fields)[i]!,
          ),
        ]);
        for (const [key, col] of Object.entries(columns)) {
          if (!written.has(key)) expect(!col.notNull || col.hasDefault, key).toBe(true);
        }
      });
    });
  }

  it("çalışma zamanında kolonlar snake_case sorgulanır (drizzle casing)", () => {
    const db = offlineDb();
    const q = db.select().from(authSchema.users).toSQL().sql;
    expect(q).toContain('"email_verified"');
    expect(q).toContain('"created_at"');
    expect(q).not.toContain('"emailVerified"');
    const r = db.select().from(authSchema.rateLimits).toSQL().sql;
    expect(r).toContain('"last_request"');
    expect(r).toContain('from "rate_limits"');
  });
});
