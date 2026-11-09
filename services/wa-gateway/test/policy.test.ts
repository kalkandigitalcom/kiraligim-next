import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DisconnectReason } from "baileys";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { authDirProblem, databaseNameProblem, loadConfig, SERVICE_DIR } from "../src/config.ts";
import { decideReconnect, isAllowedAccount, RateLimiter, SeenSet } from "../src/policy.ts";

describe("yeniden bağlanma kararı", () => {
  it("oturum kapatıldıysa durur ve anahtarları siler", () => {
    assert.deepEqual(decideReconnect(DisconnectReason.loggedOut, 0), {
      action: "stop",
      reason: "Oturum kapatıldı; yeniden QR gerekir.",
      resetAuth: true,
    });
  });

  it("aynı oturum başka yerde açıldıysa durur, anahtarlar korunur", () => {
    const d = decideReconnect(DisconnectReason.connectionReplaced, 0);
    assert.equal(d.action, "stop");
    assert.equal(d.action === "stop" && d.resetAuth, false);
  });

  it("QR sonrası yeniden başlatma hemen yapılır", () => {
    assert.deepEqual(decideReconnect(DisconnectReason.restartRequired, 3), {
      action: "reconnect",
      delayMs: 0,
      reason: "Yeniden başlatma istendi.",
    });
  });

  it("ağ kopmasında bekleme artar, 60 sn'yi geçmez", () => {
    const delays = [0, 1, 2, 3, 10].map((a) => {
      const d = decideReconnect(DisconnectReason.connectionLost, a);
      return d.action === "reconnect" ? d.delayMs : -1;
    });
    assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000, 60_000]);
    assert.equal(decideReconnect(undefined, 0).action, "reconnect");
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
