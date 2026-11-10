/**
 * WhatsApp Asistanı — A2b: öneri villasının çözülmesi (saf fonksiyon).
 *
 * Veritabanına veya ağa erişmez; villa listesi ve (ileride) takma adlar çağırandan gelir. Worker,
 * mesajın işletmesine ait AKTİF villaları (app_wa_message_context) ve grubun villasını verir.
 * Pasif villa listede yoktur; mesajda adı geçerse "villa bulunamadı" sayılır.
 *
 * Eşleştirme sırası (her basamakta birden çok aday varsa otomatik seçim YAPILMAZ):
 *   1. Tam ad: villa adı veya takma adı ("Mavi" → "Villa Mavi", takma ad "Kalamar" → "Villa Deniz").
 *   2. Tekil ilk sözcük: tek sözcüklü ad, yalnız bir villanın adının ilk sözcüğü
 *      ("Zeytin" → "Villa Zeytin Evi").
 *   3. Baş sözcükler: çok sözcüklü ad, villa adının baş sözcükleri ("Zeytin Bahçe" → "Villa Zeytin
 *      Bahçe Evi").
 * Yazım hatası tahmin edilmez ("Lavnta" eşleşmez). Türkçe harfler ve büyük/küçük harf katlanır
 * (villaKey).
 *
 * GRUP VİLLASI KESİN KAYNAKTIR (A2e iş kuralı): grup panelde bir villaya bağlıysa öneri HER ZAMAN
 * o villaya aittir (ad grubun villasını anlatıyorsa "named", aksi hâlde "single"); mesajda yazan ad (grup adı, takma ad, yazım farkı ya da başka bir
 * villanın adı) villayı değiştirmez. Yazan ad grubun villasının adıyla eşleşmiyorsa yalnız bilgi
 * veren "villa_name_mismatch" bayrağı eklenir (panelde gösterilir; onayı engellemez). Grubun
 * villası aktif değilse (pasif/silinmiş) ada göre başka villa ARANMAZ: "villa_not_found".
 *
 * Ada göre eşleştirme (aşağıdaki basamaklar) yalnız grup bir villaya bağlı DEĞİLKEN yapılır
 * (birden çok villanın konuşulduğu grup). Böyle gruplar otomatik işleme hiçbir zaman girmez.
 */
import { type VillaResolution, type WaCalendarItem, villaKey } from "@/lib/wa-calendar-parse";
import { WA_PROPOSAL_LIMITS } from "@/lib/whatsapp-meta";

/** Mesajın işletmesine ait aktif bir villa. */
export type ResolverVilla = {
  id: string;
  workspaceId: string;
  name: string;
  /** Villaya doğrudan bağlı takma adlar (isteğe bağlı). */
  aliases?: readonly string[];
};

/** Takma ad kaydı (A3'te panelden yönetilecek tablo satırının biçimi). Villa başına birden çok. */
export type VillaAlias = { propertyId: string; alias: string };

export type ResolveContext = {
  /** Mesajın işletmesi: listedeki tüm villalar bu işletmeye ait olmalı. */
  workspaceId: string;
  /** İşletmenin AKTİF villaları. */
  villas: readonly ResolverVilla[];
  /** Mesajın geldiği grubun villası; grup bir villaya bağlı değilse null. */
  groupPropertyId: string | null;
  /** Ek takma adlar; listede olmayan (pasif ya da başka işletmenin) villaya ait olanlar yok sayılır. */
  aliases?: readonly VillaAlias[];
};

/** Çözümleyicinin öneriye eklediği bayraklar (ayrıştırıcı bayraklarından ayrı tutulur). */
export const WA_VILLA_SERVER_FLAGS = [
  "villa_outside_group",
  "villa_not_found",
  /** Bilgi: mesajda yazan ad grubun villasının adı değil; grup eşleştirmesi esas alındı. */
  "villa_name_mismatch",
] as const;
export type WaVillaServerFlag = (typeof WA_VILLA_SERVER_FLAGS)[number];

