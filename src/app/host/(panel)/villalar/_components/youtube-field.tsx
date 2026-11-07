"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { PROPERTY_LIMITS as L } from "@/lib/property-meta";
import { cn } from "@/lib/utils";
import { parseYouTubeId, youtubeWatchUrl } from "@/lib/youtube";

type Props = {
  initial: string[];
  /** fieldErrors: "youtubeUrls" (genel) ve "youtubeUrls.<sıra>" (satır). */
  errors: Record<string, string>;
  readOnly?: boolean;
};

let nextKey = 0;
const row = (value: string) => ({ key: `yt-${nextKey++}`, value });

/**
 * YouTube video bağlantıları: satır ekle / kaldır. Boş satırlar kaydedilmez; her bağlantı
 * sunucuda yeniden doğrulanır ve yalnız video kimliği saklanır.
 */
export function YoutubeField({ initial, errors, readOnly }: Props) {
  const [rows, setRows] = useState(() => initial.map(row));
  const [lastAdded, setLastAdded] = useState<string | null>(null);
  const filled = rows.filter((r) => r.value.trim()).length;
  const canAdd = !readOnly && rows.length < L.youtubeMax;

  const add = () => {
    const r = row("");
    setRows((list) => [...list, r]);
    setLastAdded(r.key);
  };
  const remove = (key: string) => setRows((list) => list.filter((r) => r.key !== key));
  const update = (key: string, value: string) =>
    setRows((list) => list.map((r) => (r.key === key ? { ...r, value } : r)));

  return (
    <div className="flex flex-col gap-3">
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {readOnly ? "Video eklenmemiş." : "Henüz video eklenmedi."}
        </p>
      ) : (
        <ul aria-label="YouTube videoları" className="flex flex-col gap-3">
          {rows.map((r, i) => {
            const id = `youtube-${i}`;
            const err = errors[`youtubeUrls.${i}`];
            const videoId = r.value.trim() ? parseYouTubeId(r.value) : null;
            return (
              <li key={r.key} className="flex flex-col gap-1.5" data-testid="youtube-row">
                <label htmlFor={id} className="text-sm font-medium text-navy-900">
                  Video bağlantısı {i + 1}
                </label>
                <div className="flex gap-2">
                  <input
                    id={id}
                    name="youtubeUrls"
                    type="url"
                    inputMode="url"
                    autoComplete="off"
                    placeholder="https://www.youtube.com/watch?v=…"
                    value={r.value}
                    readOnly={readOnly}
                    autoFocus={r.key === lastAdded}
                    onChange={(e) => update(r.key, e.target.value)}
                    aria-invalid={err ? true : undefined}
                    aria-describedby={err ? `${id}-hata` : undefined}
                    className={cn(
                      "h-11 min-w-0 flex-1 rounded-lg border bg-white px-3 text-[15px] text-navy-900 placeholder:text-muted-foreground/70 read-only:bg-mist focus-visible:border-turquoise-500 focus-visible:ring-3 focus-visible:ring-turquoise-500/25 focus-visible:outline-none",
                      err ? "border-destructive" : "border-input",
                    )}
                  />
                  {readOnly ? null : (
                    <Button
                      variant="secondary"
                      className="shrink-0"
                      aria-label={`Video bağlantısı ${i + 1}: kaldır`}
                      onClick={() => remove(r.key)}
                    >
                      Kaldır
                    </Button>
                  )}
                </div>
                {err ? (
                  <p id={`${id}-hata`} className="text-sm text-destructive">
                    {err}
                  </p>
                ) : videoId ? (
                  <a
                    href={youtubeWatchUrl(videoId)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-turquoise-700 hover:underline"
                  >
                    YouTube&apos;da aç<span className="sr-only"> (yeni sekmede açılır)</span>
                  </a>
                ) : r.value.trim() ? (
                  <p className="text-sm text-muted-foreground">
                    Geçerli bir YouTube video bağlantısı değil gibi görünüyor.
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {errors.youtubeUrls ? <p className="text-sm text-destructive">{errors.youtubeUrls}</p> : null}
      {readOnly ? null : (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" onClick={add} disabled={!canAdd}>
            Video bağlantısı ekle
          </Button>
          <span className="text-sm text-muted-foreground">
            {filled} / {L.youtubeMax} video
          </span>
        </div>
      )}
    </div>
  );
}
