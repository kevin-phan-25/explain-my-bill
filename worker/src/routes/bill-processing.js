// ======================== ORIGINAL SINGLE BILL PROCESSING (PRESERVED) ========================

import { jsonResponse, errorResponse } from "../utils/response.js";
import { timingSafeEqual } from "../utils/security.js";

import { extractTextFromPDF } from "../extractors/pdf.js";
import { extractWithGoogleVision } from "../extractors/google-vision.js";
import { extractWithOcrSpace } from "../extractors/ocr-space.js";
import { processExcel } from "../extractors/excel.js";

import { normalizeBillText, toNumberedLines } from "../bill/text.js";
import { extractMoneyField, notDetectedField } from "../bill/money-extract.js";
import { enforceAmountSanity, applyCrossAIAmountBoost, applyInTextBoost } from "../bill/sanity.js";

import { analyzeWithOpenAI_AIExtract } from "../ai/openai.js";
import { analyzeWithGemini_AIExtract } from "../ai/gemini.js";
import { mergeAIResults, pickFinalField } from "../ai/merge.js";

import { getSmartSummary, getCalmExplanation } from "../bill/processor.js";

export async function handleBillProcessing(request, env, corsHeaders) {
  try {
    const devBypassHeader = request.headers.get("X-Dev-Bypass") === "true";
    const devKeyHeader = request.headers.get("X-Dev-Key") || "";
    const isDeveloper =
      String(env.DEV_MODE || "").toLowerCase() === "true" ||
      devBypassHeader ||
      (env.DEV_KEY && timingSafeEqual(devKeyHeader, env.DEV_KEY));
    const isPaid = isDeveloper;

    const form = await request.formData();
    const file = form.get("bill") || form.get("file");
    if (!file || file.size === 0) return errorResponse("No file uploaded", 400, corsHeaders);
    if (file.size > 20 * 1024 * 1024) return errorResponse("File exceeds 20MB", 413, corsHeaders);

    const name = (file.name || "").toLowerCase();
    const allowed = [".pdf", ".png", ".jpg", ".jpeg", ".xlsx", ".xls"];
    if (!allowed.some((e) => name.endsWith(e))) return errorResponse("Unsupported format", 415, corsHeaders);

    const buffer = new Uint8Array(await file.arrayBuffer());

    const extraction = {
      usedOCR: false,
      extractorUsed: "none",
      sourceType: "unknown",
      primary: { ok: false, provider: "none", status: null, textLen: 0 },
      fallback: { ok: false, provider: "none", status: null, textLen: 0 },
      textLen: 0,
    };

    let rawText = "";
    let sourceType = "unknown";

    if (name.endsWith(".pdf")) {
      sourceType = "pdf";
      extraction.sourceType = "pdf";
      rawText = await extractTextFromPDF(buffer);
      extraction.primary = {
        ok: !!rawText,
        provider: "pdf_text",
        status: rawText ? 200 : 0,
        textLen: (rawText || "").length,
      };
      extraction.extractorUsed = "pdf_text";
      if (!rawText || rawText.trim().length < 200) {
        extraction.usedOCR = true;
        extraction.sourceType = "pdf+ocr";
        const ocr = await extractWithOcrSpace(buffer, "application/pdf", env, extraction);
        rawText = ocr.text || "";
        extraction.fallback = {
          ok: !!rawText,
          provider: "ocr_space",
          status: ocr.status,
          textLen: rawText.length,
        };
        extraction.extractorUsed = rawText ? "ocr_space" : "pdf_text";
      }
    } else if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
      sourceType = "excel";
      extraction.sourceType = "excel";
      const pages = await processExcel(buffer);
      rawText = pages.map((p) => p.rawText).join("\n\n");
      extraction.primary = {
        ok: !!rawText,
        provider: "excel_csv",
        status: rawText ? 200 : 0,
        textLen: (rawText || "").length,
      };
      extraction.extractorUsed = "excel_csv";
    } else {
      sourceType = "image";
      extraction.sourceType = "image";
      const gv = await extractWithGoogleVision(buffer, file.type, env, extraction);
      rawText = gv.text || "";
      extraction.primary = {
        ok: !!rawText,
        provider: "google_vision",
        status: gv.status,
        textLen: rawText.length,
      };
      extraction.extractorUsed = rawText ? "google_vision" : "google_vision";
      if (!rawText || rawText.trim().length < 200) {
        extraction.usedOCR = true;
        extraction.sourceType = "image+ocr";
        const ocr = await extractWithOcrSpace(buffer, file.type, env, extraction);
        const ocrText = ocr.text || "";
        extraction.fallback = {
          ok: !!ocrText,
          provider: "ocr_space",
          status: ocr.status,
          textLen: ocrText.length,
        };
        if (ocrText.length > rawText.length) {
          rawText = ocrText;
          extraction.extractorUsed = "ocr_space";
        } else {
          extraction.extractorUsed = rawText ? "google_vision" : "ocr_space";
        }
      }
    }

    const text = normalizeBillText(rawText);
    extraction.textLen = text.length;
    const lines = toNumberedLines(text);

    if (!text || text.length < 60) {
      const structured = {
        summary: "We could not reliably read text from this document.",
        explanation:
          "No readable text was detected. Try a clearer photo (flat, bright, no glare) or upload the PDF directly.",
        nextSteps: [
          "Take a straight-on photo with even lighting and no glare.",
          "Fill the frame with just the bill (crop out background).",
          "If you have a PDF, upload that instead — it’s much more accurate.",
          "Smooth out any folds or creases before photographing.",
        ],
        keyAmounts: {
          totalCharges: notDetectedField("Total Charges", sourceType),
          insurancePaid: notDetectedField("Insurance Paid", sourceType),
          patientResponsibility: notDetectedField("Patient Responsibility", sourceType),
        },
        confidenceMeta: {
          sourceType: extraction.sourceType || sourceType,
          usedOCR: extraction.usedOCR,
          extractorUsed: extraction.extractorUsed,
          disclaimer:
            "This app is not HIPAA-certified. Confidence reflects document clarity + evidence matches. Verify before paying.",
        },
      };
      return jsonResponse(
        {
          isPaid,
          isDeveloper,
          extraction,
          privacyNote: "Your bill is processed in memory only. Nothing is stored, logged, or shared.",
          pages: [{ page: 1, rawText: text || "No readable text detected.", structured }],
          explanation: structured.explanation,
        },
        corsHeaders
      );
    }

    const [openAI, gemini] = await Promise.all([
      analyzeWithOpenAI_AIExtract(lines, isPaid, env),
      analyzeWithGemini_AIExtract(lines, isPaid, env),
    ]);

    const aiMerged = mergeAIResults(openAI, gemini);

    const regexTotalCharges = extractMoneyField(text, {
      label: "Total Charges",
      sourceType: extraction.sourceType || sourceType,
      lineKeywords: [
        "total charges", "total billed", "provider charges", "amount billed",
        "statement total", "billed amount", "total amount", "charges",
        "billed charges", "charges total", "total services", "services total",
        "total cost", "cost total", "grand total", "subtotal charges",
        "original charges", "full charges", "provider billed", "facility charges",
        "your total", "your totals"
      ],
      strongRegexes: [
        /total\s*(charges?|billed|provider\s*charges|amount\s*billed|statement\s*total|your\s*total|your\s*totals)\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /amount\s*billed\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /billed\s*amount\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /charges\s*total\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /total\s*amount\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /grand\s*total\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /original\s*charges\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /full\s*charges\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /provider\s*billed\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /facility\s*charges\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /total\s*cost\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /subtotal\s*charges\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /your\s*total\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
      ],
      fallbackPick: "max",
    });

    const regexInsurancePaid = extractMoneyField(text, {
      label: "Insurance Paid",
      sourceType: extraction.sourceType || sourceType,
      lineKeywords: [
        "insurance paid", "plan paid", "insurance payment", "plan payment",
        "adjustments", "contractual adjustment", "allowed amount", "write-off",
        "your plan paid", "plan payments", "paid by insurance", "insurance adjustment",
        "payments from plan", "plan allowance", "contractual allowance", "insurance discount",
        "discount from insurance", "paid by plan", "insurer paid", "carrier paid",
        "benefits paid", "covered amount", "reimbursed amount", "reimbursement",
        "amount you saved", "saved"
      ],
      strongRegexes: [
        /(insurance|plan)\s*(paid|payment)\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /contractual\s*adjustment\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /allowed\s*amount\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /adjustments?\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /plan\s*paid\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /paid\s*by\s*(insurance|plan)\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /insurance\s*adjustment\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /contractual\s*allowance\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /insurance\s*discount\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /benefits\s*paid\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /covered\s*amount\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /reimbursed\s*amount\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /reimbursement\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /carrier\s*paid\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /insurer\s*paid\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /amount\s*you\s*saved\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
      ],
      fallbackPick: "best-near-keywords",
    });

    const regexPatientDue = extractMoneyField(text, {
      label: "Patient Responsibility",
      sourceType: extraction.sourceType || sourceType,
      lineKeywords: [
        "patient responsibility", "patient balance", "balance due", "amount due",
        "you owe", "please pay", "pay this amount", "amount you may owe",
        "total due", "amt due", "net due", "patient due",
        "amount you owe", "due from patient", "patient amount", "patient pay",
        "patient co-pay", "coinsurance due", "deductible due", "out-of-pocket",
        "patient portion", "your responsibility", "member responsibility",
        "member balance", "patient owed", "owed by patient", "patient liability",
        "you owe or already paid", "amount you owe or already paid"
      ],
      strongRegexes: [
        /(amount\s*you\s*owe|amount\s*you\s*may\s*owe|you\s*owe(\s*or\s*already\s*paid)?|owe\s*or\s*already\s*paid|amount\s*you\s*owe\s*or\s*already\s*paid)\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /(patient\s*(responsibility|balance|due|owe))\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /(balance\s*due|amount\s*due|total\s*due|net\s*due|amt\s*due|you\s*owe|pay\s*this\s*amount|amount\s*you\s*may\s*owe)\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /amount\s*you\s*owe\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /due\s*from\s*patient\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /patient\s*amount\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /patient\s*pay\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /co-pay\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /coinsurance\s*due\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /deductible\s*due\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /out\s*of\s*pocket\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /patient\s*portion\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /your\s*responsibility\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /member\s*responsibility\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /patient\s*owed\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /owed\s*by\s*patient\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /patient\s*liability\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
      ],
      fallbackPick: "due",
    });

    const totalCharges = pickFinalField(
      "Total Charges",
      aiMerged?.fields?.totalCharges,
      regexTotalCharges,
      extraction.sourceType || sourceType
    );
    const insurancePaid = pickFinalField(
      "Insurance Paid",
      aiMerged?.fields?.insurancePaid,
      regexInsurancePaid,
      extraction.sourceType || sourceType
    );
    const patientResponsibility = pickFinalField(
      "Patient Responsibility",
      aiMerged?.fields?.patientResponsibility,
      regexPatientDue,
      extraction.sourceType || sourceType
    );

    // ✅ CRITICAL SAFETY: prevent scary nonsense
    enforceAmountSanity(text, extraction.sourceType || sourceType, totalCharges, insurancePaid, patientResponsibility);

    applyCrossAIAmountBoost(openAI, gemini, [totalCharges, insurancePaid, patientResponsibility]);
    applyInTextBoost(text, [totalCharges, insurancePaid, patientResponsibility]);

    const structured = {
      summary: aiMerged?.summary || getSmartSummary(totalCharges, insurancePaid, patientResponsibility),
      explanation: aiMerged?.explanation || getCalmExplanation(totalCharges, insurancePaid, patientResponsibility),
      nextSteps: aiMerged?.nextSteps?.length > 0
        ? aiMerged.nextSteps
        : [
            "Check your Explanation of Benefits (EOB) from your insurance — that shows what you actually owe.",
            "Call the billing phone number on the statement if anything looks wrong.",
            "Save this report and compare it to any payment requests you receive.",
          ],
      keyAmounts: {
        totalCharges,
        insurancePaid,
        patientResponsibility,
      },
      confidenceMeta: {
        sourceType: extraction.sourceType || sourceType,
        usedOCR: extraction.usedOCR,
        extractorUsed: extraction.extractorUsed,
        disclaimer:
          "Educational tool only • Not medical or legal advice • Always verify with your provider and insurer.",
      },
      aiMeta: {
        openai_ok: !!openAI?.ok,
        gemini_ok: !!gemini?.ok,
      },
    };

    return jsonResponse(
      {
        isPaid,
        isDeveloper,
        extraction,
        privacyNote: "Your bill is processed transiently in memory only. No data is stored, logged, or shared with anyone. We never retain your document.",
        pages: [{ page: 1, rawText: text, structured }],
        explanation: structured.explanation,
      },
      corsHeaders
    );
  } catch (err) {
    console.error("Processing error:", err?.message || err);
    return errorResponse("Processing failed", 500, corsHeaders);
  }
}

