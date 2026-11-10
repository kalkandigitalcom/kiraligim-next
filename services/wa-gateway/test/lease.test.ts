import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import pg from "pg";

import { LEASE_NAMESPACE, leaseKey, PgLease } from "../src/lease.ts";

/**
 * Tek kopya kilidi (PostgreSQL advisory lock). Birim testleri sahte istemciyle; gerçek
 * PostgreSQL testi yalnız WA_TEST_PG_URL tanımlıysa (yerel/geçici test veritabanı) çalışır.
 */
class FakeClient extends EventEmitter {
  static locks = new Set<string>();
  held: string | null = null;
  queries: string[] = [];
  failNext = false;
  async connect() {}
  async query<R>(text: string, values?: unknown[]): Promise<{ rows: R[] }> {
    this.queries.push(text);
    if (this.failNext) {
      this.failNext = false;
      throw new Error("bağlantı koptu");
    }
    const key = (values ?? []).join(":");
    if (text.includes("pg_try_advisory_lock")) {
      const ok = !FakeClient.locks.has(key);
      if (ok) {
        FakeClient.locks.add(key);
        this.held = key;
      }
      return { rows: [{ ok } as R] };
    }
    if (text.includes("pg_advisory_unlock") && this.held) {
      FakeClient.locks.delete(this.held);
      this.held = null;
    }
    return { rows: [] };
  }
  async end() {
    if (this.held) FakeClient.locks.delete(this.held);
    this.held = null;
    this.emit("end");
  }
}

describe("tek kopya kilidi (birim)", () => {
  it("etiket anahtarı kararlı ve 32 bit; etiketler ayrışır", () => {
    assert.equal(leaseKey("prod"), leaseKey("prod"));
    assert.notEqual(leaseKey("prod"), leaseKey("primary"));
    assert.ok(Number.isInteger(leaseKey("prod")) && Math.abs(leaseKey("prod")) <= 2 ** 31);
    assert.ok(Number.isInteger(LEASE_NAMESPACE));
  });

  it("ikinci kopya kilidi alamaz; ilki bırakınca alır", async () => {
    const clients: FakeClient[] = [];
    const make = () => {
      const c = new FakeClient();
      clients.push(c);
      return c;
    };
    const a = new PgLease(make, "prod", 60_000);
    const b = new PgLease(make, "prod", 60_000);
    assert.equal(await a.acquire(), true);
    assert.equal(await a.acquire(), true); // zaten bizde
    assert.equal(await b.acquire(), false);
    assert.equal(b.held, false);
    await a.release();
    assert.equal(await b.acquire(), true);
    await b.release();
  });

  it("eşzamanlı denemeler tek bağlantı açar ve aynı sonucu alır", async () => {
    let made = 0;
    const lease = new PgLease(
      () => {
        made += 1;
        return new FakeClient();
      },
      "prod-concurrent",
      60_000,
    );
    const results = await Promise.all([lease.acquire(), lease.acquire(), lease.acquire()]);
    assert.deepEqual(results, [true, true, true]);
    assert.equal(made, 1);
    await lease.release();
  });

  it("bırakılmış eski bir istemcinin kapanması güncel kilidi düşürmez", async () => {
    const clients: FakeClient[] = [];
    const holder = new PgLease(() => new FakeClient(), "prod-old", 60_000);
    assert.equal(await holder.acquire(), true);
    const waiter = new PgLease(
      () => {
        const c = new FakeClient();
        clients.push(c);
        return c;
      },
      "prod-old",
      60_000,
    );
    let lost = 0;
    waiter.onLost(() => (lost += 1));
    assert.equal(await waiter.acquire(), false); // ilk istemci bırakıldı
    await holder.release();
    assert.equal(await waiter.acquire(), true); // ikinci istemci kilidi tuttu
    clients[0]!.emit("end"); // eski istemcinin geç gelen kapanış olayı
    assert.equal(waiter.held, true);
    assert.equal(lost, 0);
    await waiter.release();
  });

  it("bağlantı koparsa kilit kaybı bir kez bildirilir", async () => {
    let client!: FakeClient;
    const lease = new PgLease(() => (client = new FakeClient()), "prod-2", 60_000);
    let lost = 0;
    lease.onLost(() => (lost += 1));
    await lease.acquire();
    client.emit("error", new Error("terminated"));
    client.emit("end");
    assert.equal(lost, 1);
    assert.equal(lease.held, false);
  });

  it("düzenli denetim başarısız olursa kilit kaybı bildirilir", async () => {
    let client!: FakeClient;
    const lease = new PgLease(() => (client = new FakeClient()), "prod-3", 5);
    let lost = 0;
    lease.onLost(() => (lost += 1));
    await lease.acquire();
    client.failNext = true;
    const end = Date.now() + 1_000;
    while (lost === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
    assert.equal(lost, 1);
    await lease.release();
  });
});

const PG_URL = process.env.WA_TEST_PG_URL;
describe("tek kopya kilidi (gerçek PostgreSQL)", { skip: !PG_URL }, () => {
  it("ayrıcalıksız rol kilidi alabilir; ikinci kopya alamaz; bağlantı ölünce kilit düşer", async () => {
    const label = `test-${Date.now()}`;
    const a = PgLease.fromUrl(PG_URL!, label);
    const b = PgLease.fromUrl(PG_URL!, label);
    let lost = 0;
    a.onLost(() => (lost += 1));
    assert.equal(await a.acquire(), true);
    assert.equal(await b.acquire(), false);
    // Yönetici a'nın bağlantısını sonlandırır (ör. veritabanı yeniden başladı).
    const admin = new pg.Client({ connectionString: process.env.WA_TEST_PG_ADMIN_URL ?? PG_URL });
    await admin.connect();
    await admin.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'kiraligim-wa-gateway-lease' and pid <> pg_backend_pid()",
    );
    const end = Date.now() + 5_000;
    while (lost === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    assert.equal(lost, 1);
    assert.equal(await b.acquire(), true);
    await b.release();
    await a.release();
    await admin.end();
  });
});
