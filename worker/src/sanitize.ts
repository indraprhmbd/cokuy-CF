// Reply sanitizer: the model sometimes emits literal mojibake (e.g. U+2261
// U+0192 sequences where an emoji should be) plus non-Latin script leaks.
// Telegram renders UTF-8, so these arrive as visible garbage, not a display
// error: the corruption is in the data. Prompt guards reduce it but the model
// disobeys, so scrub deterministically before persist + send.
//
// Policy: allow ASCII printable, newline/tab, a small EXTRA set of common
// punctuation/symbols, joining/variation marks needed for emoji sequences,
// and Extended_Pictographic (real emoji). Deny everything else: Latin-1
// lookalikes that carry mojibake (U+0192 LATIN SMALL F HOOK etc), math and
// box-drawing symbols (U+2261 IDENTICAL TO etc), C1 controls, and whole
// non-Latin scripts (Han, Greek, Cyrillic...). Indonesian casual text plus
// common emoji passes untouched; anything exotic is stripped, never sent.
// NFC first so combining marks stay attached to their base.

const EXTRA = new Set([
  "\u2026", // … ellipsis
  "\u2014", // — em dash
  "\u2013", // – en dash
  "\u2018", // ‘
  "\u2019", // ’
  "\u201C", // “
  "\u201D", // ”
  "\u00AB", // «
  "\u00BB", // »
  "\u2022", // • bullet
  "\u00B0", // ° degree
  "\u20AC", // € euro
  "\u00D7", // ×
  "\u00F7", // ÷
  "\u200D", // ZWJ (emoji sequences)
  "\u20E3", // combining enclosing keycap
]);

const EMOJI = /\p{Extended_Pictographic}/u;

function keep(ch: string): boolean {
  if (ch === "\n" || ch === "\t") return true;
  const cp = ch.codePointAt(0)!;
  // Lone surrogates (split pairs, invalid scalars): always drop.
  if (cp >= 0xd800 && cp <= 0xdfff) return false;
  if (cp >= 0x20 && cp <= 0x7e) return true; // ASCII printable
  if (EXTRA.has(ch)) return true;
  return EMOJI.test(ch);
}

export function sanitizeReply(s: string): { text: string; stripped: number } {
  const norm = s.normalize("NFC");
  let out = "";
  let stripped = 0;
  for (const ch of norm) {
    if (keep(ch)) out += ch;
    else stripped++;
  }
  return { text: out, stripped };
}
