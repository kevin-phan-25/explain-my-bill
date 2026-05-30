/**
 * Core utilities for bill processing
 * Updated: May 30, 2026
 */

// Clamp a value between lo and hi
export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Check if value is a valid finite number
export function isFiniteNumber(x) {
  if (x == null) return false;
  const n = Number(x);
  return Number.isFinite(n) && !isNaN(n);
}

// Normalize messy money strings from bills/OCR
export function normalizeAmount(a) {
  if (a == null) return "";

  let s = String(a)
    .trim()
    .replace(/,/g, "")           // remove thousand separators
    .replace(/\$/g, "")          // remove dollar signs
    .replace(/\s/g, "");         // remove spaces

  // Handle common negative formats on bills
  if (s.startsWith("(") && s.endsWith(")")) {
    s = "-" + s.slice(1, -1);
  }
  if (s.startsWith("-")) {
    // keep the minus sign
  }

  return s.replace(/[^\d.-]/g, ""); // keep only digits, decimal, and minus
}

// Format number as clean USD string
export function formatUSD(input) {
  const cleaned = normalizeAmount(input);
  const n = Number(cleaned);

  if (!isFiniteNumber(n)) return "Not detected";

  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Pick the best amount from a regex match group (prefers last valid one)
export function pickAmountGroup(matchArray) {
  for (let i = matchArray.length - 1; i >= 1; i--) {
    const candidate = normalizeAmount(matchArray[i]);
    if (candidate && /^\d+(\.\d{2})?$/.test(candidate)) return candidate;
    if (candidate && /^\d+(\.\d+)?$/.test(candidate)) return candidate;
  }
  return null;
}

// Convert Uint8Array to Base64 (safe for Cloudflare Workers)
export function uint8ArrayToBase64(uint8) {
  let s = "";
  for (let i = 0; i < uint8.length; i += 0x8000) {
    s += String.fromCharCode(...uint8.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

// Safely parse JSON from potentially messy AI responses
export function safeParseJsonFromText(text) {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    const s = String(text || "").trim();
    if (s.length > 50000) return null; // prevent huge strings

    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      const sub = s.slice(start, end + 1);
      try {
        return JSON.parse(sub);
      } catch {
        return null;
      }
    }
    return null;
  }
}
