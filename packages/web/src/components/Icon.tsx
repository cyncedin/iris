/*
 * Iris icon set. Path data copied from Lucide (lucide-static 1.61.0), https://lucide.dev
 *
 * ISC License
 * Copyright (c) 2026 Lucide Icons and Contributors
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 *
 * Portions of Lucide are derived from Feather (MIT, Copyright (c) 2013-2023 Cole Bemis).
 *
 * Names are part of the API: do not rename.
 */
import type { JSX, SVGProps } from "react";

export type IconName =
  | "menu" | "search" | "sparkles" | "calendar" | "calendar-week" | "plus" | "pen" | "x"
  | "check" | "alarm" | "star" | "trash" | "paperclip" | "tag" | "arrow-left" | "arrow-up-right"
  | "reply" | "reply-all" | "forward" | "clock" | "snippet" | "undo" | "mail" | "link" | "settings" | "alert"
  | "square" | "check-square" | "chevron-left" | "chevron-right" | "chevron-down" | "more"
  | "map-pin" | "users" | "video" | "external-link"
  | "inbox" | "file" | "send" | "circle-check" | "bell-off" | "octagon-alert" | "archive" | "pin" | "panel-left" | "target" | "languages"
  | "user-search" | "refresh";

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name" | "ref" | "stroke"> {
  name: IconName;
  size?: 12 | 14 | 16 | 18 | 20; // px, default 16
  stroke?: number; // rendered stroke in px, default 1.5 (strokeWidth = stroke * 24 / size)
  filled?: boolean; // fill="currentColor" (star, check-square)
  title?: string; // sets role="img" + <title>; without it the icon is aria-hidden
}

// A shape is a path `d`, or a circle/rect. `knock` marks strokes that sit inside a
// filled shape (the check in check-square): when filled, they are drawn in the surface color.
type Shape =
  | string
  | { c: [cx: number, cy: number, r: number]; dot?: boolean }
  | { r: [x: number, y: number, w: number, h: number, rx: number] }
  | { d: string; knock: true };

