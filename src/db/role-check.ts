import type { Pool, PoolClient } from "pg";

/**
 * Uygulamanın bağlandığı PostgreSQL rolünün güvenli olup olmadığını denetler.
 * Web uygulaması (app_user) şunlara SAHİP OLMAMALI:
 *   - süper kullanıcı veya BYPASSRLS (RLS'i yok sayar → tenant izolasyonu çöker)
 *   - CREATEROLE / CREATEDB
 *   - veritabanı veya public şema sahipliği, public şemada CREATE yetkisi
 *   - herhangi bir tablonun sahipliği (sahip, FORCE yoksa RLS'ten muaf olur ve RLS'i kapatabilir)
 */

export type DbRoleFinding =
  | "superuser"
  | "bypassrls"
  | "createrole"
  | "createdb"
  | "owns_database"
  | "owns_schema"
  | "can_create_in_schema"
  | "owns_tables";

export type DbRoleReport = {
  role: string;
  safe: boolean;
  findings: DbRoleFinding[];
};

const QUERY = `
  select
    r.rolname                                                   as role,
    r.rolsuper                                                  as superuser,
    r.rolbypassrls                                              as bypassrls,
    r.rolcreaterole                                             as createrole,
    r.rolcreatedb                                               as createdb,
    (select d.datdba = r.oid from pg_database d where d.datname = current_database()) as owns_database,
    (select n.nspowner = r.oid from pg_namespace n where n.nspname = 'public')        as owns_schema,
    has_schema_privilege(current_user, 'public', 'CREATE')       as can_create_in_schema,
    (select count(*)::int from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where c.relowner = r.oid
        and c.relkind in ('r', 'p', 'v', 'm', 'f')
        and n.nspname not in ('pg_catalog', 'information_schema')
        and n.nspname not like 'pg_toast%')                     as owned_tables
  from pg_roles r
  where r.rolname = current_user
`;

type Row = {
  role: string;
  superuser: boolean;
  bypassrls: boolean;
  createrole: boolean;
  createdb: boolean;
  owns_database: boolean | null;
  owns_schema: boolean | null;
  can_create_in_schema: boolean;
  owned_tables: number;
};

export async function inspectDbRole(db: Pool | PoolClient): Promise<DbRoleReport> {
  const { rows } = await db.query<Row>(QUERY);
  const r = rows[0];
  if (!r) throw new Error("Rol bilgisi okunamadı");

  const findings: DbRoleFinding[] = [];
  if (r.superuser) findings.push("superuser");
  if (r.bypassrls) findings.push("bypassrls");
  if (r.createrole) findings.push("createrole");
  if (r.createdb) findings.push("createdb");
  if (r.owns_database) findings.push("owns_database");
  if (r.owns_schema) findings.push("owns_schema");
  if (r.can_create_in_schema) findings.push("can_create_in_schema");
  if (r.owned_tables > 0) findings.push("owns_tables");

  return { role: r.role, safe: findings.length === 0, findings };
}
