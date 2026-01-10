export function normalizeBillText(s) {
  if (!s) return "";
  return String(s)
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[•·]/g, "-")
    .trim();
}

export function toNumberedLines(text) {
  const lines = String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const capped = lines.slice(0, 300);
  return capped.map((l, i) => `${i + 1}. ${l}`).join("\n");
}

