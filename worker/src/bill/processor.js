import { clamp, normalizeAmount, formatUSD, pickAmountGroup, isFiniteNumber } from "../utils/core.js";

import { extractTextFromPDF } from "../extractors/pdf.js";
import { extractWithOcrSpace } from "../extractors/ocr-space.js";
import { extractWithGoogleVision } from "../extractors/google-vision.js";
import { processExcel } from "../extractors/excel.js";

import { normalizeBillText, toNumberedLines } from "./text.js";
import { extractMoneyField } from "./money-extract.js";
import { enforceAmountSanity, applyCrossAIAmountBoost, applyInTextBoost } from "./sanity.js";
import { analyzeWithOpenAI_AIExtract } from "../ai/openai.js";
import { analyzeWithGemini_AIExtract } from "../ai/gemini.js";
import { mergeAIResults, pickFinalField } from "../ai/merge.js";

// ======================== SHARED BILL PROCESSING ========================

export async function processSingleBill(file, env) {
  const buffer = new Uint8Array(await file.arrayBuffer());
  const name = (file.name || "").toLowerCase();

  let rawText = "";
  let sourceType = "unknown";

  if (name.endsWith(".pdf")) {
    rawText = await extractTextFromPDF(buffer);
    if (!rawText || rawText.trim().length < 200) {
      const ocr = await extractWithOcrSpace(buffer, "application/pdf", env);
      rawText = ocr.text || rawText;
    }
    sourceType = rawText.length > 200 ? "pdf" : "pdf+ocr";
  }
  else if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    const pages = await processExcel(buffer);
    rawText = pages.map((p) => p.rawText).join("\n\n");
    sourceType = "excel";
  }
  else {
    // Images
    const gv = await extractWithGoogleVision(buffer, file.type, env);
    rawText = gv.text || "";
    if (!rawText || rawText.trim().length < 200) {
      const ocr = await extractWithOcrSpace(buffer, file.type, env);
      rawText = (ocr.text || "").length > rawText.length ? ocr.text : rawText;
    }
    sourceType = rawText.length > 200 ? "image" : "image+ocr";
  }

  const text = normalizeBillText(rawText);
  const lines = toNumberedLines(text);

  // Run both AIs in parallel
  const [openAI, gemini] = await Promise.all([
    analyzeWithOpenAI_AIExtract(lines, true, env),
    analyzeWithGemini_AIExtract(lines, true, env),
  ]);

  const aiMerged = mergeAIResults(openAI, gemini);

  // === Regex-based extraction (strong fallback) ===
  const regexTotalCharges = extractMoneyField(text, {
    label: "Total Charges",
    sourceType,
    lineKeywords: [
      "total charges", "total billed", "provider charges", "amount billed",
      "statement total", "billed amount", "total amount", "charges",
      "grand total", "your total", "total"
    ],
    strongRegexes: [
      /total\s*(charges?|billed|amount|your\s*total)\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
      /your\s*total\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
      /grand\s*total\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
    ],
    fallbackPick: "max",
  });

  const regexInsurancePaid = extractMoneyField(text, {
    label: "Insurance Paid",
    sourceType,
    lineKeywords: [
      "plan paid", "insurance paid", "your plan paid", "paid by plan", "paid by insurance",
      "insurance payment", "plan payment", "benefits paid", "insurer paid", "carrier paid",
      "discount", "write-off", "contractual adjustment", "adjustment", "allowed amount"
    ],
    strongRegexes: [
      /(your\s*)?(plan|insurance)\s*(paid|payment)\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
      /paid\s*by\s*(plan|insurance)\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
      /benefits\s*paid\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
      /insurer\s*paid\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
      /carrier\s*paid\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
      /contractual\s*(adjustment|allowance)\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
    ],
    fallbackPick: "best-near-keywords",
  });

  const regexPatientDue = extractMoneyField(text, {
    label: "Patient Responsibility",
    sourceType,
    lineKeywords: [
      "amount you owe", "you owe", "owe", "patient responsibility", "patient balance",
      "balance due", "amount due", "total due", "net due", "amt due",
      "you owe or already paid", "your responsibility", "member responsibility",
      "your share", "member share", "patient owes", "amount you may owe"
    ],
    strongRegexes: [
      /(amount\s*you\s*owe|amount\s*you\s*may\s*owe|you\s*owe(\s*or\s*already\s*paid)?|owe\s*or\s*already\s*paid)\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
      /(patient\s*(responsibility|balance|due|owe))\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
      /(balance\s*due|amount\s*due|total\s*due|net\s*due|amt\s*due)\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
      /(your\s*responsibility|member\s*responsibility|your\s*share|member\s*share)\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
    ],
    fallbackPick: "due",
  });

  const totalCharges = pickFinalField(
    "Total Charges",
    aiMerged?.fields?.totalCharges,
    regexTotalCharges,
    sourceType
  );

  const insurancePaid = pickFinalField(
    "Insurance Paid",
    aiMerged?.fields?.insurancePaid,
    regexInsurancePaid,
    sourceType
  );

  const patientResponsibility = pickFinalField(
    "Patient Responsibility",
    aiMerged?.fields?.patientResponsibility,
    regexPatientDue,
    sourceType
  );

  // ✅ CRITICAL SAFETY: prevent scary nonsense
  enforceAmountSanity(text, sourceType, totalCharges, insurancePaid, patientResponsibility);

  // ✅ FIX: Detect when insurancePaid and patientResponsibility resolved to the same value.
  // This happens when a bill has a single "Balance Due" or "Amount Due" line and both
  // fallback pickers latch onto it. In that case, derive patient responsibility from
  // total - insurance if we have enough data; otherwise mark it as not detected so we
  // don't show a clearly wrong duplicate to the user.
  _fixDuplicateAmounts(totalCharges, insurancePaid, patientResponsibility, sourceType);

  applyCrossAIAmountBoost(openAI, gemini, [totalCharges, insurancePaid, patientResponsibility]);
  applyInTextBoost(text, [totalCharges, insurancePaid, patientResponsibility]);

  return {
    rawText: text,
    structured: {
      keyAmounts: { totalCharges, insurancePaid, patientResponsibility },
      summary: aiMerged?.summary || getSmartSummary(totalCharges, insurancePaid, patientResponsibility),
      explanation: aiMerged?.explanation || getCalmExplanation(totalCharges, insurancePaid, patientResponsibility),
    },
    sourceType,
  };
}