export type VillaMatchTier = "exact" | "alias" | "first_word" | "prefix" | "group_default";

export type VillaResolutionResult = {
  resolution: VillaResolution;
  /** Yalnız named/single için dolu. */
  propertyId: string | null;
  /** Yalnız ambiguous için: aday villalar (grubun villası önce, sonra ada göre). */
  candidateIds: string[];
  /** Eşleşmenin hangi basamakta bulunduğu (ambiguous için adayların bulunduğu basamak). */
  tier: VillaMatchTier | null;
  serverFlags: WaVillaServerFlag[];
};

/** Tek başına villa adı olamayacak genel sözcükler ("ev", "konak"…). */
const GENERIC_WORDS: ReadonlySet<string> = new Set([
  "ev",
  "evi",
  "konak",
  "konagi",
  "apart",
  "apartman",
  "daire",
  "dairesi",
  "bungalov",
  "bungalow",
  "suit",
  "suite",
  "mulk",
  "tesis",
]);

export class VillaWorkspaceMismatchError extends Error {
  constructor() {
    super("wa_villa_workspace_mismatch");
    this.name = "VillaWorkspaceMismatchError";
  }
}

type Indexed = { id: string; name: string; nameKey: string; aliasKeys: Set<string> };

function index(ctx: ResolveContext): Indexed[] {
  const byId = new Map<string, Indexed>();
  for (const v of ctx.villas) {
    // Başka işletmenin villası listeye girmişse bu bir programlama hatasıdır: sessizce eşlemek
    // yerine durulur (işletme izolasyonu).
    if (v.workspaceId !== ctx.workspaceId) throw new VillaWorkspaceMismatchError();
    const entry = byId.get(v.id) ?? {
      id: v.id,
      name: v.name,
      nameKey: villaKey(v.name),
      aliasKeys: new Set<string>(),
    };
    for (const a of v.aliases ?? []) addAlias(entry, a);
    byId.set(v.id, entry);
  }
  for (const a of ctx.aliases ?? []) {
    const entry = byId.get(a.propertyId);
    if (entry) addAlias(entry, a.alias);
  }
  return [...byId.values()];
}

function addAlias(entry: Indexed, alias: string) {
  const key = villaKey(alias);
  if (key && !isGeneric(key)) entry.aliasKeys.add(key);
}

function isGeneric(key: string): boolean {
  return key.split(" ").every((w) => GENERIC_WORDS.has(w));
}

function result(
  resolution: VillaResolution,
  propertyId: string | null,
  tier: VillaMatchTier | null,
  serverFlags: WaVillaServerFlag[] = [],
  candidateIds: string[] = [],
): VillaResolutionResult {
  return { resolution, propertyId, candidateIds, tier, serverFlags };
}

const collator = new Intl.Collator("tr", { sensitivity: "base" });

/**
 * Bir ayrıştırıcı önerisinin villasını işletmenin aktif villalarına çözer. Saf: aynı girdi her
 * zaman aynı sonucu verir; dönen kimlikler yalnız ctx.villas içinden gelir.
 */
