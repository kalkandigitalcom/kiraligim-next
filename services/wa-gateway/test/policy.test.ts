import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DisconnectReason } from "baileys";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { authDirProblem, databaseNameProblem, loadConfig, SERVICE_DIR } from "../src/config.ts";
import {
  BAD_SESSION_WARN,
  backoffDelay,
  decideClose,
  DEFAULT_TIMING,
  isAllowedAccount,
  RateLimiter,
  REPLACED_WINDOW_MS,
  SeenSet,
  watchdogWindowMs,
} from "../src/policy.ts";

describe("kapanma kararı (Aşama 1)", () => {
  const ctx = {
    attempt: 0,
    replacedAt: [] as number[],
    badSessionStreak: 0,
    now: 1_000_000,
    rnd: 0.5,
  };
  const codes = [401, 403, 408, 411, 428, 440, 500, 503, 515, undefined, 999];

  it("hiçbir kapanma kodu oturum silme kararı vermez", () => {
    for (const c of codes) {
      const d = decideClose(c, ctx) as Record<string, unknown>;
      assert.equal("resetAuth" in d, false, String(c));
    }
  });

  it("401 ve 411: durur (needs_qr), oturum korunur", () => {
    for (const c of [DisconnectReason.loggedOut, DisconnectReason.multideviceMismatch]) {
      const d = decideClose(c, ctx);
      assert.equal(d.action, "halt");
      assert.equal(d.action === "halt" && d.state, "needs_qr");
      assert.match(d.reason, /korunuyor/);
    }
  });

  it("403: durur (blocked)", () => {
    const d = decideClose(DisconnectReason.forbidden, ctx);
    assert.deepEqual(
      [d.action, d.action === "halt" && d.state, d.code],
      ["halt", "blocked", "blocked_403"],
    );
  });

  it("500 (kodsuz 'stream errored out' dahil) DURMAZ: yeniden denenir; art arda 5'te degraded", () => {
    const d = decideClose(DisconnectReason.badSession, ctx);
    assert.equal(d.action, "reconnect");
    assert.equal(d.action === "reconnect" && d.degraded, undefined);
    const d5 = decideClose(DisconnectReason.badSession, {
      ...ctx,
      badSessionStreak: BAD_SESSION_WARN - 1,
    });
    assert.equal(d5.action === "reconnect" && d5.degraded, true);
  });

  it("440: önce 2–5 dk bekleyip dener; 30 dk içinde 3. kez durur (replaced)", () => {
    for (const rnd of [0, 0.5, 0.999]) {
      const d = decideClose(DisconnectReason.connectionReplaced, { ...ctx, rnd });
      assert.equal(d.action, "reconnect");
      const ms = d.action === "reconnect" ? d.delayMs : -1;
      assert.ok(
        ms >= DEFAULT_TIMING.replacedCooldownMinMs && ms < DEFAULT_TIMING.replacedCooldownMaxMs,
        String(ms),
      );
    }
    const now = ctx.now;
    assert.equal(decideClose(440, { ...ctx, replacedAt: [now - 60_000] }).action, "reconnect");
    const halt = decideClose(440, { ...ctx, replacedAt: [now - 60_000, now - 120_000] });
    assert.deepEqual([halt.action, halt.action === "halt" && halt.state], ["halt", "replaced"]);
    // Pencere dışındaki eski 440'lar sayılmaz.
    assert.equal(
      decideClose(440, {
        ...ctx,
        replacedAt: [now - REPLACED_WINDOW_MS - 1, now - REPLACED_WINDOW_MS - 2],
      }).action,
      "reconnect",
    );
  });

  it("515 hemen, deneme sayılmaz; 503 en az 30 sn; diğerleri jitter'lı", () => {
    assert.deepEqual(decideClose(515, { ...ctx, attempt: 7 }), {
      action: "reconnect",
      delayMs: 0,
      reason: "Yeniden başlatma istendi (515).",
      countsAttempt: false,
      code: "close_515",
    });
    for (const rnd of [0, 0.3, 0.999]) {
      const d = decideClose(503, { ...ctx, rnd });
      assert.ok(d.action === "reconnect" && d.delayMs >= DEFAULT_TIMING.unavailableBaseMs);
    }
    for (const c of [408, 428, undefined, 999]) {
      const d = decideClose(c, { ...ctx, attempt: 3, rnd: 0.999 });
      assert.ok(d.action === "reconnect" && d.delayMs <= 2_000 * 8 && d.countsAttempt, String(c));
    }
    assert.equal(decideClose(undefined, ctx).code, "close_none");
  });

  it("full jitter: [0, min(tavan, taban × 2^deneme)]", () => {
    for (let a = 0; a < 30; a++) {
      for (const r of [0, 0.25, 0.5, 0.999999, 1, -1]) {
        const d = backoffDelay(a, 2_000, 120_000, r);
        assert.ok(d >= 0 && d <= Math.min(120_000, 2_000 * 2 ** a), `${a} ${r} ${d}`);
      }
    }
    assert.equal(backoffDelay(10, 2_000, 120_000, 0.5), 60_000);
    assert.equal(backoffDelay(0, 2_000, 120_000, 0), 0);
  });

  it("watchdog penceresi: 10 → 20 → 40 → 60 dk (6 saat içindeki çıkışlara göre), en fazla 60", () => {
    const now = 100 * 3_600_000;
    assert.equal(watchdogWindowMs([], now), 10 * 60_000);
    assert.equal(watchdogWindowMs([now - 1_000], now), 20 * 60_000);
    assert.equal(watchdogWindowMs([now - 1_000, now - 2_000], now), 40 * 60_000);
    assert.equal(
      watchdogWindowMs(
        [1, 2, 3, 4, 5].map((n) => now - n * 1_000),
        now,
      ),
      60 * 60_000,
    );
    assert.equal(watchdogWindowMs([now - 7 * 3_600_000], now), 10 * 60_000);
  });
});

