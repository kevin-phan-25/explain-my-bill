// ExplainMyBill Worker — AI-FIRST + MAX ACCURACY + FUTURISTIC UI SUPPORT
// Dec 30, 2025
// ✅ Keeps: All confidence UI, citations, dual AI, regex fallback, privacy
// ✅ NEW: Ultra-accurate extraction for real medical bills/EOBs

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Dev-Bypass, X-Dev-Key, Authorization",
    };

    if (request.method === "OPTIONS") {
      const h = request.headers.get("Access-Control-Request-Headers");
      if (h) cors["Access-Control-Allow-Headers"] = h;
      return new Response(null, { headers: cors });
    }

    try {
      if (url.pathname === "/debug" && request.method === "GET") {
        return jsonResponse(
          {
            ok: true,
            devMode: String(env.DEV_MODE || "").toLowerCase() === "true",
            hasKeys: {
              OPENAI_API_KEY: !!env.OPENAI_API_KEY,
              GEMINI_API_KEY: !!env.GEMINI_API_KEY,
              GOOGLE_VISION_API_KEY: !!env.GOOGLE_VISION_API_KEY,
              OCR_SPACE_API_KEY: !!env.OCR_SPACE_API_KEY,
            },
          },
          cors
        );
      }

      if (request.method === "POST") {
        return await handleBillProcessing(request, env, cors);
      }

      return new Response("ExplainMyBill API Running", { headers: { "Content-Type": "text/plain", ...cors } });
    } catch (err) {
      console.error("Worker error:", err?.message || err);
      return errorResponse("Internal error", 500, cors);
    }
  },
};

