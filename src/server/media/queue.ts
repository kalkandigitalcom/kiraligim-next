import "server-only";

/**
 * Süreç içi iş kuyruğu: aynı anda en fazla `concurrency` görsel işlenir, en fazla `maxWaiting`
 * istek bekler; fazlası hemen reddedilir (bellek taşmasını önler, kullanıcı tekrar dener).
 * Sunucu 3.7 GB RAM ve swap'sız olduğu için varsayılan: 1 eşzamanlı, 3 bekleyen.
 */
export class QueueBusyError extends Error {
  constructor() {
    super("Sunucu şu an başka fotoğrafları işliyor. Lütfen birkaç saniye sonra tekrar deneyin.");
    this.name = "QueueBusyError";
  }
}

export function createJobQueue(concurrency = 1, maxWaiting = 3) {
  let active = 0;
  const waiting: (() => void)[] = [];

  const next = () => {
    if (active >= concurrency) return;
    const start = waiting.shift();
    if (start) {
      active++;
      start();
    }
  };

  return {
    get active() {
      return active;
    },
    get waiting() {
      return waiting.length;
    },
    run<T>(job: () => Promise<T>): Promise<T> {
      if (active >= concurrency && waiting.length >= maxWaiting) {
        return Promise.reject(new QueueBusyError());
      }
      return new Promise<T>((resolve, reject) => {
        waiting.push(() => {
          job()
            .then(resolve, reject)
            .finally(() => {
              active--;
              next();
            });
        });
        next();
      });
    },
  };
}

/** Uygulama genelinde tek görsel işleme kuyruğu. */
export const imageQueue = createJobQueue(1, 3);
