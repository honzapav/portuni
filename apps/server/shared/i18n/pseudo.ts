// The pseudo-locale (dev builds only): shows at a glance which text on screen
// is not coming from the catalog and whether the layout survives longer,
// accented translations. Every message is wrapped in ⟦…⟧, its letters get
// diacritics, and it is padded by 35 %. Interpolation placeholders and
// <Trans> tags are left untouched so the message still renders.

import type { PostProcessorModule } from "i18next";
import { PSEUDO_LOCALE } from "./config.js";

const ACCENTED: Record<string, string> = {
  a: "á",
  c: "č",
  d: "ď",
  e: "é",
  i: "í",
  l: "ĺ",
  n: "ň",
  o: "ó",
  r: "ř",
  s: "š",
  t: "ť",
  u: "ů",
  y: "ý",
  z: "ž",
  A: "Á",
  C: "Č",
  D: "Ď",
  E: "É",
  I: "Í",
  L: "Ĺ",
  N: "Ň",
  O: "Ó",
  R: "Ř",
  S: "Š",
  T: "Ť",
  U: "Ů",
  Y: "Ý",
  Z: "Ž",
};

export const PSEUDO_PADDING = 0.35;

export function pseudoLocalize(message: string): string {
  let out = "";
  let letters = 0;
  let i = 0;
  while (i < message.length) {
    // Copy <tag>, </tag>, <tag/> and {{placeholder}} verbatim.
    const rest = message.slice(i);
    const skip = rest.match(/^(<\/?[A-Za-z0-9_-]+\s*\/?>|\{\{[^}]*\}\})/);
    if (skip) {
      out += skip[0];
      i += skip[0].length;
      continue;
    }
    const ch = message[i];
    if (/\p{L}/u.test(ch)) letters += 1;
    out += ACCENTED[ch] ?? ch;
    i += 1;
  }
  const padding = "~".repeat(Math.ceil(letters * PSEUDO_PADDING));
  return `⟦${out}${padding}⟧`;
}

export const pseudoPostProcessor: PostProcessorModule = {
  type: "postProcessor",
  name: "pseudo",
  process(value: string, _key: string | string[], options: { lng?: string }, translator: {
    language?: string;
  }) {
    const lng = options?.lng ?? translator?.language;
    return lng === PSEUDO_LOCALE ? pseudoLocalize(value) : value;
  },
};
