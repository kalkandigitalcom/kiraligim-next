"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";

import { Alert } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { useHydrated } from "@/components/ui/use-hydrated";
import {
  formatMb,
  isAcceptedPhotoFile,
  PHOTO_ACCEPT,
  PHOTO_LIMITS,
  PHOTO_MIME_TYPES,
} from "@/lib/photo-meta";
import { isPermutationOf } from "@/lib/photo-order";
import { cn } from "@/lib/utils";

import {
  deletePhotoAction,
  movePhotoAction,
  reorderPhotosAction,
  setCoverPhotoAction,
} from "./actions";
import { usePhotoDrag } from "./use-photo-drag";

export type ManagerPhoto = {
  id: string;
  isCover: boolean;
  width: number;
  height: number;
  sources: { src: string; thumb: string; large: string; srcSet: string } | null;
};

type Props = {
  propertyId: string;
  propertyName: string;
  photos: ManagerPhoto[];
  canManage: boolean;
  storageReady: boolean;
};

type UploadItem = {
  key: string;
  name: string;
  size: number;
  status: "waiting" | "uploading" | "processing" | "done" | "error";
  progress: number;
  message?: string;
};

const LIMIT = PHOTO_LIMITS.perProperty;

type UploadResult = { ok: true } | { ok: false; message: string; retryAfter?: number };