describe("hesap ve hız kuralları", () => {
  it("yalnız test numarası kabul edilir", () => {
    assert.equal(isAllowedAccount("905321112233:7@s.whatsapp.net", "905321112233"), true);
    assert.equal(isAllowedAccount("905329998877:7@s.whatsapp.net", "905321112233"), false);
    assert.equal(isAllowedAccount(undefined, "905321112233"), false);
  });

  it("dakikada en fazla N tepki", () => {
    const rl = new RateLimiter(2, 60_000);
    assert.equal(rl.tryTake(0), true);
    assert.equal(rl.tryTake(1), true);
    assert.equal(rl.tryTake(2), false);
    assert.equal(rl.tryTake(60_001), true);
  });

  it("aynı mesaj ikinci kez işlenmez; sınır aşılınca en eski unutulur", () => {
    const s = new SeenSet(2);
    assert.equal(s.add("a"), true);
    assert.equal(s.add("a"), false);
    s.add("b");
    s.add("c");
    assert.equal(s.add("a"), true);
  });
});

describe("yapılandırma", () => {
  const base = { WA_TEST_NUMBER: "+90 532 111 22 33" };

  it("test numarası zorunlu ve normalize edilir", () => {
    assert.throws(() => loadConfig({}, "/tmp"), /WA_ALLOWED_NUMBER/);
    const c = loadConfig(base, "/tmp/svc");
    assert.equal(c.allowedNumber, "905321112233");
    assert.equal(c.databaseUrl, null);
    assert.equal(c.testGroupJid, null);
    assert.equal(c.authDir, "/tmp/svc/.wa-auth");
    assert.equal(c.httpPort, 4010);
  });

  it("grup kimliği biçimi denetlenir", () => {
    assert.throws(
      () => loadConfig({ ...base, WA_TEST_GROUP_JID: "abc" }, "/tmp"),
      /WA_TEST_GROUP_JID/,
    );
    assert.equal(
      loadConfig({ ...base, WA_TEST_GROUP_JID: "120363025555555555@g.us" }, "/tmp").testGroupJid,
      "120363025555555555@g.us",
    );
  });
});