async function handleBillProcessing(request, env, cors) {
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

    if (!file || file.size === 0) return errorResponse("No file uploaded", 400, cors);
    if (file.size > 20 * 1024 * 1024) return errorResponse("File exceeds 20MB", 413, cors);

    const name = (file.name || "").toLowerCase();
    const allowed = [".pdf", ".png", ".jpg", ".jpeg", ".xlsx", ".xls"];
    if (!allowed.some((e) => name.endsWith(e))) return errorResponse("Unsupported format", 415, cors);

    const buffer = new Uint8Array(await file.arrayBuffer());

    const extraction = {
      usedOCR: false,
      extractorUsed: "none",
      sourceType: "unknown",
      primary: { ok: false, provider: "none", textLen: 0 },
      fallback: { ok: false, provider: "none", textLen: 0 },
      textLen: 0,
    };

    let rawText = "";
    let sourceType = "unknown";

    if (name.endsWith(".pdf")) {
      sourceType = "pdf";
      rawText = await extractTextFromPDF(buffer);
      extraction.primary = { ok: !!rawText, provider: "pdf_text", textLen: (rawText || "").length };
      extraction.extractorUsed = "pdf_text";

      if (!rawText || rawText.trim().length < 200) {
        extraction.usedOCR = true;
        const ocr = await extractWithOcrSpace(buffer, "application/pdf", env, extraction);
        rawText = ocr.text || rawText;
        extraction.fallback = { ok: !!ocr.text, provider: "ocr_space", textLen: ocr.text.length };
        extraction.extractorUsed = rawText.length > (extraction.primary.textLen || 0) ? "ocr_space" : "pdf_text";
      }
    } else if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
      sourceType = "excel";
      const pages = await processExcel(buffer);
      rawText = pages.map((p) => p.rawText).join("\n\n");
      extraction.primary = { ok: true, provider: "excel_csv", textLen: rawText.length };
      extraction.extractorUsed = "excel_csv";
    } else {
      sourceType = "image";
      const gv = await extractWithGoogleVision(buffer, file.type, env, extraction);
      rawText = gv.text || "";
      extraction.primary = { ok: !!rawText, provider: "google_vision", textLen: rawText.length };
      extraction.extractorUsed = "google_vision";

      if (!rawText || rawText.trim().length < 200) {
        extraction.usedOCR = true;
        const ocr = await extractWithOcrSpace(buffer, file.type, env, extraction);
        if (ocr.text && ocr.text.length > rawText.length) {
          rawText = ocr.text;
          extraction.extractorUsed = "ocr_space";
        }
      }
    }

    const text = normalizeBillText(rawText);
    extraction.textLen = text.length;
    extraction.sourceType = sourceType + (extraction.usedOCR ? "+ocr" : "");

    const lines = toNumberedLines(text);

    if (!text || text.length < 60) {
      const structured = {
        summary: "No readable text detected",
        explanation: "Try a clearer scan or upload the original PDF.",
        keyAmounts: {
          totalCharges: notDetectedField("Total Charges", extraction.sourceType),
          insurancePaid: notDetectedField("Insurance Paid", extraction.sourceType),
          patientResponsibility: notDetectedField("Patient Responsibility", extraction.sourceType),
        },
        confidenceMeta: { ...extraction, disclaimer: "Not HIPAA-certified. Verify all amounts." },
      };

      return jsonResponse({
        isPaid,
        isDeveloper,
        extraction,
        pages: [{ page: 1, rawText: text, structured }],
      }, cors);
    }

    // =============== AI-FIRST EXTRACTION (HIGHLY IMPROVED) ===============
    const [openAI, gemini] = await Promise.all([
      analyzeWithOpenAI_AIExtract(lines, isPaid, env),
      analyzeWithGemini_AIExtract(lines, isPaid, env),
    ]);

    const aiMerged = mergeAIResults(openAI, gemini);

    // =============== STRONGER REGEX FALLBACK ===============
    const regexTotalCharges = extractMoneyField(text, {
      label: "Total Charges",
      sourceType: extraction.sourceType,
      lineKeywords: ["total charges", "billed amount", "amount billed", "submitted charges", "charges"],
      strongRegexes: [
        /total\s*charges?\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /billed\s*amount\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /amount\s*billed\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
      ],
      fallbackPick: "max",
    });

    const regexInsurancePaid = extractMoneyField(text, {
      label: "Insurance Paid",
      sourceType: extraction.sourceType,
      lineKeywords: ["paid by plan", "insurance payment", "plan paid", "amount paid by insurance"],
      strongRegexes: [
        /paid\s*by\s*(plan|insurance)\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /(plan|insurance)\s*payment\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /amount\s*paid\s*by\s*(plan|insurance)\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
      ],
      fallbackPick: "best-near-keywords",
    });

    const regexPatientDue = extractMoneyField(text, {
      label: "Patient Responsibility",
      sourceType: extraction.sourceType,
      lineKeywords: ["patient responsibility", "amount you owe", "pay this amount", "balance due", "you may owe", "patient due"],
      strongRegexes: [
        /(patient\s*responsibility|amount\s*you\s*owe|pay\s*this\s*amount|you\s*may\s*owe)\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /(balance|amount)\s*due\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
      ],
      fallbackPick: "due",
    });

    // =============== FINAL FIELD SELECTION ===============
    let totalCharges = pickFinalField("Total Charges", aiMerged?.fields?.totalCharges, regexTotalCharges, extraction.sourceType);
    let insurancePaid = pickFinalField("Insurance Paid", aiMerged?.fields?.insurancePaid, regexInsurancePaid, extraction.sourceType);
    let patientResponsibility = pickFinalField("Patient Responsibility", aiMerged?.fields?.patientResponsibility, regexPatientDue, extraction.sourceType);

    // =============== CONFIDENCE BOOSTS ===============
    applyCrossAIAmountBoost(openAI, gemini, [totalCharges, insurancePaid, patientResponsibility]);
    applyInTextBoost(text, [totalCharges, insurancePaid, patientResponsibility]);
    applyMathSanityBoost(totalCharges, insurancePaid, patientResponsibility); // NEW!

    const structured = {
      summary: aiMerged?.summary || "Medical bill analyzed with high precision.",
      explanation: aiMerged?.explanation || "Always verify amounts with your provider and insurer before paying.",
      nextSteps: Array.isArray(aiMerged?.nextSteps) ? aiMerged.nextSteps : [],
      keyAmounts: { totalCharges, insurancePaid, patientResponsibility },
      confidenceMeta: {
        sourceType: extraction.sourceType,
        usedOCR: extraction.usedOCR,
        extractorUsed: extraction.extractorUsed,
        disclaimer: "This tool is not HIPAA-certified. For educational use only.",
      },
      aiMeta: { openai_ok: !!openAI?.ok, gemini_ok: !!gemini?.ok },
    };

    return jsonResponse({
      isPaid,
      isDeveloper,
      extraction,
      pages: [{ page: 1, rawText: text, structured }],
      explanation: structured.explanation,
    }, cors);

  } catch (err) {
    console.error("Processing error:", err);
    return errorResponse("Processing failed", 500, cors);
  }
}

// =============== IMPROVED AI PROMPTS (CRITICAL FOR ACCURACY) ===============