export function resolveProposal(
  item: Pick<WaCalendarItem, "villaName" | "flags">,
  ctx: ResolveContext,
): VillaResolutionResult {
  const villas = index(ctx);
  const group = ctx.groupPropertyId
    ? (villas.find((v) => v.id === ctx.groupPropertyId) ?? null)
    : null;

  // Ayrıştırıcı hangi villanın hangi aralığa ait olduğunu bilemedi: hiçbir villa seçilmez.
  if (item.flags.includes("villa_ambiguous")) return result("ambiguous", null, null);

  const raw = item.villaName?.trim() ?? "";
  // Grup bir villaya bağlı: grup eşleştirmesi kesin kaynaktır (yazılan ad villayı değiştirmez).
  if (ctx.groupPropertyId) {
    // Grubun villası aktif değil (pasif veya silinmiş): başka villa aranmaz.
    if (!group) return result("none", null, null, ["villa_not_found"]);
    const rawKey = raw ? villaKey(raw) : "";
    // Ad yok (veya yalnız genel sözcük): grubun villası varsayılan.
    if (!rawKey || isGeneric(rawKey)) return result("single", group.id, "group_default");
    // Ad grubun villasını anlatıyor: "named" (aynı villa; grup dışı değil).
    if (group.nameKey === rawKey) return result("named", group.id, "exact");
    if (group.aliasKeys.has(rawKey)) return result("named", group.id, "alias");
    if (namePrefixMatches(group, rawKey)) {
      return result("named", group.id, rawKey.includes(" ") ? "prefix" : "first_word");
    }
    // Ad başka (grubun adı, başka villa, yazım farkı): grup eşleştirmesi kazanır; bilgi bayrağı.
    return result("single", group.id, "group_default", ["villa_name_mismatch"]);
  }

  if (!raw) return result("none", null, null);

  const key = villaKey(raw);
  if (!key || isGeneric(key)) return result("none", null, null, ["villa_not_found"]);

  const finish = (matches: Indexed[], tier: VillaMatchTier): VillaResolutionResult => {
    if (matches.length === 1) {
      const id = matches[0]!.id;
      const outside = ctx.groupPropertyId !== null && id !== ctx.groupPropertyId;
      return result("named", id, tier, outside ? ["villa_outside_group"] : []);
    }
    const ids = matches
      .slice()
      .sort((a, b) => {
        if (a.id === ctx.groupPropertyId) return -1;
        if (b.id === ctx.groupPropertyId) return 1;
        return collator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      })
      .map((v) => v.id)
      .slice(0, WA_PROPOSAL_LIMITS.arrayMax);
    return result("ambiguous", null, tier, [], ids);
  };

  // 1. Tam ad (villa adı veya takma ad). Ad ve takma ad birlikte değerlendirilir: aynı anahtar
  //    iki villaya çıkıyorsa (biri adıyla, öteki takma adıyla) seçim yapılmaz.
  const byName = villas.filter((v) => v.nameKey === key);
  const byAlias = villas.filter((v) => v.nameKey !== key && v.aliasKeys.has(key));
  if (byName.length + byAlias.length > 0) {
    return finish([...byName, ...byAlias], byName.length > 0 ? "exact" : "alias");
  }

  const words = key.split(" ");
  if (words.length === 1) {
    // 2. Tekil ilk sözcük: yalnız çok sözcüklü villa adlarının ilk sözcüğüyle.
    const w = words[0]!;
    if (GENERIC_WORDS.has(w)) return result("none", null, null, ["villa_not_found"]);
    const m = villas.filter((v) => {
      const vw = v.nameKey.split(" ");
      return vw.length > 1 && vw[0] === w;
    });
    if (m.length > 0) return finish(m, "first_word");
  } else {
    // 3. Adın baş sözcükleri.
    const m = villas.filter((v) => v.nameKey.startsWith(`${key} `));
    if (m.length > 0) return finish(m, "prefix");
  }

  return result("none", null, null, ["villa_not_found"]);
}

/** Yazılan ad grubun villasını ilk sözcüğüyle veya baş sözcükleriyle anlatıyor mu (bilgi bayrağı için). */
function namePrefixMatches(v: Indexed, key: string): boolean {
  const words = key.split(" ");
  if (words.length === 1) {
    const vw = v.nameKey.split(" ");
    return vw.length > 1 && vw[0] === words[0];
  }
  return v.nameKey.startsWith(`${key} `);
}

/** resolveProposal sonucunu reviewRequirement bağlamının villa alanlarına çevirir. */
export function villaReviewContext(r: VillaResolutionResult): {
  villa: VillaResolution;
  villaOutsideGroup: boolean;
} {
  return { villa: r.resolution, villaOutsideGroup: r.serverFlags.includes("villa_outside_group") };
}
