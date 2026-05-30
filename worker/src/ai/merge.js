import { clamp, formatUSD, isFiniteNumber } from "../utils/core.js";
import { notDetectedField } from "../bill/money-extract.js";

/**
 * AI Result Merging & Final Field Selection
 * Updated: May 30, 2026
 */

/**
 * Merge results from OpenAI and Gemini
 * Prefers OpenAI but falls back intelligently
 */
export function mergeAIResults(openAI, gemini) {
  const a = openAI && openAI.ok ? openAI : null;
  const g = gemini && gemini.ok ? gemini : null;
  const pick = a || g;
  if (!pick) return null;

  const fields = {
    totalCharges: pick?.fields?.totalCharges || null,
    insurancePaid: pick?.fields?.insurancePaid || null,
    patientResponsibility: pick?.fields?.patientResponsibility || null,
  };

  // If both AIs returned successfully, prefer OpenAI but keep any missing fields from Gemini
  if (a && g) {
    fields.totalCharges = a.fields?.totalCharges || g.fields?.totalCharges || null;
    fields.insurancePaid = a.fields?.insurancePaid || g.fields?.insurancePaid || null;
    fields.patientResponsibility = a.fields?.patientResponsibility || g.fields?.patientResponsibility || null;
  }

  // ✅ FIX: Catch duplicate AI amounts before they reach pickFinalField.
  // When both insurancePaid and patientResponsibility resolve to the same number,
  // the AI latched onto the same line for both fields (common on simple bills with
  // only one "Balance Due" / "Amount Due" line). Null out patientResponsibility so
  // the regex fallback in pickFinalField gets a chance to derive a correct value,
  // or so _fixDuplicateAmounts in processor/bill-processing can derive it from total.
  fields = _deduplicateAIFields(fields);

  return {
    summary: pick.summary || "",
    explanation: pick.explanation || "",
    nextSteps: Array.isArray(pick.nextSteps) ? pick.nextSteps : [],
    fields,
  };
}

/**
 * Detect when two AI fields resolved to the same amount and null out the weaker one.
 * patientResponsibility is nulled first because it is the most commonly mis-matched field
 * and the most harmful to show wrong (people might pay the wrong amount).
 */
function _deduplicateAIFields(fields) {
  const i = Number(fields.insurancePaid?.amount);
  const p = Number(fields.patientResponsibility?.amount);
  const t = Number(fields.totalCharges?.amount);

  const iOk = isFiniteNumber(i) && i > 0;
  const pOk = isFiniteNumber(p) && p > 0;
  const tOk = isFiniteNumber(t) && t > 0;

  // Nothing to do if either field is missing or they differ
  if (!iOk || !pOk) return fields;
  if (Math.abs(i - p) > 0.02) return fields;

  // They matched — derive the correct patient responsibility if we can
  if (tOk && t > i) {
    const derived = parseFloat((t - i).toFixed(2));
    return {
      ...fields,
      patientResponsibility: {
        amount: derived,
        currency: "USD",
        citations: [],
        _derived: true,
        _reason: "Derived: total charges minus insurance paid (AI returned duplicate values for both fields)",
      },
    };
  }

  // Can't derive — null out patientResponsibility so regex fallback runs
  return {
    ...fields,
    patientResponsibility: null,
  };
}

/**
 * Sanitize citations to prevent oversized or malformed data
 */
function sanitizeCitations(citations) {
  return (citations || [])
    .filter((c) => c && Number.isInteger(c.line) && typeof c.text === "string" && c.text.trim().length > 0)
    .slice(0, 6)
    .map((c) => ({
      line: c.line,
      text: c.text.slice(0, 180).trim(),
    }));
}

/**
 * Build a clean field object with citations (used when AI wins)
 */
function buildFieldWithCitations(label, amountNumber, sourceType, { reasonBase, citations, from }) {
  let confidence = 0.80;
  let reason = reasonBase;

  if (sourceType.includes("pdf")) confidence += 0.08;
  if (sourceType.includes("excel")) confidence += 0.05;
  if (sourceType.includes("ocr")) {
    confidence -= 0.18;
    reason += " (OCR can introduce noise)";
  }

  confidence = clamp(confidence, 0.20, 0.97);
  const raw = String(amountNumber.toFixed(2));

  return {
    label,
    value: formatUSD(raw),
    raw,
    confidence: Number(confidence.toFixed(2)),
    reason,
    source: sourceType,
    from,
    citations: sanitizeCitations(citations),
  };
}

/**
 * Decide final field value: prefer strong AI result with citations, otherwise use regex.
 * Also handles derived fields produced by _deduplicateAIFields.
 */
export function pickFinalField(label, aiField, regexField, sourceType) {
  // ✅ Handle derived fields (produced by _deduplicateAIFields when it calculated
  // patient responsibility as total - insurance). These have no citations by design
  // but are more trustworthy than a raw regex fallback on this type of bill.
  if (aiField && aiField._derived && isFiniteNumber(aiField.amount)) {
    const amt = Number(aiField.amount);
    let confidence = 0.72;
    if (sourceType.includes("pdf")) confidence += 0.05;
    if (sourceType.includes("ocr")) confidence -= 0.12;
    confidence = clamp(confidence, 0.20, 0.88);

    return {
      label,
      value: formatUSD(String(amt.toFixed(2))),
      raw: amt.toFixed(2),
      confidence: Number(confidence.toFixed(2)),
      reason: aiField._reason || "Derived from total charges and insurance paid",
      source: sourceType,
      from: "derived",
      citations: [],
    };
  }

  // Prefer AI if it returned a valid amount with citations
  if (
    aiField &&
    isFiniteNumber(aiField.amount) &&
    Array.isArray(aiField.citations) &&
    aiField.citations.length > 0
  ) {
    const amt = Number(aiField.amount);
    return buildFieldWithCitations(label, amt, sourceType, {
      reasonBase: "AI extracted with direct evidence citations",
      citations: aiField.citations,
      from: "ai",
    });
  }

  // Fall back to regex result if it's valid
  if (regexField && regexField.value !== "Not detected") {
    return {
      ...regexField,
      reason: (regexField.reason || "Regex extraction") + " (AI missing/uncertain)",
      from: "regex",
      citations: [],
    };
  }

  // Final fallback
  return notDetectedField(label, sourceType, "AI + regex could not confidently locate this field");
}
