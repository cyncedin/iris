// Keyboard model: combos, "g x" sequences, regions.
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const NAMED: Record<string, string> = {
  Enter: "enter",
  Escape: "esc",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Backspace: "backspace",
  Delete: "delete",
  Tab: "tab",
  " ": "space",
};

const CODES: Record<string, string> = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Quote: "'",
  Backquote: "`",
};

/** Normalise a keydown into "mod+shift+k", "e", "#", "shift+e", "mod+enter" … */
export function comboOf(e: KeyboardEvent): string | null {
  if (["Shift", "Meta", "Control", "Alt", "CapsLock"].includes(e.key)) return null;
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const ctrl = isMac && e.ctrlKey;
  let shift = e.shiftKey;
  let k: string;
  if (NAMED[e.key]) k = NAMED[e.key];
  else if (mod || ctrl || e.altKey) {
    if (e.code.startsWith("Key")) k = e.code.slice(3).toLowerCase();
    else if (e.code.startsWith("Digit")) k = e.code.slice(5);
    else k = CODES[e.code] ?? e.key.toLowerCase();
  } else if (e.key.length === 1 && /[a-z]/i.test(e.key)) k = e.key.toLowerCase();
  else if (e.key.length === 1) {
    k = e.key; // symbols already include shift: # ! ? + …
    shift = false;
  } else k = e.key.toLowerCase();
  const parts: string[] = [];
  if (mod) parts.push("mod");
  if (ctrl) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (shift) parts.push("shift");
  parts.push(k);
  return parts.join("+");
}

const GLYPH: Record<string, string> = isMac
  ? { mod: "⌘", shift: "⇧", alt: "⌥", ctrl: "⌃", enter: "↵", esc: "Esc", backspace: "⌫", up: "↑", down: "↓", tab: "Tab", space: "Space" }
  : { mod: "Ctrl", shift: "Shift", alt: "Alt", ctrl: "Ctrl", enter: "Enter", esc: "Esc", backspace: "Backspace", up: "↑", down: "↓", tab: "Tab", space: "Space" };

/** "mod+shift+enter" → ["⌘","⇧","↵"]; "g i" → ["G","then","I"] */
export function keyCaps(combo: string): string[] {
  return combo.split(" ").flatMap((step, i) => {
    const caps = step.split("+").map((p) => GLYPH[p] ?? (p.length === 1 ? p.toUpperCase() : p));
    return i ? ["then", ...caps] : caps;
  });
}

export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

/** Tracks "g" prefixes. Returns the full combo once complete, null while waiting. */
export class Sequencer {
  private pending: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private prefixes: Set<string>;
  constructor(prefixes: string[]) {
    this.prefixes = new Set(prefixes);
  }
  feed(combo: string): string | null {
    if (this.pending) {
      const full = `${this.pending} ${combo}`;
      this.reset();
      return full;
    }
    if (this.prefixes.has(combo)) {
      this.pending = combo;
      this.timer = setTimeout(() => this.reset(), 1200);
      return null;
    }
    return combo;
  }
  get waiting(): boolean {
    return !!this.pending;
  }
  reset(): void {
    this.pending = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
