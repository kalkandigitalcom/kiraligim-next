import { describe, expect, it } from "vitest";

import { createJobQueue, QueueBusyError } from "@/server/media/queue";

const deferred = <T = void>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("görsel işleme kuyruğu", () => {
  it("aynı anda en fazla 1 iş çalışır; sıra korunur", async () => {
    const q = createJobQueue(1, 3);
    const order: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const job = (name: string, d: { promise: Promise<void> }) => async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      order.push(`start:${name}`);
      await d.promise;
      running--;
      order.push(`end:${name}`);
      return name;
    };
    const [a, b, c] = [deferred(), deferred(), deferred()];
    const pa = q.run(job("a", a));
    const pb = q.run(job("b", b));
    const pc = q.run(job("c", c));
    expect([q.active, q.waiting]).toEqual([1, 2]);
    a.resolve();
    b.resolve();
    c.resolve();
    expect(await Promise.all([pa, pb, pc])).toEqual(["a", "b", "c"]);
    expect(maxRunning).toBe(1);
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
    expect([q.active, q.waiting]).toEqual([0, 0]);
  });

  it("bekleme sırası doluysa yeni iş hemen reddedilir (bellek taşmaz)", async () => {
    const q = createJobQueue(1, 2);
    const gate = deferred();
    const jobs = [0, 1, 2].map(() => q.run(() => gate.promise));
    await expect(q.run(async () => "fazla")).rejects.toBeInstanceOf(QueueBusyError);
    gate.resolve();
    await Promise.all(jobs);
    await expect(q.run(async () => "tekrar")).resolves.toBe("tekrar");
  });

  it("hata veren iş kuyruğu kilitlemez", async () => {
    const q = createJobQueue(1, 3);
    await expect(
      q.run(async () => {
        throw new Error("işleme hatası");
      }),
    ).rejects.toThrow("işleme hatası");
    await expect(q.run(async () => 42)).resolves.toBe(42);
    expect(q.active).toBe(0);
  });
});
