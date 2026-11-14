/**
 * docs/precheck-0063.sql: production konteynerine yapıştırılan komutların taşıdığı sorgu
 * (gzip + base64), dosyadaki sorgu bölümüyle birebir aynı olmalı ve salt okuma kalmalı.
 */
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

const file = fs.readFileSync(path.resolve(__dirname, "../../docs/precheck-0063.sql"), "utf8");
// Sorgu bölümü: satır BAŞINDAKİ "BEGIN TRANSACTION READ ONLY;" ile başlar (başlıktaki anılar yorumdur).
const query = file.slice(file.search(/^BEGIN TRANSACTION READ ONLY;$/m));
const commands = file.split("\n").filter((l) => l.startsWith("-- echo '"));
const payloadOf = (line: string) => /^-- echo '([A-Za-z0-9+/=]+)'/.exec(line)?.[1] ?? "";

describe("precheck-0063", () => {
  it("iki komut var (görüntüle, çalıştır) ve aynı yükü taşıyor", () => {
    expect(commands).toHaveLength(2);
    expect(payloadOf(commands[0]!)).not.toBe("");
    expect(payloadOf(commands[0]!)).toBe(payloadOf(commands[1]!));
  });

  it("taşınan sorgu dosyadaki sorgu bölümünün aynısı", () => {
    const decoded = gunzipSync(Buffer.from(payloadOf(commands[1]!), "base64")).toString("utf8");
    expect(decoded).toBe(query);
  });

  it("salt okuma: oturum ve işlem salt okuma, yalnız SELECT, sonunda ROLLBACK", () => {
    expect(commands[1]).toContain("PGOPTIONS='-c default_transaction_read_only=on'");
    expect(commands[1]).toContain("-v ON_ERROR_STOP=1");
    expect(commands[1]).not.toMatch(/>\s*\/|tee\s/);
    expect(query.trimEnd().endsWith("ROLLBACK;")).toBe(true);
    const sql = query.replace(/--.*$/gm, "");
    expect(sql).not.toMatch(
      /\b(insert|update|delete|alter|create|drop|truncate|grant|revoke|commit)\b/i,
    );
  });

  it("komutlar terminale tek satırda sığar", () => {
    for (const c of commands) expect(c.length).toBeLessThan(2000);
  });
});