describe("A1 yapılandırması", () => {
  const base = { WA_ALLOWED_NUMBER: "905321112233" };

  it("WA_ALLOWED_NUMBER, WA_TEST_NUMBER'ın yerine geçer", () => {
    assert.equal(loadConfig(base, "/tmp").allowedNumber, "905321112233");
  });

  it("veritabanı tanımlıyken test grubu tepkisi kapalıdır", () => {
    const c = loadConfig(
      {
        ...base,
        WA_DATABASE_URL: "postgres://app_user:x@localhost:5433/lodging_dev",
        WA_TEST_GROUP_JID: "120363025555555555@g.us",
      },
      "/tmp",
    );
    assert.equal(c.testGroupJid, null);
    assert.equal(c.connectionLabel, "primary");
  });

  it("üretim adına benzeyen veritabanı reddedilir", () => {
    assert.match(databaseNameProblem("postgres://app_user:x@db:5432/lodging_prod") ?? "", /üretim/);
    assert.match(
      databaseNameProblem("postgres://app_user:x@db:5432/kiraligim_production") ?? "",
      /üretim/,
    );
    assert.equal(databaseNameProblem("postgres://app_user:x@localhost:5433/lodging_dev"), null);
    assert.throws(
      () => loadConfig({ ...base, WA_DATABASE_URL: "postgres://u:p@h/lodging_prod" }, "/tmp"),
      /üretim/,
    );
    assert.throws(() => loadConfig({ ...base, WA_CONNECTION_LABEL: "Ana Hat" }, "/tmp"), /LABEL/);
  });
});

describe("güvenlik sertleştirmesi", () => {
  const base = { WA_ALLOWED_NUMBER: "905321112233" };

  it("veritabanı adı _dev ile bitmeli; denetim bağlantıdan önce (loadConfig) yapılır", () => {
    for (const name of ["kiraligim", "lodging", "lodging_dev_backup", "devdb", "lodging_DEV"]) {
      assert.match(
        databaseNameProblem(`postgres://u:p@127.0.0.1:5433/${name}`) ?? "",
        /_dev/,
        name,
      );
      assert.throws(
        () =>
          loadConfig(
            { ...base, WA_DATABASE_URL: `postgres://u:p@127.0.0.1:5433/${name}` },
            "/tmp/svc",
          ),
        /_dev/,
        name,
      );
    }
    assert.match(databaseNameProblem("postgres://u:p@h/kiraligim_prod_dev") ?? "", /üretim/);
    assert.equal(databaseNameProblem("postgres://u:p@127.0.0.1:5433/kiraligim_e2e_dev"), null);
    // Hata mesajı parolayı içermez.
    assert.doesNotMatch(databaseNameProblem("postgres://u:GizliParola@h/x") ?? "", /GizliParola/);
  });

  it("WA_AUTH_DIR yalnız servis klasöründeki .wa-auth olabilir", () => {
    const svc = "/tmp/svc";
    assert.equal(
      loadConfig({ ...base, WA_AUTH_DIR: ".wa-auth-test" }, svc).authDir,
      "/tmp/svc/.wa-auth-test",
    );
    assert.equal(
      loadConfig({ ...base, WA_AUTH_DIR: "/tmp/svc/.wa-auth" }, svc).authDir,
      "/tmp/svc/.wa-auth",
    );
    for (const bad of [
      ".",
      "..",
      "/",
      "../.wa-auth",
      "src",
      "/tmp",
      ".wa-auth/..",
      "x/.wa-auth",
      "/etc/.wa-auth",
      ".wa-auth-Ana",
      "~/.wa-auth",
      "node_modules",
    ]) {
      assert.throws(() => loadConfig({ ...base, WA_AUTH_DIR: bad }, svc), /WA_AUTH_DIR/, bad);
    }
  });

  it("sembolik bağlantı olan oturum klasörü reddedilir; varsayılan servis klasörü doğru", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wa-svc-"));
    try {
      const target = fs.mkdtempSync(path.join(os.tmpdir(), "wa-target-"));
      fs.symlinkSync(target, path.join(tmp, ".wa-auth"));
      assert.match(authDirProblem(path.join(tmp, ".wa-auth"), tmp) ?? "", /sembolik/);
      assert.throws(() => loadConfig(base, tmp), /sembolik/);
      fs.rmSync(target, { recursive: true, force: true });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    assert.equal(path.basename(SERVICE_DIR), "wa-gateway");
    assert.equal(loadConfig(base).authDir, path.join(SERVICE_DIR, ".wa-auth"));
  });
});
