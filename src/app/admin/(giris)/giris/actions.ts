"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { logger } from "@/lib/logger";
import {
  beginAdminLogin,
  completeAdminLogin,
  type LoginFailure,
  pruneAdminAuth,
} from "@/server/admin/auth";
import { adminCookieNames, getAdminContext } from "@/server/admin/session";

/**
 * Super Admin girişi: 1) e-posta + şifre → kısa ömürlü adım çerezi; 2) TOTP → oturum çerezi.
 * Hatalar genel mesajla döner (hangi bilginin yanlış olduğu söylenmez).
 */
export type AdminLoginState = { error?: string; email?: string; signedIn?: boolean };

const MESSAGES: Record<LoginFailure, string> = {
  invalid: "Bilgiler hatalı. Yeniden deneyin.",
  locked: "Çok fazla hatalı deneme. 15 dakika sonra yeniden deneyin.",
  expired: "Giriş adımının süresi doldu. Yeniden giriş yapın.",
};
const UNAVAILABLE = "Yönetim paneli bu ortamda yapılandırılmamış.";

const text = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v : "";
};

export async function adminLoginAction(
  _prev: AdminLoginState,
  fd: FormData,
): Promise<AdminLoginState> {
  const ctx = getAdminContext();
  if (!ctx) return { error: UNAVAILABLE };
  const email = text(fd, "email").slice(0, 254);
  const password = text(fd, "password").slice(0, 256);
  if (!email || !password) return { error: "E-posta ve şifre girin.", email };
  let r;
  try {
    await pruneAdminAuth(ctx.db);
    r = await beginAdminLogin(ctx.db, { email, password });
  } catch (err) {
    logger.error("admin_login_error", { err });
    return { error: "Giriş şu an yapılamıyor. Biraz sonra yeniden deneyin.", email };
  }
  // React form sıfırlansa da e-posta korunur (şifre korunmaz).
  if (!r.ok) return { error: MESSAGES[r.reason], email };
  const jar = await cookies();
  jar.set(adminCookieNames(ctx.config.secureCookies).step, r.challengeToken, {
    httpOnly: true,
    secure: ctx.config.secureCookies,
    sameSite: "strict",
    path: "/",
    maxAge: 5 * 60,
  });
  redirect("/giris/dogrulama");
}

export async function adminVerifyAction(
  _prev: AdminLoginState,
  fd: FormData,
): Promise<AdminLoginState> {
  const ctx = getAdminContext();
  if (!ctx) return { error: UNAVAILABLE };
  const names = adminCookieNames(ctx.config.secureCookies);
  const jar = await cookies();
  const step = jar.get(names.step)?.value ?? "";
  let r;
  try {
    r = await completeAdminLogin(
      ctx.db,
      { challengeToken: step, code: text(fd, "code").slice(0, 16) },
      ctx.config.key,
    );
  } catch (err) {
    logger.error("admin_verify_error", { err });
    return { error: "Giriş şu an yapılamıyor. Biraz sonra yeniden deneyin." };
  }
  if (!r.ok) {
    if (r.reason !== "invalid") {
      jar.delete(names.step);
      redirect(`/giris?durum=${r.reason === "locked" ? "kilitli" : "sure-doldu"}`);
    }
    return { error: "Kod hatalı. Uygulamadaki güncel 6 haneli kodu girin." };
  }
  jar.delete(names.step);
  jar.set(names.session, r.sessionToken, {
    httpOnly: true,
    secure: ctx.config.secureCookies,
    sameSite: "strict",
    path: "/",
    expires: r.expiresAt,
  });
  // Ana sayfaya tam sayfa geçiş istemcide yapılır (yeni çerezle, yüzey yönlendirmesinden geçerek).
  return { signedIn: true };
}