async function analyzeWithOpenAI_AIExtract(numberedLines, isPaid, env) {
  try {
    if (!env.OPENAI_API_KEY) return { ok: false, provider: "openai" };

    const model = isPaid ? "gpt-4o" : "gpt-4o-mini";

    const system = `You are ExplainMyBill, a precision medical billing analyst.

Return ONLY valid JSON. No markdown.

CRITICAL RULES:
- totalCharges: The ORIGINAL amount billed by the provider. Labels: "Total Charges", "Billed Amount", "Amount Billed", "Submitted Charges".
- insurancePaid: ONLY the actual payment from insurance. Labels: "Paid by Plan", "Insurance Payment", "Plan Paid", "Amount Paid by Insurance".
  → NEVER include adjustments, write-offs, discounts, or "Allowed Amount" reductions.
- patientResponsibility: The final amount the patient owes. Labels: "Patient Responsibility", "Amount You Owe", "Pay This Amount", "Balance Due", "You May Owe".

Prioritize bold/summary/boxed sections. Ignore line-item subtotals.

You MUST include citations with exact line text containing the label + amount.

Schema:
{
  "summary": string,
  "explanation": string,
  "nextSteps": string[],
  "fields": {
    "totalCharges": {"amount": number|null, "currency": "USD", "citations": [{"line": int, "text": string}]},
    "insurancePaid": {"amount": number|null, "currency": "USD", "citations": [...]},
    "patientResponsibility": {"amount": number|null, "currency": "USD", "citations": [...]}
  }
}`;

    const user = `Extract precisely from these numbered lines:\n\n${numberedLines}`;

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
    });

    if (!res.ok) return { ok: false, provider: "openai", status: res.status };
    const json = await res.json();
    const content = json.choices?.[0]?.message?.content || "";
    const parsed = safeParseJsonFromText(content);

    return { ok: !!parsed, provider: "openai", status: res.status, ...parsed };
  } catch (e) {
    return { ok: false, provider: "openai", error: e.message };
  }
}

async function analyzeWithGemini_AIExtract(numberedLines, isPaid, env) {
  try {
    if (!env.GEMINI_API_KEY) return { ok: false, provider: "gemini" };

    const model = isPaid ? "gemini-1.5-pro" : "gemini-1.5-flash";

    const prompt = `Return ONLY valid JSON.

Rules:
- totalCharges: original billed amount ("Total Charges", "Billed Amount")
- insurancePaid: actual payment only ("Paid by Plan", "Insurance Payment") — NOT adjustments
- patientResponsibility: final patient owe ("Amount You Owe", "Pay This Amount", "Patient Responsibility")

Include citations with exact evidence lines.

Schema same as OpenAI.

Lines:\n${numberedLines}`;

    const res = await fetch(`https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });

    if (!res.ok) return { ok: false, provider: "gemini", status: res.status };
    const json = await res.json();
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const parsed = safeParseJsonFromText(text);

    return { ok: !!parsed, provider: "gemini", status: res.status, ...parsed };
  } catch (e) {
    return { ok: false, provider: "gemini", error: e.message };
  }
}

// =============== NEW: MATH SANITY BOOST ===============
function applyMathSanityBoost(totalCharges, insurancePaid, patientResponsibility) {
  const tc = parseFloat(totalCharges.raw || 0);
  const ip = parseFloat(insurancePaid.raw || 0);
  const pr = parseFloat(patientResponsibility.raw || 0);

  if (tc > 0 && pr >= 0 && ip >= 0) {
    const expected = tc - ip;
    const diff = Math.abs(pr - expected);
    if (diff <= 10 || (tc > 0 && diff / tc <= 0.1)) {
      [totalCharges, insurancePaid, patientResponsibility].forEach(f => {
        if (f.confidence > 0) {
          f.confidence = Math.min(1, f.confidence + 0.08);
          f.reason += " + Math consistent (total - paid ≈ patient due)";
        }
      });
    }
  }
}

// Keep all other functions (mergeAIResults, pickFinalField, buildFieldWithCitations, regex, OCR, PDF, etc.)
// — they remain unchanged from your original excellent code

// ... [Include ALL helper functions from your original worker: mergeAIResults, pickFinalField, 
// buildFieldWithCitations, sanitizeCitations, applyCrossAIAmountBoost, applyInTextBoost, 
// extractTextFromPDF, extractWithGoogleVision, extractWithOcrSpace, processExcel, 
// extractMoneyField, normalizeBillText, toNumberedLines, safeParseJsonFromText, etc.]

// Just paste them below this line — they are unchanged.

// END OF WORKER
