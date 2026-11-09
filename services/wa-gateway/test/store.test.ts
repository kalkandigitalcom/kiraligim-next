import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createPool, type Queryable, WaStore } from "../src/store.ts";

function fakeDb(results: Record<string, Record<string, unknown>>) {
  const calls: { text: string; values: unknown[] }[] = [];
  const db: Queryable = {
    async query<R extends Record<string, unknown>>(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      const fn = /public\.(app_wa_[a-z_]+)/.exec(text)?.[1] ?? "";
      return { rows: [results[fn] ?? {}] as R[] };
    },
  };
  return { db, calls };
}

describe("veritabanı erişimi yalnız A1 fonksiyonlarıyla", () => {
  it("her çağrı yalnız app_wa_* fonksiyonuna parametreli gider", async () => {
    const { db, calls } = fakeDb({
      app_wa_heartbeat: { id: "c1" },
      app_wa_sync_group: { status: "discovered" },
      app_wa_verify_phone: { out: "verified" },
      app_wa_ingest_message: { out: "stored" },
      app_wa_purge_messages: { n: 3 },
    });
    const s = new WaStore(db, "primary");
    assert.equal(await s.heartbeat("open", null, "905321112233"), "c1");
    assert.equal(
      await s.syncGroup({
        jid: "120363025555555555@g.us",
        subject: "x",
        participants: 2,
        botIsAdmin: false,
        adminsOnly: false,
        present: true,
        addedByPn: "905329998877",
      }),
      "discovered",
    );
    assert.equal(await s.verifyPhone("7Q4M2XKD", "905321112233"), "verified");
    assert.equal(
      await s.ingest({
        groupJid: "120363025555555555@g.us",
        messageId: "M1",
        senderJid: "905321112233@s.whatsapp.net",
        senderPn: "905321112233",
        senderLid: null,
        body: "'; drop table x; --",
        sentAt: "2026-11-09T10:00:00.000Z",
        kind: "live",
      }),
      "stored",
    );
    assert.equal(await s.purge(90), 3);
    for (const c of calls) {
      assert.match(c.text, /^select public\.app_wa_[a-z_]+\((\$\d+(, )?)*\) as [a-z]+$/);
      assert.ok(!c.text.includes("drop"), "değerler SQL metnine girmez");
    }
    assert.equal(calls[1]!.values[0], "c1", "bağlantı kimliği heartbeat'ten");
    assert.deepEqual(calls[0]!.values, ["primary", "open", null, "905321112233"]);
    assert.equal(calls[1]!.values.length, 9);
    assert.deepEqual(calls[1]!.values.slice(7), ["905329998877", null], "ekleyen ve kurucu");
    assert.ok(!calls.some((c) => c.text.includes("redeem")), "gruba yazılan kod artık işlenmez");
  });

  it("üretim adına benzeyen veritabanına havuz açılmaz", () => {
    assert.throws(() => createPool("postgres://app_user:x@db:5432/lodging_prod"), /üretim/);
  });
});
