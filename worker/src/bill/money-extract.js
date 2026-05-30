import { clamp, normalizeAmount, formatUSD, pickAmountGroup, isFiniteNumber } from "../utils/core.js";

// ======================== ✅ FIX: STOP "$3.00" FROM DATES (03/28/2013) ========================
// Cloudflare PDF text often contains dates like "03/28/2013" which your old money regex treated as "03" => $3.00.
// We add a strict-first scanner that:
// - prefers $-prefixed amounts
// - ignores numbers sitting inside date-like contexts ("/" or "-")
// - ignores tiny 1–2 digit bare numbers unless they have cents and are not date-like
// We DO NOT remove legacy logic; we keep it as a fallback.

export function findFirstMoney(s) {
  // ✅ NEW strict path (prevents dates like 03/28/2013 turning into $3.00)
  const strict = findFirstMoney_STRICT(s);
  if (strict) return strict;

  // === legacy fallback (PRESERVED) ===
  const m = String(s).match(/\$?\s*([\d]{1,3}(?:,[\d]{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)/);
  if (!m) return null;
  const amt = normalizeAmount(m[1]);
  const val = Number(amt);
  if (!isFiniteNumber(val) || val <= 0) return null;
  return amt;
}

export function extractAllMoney(s) {
  // ✅ NEW strict path first (prevents date fragments "03" "04" etc)
  const strict = extractAllMoney_STRICT(s);
  if (strict && strict.length) return strict;

  // === legacy fallback (PRESERVED) ===
  const out = [];
  const rx = /\$?\s*([\d]{1,3}(?:,[\d]{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)/g;
  const str = String(s);
  let m;
  while ((m = rx.exec(str))) {
    const amt = normalizeAmount(m[1]);
    const val = Number(amt);
    if (!isFiniteNumber(val) || val <= 0) continue;
    if (val >= 1900 && val <= 2099) continue;
    out.push({ amount: amt, value: val });
    if (out.length > 250) break;
  }
  return out;
}

// ✅ NEW strict-first helpers (ADDED + IMPROVED)
function findFirstMoney_STRICT(input) {
  const s = String(input || "");
  if (!s) return null;

  // 1) Prefer explicit $ amounts
  const dollar = /\$\s*([\d]{1,3}(?:,[\d]{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)/g;
  let m;
  while ((m = dollar.exec(s))) {
    const amt = normalizeAmount(m[1]);
    if (!amt) continue;
    const val = Number(amt);
    if (!isFiniteNumber(val) || val <= 0) continue;
    if (val >= 1900 && val <= 2099) continue;
    if (isDateLikeContext(s, m.index)) continue;
    return amt;
  }

  // 2) Then allow non-$ amounts ONLY if they look like real money
  const loose = /([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[0-9]+(?:\.[0-9]{2}))/g;
  while ((m = loose.exec(s))) {
    const raw = m[1];
    const amt = normalizeAmount(raw);
    const val = Number(amt);
    if (!isFiniteNumber(val) || val <= 0) continue;
    if (val >= 1900 && val <= 2099) continue;

    const hasCents = /\.[0-9]{2}$/.test(raw);
    if (!hasCents && val < 10) continue;
    if (isDateLikeContext(s, m.index)) continue;

    return amt;
  }
  return null;
}

function extractAllMoney_STRICT(input) {
  const s = String(input || "");
  if (!s) return [];

  const out = [];

  // 1) Collect all explicit $ amounts first
  const dollar = /\$\s*([\d]{1,3}(?:,[\d]{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)/g;
  let m;
  while ((m = dollar.exec(s))) {
    const amt = normalizeAmount(m[1]);
    const val = Number(amt);
    if (!isFiniteNumber(val) || val <= 0) continue;
    if (val >= 1900 && val <= 2099) continue;
    if (isDateLikeContext(s, m.index)) continue;
    out.push({ amount: amt, value: val });
    if (out.length > 250) break;
  }

  // If we found $ amounts, that’s the cleanest set — return early.
  if (out.length) return out;

  // 2) Otherwise collect "money-like" numbers
  const loose = /([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[0-9]+(?:\.[0-9]{2}))/g;
  while ((m = loose.exec(s))) {
    const raw = m[1];
    const amt = normalizeAmount(raw);
    const val = Number(amt);
    if (!isFiniteNumber(val) || val <= 0) continue;
    if (val >= 1900 && val <= 2099) continue;

    const hasCents = /\.[0-9]{2}$/.test(raw);
    if (!hasCents && val < 10) continue;
    if (isDateLikeContext(s, m.index)) continue;

    out.push({ amount: amt, value: val });
    if (out.length > 250) break;
  }
  return out;
}

// ✅ Improved date context detection
function isDateLikeContext(str, idx) {
  const s = String(str || "");
  const i = Number(idx || 0);

  const left = s.slice(Math.max(0, i - 12), i + 1);
  const right = s.slice(i, Math.min(s.length, i + 18));
  const window = (left + right).replace(/\s+/g, "");

  if (/\d{1,4}[\/\-]\d{1,2}[\/\-]\d{1,4}/.test(window)) return true;
  if (/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(window)) return true;

  const before = s[i - 1] || "";
  const after = s[i + 1] || "";
  if ("/-".includes(before) || "/-".includes(after)) return true;

  return false;
}

export function notDetectedField(label, sourceType, why = "No clear matching line found") {
  return {
    label,
    value: "Not detected",
    confidence: 0,
    reason: why,
    source: sourceType || "none",
    from: "none",
    citations: [],
  };
}

function buildField(label, amountStr, sourceType, reasonBase) {
  const cleaned = normalizeAmount(amountStr);
  let confidence = 0.70;
  let reason = reasonBase;

  if (sourceType.includes("pdf")) confidence += 0.10;
  if (sourceType.includes("excel")) confidence += 0.05;
  if (sourceType.includes("ocr")) {
    confidence -= 0.18;
    reason += " (OCR text can be noisy)";
  }

  confidence = clamp(confidence, 0.15, 0.95);

  return {
    label,
    value: formatUSD(cleaned),
    confidence: Number(confidence.toFixed(2)),
    reason,
    source: sourceType,
    raw: cleaned,
    from: "regex",
    citations: [],
  };
}

function candidateMoneyByLine(lines, keywords) {
  const out = [];
  const kw = keywords.map((k) => k.toLowerCase());
  for (const line of lines) {
    const ll = line.toLowerCase();
    if (!kw.some((k) => ll.includes(k))) continue;
    const money = extractAllMoney(line);
    for (const m of money) out.push(m);
  }
  out.sort((a, b) => b.value - a.value);
  return out;
}

export function extractMoneyField(text, cfg) {
  const { label, sourceType, strongRegexes = [], lineKeywords = [], fallbackPick } = cfg;

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  // 1. Strong regexes
  for (const rx of strongRegexes) {
    const m = text.match(rx);
    if (m) {
      const amt = pickAmountGroup(m);
      if (amt) return buildField(label, amt, sourceType, "Matched strong labeled pattern");
    }
  }

  // 2. Direct keyword lines
  for (const line of lines) {
    const ll = line.toLowerCase();
    if (lineKeywords.some((k) => ll.includes(k.toLowerCase()))) {
      const amt = findFirstMoney(line);
      if (amt) return buildField(label, amt, sourceType, "Found amount on labeled line");
    }
  }

  // 3. Nearby window search
  for (let i = 0; i < lines.length; i++) {
    const ll = lines[i].toLowerCase();
    if (!lineKeywords.some((k) => ll.includes(k.toLowerCase()))) continue;

    const window = [lines[i], lines[i + 1] || "", lines[i + 2] || ""].join(" ");
    const amt = findFirstMoney(window);
    if (amt) return buildField(label, amt, sourceType, "Found amount near labeled text");
  }

  // 4. Fallbacks
  const allMoney = extractAllMoney(text);
  if (!allMoney.length) return notDetectedField(label, sourceType, "No currency values detected");

  if (fallbackPick === "due") {
    const dueCandidates = candidateMoneyByLine(lines, [
      "amount due", "balance due", "total due", "please pay", "you owe",
      "net due", "amt due", "pay this amount", "amount you may owe",
      "owe or already paid", "amount you owe or already paid"
    ]);
    if (dueCandidates.length) {
      return buildField(label, dueCandidates[0].amount, sourceType, "Fallback: selected due/balance amount");
    }
    const sorted = [...allMoney].sort((a, b) => b.value - a.value);
    return buildField(label, sorted[0].amount, sourceType, "Fallback: largest amount (heuristic)");
  }

  if (fallbackPick === "max") {
    const max = allMoney.reduce((a, b) => (b.value > a.value ? b : a));
    return buildField(label, max.amount, sourceType, "Fallback: selected largest amount");
  }

  if (fallbackPick === "best-near-keywords") {
    const near = candidateMoneyByLine(lines, ["insurance", "plan", "paid", "adjustment", "allowed", "write-off", "saved"]);
    if (near.length) {
      return buildField(label, near[0].amount, sourceType, "Fallback: amount near insurance keywords");
    }
  }

  return buildField(label, allMoney[0].amount, sourceType, "Fallback: first detected amount");
}
