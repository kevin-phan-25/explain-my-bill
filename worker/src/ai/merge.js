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

  return {
    summary: pick.summary || "",
    explanation: pick.explanation || "",
    nextSteps: Array.isArray(pick.nextSteps) ? pick.nextSteps : [],
    fields,
  };
}

/**
 * Sanitize citations to prevent oversized or malformed data
 */
function sanitizeCitations(citations) {
  return (citations || [])
    .filter((c) => c && Number.isInteger(c.line) && typeof c.text === "string" && c.text.trim().length > 0)
    .slice(0, 6)                                   // limit to reasonable number
    .map((c) => ({
      line: c.line,
      text: c.text.slice(0, 180).trim(),           // truncate long citations
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
 * Decide final field value: prefer strong AI result with citations, otherwise use regex
 */
export function pickFinalField(label, aiField, regexField, sourceType) {
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
