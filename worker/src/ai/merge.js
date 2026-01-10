import { clamp, formatUSD, isFiniteNumber } from "../utils/core.js";
import { notDetectedField } from "../bill/money-extract.js";

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

function sanitizeCitations(citations) {
  return (citations || [])
    .filter((c) => c && Number.isInteger(c.line) && typeof c.text === "string")
    .slice(0, 6)
    .map((c) => ({
      line: c.line,
      text: c.text.slice(0, 180),
    }));
}

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
    citations: citations || [],
  };
}

export function pickFinalField(label, aiField, regexField, sourceType) {
  if (
    aiField &&
    isFiniteNumber(aiField.amount) &&
    Array.isArray(aiField.citations) &&
    aiField.citations.length
  ) {
    const amt = Number(aiField.amount);
    return buildFieldWithCitations(label, amt, sourceType, {
      reasonBase: "AI extracted with direct evidence citations",
      citations: sanitizeCitations(aiField.citations),
      from: "ai",
    });
  }

  if (regexField && regexField.value !== "Not detected") {
    return {
      ...regexField,
      reason: (regexField.reason || "Regex extraction") + " (AI missing/uncertain)",
      from: "regex",
      citations: [],
    };
  }

  return notDetectedField(label, sourceType, "AI + regex could not confidently locate this field");
}