/** Ham dosya baytlarıyla tek yükleme (XHR: ilerleme bilgisi için). Dosya adı gönderilmez. */
function uploadOne(
  propertyId: string,
  file: File,
  onProgress: (fraction: number) => void,
): Promise<UploadResult> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/mulkler/${encodeURIComponent(propertyId)}/fotograflar`);
    xhr.setRequestHeader(
      "content-type",
      (PHOTO_MIME_TYPES as readonly string[]).includes(file.type)
        ? file.type
        : "application/octet-stream",
    );
    xhr.responseType = "json";
    xhr.timeout = 180_000;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      const body = (xhr.response ?? {}) as { ok?: boolean; code?: string; message?: string };
      if (xhr.status === 201 && body.ok) return resolve({ ok: true });
      const retry = Number(xhr.getResponseHeader("retry-after"));
      resolve({
        ok: false,
        message: body.message ?? "Fotoğraf yüklenemedi. Lütfen tekrar deneyin.",
        ...(body.code === "BUSY" && Number.isFinite(retry) ? { retryAfter: retry } : {}),
      });
    };
    xhr.onerror = () =>
      resolve({ ok: false, message: "Bağlantı hatası. İnternet bağlantınızı kontrol edin." });
    xhr.ontimeout = () => resolve({ ok: false, message: "Yükleme zaman aşımına uğradı." });
    xhr.send(file);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function PhotoManager({ propertyId, propertyName, photos, canManage, storageReady }: Props) {
  const router = useRouter();
  const hydrated = useHydrated();
  const inputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState<{ tone: "error" | "info"; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busyPhoto, setBusyPhoto] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const [dragging, setDragging] = useState(false);
  // Sürükle-bırak sonrası, sunucudan yeni liste gelene kadar gösterilen sıra (iyimser).
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const propIds = photos.map((p) => p.id);
  const baseOrder = pendingOrder && isPermutationOf(pendingOrder, propIds) ? pendingOrder : propIds;
  const byId = new Map(photos.map((p) => [p.id, p]));

  const { drag, listRef, onPointerDown } = usePhotoDrag({
    ids: baseOrder,
    enabled:
      canManage && hydrated && busyPhoto === null && confirmDelete === null && photos.length > 1,
    onAnnounce: setAnnouncement,
    onDrop: (order, movedId) => void saveOrder(order, movedId),
  });
  const shown = (drag?.order ?? baseOrder)
    .map((id) => byId.get(id))
    .filter((p): p is ManagerPhoto => p !== undefined);

  const count = photos.length;
  const remaining = Math.max(0, LIMIT - count);
  const full = remaining === 0;
  const canUpload = canManage && storageReady && !full && !uploading && hydrated;

  const patch = (key: string, p: Partial<UploadItem>) =>
    setItems((list) => list.map((i) => (i.key === key ? { ...i, ...p } : i)));

  async function startUpload(fileList: FileList | File[]) {
    if (!canUpload) return;
    setNotice(null);
    const files = Array.from(fileList);
    const rejected: string[] = [];
    const accepted: File[] = [];
    for (const f of files) {
      if (!isAcceptedPhotoFile(f)) rejected.push(`${f.name}: desteklenmeyen biçim`);
      else if (f.size > PHOTO_LIMITS.maxInputBytes)
        rejected.push(
          `${f.name}: ${formatMb(f.size)} (en fazla ${formatMb(PHOTO_LIMITS.maxInputBytes)})`,
        );
      else if (f.size === 0) rejected.push(`${f.name}: boş dosya`);
      else accepted.push(f);
    }
    const queue = accepted.slice(0, remaining);
    const skipped = accepted.length - queue.length;
    const messages: string[] = [];
    if (rejected.length) messages.push(`Yüklenmeyen dosyalar — ${rejected.join("; ")}.`);
    if (skipped > 0) {
      messages.push(
        `${skipped} dosya eklenmedi: mülk başına en fazla ${LIMIT} fotoğraf yüklenebilir.`,
      );
    }
    if (messages.length) setNotice({ tone: "error", text: messages.join(" ") });
    if (queue.length === 0) return;

    const batch: UploadItem[] = queue.map((f, i) => ({
      key: `${Date.now()}-${i}`,
      name: f.name,
      size: f.size,
      status: "waiting",
      progress: 0,
    }));
    setItems(batch);
    setUploading(true);
    let succeeded = 0;
    // Sıralı: sunucu aynı anda tek görsel işler; paralel istek yalnız kuyruğu doldurur.
    for (const [i, file] of queue.entries()) {
      const key = batch[i]!.key;
      patch(key, { status: "uploading" });
      let result: UploadResult = { ok: false, message: "" };
      for (let attempt = 0; attempt < 4; attempt++) {
        result = await uploadOne(propertyId, file, (p) =>
          patch(key, { progress: p, status: p >= 1 ? "processing" : "uploading" }),
        );
        if (result.ok || result.retryAfter === undefined) break;
        patch(key, { status: "waiting", message: "Sunucu meşgul, yeniden deneniyor…" });
        await sleep(Math.min(Math.max(result.retryAfter, 1), 15) * 1000);
      }
      if (result.ok) {
        succeeded++;
        patch(key, { status: "done", progress: 1, message: undefined });
      } else {
        patch(key, { status: "error", message: result.message });
        // Sınır doldu → kalanları denemenin anlamı yok.
        if (/en fazla \d+ fotoğraf/.test(result.message)) break;
      }
    }
    setUploading(false);
    if (inputRef.current) inputRef.current.value = "";
    if (succeeded > 0) startTransition(() => router.refresh());
  }

  async function saveOrder(order: string[], movedId: string) {
    setPendingOrder(order);
    setBusyPhoto(movedId);
    setActionError(null);
    try {
      const r = await reorderPhotosAction(propertyId, order);
      if (!r.ok) {
        setPendingOrder(null);
        setActionError(r.error);
        setAnnouncement("Sıra kaydedilemedi.");
      }
      startTransition(() => router.refresh());
    } catch {
      setPendingOrder(null);
      setActionError("Sıra kaydedilemedi. Lütfen tekrar deneyin.");
    } finally {
      setBusyPhoto(null);
    }
  }

  async function runPhotoAction(
    photoId: string,
    fn: () => Promise<{ ok: boolean; error?: string }>,
    done?: string,
  ) {
    setBusyPhoto(photoId);
    setActionError(null);
    // Ok düğmeleri sunucudaki sırayı esas alır; bekleyen sürükleme sırası bırakılır.
    setPendingOrder(null);
    try {
      const r = await fn();
      if (!r.ok) setActionError(r.error ?? "İşlem yapılamadı.");
      else if (done) setAnnouncement(done);
      startTransition(() => router.refresh());
    } catch {
      setActionError("İşlem yapılamadı. Lütfen tekrar deneyin.");
    } finally {
      setBusyPhoto(null);
      setConfirmDelete(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          JPG, JPEG, PNG veya WebP · dosya başına en fazla {formatMb(PHOTO_LIMITS.maxInputBytes)}.
          Fotoğraflar WebP biçimine dönüştürülür; konum (GPS) ve kamera bilgileri silinir.
        </p>
        <p
          role="status"
          aria-live="polite"
          data-testid="photo-counter"
          className={cn(
            "shrink-0 text-sm font-semibold",
            full ? "text-destructive" : "text-navy-900",
          )}
        >
          {count} / {LIMIT} fotoğraf
        </p>
      </div>

      {!storageReady ? (
        <Alert tone="info">
          Fotoğraf depolama henüz yapılandırılmadı; şu an fotoğraf yüklenemez.
        </Alert>
      ) : null}
      {!canManage ? (
        <Alert tone="info">
          Fotoğrafları görüntülüyorsunuz; yükleme ve düzenleme yetkisi işletme sahibi ve
          yöneticilerdedir.
        </Alert>
      ) : null}
      {canManage && full ? (
        <Alert tone="info">
          Bu mülk için {LIMIT} fotoğraf sınırına ulaşıldı. Yeni fotoğraf eklemek için önce bir
          fotoğrafı silin.
        </Alert>
      ) : null}

      {canManage && storageReady && !full ? (
        <div
          onDragOver={(e) => {
            if (!canUpload) return;
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (e.dataTransfer.files.length) void startUpload(e.dataTransfer.files);
          }}
          className={cn(
            "flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed px-6 py-8 text-center transition-colors",
            dragging ? "border-turquoise-500 bg-turquoise-50" : "border-border bg-white/60",
          )}
        >
          <p className="text-sm text-navy-900">
            Fotoğrafları buraya sürükleyin veya seçin. En fazla {remaining} fotoğraf daha
            ekleyebilirsiniz.
          </p>
          <label
            className={cn(
              buttonVariants(),
              !canUpload && "pointer-events-none opacity-60",
              "cursor-pointer",
            )}
          >
            {uploading ? "Yükleniyor…" : "Fotoğraf seç"}
            <input
              ref={inputRef}
              type="file"
              accept={PHOTO_ACCEPT}
              multiple
              disabled={!canUpload}
              className="sr-only"
              aria-label="Fotoğraf seç"
              onChange={(e) => {
                if (e.target.files?.length) void startUpload(e.target.files);
              }}
            />
          </label>
        </div>
      ) : null}

      {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}

      {items.length > 0 ? (
        <ul aria-label="Yükleme durumu" className="flex flex-col gap-2">
          {items.map((it) => (
            <li
              key={it.key}
              className="flex flex-col gap-1.5 rounded-lg border border-border bg-white px-4 py-3"
            >
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate text-navy-900">{it.name}</span>
                <span
                  className={cn(
                    "shrink-0 text-xs font-semibold",
                    it.status === "error"
                      ? "text-destructive"
                      : it.status === "done"
                        ? "text-turquoise-700"
                        : "text-muted-foreground",
                  )}
                >
                  {
                    {
                      waiting: "Sırada",
                      uploading: `Yükleniyor %${Math.round(it.progress * 100)}`,
                      processing: "İşleniyor…",
                      done: "Yüklendi",
                      error: "Hata",
                    }[it.status]
                  }
                </span>
              </div>
              {it.status === "uploading" || it.status === "processing" ? (
                <progress
                  max={1}
                  value={it.status === "processing" ? undefined : it.progress}
                  aria-label={`${it.name} yükleme ilerlemesi`}
                  className="h-1.5 w-full overflow-hidden rounded-full [&::-moz-progress-bar]:bg-turquoise-500 [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-turquoise-500"
                />
              ) : null}
              {it.message ? (
                <p
                  className={cn(
                    "text-xs",
                    it.status === "error" ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  {it.message}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {actionError ? <Alert tone="error">{actionError}</Alert> : null}

      <p aria-live="assertive" className="sr-only" data-testid="photo-announcer">
        {announcement}
      </p>
      {canManage && photos.length > 1 ? (
        <p id="photo-sort-hint" className="-mb-3 text-sm text-muted-foreground">
          Sıralamak için fotoğrafı tutup sürükleyin (dokunmatik ekranda kısa süre basılı tutun) ya
          da ← → düğmelerini kullanın.
        </p>
      ) : null}

      {photos.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-white/60 px-6 py-12 text-center">
          <p className="font-semibold text-navy-900">Henüz fotoğraf yok</p>
          <p className="mt-1 text-sm text-muted-foreground">
            İlk yüklenen fotoğraf otomatik olarak kapak olur.
          </p>
        </div>
      ) : (
        <ol
          ref={listRef}
          aria-label="Fotoğraflar"
          aria-describedby={canManage && photos.length > 1 ? "photo-sort-hint" : undefined}
          className="grid grid-cols-2 gap-4 sm:grid-cols-3"
        >
          {shown.map((p, i) => {
            const busy = busyPhoto === p.id;
            const disabled = busy || busyPhoto !== null || !hydrated || drag !== null;
            const isDragged = drag?.id === p.id;
            const draggable =
              canManage &&
              hydrated &&
              busyPhoto === null &&
              confirmDelete === null &&
              shown.length > 1;
            return (
              <li
                key={p.id}
                data-testid="photo-item"
                data-photo-id={p.id}
                data-cover={p.isCover ? "true" : "false"}
                data-dragging={isDragged ? "true" : undefined}
                className={cn(
                  "flex flex-col overflow-hidden rounded-xl border bg-white shadow-sm transition-[opacity,box-shadow] duration-150",
                  isDragged
                    ? "border-dashed border-turquoise-500 opacity-40 ring-2 ring-turquoise-500/40"
                    : "border-border",
                )}
              >
                <div
                  onPointerDown={draggable ? (e) => onPointerDown(e, p.id) : undefined}
                  onContextMenu={draggable ? (e) => e.preventDefault() : undefined}
                  data-testid="photo-drag-area"
                  className={cn(
                    "relative aspect-[4/3] overflow-hidden bg-muted",
                    draggable &&
                      "cursor-grab touch-manipulation select-none [-webkit-touch-callout:none]",
                  )}
                >
                  {p.sources ? (
                    // next/image kullanılmıyor: varyantlar zaten üretilmiş, CDN'den doğrudan gelir.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={p.sources.src}
                      srcSet={p.sources.srcSet}
                      sizes="(min-width: 640px) 220px, 45vw"
                      width={p.width}
                      height={p.height}
                      loading="lazy"
                      decoding="async"
                      draggable={false}
                      alt={`${propertyName} — fotoğraf ${i + 1}${p.isCover ? " (kapak)" : ""}`}
                      className="absolute inset-0 size-full object-cover"
                    />
                  ) : (
                    <div className="flex size-full items-center justify-center text-xs text-muted-foreground">
                      Önizleme yok
                    </div>
                  )}
                  {p.isCover ? (
                    <span className="absolute top-2 left-2 rounded-full bg-navy-900/85 px-2 py-0.5 text-xs font-semibold text-white">
                      Kapak
                    </span>
                  ) : null}
                  <span
                    data-photo-position
                    className="absolute top-2 right-2 rounded-full bg-white/90 px-2 py-0.5 text-xs font-semibold text-navy-900"
                  >
                    {i + 1}
                  </span>
                </div>
                {canManage ? (
                  <div className="flex flex-wrap items-center gap-1 p-2">
                    {confirmDelete === p.id ? (
                      <>
                        <Button
                          size="sm"
                          variant="primary"
                          className="bg-destructive hover:bg-destructive/90"
                          disabled={disabled}
                          onClick={() =>
                            runPhotoAction(p.id, () => deletePhotoAction(propertyId, p.id))
                          }
                        >
                          {busy ? "Siliniyor…" : "Silmeyi onayla"}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => setConfirmDelete(null)}
                        >
                          Vazgeç
                        </Button>
                      </>
                    ) : (
                      <>
                        {!p.isCover ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={disabled}
                            onClick={() =>
                              runPhotoAction(p.id, () => setCoverPhotoAction(propertyId, p.id))
                            }
                          >
                            Kapak yap
                          </Button>
                        ) : null}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="px-2.5"
                          aria-label={`Fotoğraf ${i + 1}: öne al`}
                          disabled={disabled || i === 0}
                          onClick={() =>
                            runPhotoAction(
                              p.id,
                              () => movePhotoAction(propertyId, p.id, "up"),
                              `Fotoğraf ${i}. sıraya taşındı.`,
                            )
                          }
                        >
                          ←
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="px-2.5"
                          aria-label={`Fotoğraf ${i + 1}: geri al`}
                          disabled={disabled || i === shown.length - 1}
                          onClick={() =>
                            runPhotoAction(
                              p.id,
                              () => movePhotoAction(propertyId, p.id, "down"),
                              `Fotoğraf ${i + 2}. sıraya taşındı.`,
                            )
                          }
                        >
                          →
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="ml-auto px-2.5 text-destructive hover:bg-destructive/5"
                          disabled={disabled}
                          onClick={() => setConfirmDelete(p.id)}
                        >
                          Sil
                        </Button>
                      </>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
