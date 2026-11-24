// Renders untrusted email HTML in a sandboxed iframe (no scripts, no forms), sized to its content.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Message } from "@iris/core/types.ts";
import { attachmentUrl } from "../api";
import type { Theme } from "../state";
import { escapeHtml } from "../util";
import { Icon } from "./Icon";

function isRich(html: string): boolean {
  return /<table|bgcolor=|background(-color)?\s*:|<style/i.test(html);
}

function prepare(m: Message, blockImages: boolean): { html: string; blocked: number; hasQuote: boolean; trackers: number } {
  let html = m.bodyHtml || `<div style="white-space:pre-wrap">${escapeHtml(m.bodyText)}</div>`;
  html = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  // inline images
  html = html.replace(/(["'(])cid:([^"')\s>]+)/gi, (_, q: string, cid: string) => `${q}${attachmentUrl(m.id, cid, false, m.accountId)}`);
  // tracking pixels: 1x1 images and well-known open-tracking endpoints never load
  let trackers = 0;
  html = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = tag.match(/\ssrc=(["'])([^"']*)\1/i)?.[2] ?? "";
    const tiny = /\b(width|height)=["']?[01](px)?["'\s>]/i.test(tag) || /(width|height)\s*:\s*[01]px/i.test(tag);
    const known = /\/(open|opens|track|tracking|pixel|beacon|wf\/open|e\/o|o\.gif|imp|t\.gif)(\/|\.|\?|$)|list-manage\.com\/track|mailtrack|mixpanel|sendgrid\.net\/wf\/open|mandrillapp\.com\/track\/open|hubspot.*\/e2t\/to/i.test(src);
    if (/^https?:/i.test(src) && (tiny || known)) {
      trackers++;
      return "";
    }
    return tag;
  });
  let blocked = 0;
  if (blockImages) {
    html = html.replace(/<img\b([^>]*?)\ssrc=(["'])(https?:[^"']+)\2/gi, (_all, pre: string, q: string, url: string) => {
      blocked++;
      return `<img${pre} data-iris-src=${q}${url}${q} src=""`;
    });
  }
  const hasQuote = /class="?gmail_quote|<blockquote[^>]+type="?cite|data-iris-quote/i.test(html);
  return { html, blocked, hasQuote, trackers };
}

// The iframe can't see the app's custom properties, so the theme tokens are resolved into it.
// A probe element with its own data-theme reads the right theme even before App's effect
// has flipped <html data-theme> (child effects run first).
type FrameTokens = { text: string; text2: string; link: string; line: string; selection: string; font: string; fontUrl: string };
const tokenCache = new Map<string, FrameTokens>();
function frameTokens(theme: Theme): FrameTokens {
  const hit = tokenCache.get(theme);
  if (hit) return hit;
  const probe = document.createElement("div");
  probe.dataset.theme = theme;
  probe.hidden = true;
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  const t: FrameTokens = { text: v("--text"), text2: v("--text-2"), link: v("--link"), line: v("--line-2"), selection: v("--text-selection"), font: v("--font-sans"), fontUrl: new URL("/fonts/InterVariable.woff2", location.href).href };
  probe.remove();
  if (t.text) tokenCache.set(theme, t);
  return t;
}

function srcdoc(body: string, theme: Theme, rich: boolean): string {
  const dark = theme === "graphite" && !rich;
  // rich (designed) mail keeps its own white canvas; plain mail follows the app theme. Light themes (Glass, Paper)
  // use their own tokens for rich mail too; Graphite falls back to Paper's light ones.
  const t = frameTokens(rich && theme === "graphite" ? "paper" : theme);
  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; form-action 'none'">
<style>
@font-face{font-family:"Inter";src:url("${t.fontUrl}") format("woff2");font-weight:100 900;font-style:normal;font-display:swap}
:root{color-scheme:${dark ? "dark" : "light"}}
html,body{margin:0;padding:0;background:${rich ? "#fff" : "transparent"}}
body{color:${t.text};font:15px/22px ${t.font || "-apple-system,BlinkMacSystemFont,sans-serif"};font-optical-sizing:auto;-webkit-font-smoothing:antialiased;overflow-wrap:anywhere;${rich ? "padding:12px 16px;" : ""}}
a{color:${t.link}}
img{max-width:100%;height:auto}
pre{white-space:pre-wrap}
table{max-width:100%}
blockquote{margin:0 0 0 .8ex;border-left:2px solid ${t.line};padding-left:1ex;color:${t.text2}}
::selection{background:${t.selection}}
body:not(.show-quotes) .gmail_quote, body:not(.show-quotes) blockquote[type=cite], body:not(.show-quotes) [data-iris-quote]{display:none}
</style></head><body>${body}</body></html>`;
}

export function EmailFrame({ message, theme, blockImages }: { message: Message; theme: Theme; blockImages: boolean }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(60);
  const [showImages, setShowImages] = useState(false);
  const [showQuotes, setShowQuotes] = useState(false);
  const prepared = useMemo(() => prepare(message, blockImages && !showImages), [message, blockImages, showImages]);
  const rich = useMemo(() => isRich(prepared.html), [prepared.html]);
  const doc = useMemo(() => srcdoc(prepared.html, theme, rich), [prepared.html, theme, rich]);

  useEffect(() => {
    const iframe = ref.current;
    if (!iframe) return;
    let ro: ResizeObserver | null = null;
    const onLoad = () => {
      const d = iframe.contentDocument;
      if (!d) return;
      const measure = () => setHeight(Math.max(30, d.documentElement.scrollHeight));
      measure();
      ro = new ResizeObserver(measure);
      ro.observe(d.body);
      // keyboard shortcuts keep working while the email has focus
      d.addEventListener("keydown", (e) => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: e.key, code: e.code, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, bubbles: true, cancelable: true }));
      });
      d.body.classList.toggle("show-quotes", showQuotes);
    };
    iframe.addEventListener("load", onLoad);
    return () => {
      iframe.removeEventListener("load", onLoad);
      ro?.disconnect();
    };
  }, [doc, showQuotes]);

  useEffect(() => {
    ref.current?.contentDocument?.body?.classList.toggle("show-quotes", showQuotes);
  }, [showQuotes]);

  return (
    <div className={`email-frame${rich ? " rich" : ""}`}>
      {prepared.blocked > 0 && (
        <button className="link small" onClick={() => setShowImages(true)}>
          {prepared.blocked} remote image{prepared.blocked > 1 ? "s" : ""} blocked · Show
        </button>
      )}
      {prepared.trackers > 0 && (
        <div className="tracker-note" title="Tracking pixels are never loaded, so the sender can't see when you open this email.">
          {prepared.trackers} tracker{prepared.trackers > 1 ? "s" : ""} blocked
        </div>
      )}
      <iframe
        ref={ref}
        title={`message-${message.id}`}
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        srcDoc={doc}
        style={{ height }}
      />
      {prepared.hasQuote && (
        <button className="quote-toggle" title={showQuotes ? "Hide quoted text" : "Show quoted text"} aria-label="Toggle quoted text" aria-expanded={showQuotes} onClick={() => setShowQuotes((v) => !v)}>
          <Icon name="more" size={14} stroke={2} />
        </button>
      )}
    </div>
  );
}
