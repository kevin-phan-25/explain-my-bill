/**
 * Bill text normalization utilities
 * Updated: May 30, 2026
 */

/**
 * Clean and normalize raw extracted text from PDFs, OCR, etc.
 */
export function normalizeBillText(s) {
  if (!s) return "";

  return String(s)
    .replace(/\r/g, "\n")                    // normalize line endings
    .replace(/[ \t]+/g, " ")                 // collapse multiple spaces/tabs
    .replace(/\n{3,}/g, "\n\n")              // collapse excessive newlines
    .replace(/[•·]/g, "-")                   // replace bullet points
    .replace(/[-]{3,}/g, "---")              // normalize long dashes
    .replace(/[^\S\n]+/g, " ")               // normalize all whitespace except newlines
    .trim();
}

/**
 * Convert text into numbered lines for AI prompting
 * Limits to first 300 lines to avoid token limits
 */
export function toNumberedLines(text, maxLines = 300) {
  const lines = String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);                        // remove empty lines

  const capped = lines.slice(0, maxLines);

  return capped.map((l, i) => `${i + 1}. ${l}`).join("\n");
}

// Optional: Extended version if you want more aggressive cleaning later
export function normalizeBillTextAggressive(s) {
  if (!s) return "";
  let cleaned = normalizeBillText(s);

  // Extra aggressive cleanup (can be used selectively)
  cleaned = cleaned
    .replace(/\|+/g, "|")                    // collapse multiple pipes
    .replace(/[□■▪▫]/g, "-")                 // more bullet symbols
    .replace(/\u200B/g, "");                 // remove zero-width spaces

  return cleaned;
}
