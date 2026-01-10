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
  } else if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    const pages = await processExcel(buffer);
    rawText = pages.map((p) => p.rawText).join("\n\n");
    sourceType = "excel";
  } else {
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

  const [openAI, gemini] = await Promise.all([
    analyzeWithOpenAI_AIExtract(lines, true, env),
    analyzeWithGemini_AIExtract(lines, true, env),
  ]);

  const aiMerged = mergeAIResults(openAI, gemini);

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

  // EOB-aware: look for "Amount you owe", "You owe or already paid", etc.
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
    "Here’s what this document is telling you in simple terms:\n\n" +
    `• The provider charged ${t} for the services.\n` +
    `• Your insurance has covered ${i} so far (this includes payments and discounts).\n` +
    `• The remaining amount you may be responsible for is ${p}.\n\n` +
    "Important: If this is just the hospital’s itemized bill (not an EOB), your actual responsibility is usually much lower after insurance. " +
    "Always check your official Explanation of Benefits from your insurer — that’s the final word on what you owe."
  );
}

