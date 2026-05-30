import { isFiniteNumber } from "../utils/core.js";

/**
 * Sanity & Boost utilities for bill processing
 * Updated: May 30, 2026
 */

// Internal helper
function labelFromKey(key) {
  if (key === "totalCharges") return "Total Charges";
  if (key === "insurancePaid") return "Insurance Paid";
  if (key === "patientResponsibility") return "Patient Responsibility";
  return key;
}

/**
 * Enforce logical sanity rules on extracted amounts to prevent scary/wrong outputs
 */
export function enforceAmountSanity(text, sourceType, totalCharges, insurancePaid, patientResponsibility) {
  const t = parseFloat(totalCharges?.raw || 0);
  const i = parseFloat(insurancePaid?.raw || 0);
  const p = parseFloat(patientResponsibility?.raw || 0);

  // If total is missing, nothing to sanity-check.
  if (!isFiniteNumber(t) || t <= 0) return;

  // Patient responsibility can never be > total charges (for a single claim/summary).
  if (patientResponsibility?.value !== "Not detected" && isFiniteNumber(p) && p > t + 1) {
    patientResponsibility.label = "Patient Responsibility";
    patientResponsibility.value = "Not detected";
    patientResponsibility.raw = "";
    patientResponsibility.confidence = 0;
    patientResponsibility.reason =
      "Sanity check failed: extracted patient responsibility exceeded total charges (likely a deductible/limit figure).";
    patientResponsibility.source = sourceType || "unknown";
    patientResponsibility.from = "none";
    patientResponsibility.citations = [];
  }

  // Insurance paid should not massively exceed total charges.
  if (insurancePaid?.value !== "Not detected" && isFiniteNumber(i) && i > t * 1.25) {
    insurancePaid.value = "Not detected";
    insurancePaid.raw = "";
    insurancePaid.confidence = 0;
    insurancePaid.reason =
      "Sanity check failed: extracted insurance-paid exceeded total charges by a large margin (likely picked deductible/benefit balance).";
    insurancePaid.source = sourceType || "unknown";
    insurancePaid.from = "none";
    insurancePaid.citations = [];
  }

  // If both insurancePaid and patientResponsibility exist but sum is wildly off, downgrade the weaker one.
  const ii = parseFloat(insurancePaid?.raw || 0);
  const pp = parseFloat(patientResponsibility?.raw || 0);

  if (insurancePaid?.value !== "Not detected" && patientResponsibility?.value !== "Not detected") {
    if (isFiniteNumber(ii) && isFiniteNumber(pp) && (ii + pp) > t * 1.6) {
      // Prefer keeping patient responsibility if it came from strong "you owe" phrasing
      const low =
        (insurancePaid.confidence || 0) <= (patientResponsibility.confidence || 0)
          ? insurancePaid
          : patientResponsibility;

      low.value = "Not detected";
      low.raw = "";
      low.confidence = 0;
      low.reason = "Sanity check failed: amounts inconsistent with total charges.";
      low.source = sourceType || "unknown";
      low.from = "none";
      low.citations = [];
    }
  }
}

/**
 * Boost confidence when both OpenAI and Gemini agree on the same amount
 */
export function applyCrossAIAmountBoost(openAI, gemini, fields) {
  const o = openAI?.fields || {};
  const g = gemini?.fields || {};

  const pairs = [
    ["totalCharges", o.totalCharges, g.totalCharges],
    ["insurancePaid", o.insurancePaid, g.insurancePaid],
    ["patientResponsibility", o.patientResponsibility, g.patientResponsibility],
  ];

  for (const [key, a, b] of pairs) {
    if (!a || !b) continue;

    const aa = Number(a.amount);
    const bb = Number(b.amount);

    if (!isFiniteNumber(aa) || !isFiniteNumber(bb)) continue;

    const diff = Math.abs(aa - bb);
    const base = Math.max(aa, bb, 1);

    if (diff <= 2 || diff / base <= 0.01) {
      const target = fields.find((f) => f.label === labelFromKey(key));
      if (target && target.value !== "Not detected") {
        target.confidence = Math.min(1, Number((target.confidence + 0.06).toFixed(2)));
        target.reason += " + Both AIs agree on amount";
        target.source += "+ai2";
      }
    }
  }
}

/**
 * Boost confidence if the extracted amount appears verbatim in the original text
 */
export function applyInTextBoost(text, fields) {
  const t = String(text || "").replace(/,/g, "");

  for (const f of fields) {
    if (!f || !f.raw || f.value === "Not detected") continue;

    const raw = String(f.raw).replace(/,/g, "");
    if (raw && t.includes(raw)) {
      f.confidence = Math.min(1, Number((f.confidence + 0.04).toFixed(2)));
      f.reason += " + Amount appears verbatim in document";
    }
  }
}