// ======================== DUPLICATE AMOUNT GUARD ========================

/**
 * Fix the case where insurancePaid and patientResponsibility resolved to the same
 * dollar value. This almost always means one of them is wrong — typically the
 * patientResponsibility fallback grabbed the same "Balance Due" line that
 * insurancePaid already claimed, or vice versa.
 *
 * Resolution strategy (in priority order):
 *  1. If total is known and insurance is known, derive patient = total - insurance.
 *  2. If total is known but insurance is unknown, derive insurance = total - patient.
 *  3. If we can't derive anything safely, null out patientResponsibility so we
 *     never show an obviously wrong duplicate to the user.
 */
function _fixDuplicateAmounts(totalCharges, insurancePaid, patientResponsibility, sourceType) {
  const t = parseFloat(totalCharges?.raw || 0);
  const i = parseFloat(insurancePaid?.raw || 0);
  const p = parseFloat(patientResponsibility?.raw || 0);

  const tOk = isFiniteNumber(t) && t > 0 && totalCharges?.value !== "Not detected";
  const iOk = isFiniteNumber(i) && i > 0 && insurancePaid?.value !== "Not detected";
  const pOk = isFiniteNumber(p) && p > 0 && patientResponsibility?.value !== "Not detected";

  // Nothing to fix if they aren't both detected or aren't the same.
  if (!iOk || !pOk) return;
  if (Math.abs(i - p) > 0.02) return; // not a duplicate — different values

  // They matched. Figure out which one to trust more.
  const iConf = insurancePaid.confidence || 0;
  const pConf = patientResponsibility.confidence || 0;

  // Strategy 1: derive the lower-confidence field from total - other
  if (tOk) {
    if (iConf >= pConf) {
      // Trust insurance, derive patient
      const derived = Math.max(0, t - i);
      patientResponsibility.value = formatUSD(String(derived.toFixed(2)));
      patientResponsibility.raw = derived.toFixed(2);
      patientResponsibility.confidence = clamp(
        Number(((iConf + pConf) / 2 - 0.10).toFixed(2)),
        0.15,
        0.80
      );
      patientResponsibility.reason =
        "Derived: total charges minus insurance paid (duplicate field value detected — original values were identical)";
      patientResponsibility.source = sourceType || "unknown";
      patientResponsibility.from = "derived";
    } else {
      // Trust patient responsibility, derive insurance
      const derived = Math.max(0, t - p);
      insurancePaid.value = formatUSD(String(derived.toFixed(2)));
      insurancePaid.raw = derived.toFixed(2);
      insurancePaid.confidence = clamp(
        Number(((iConf + pConf) / 2 - 0.10).toFixed(2)),
        0.15,
        0.80
      );
      insurancePaid.reason =
        "Derived: total charges minus patient responsibility (duplicate field value detected — original values were identical)";
      insurancePaid.source = sourceType || "unknown";
      insurancePaid.from = "derived";
    }
    return;
  }

  // Strategy 2: total unknown — we can't derive anything safely.
  // Null out patientResponsibility (it's the field users care most about getting right).
  patientResponsibility.value = "Not detected";
  patientResponsibility.raw = "";
  patientResponsibility.confidence = 0;
  patientResponsibility.reason =
    "Could not determine: extracted value matched insurance paid exactly — likely the same line was matched twice. Check your EOB for the actual amount you owe.";
  patientResponsibility.source = sourceType || "unknown";
  patientResponsibility.from = "none";
  patientResponsibility.citations = [];
}

// ======================== ALL ORIGINAL FUNCTIONS BELOW (UNCHANGED & PRESERVED) ========================

export function getSmartSummary(total, ins, patient) {
  if (patient.value === "Not detected") return "We found the billed amount, but not what you owe.";
  if (ins.value === "Not detected") return "This appears to be a provider bill — insurance info may be on a separate EOB.";
  return "Your bill breakdown is ready below.";
}

export function getCalmExplanation(total, ins, patient) {
  const t = total.value !== "Not detected" ? total.value : "the full billed amount";
  const i = ins.value !== "Not detected" ? ins.value : "nothing yet";
  const p = patient.value !== "Not detected" ? patient.value : "unknown at this time";

  return (
    "Here's what this document is telling you in simple terms:\n\n" +
    `• The provider charged ${t} for the services.\n` +
    `• Your insurance has covered ${i} so far (this includes payments and discounts).\n` +
    `• The remaining amount you may be responsible for is ${p}.\n\n` +
    "Important: If this is just the hospital's itemized bill (not an EOB), your actual responsibility is usually much lower after insurance. " +
    "Always check your official Explanation of Benefits from your insurer — that's the final word on what you owe."
  );
}