const SHAPES: Record<IconName, readonly Shape[]> = {
  menu: ["M4 5h16", "M4 12h16", "M4 19h16"],
  search: ["m21 21-4.34-4.34", { c: [11, 11, 8] }],
  sparkles: [
    "M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z",
    "M20 2v4",
    "M22 4h-4",
    { c: [4, 20, 2] },
  ],
  target: [{ c: [12, 12, 10] }, { c: [12, 12, 6] }, { c: [12, 12, 2] }],
  languages: ["m5 8 6 6", "m4 14 6-6 2-3", "M2 5h12", "M7 2h1", "m22 22-5-10-5 10", "M14 18h6"],
  calendar: ["M8 2v3", "M16 2v3", { r: [3, 3, 18, 18, 2] }, "M3 9h18"],
  "calendar-week": [
    "M8 2v3", "M16 2v3", { r: [3, 3, 18, 18, 2] }, "M3 9h18",
    "M8 13h.01", "M12 13h.01", "M16 13h.01", "M8 17h.01", "M12 17h.01", "M16 17h.01",
  ],
  plus: ["M5 12h14", "M12 5v14"],
  pen: [
    "M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7",
    "M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z",
  ],
  x: ["M18 6 6 18", "m6 6 12 12"],
  check: ["M20 6 9 17l-5-5"],
  alarm: [{ c: [12, 13, 8] }, "M12 9v4l2 2", "M5 3 2 6", "m22 6-3-3", "M6.38 18.7 4 21", "M17.64 18.67 20 21"],
  star: [
    "M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z",
  ],
  trash: ["M10 11v6", "M14 11v6", "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6", "M3 6h18", "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"],
  paperclip: ["m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551"],
  tag: [
    "M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z",
    { c: [7.5, 7.5, 0.5], dot: true },
  ],
  "arrow-left": ["m12 19-7-7 7-7", "M19 12H5"],
  "arrow-up-right": ["M7 7h10v10", "M7 17 17 7"],
  reply: ["M20 18v-2a4 4 0 0 0-4-4H4", "m9 17-5-5 5-5"],
  "reply-all": ["m12 17-5-5 5-5", "M22 18v-2a4 4 0 0 0-4-4H7", "m7 17-5-5 5-5"],
  forward: ["m15 17 5-5-5-5", "M4 18v-2a4 4 0 0 1 4-4h12"],
  clock: [{ c: [12, 12, 10] }, "M12 6v6l4 2"],
  snippet: [
    "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z",
    "M14 2v5a1 1 0 0 0 1 1h5",
    "M10 9H8",
    "M16 13H8",
    "M16 17H8",
  ],
  undo: ["M9 14 4 9l5-5", "M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"],
  mail: ["m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7", { r: [2, 4, 20, 16, 2] }],
  link: ["M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71", "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"],
  settings: [
    "M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915",
    { c: [12, 12, 3] },
  ],
  alert: ["m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3", "M12 9v4", "M12 17h.01"],
  square: [{ r: [3, 3, 18, 18, 2] }],
  "check-square": [{ r: [3, 3, 18, 18, 2] }, { d: "m16 9-5.5 5.5L8 12", knock: true }],
  "chevron-left": ["m15 18-6-6 6-6"],
  "chevron-right": ["m9 18 6-6-6-6"],
  "chevron-down": ["m6 9 6 6 6-6"],
  more: [{ c: [12, 12, 1] }, { c: [19, 12, 1] }, { c: [5, 12, 1] }],
  "map-pin": ["M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0", { c: [12, 10, 3] }],
  users: ["M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", "M16 3.128a4 4 0 0 1 0 7.744", "M22 21v-2a4 4 0 0 0-3-3.87", { c: [9, 7, 4] }],
  video: ["m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5", { r: [2, 6, 14, 12, 2] }],
  "external-link": ["M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"],
  // sidebar
  inbox: ["M22 12h-6l-2 3h-4l-2-3H2", "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"],
  file: ["M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z", "M14 2v5a1 1 0 0 0 1 1h5"],
  send: ["M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z", "m21.854 2.147-10.94 10.939"],
  "circle-check": [{ c: [12, 12, 10] }, "m9 12 2 2 4-4"],
  "bell-off": ["M10.268 21a2 2 0 0 0 3.464 0", "M17 17H4a1 1 0 0 1-.74-1.673C4.59 13.956 6 12.499 6 8a6 6 0 0 1 .258-1.742", "m2 2 20 20", "M8.668 3.01A6 6 0 0 1 18 8c0 2.687.77 4.653 1.707 6.05"],
  "octagon-alert": [
    "M12 16h.01",
    "M12 8v4",
    "M15.312 2a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586l-4.688-4.688A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2z",
  ],
  archive: [{ r: [2, 3, 20, 5, 1] }, "M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8", "M10 12h4"],
  pin: [
    "M12 17v5",
    "M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z",
  ],
  "panel-left": [{ r: [3, 3, 18, 18, 2] }, "M9 3v18"],
  // person research: lucide user-search, refresh-cw
  "user-search": [{ c: [10, 7, 4] }, "M10.3 15H7a4 4 0 0 0-4 4v2", { c: [17, 17, 3] }, "m21 21-1.9-1.9"],
  refresh: ["M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8", "M21 3v5h-5", "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16", "M8 16H3v5"],
};

function shape(s: Shape, i: number, filled: boolean): JSX.Element {
  if (typeof s === "string") return <path key={i} d={s} />;
  if ("knock" in s) return <path key={i} d={s.d} fill="none" stroke={filled ? "var(--icon-knock, var(--bg))" : undefined} />;
  if ("c" in s) return <circle key={i} cx={s.c[0]} cy={s.c[1]} r={s.c[2]} fill={s.dot ? "currentColor" : undefined} />;
  return <rect key={i} x={s.r[0]} y={s.r[1]} width={s.r[2]} height={s.r[3]} rx={s.r[4]} />;
}

export function Icon({ name, size = 16, stroke = 1.5, filled = false, title, className, ...rest }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={(stroke * 24) / size}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      className={"i " + (className ?? "")}
      {...rest}
    >
      {title && <title>{title}</title>}
      {SHAPES[name].map((s, i) => shape(s, i, filled))}
    </svg>
  );
}
