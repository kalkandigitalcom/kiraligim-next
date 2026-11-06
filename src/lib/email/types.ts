export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Aynı iletinin iki kez gönderilmesini önler (Resend Idempotency-Key). */
  idempotencyKey?: string;
  /** Yalnız log/izleme için: "auth.verify-email" gibi. İçerik değildir. */
  category: string;
};

export type EmailTransport = {
  readonly name: "resend" | "log" | "memory";
  send(message: EmailMessage): Promise<{ id: string | null }>;
};
