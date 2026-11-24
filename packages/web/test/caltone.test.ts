// Calendar color engine: every event text reaches WCAG AA on its own background.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CAL_SURFACES, calTone, contrast, hueOf, RAMPS, type CalHue, type CalTheme } from "../src/calutil.ts";

const HUES = Object.keys(RAMPS) as CalHue[];
const THEMES: CalTheme[] = ["graphite", "paper", "glass"];
const STYLES = ["filled", "bordered", "dashed", "focused"] as const;

test("contrast() matches WCAG reference values", () => {
  assert.equal(contrast("#000000", "#ffffff").toFixed(2), "21.00");
  assert.equal(contrast("#ffffff", "#ffffff"), 1);
  assert.equal(contrast("#bfbcb6", "#292827").toFixed(1), "7.8"); // --text-2 on --bg
});

test("every hue × state × theme keeps event text ≥ 4.5:1", () => {
  for (const theme of THEMES)
    for (const hue of HUES)
      for (const style of STYLES)
        for (const past of [false, true]) {
          const t = calTone(hue, theme, { style, past });
          const bgs = t.bg.startsWith("var(") ? CAL_SURFACES[theme] : [t.bg];
          for (const bg of bgs) assert.ok(contrast(t.fg, bg) >= 4.5, `${theme} ${hue} ${style} past=${past}: ${t.fg} on ${bg} = ${contrast(t.fg, bg).toFixed(2)}`);
        }
});

test("clamp: warm hues step to darker fills in Graphite, past stays distinct", () => {
  assert.equal(calTone("yellow", "graphite", { style: "filled", past: false }).bg, "#755c0a"); // step 90, 5.98
  assert.equal(calTone("orange", "graphite", { style: "filled", past: false }).bg, "#8f4900"); // step 90, 6.33
  assert.equal(calTone("lime", "graphite", { style: "filled", past: false }).bg, "#455c00"); // step 80, 7.19
  assert.equal(calTone("blue", "graphite", { style: "filled", past: false }).bg, "#1173a8"); // step 60
  assert.equal(calTone("blue", "graphite", { style: "filled", past: true }).bg, "#0a476d"); // step 90
  assert.notEqual(calTone("yellow", "graphite", { style: "filled", past: true }).bg, calTone("yellow", "graphite", { style: "filled", past: false }).bg);
  assert.equal(calTone("yellow", "paper", { style: "filled", past: true }).fg, "#755c0a"); // step 60 is 1.95:1
});

test("hueOf: colorId, both Google event palettes, nearest calendar color", () => {
  assert.equal(hueOf({ colorId: "5" }), "yellow");
  assert.equal(hueOf({ colorId: "11" }), "pink");
  assert.equal(hueOf({ hex: "#46d6db" }), "blue"); // classic Peacock (core EVENT_COLORS)
  assert.equal(hueOf({ hex: "#039be5" }), "blue"); // current Peacock
  assert.equal(hueOf({ hex: "#16a765" }), "green");
  assert.equal(hueOf({ hex: "#c2c2c2" }), "pewter");
  assert.equal(hueOf({ hex: "#a47ae2" }), "violet");
  assert.equal(hueOf({ hex: "#f83a22" }), "red");
  assert.equal(hueOf({}), "blue");
  assert.equal(hueOf({ hex: "nope" }), "blue");
});
