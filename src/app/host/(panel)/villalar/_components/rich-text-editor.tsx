"use client";

import { useEffect, useId, useRef, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * Basit biçimlendirilmiş metin düzenleyici: kalın, italik, altı çizili ve bağlantı.
 * Bağımlılıksız (contentEditable + tarayıcı düzenleme komutları).
 *
 * Güvenlik: başlangıç değeri SUNUCUDA temizlenmiş HTML'dir (src/server/properties/description.ts);
 * kaydedilen her değer de sunucuda yeniden temizlenir. Yapıştırılan içerik yalnız düz metin
 * olarak eklenir (başka sitelerden gelen biçim, betik veya stil taşınmaz).
 * Klavye: Ctrl/⌘+B, I, U ve bağlantı için Ctrl/⌘+K.
 */

type Props = {
  id: string;
  name: string;
  label: string;
  defaultHtml: string;
  error?: string | undefined;
  readOnly?: boolean;
  maxText: number;
};

type Mark = "bold" | "italic" | "underline";

const MARKS: { cmd: Mark; label: string; short: string; className: string }[] = [
  { cmd: "bold", label: "Kalın", short: "B", className: "font-bold" },
  { cmd: "italic", label: "İtalik", short: "I", className: "italic" },
  { cmd: "underline", label: "Altı çizili", short: "U", className: "underline" },
];

/** Kullanıcının yazdığı adresi bağlantıya çevirir; yalnız http(s) ve e-posta. */
export function normalizeLinkUrl(input: string): string | null {
  const v = input.trim();
  if (!v || v.length > 2000) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(v)
    ? v
    : /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(v)
      ? `mailto:${v}`
      : `https://${v}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol === "mailto:") return u.href;
    if ((u.protocol === "https:" || u.protocol === "http:") && u.hostname.includes(".")) {
      return u.href;
    }
  } catch {
    // geçersiz
  }
  return null;
}

const textLength = (el: HTMLElement | null) => (el?.innerText ?? "").trim().length;

export function RichTextEditor({ id, name, label, defaultHtml, error, readOnly, maxText }: Props) {
  const labelId = useId();
  const editorRef = useRef<HTMLDivElement>(null);
  const linkInputRef = useRef<HTMLInputElement>(null);
  const savedRange = useRef<Range | null>(null);
  // Başlangıç HTML'i yalnız ilk render'da yazılır; sonrasını kullanıcı düzenler.
  const [initialHtml] = useState(defaultHtml);
  const [html, setHtml] = useState(defaultHtml);
  const [length, setLength] = useState(0);
  const [active, setActive] = useState<Record<Mark | "link", boolean>>({
    bold: false,
    italic: false,
    underline: false,
    link: false,
  });
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);

  const insideEditor = (node: Node | null) => !!node && !!editorRef.current?.contains(node);

  const currentLink = (): HTMLAnchorElement | null => {
    const sel = window.getSelection();
    const node = sel?.anchorNode ?? null;
    if (!insideEditor(node)) return null;
    const el = node instanceof Element ? node : node?.parentElement;
    const a = el?.closest("a");
    return a && insideEditor(a) ? a : null;
  };

  const refreshState = () => {
    const sel = window.getSelection();
    if (!sel || !insideEditor(sel.anchorNode)) return;
    setActive({
      bold: document.queryCommandState("bold"),
      italic: document.queryCommandState("italic"),
      underline: document.queryCommandState("underline"),
      link: currentLink() !== null,
    });
  };

  useEffect(() => {
    setLength(textLength(editorRef.current));
    const onSel = () => refreshState();
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sync = () => {
    const el = editorRef.current;
    if (!el) return;
    // Yalnız boş satır kaldıysa (ör. her şey silindi) açıklama boştur.
    setHtml(el.innerText.trim() ? el.innerHTML : "");
    setLength(textLength(el));
  };

  const run = (cmd: string, value?: string) => {
    editorRef.current?.focus();
    document.execCommand("styleWithCSS", false, "false");
    document.execCommand(cmd, false, value);
    sync();
    refreshState();
  };

  const saveSelection = () => {
    const sel = window.getSelection();
    savedRange.current =
      sel && sel.rangeCount > 0 && insideEditor(sel.anchorNode)
        ? sel.getRangeAt(0).cloneRange()
        : null;
  };

  const restoreSelection = () => {
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    if (savedRange.current) sel.addRange(savedRange.current);
    else {
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      sel.addRange(r);
    }
  };

  const openLink = () => {
    saveSelection();
    const existing = currentLink();
    setLinkValue(existing?.getAttribute("href") ?? "");
    setLinkError(null);
    setLinkOpen(true);
    window.setTimeout(() => linkInputRef.current?.focus(), 0);
  };

  const closeLink = () => {
    setLinkOpen(false);
    setLinkError(null);
    restoreSelection();
  };

  const applyLink = () => {
    const url = normalizeLinkUrl(linkValue);
    if (!url) {
      setLinkError("Geçerli bir adres girin (ör. https://ornek.com).");
      return;
    }
    setLinkOpen(false);
    setLinkError(null);
    restoreSelection();
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) {
      run("createLink", url);
    } else {
      // Seçim yoksa adresin kendisi bağlantı metni olarak eklenir.
      const a = document.createElement("a");
      a.href = url;
      a.textContent = linkValue.trim();
      run("insertHTML", a.outerHTML);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      openLink();
    }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    document.execCommand("insertText", false, text);
    sync();
  };

  const over = length > maxText;

  return (
    <div className="flex flex-col gap-1.5">
      <span id={labelId} className="text-sm font-medium text-navy-900">
        {label}
      </span>
      <input type="hidden" name={name} value={html} />
      <div
        className={cn(
          "overflow-hidden rounded-lg border bg-white transition-colors focus-within:border-turquoise-500 focus-within:ring-3 focus-within:ring-turquoise-500/25",
          error || over ? "border-destructive" : "border-input",
          readOnly && "bg-mist",
        )}
      >
        {readOnly ? null : (
          <div
            role="toolbar"
            aria-label="Açıklama biçimlendirme"
            aria-controls={id}
            className="flex flex-wrap items-center gap-1 border-b border-border bg-mist/60 px-2 py-1.5"
          >
            {MARKS.map((m) => (
              <button
                key={m.cmd}
                type="button"
                title={`${m.label} (Ctrl/⌘+${m.short})`}
                aria-label={m.label}
                aria-pressed={active[m.cmd]}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => run(m.cmd)}
                className={cn(
                  "flex size-8 items-center justify-center rounded-md text-[15px] text-navy-900 hover:bg-white focus-visible:ring-2 focus-visible:ring-turquoise-500/50 focus-visible:outline-none",
                  m.className,
                  active[m.cmd] && "bg-white shadow-sm ring-1 ring-border",
                )}
              >
                {m.short}
              </button>
            ))}
            <span aria-hidden className="mx-1 h-5 w-px bg-border" />
            <button
              type="button"
              title="Bağlantı ekle (Ctrl/⌘+K)"
              aria-label="Bağlantı ekle"
              aria-pressed={active.link}
              aria-expanded={linkOpen}
              onMouseDown={(e) => e.preventDefault()}
              onClick={openLink}
              className={cn(
                "flex h-8 items-center gap-1 rounded-md px-2 text-sm font-medium text-navy-900 hover:bg-white focus-visible:ring-2 focus-visible:ring-turquoise-500/50 focus-visible:outline-none",
                active.link && "bg-white shadow-sm ring-1 ring-border",
              )}
            >
              Bağlantı
            </button>
            {active.link ? (
              <button
                type="button"
                aria-label="Bağlantıyı kaldır"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => run("unlink")}
                className="flex h-8 items-center rounded-md px-2 text-sm text-muted-foreground hover:bg-white hover:text-navy-900 focus-visible:ring-2 focus-visible:ring-turquoise-500/50 focus-visible:outline-none"
              >
                Kaldır
              </button>
            ) : null}
          </div>
        )}
        {linkOpen ? (
          <div className="flex flex-col gap-2 border-b border-border bg-white px-3 py-3 sm:flex-row sm:items-start">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <label htmlFor={`${id}-link`} className="sr-only">
                Bağlantı adresi
              </label>
              <input
                ref={linkInputRef}
                id={`${id}-link`}
                type="url"
                inputMode="url"
                placeholder="https://ornek.com"
                value={linkValue}
                onChange={(e) => setLinkValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    applyLink();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    closeLink();
                  }
                }}
                aria-invalid={linkError ? true : undefined}
                aria-describedby={linkError ? `${id}-link-hata` : undefined}
                className="h-9 w-full rounded-md border border-input px-2.5 text-sm focus-visible:border-turquoise-500 focus-visible:ring-2 focus-visible:ring-turquoise-500/25 focus-visible:outline-none"
              />
              {linkError ? (
                <p id={`${id}-link-hata`} className="text-sm text-destructive">
                  {linkError}
                </p>
              ) : null}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={applyLink}
                className="h-9 rounded-md bg-navy-900 px-3 text-sm font-semibold text-white hover:bg-navy-800"
              >
                Ekle
              </button>
              <button
                type="button"
                onClick={closeLink}
                className="h-9 rounded-md px-3 text-sm text-navy-900 hover:bg-mist"
              >
                Vazgeç
              </button>
            </div>
          </div>
        ) : null}
        <div
          ref={editorRef}
          id={id}
          role="textbox"
          aria-multiline="true"
          aria-labelledby={labelId}
          aria-readonly={readOnly ? true : undefined}
          aria-invalid={error || over ? true : undefined}
          aria-describedby={`${id}-sayac${error ? ` ${id}-hata` : ""}`}
          contentEditable={!readOnly}
          suppressContentEditableWarning
          tabIndex={readOnly ? 0 : undefined}
          onInput={sync}
          onBlur={sync}
          onKeyDown={onKeyDown}
          onKeyUp={refreshState}
          onPaste={onPaste}
          onFocus={() => document.execCommand("defaultParagraphSeparator", false, "p")}
          className="min-h-32 px-3 py-2.5 text-[15px] leading-relaxed text-navy-900 focus:outline-none [&_a]:text-turquoise-700 [&_a]:underline [&_p]:mb-2 [&_p:last-child]:mb-0"
          dangerouslySetInnerHTML={{ __html: initialHtml }}
        />
      </div>
      <div className="flex items-start justify-between gap-3">
        {error ? (
          <p id={`${id}-hata`} className="text-sm text-destructive">
            {error}
          </p>
        ) : (
          <span />
        )}
        <p
          id={`${id}-sayac`}
          className={cn("shrink-0 text-xs", over ? "text-destructive" : "text-muted-foreground")}
        >
          {length.toLocaleString("tr-TR")} / {maxText.toLocaleString("tr-TR")}
        </p>
      </div>
    </div>
  );
}
