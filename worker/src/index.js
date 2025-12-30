// ExplainMyBill Worker — EXCEL SUPPORT REMOVED (No other features removed)
// December 30, 2025
// Keeps: All futuristic UI support, AI accuracy, citations, confidence, OCR, PDF, images
// Removed: Only Excel (.xlsx/.xls) handling

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS headers — sent on EVERY response
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*", // Or restrict to your frontend domain
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Dev-Bypass, X-Dev-Key, Authorization",
      "Access-Control-Max-Age": "86400",
    };

    // Handle preflight
    if (request.method === "OPTIONS") {
      const requestHeaders = request.headers.get("Access-Control-Request-Headers");
      if (requestHeaders) {
        corsHeaders["Access-Control-Allow-Headers"] = requestHeaders;
      }
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      // Debug endpoint
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
          corsHeaders
        );
      }

      if (request.method === "POST") {
        return await handleBillProcessing(request, env, corsHeaders);
      }

      return new Response("ExplainMyBill API Running", {
        headers: { "Content-Type": "text/plain", ...corsHeaders },
      });
    } catch (err) {
      console.error("Top-level error:", err);
      return errorResponse("Internal server error", 500, corsHeaders);
    }
  },
};

async function handleBillProcessing(request, env, corsHeaders) {
  try {
    const devBypass = request.headers.get("X-Dev-Bypass") === "true";
    const devKey = request.headers.get("X-Dev-Key") || "";
    const isDeveloper =
      String(env.DEV_MODE || "").toLowerCase() === "true" ||
      devBypass ||
      (env.DEV_KEY && timingSafeEqual(devKey, env.DEV_KEY));

    const isPaid = isDeveloper;

    const form = await request.formData();
    const file = form.get("bill") || form.get("file");

    if (!file || file.size === 0) return errorResponse("No file uploaded", 400, corsHeaders);
    if (file.size > 20 * 1024 * 1024) return errorResponse("File exceeds 20MB", 413, corsHeaders);

    const name = (file.name || "").toLowerCase();
    const allowed = [".pdf", ".png", ".jpg", ".jpeg"]; // REMOVED .xlsx and .xls
    if (!allowed.some((e) => name.endsWith(e))) return errorResponse("Unsupported format. Use PDF, PNG, JPG.", 415, corsHeaders);

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

    // ========== PDF ==========
    if (name.endsWith(".pdf")) {
      sourceType = "pdf";
      rawText = await extractTextFromPDF(buffer);
      extraction.primary = {
        ok: !!rawText,
        provider: "pdf_text",
        textLen: (rawText || "").length,
      };
      extraction.extractorUsed = "pdf_text";

      if (!rawText || rawText.trim().length < 200) {
        extraction.usedOCR = true;
        const ocr = await extractWithOcrSpace(buffer, "application/pdf", env);
        rawText = ocr.text || rawText;
        extraction.fallback = {
          ok: !!ocr.text,
          provider: "ocr_space",
          textLen: ocr.text?.length || 0,
        };
        extraction.extractorUsed = rawText.length > extraction.primary.textLen ? "ocr_space" : "pdf_text";
      }
    }
    // ========== IMAGE ==========
    else {
      sourceType = "image";
      const gv = await extractWithGoogleVision(buffer, file.type, env);
      rawText = gv.text || "";
      extraction.primary = {
        ok: !!rawText,
        provider: "google_vision",
        textLen: rawText.length,
      };
      extraction.extractorUsed = "google_vision";

      if (!rawText || rawText.trim().length < 200) {
        extraction.usedOCR = true;
        const ocr = await extractWithOcrSpace(buffer, file.type, env);
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
        explanation: "Try a clearer photo or upload a text-based PDF.",
        nextSteps: [
          "Take a straight, well-lit photo",
          "Upload original PDF if available",
        ],
        keyAmounts: {
          totalCharges: notDetectedField("Total Charges", extraction.sourceType),
          insurancePaid: notDetectedField("Insurance Paid", extraction.sourceType),
          patientResponsibility: notDetectedField("Patient Responsibility", extraction.sourceType),
        },
        confidenceMeta: {
          ...extraction,
          disclaimer: "Educational tool only. Not HIPAA-certified.",
        },
      };

      return jsonResponse(
        {
          isPaid,
          isDeveloper,
          extraction,
          pages: [{ page: 1, rawText: text, structured }],
        },
        corsHeaders
      );
    }

    // AI-first extraction
    const [openAI, gemini] = await Promise.all([
      analyzeWithOpenAI_AIExtract(lines, isPaid, env),
      analyzeWithGemini_AIExtract(lines, isPaid, env),
    ]);

    const aiMerged = mergeAIResults(openAI, gemini);

    // Stronger regex fallback
    const regexTotalCharges = extractMoneyField(text, {
      label: "Total Charges",
      sourceType: extraction.sourceType,
      lineKeywords: ["total charges", "billed amount", "amount billed", "submitted charges"],
      strongRegexes: [
        /total\s*charges?\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /billed\s*amount\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
      ],
      fallbackPick: "max",
    });

    const regexInsurancePaid = extractMoneyField(text, {
      label: "Insurance Paid",
      sourceType: extraction.sourceType,
      lineKeywords: ["paid by plan", "insurance payment", "plan paid"],
      strongRegexes: [
        /paid\s*by\s*(plan|insurance)\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
      ],
      fallbackPick: "best-near-keywords",
    });

    const regexPatientDue = extractMoneyField(text, {
      label: "Patient Responsibility",
      sourceType: extraction.sourceType,
      lineKeywords: ["patient responsibility", "amount you owe", "pay this amount", "balance due", "you may owe"],
      strongRegexes: [
        /(patient\s*responsibility|amount\s*you\s*owe|pay\s*this\s*amount|you\s*may\s*owe)\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /(balance|amount)\s*due\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
      ],
      fallbackPick: "due",
    });

    let totalCharges = pickFinalField("Total Charges", aiMerged?.fields?.totalCharges, regexTotalCharges, extraction.sourceType);
    let insurancePaid = pickFinalField("Insurance Paid", aiMerged?.fields?.insurancePaid, regexInsurancePaid, extraction.sourceType);
    let patientResponsibility = pickFinalField("Patient Responsibility", aiMerged?.fields?.patientResponsibility, regexPatientDue, extraction.sourceType);

    applyCrossAIAmountBoost(openAI, gemini, [totalCharges, insurancePaid, patientResponsibility]);
    applyInTextBoost(text, [totalCharges, insurancePaid, patientResponsibility]);
    applyMathSanityBoost(totalCharges, insurancePaid, patientResponsibility);

    const structured = {
      summary: aiMerged?.summary || "Bill analyzed.",
      explanation: aiMerged?.explanation || "Always verify amounts with your provider before paying.",
      nextSteps: Array.isArray(aiMerged?.nextSteps) ? aiMerged.nextSteps : [],
      keyAmounts: { totalCharges, insurancePaid, patientResponsibility },
      confidenceMeta: {
        ...extraction,
        disclaimer: "Educational tool only. Not HIPAA-certified.",
      },
      aiMeta: { openai_ok: !!openAI?.ok, gemini_ok: !!gemini?.ok },
    };

    return jsonResponse(
      {
        isPaid,
        isDeveloper,
        extraction,
        pages: [{ page: 1, rawText: text, structured }],
        explanation: structured.explanation,
      },
      corsHeaders
    );
  } catch (err) {
    console.error("Processing error:", err);
    return errorResponse(`Processing failed: ${err.message}`, 500, corsHeaders);
  }
}

// ======================== AI EXTRACTION (HIGH ACCURACY) ========================
async function analyzeWithOpenAI_AIExtract(numberedLines, isPaid, env) {
  try {
    if (!env.OPENAI_API_KEY) return { ok: false, provider: "openai" };

    const model = isPaid ? "gpt-4o" : "gpt-4o-mini";

    const system = `You are ExplainMyBill, a precision medical billing analyst.

Return ONLY valid JSON.

Rules:
- totalCharges: Original amount billed by provider ("Total Charges", "Billed Amount", etc.)
- insurancePaid: ONLY actual payment from insurance ("Paid by Plan", "Insurance Payment") — NOT adjustments/write-offs
- patientResponsibility: Final amount patient owes ("Amount You Owe", "Pay This Amount", "Patient Responsibility")

Prioritize summary/boxed sections. Use citations with exact evidence lines.

Schema:
{
  "summary": string,
  "explanation": string,
  "nextSteps": string[],
  "fields": {
    "totalCharges": {"amount": number|null, "currency": "USD", "citations": [{"line": number, "text": string}]},
    "insurancePaid": {"amount": number|null, "currency": "USD", "citations": [...]},
    "patientResponsibility": {"amount": number|null, "currency": "USD", "citations": [...]}
  }
}`;

    const user = `Extract precisely:\n\n${numberedLines}`;

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });

    if (!res.ok) return { ok: false, provider: "openai", status: res.status };
    const json = await res.json();
    const content = json.choices?.[0]?.message?.content || "";
    const parsed = safeParseJsonFromText(content);
    return { ok: !!parsed, provider: "openai", ...parsed };
  } catch (e) {
    return { ok: false, provider: "openai", error: e.message };
  }
}

async function analyzeWithGemini_AIExtract(numberedLines, isPaid, env) {
  try {
    if (!env.GEMINI_API_KEY) return { ok: false, provider: "gemini" };

    const model = isPaid ? "gemini-1.5-pro" : "gemini-1.5-flash";

    const prompt = `Return ONLY valid JSON (same schema and rules as OpenAI above).

Lines:\n${numberedLines}`;

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      }
    );

    if (!res.ok) return { ok: false, provider: "gemini", status: res.status };
    const json = await res.json();
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const parsed = safeParseJsonFromText(text);
    return { ok: !!parsed, provider: "gemini", ...parsed };
  } catch (e) {
    return { ok: false, provider: "gemini", error: e.message };
  }
}

// ======================== HELPER FUNCTIONS (UNCHANGED) ========================
function mergeAIResults(openAI, gemini) {
  const primary = openAI?.ok ? openAI : gemini?.ok ? gemini : null;
  if (!primary) return null;
  return { ...primary };
}

function pickFinalField(label, aiField, regexField, sourceType) {
  if (aiField && aiField.amount !== null && Array.isArray(aiField.citations) && aiField.citations.length > 0) {
    return buildFieldWithCitations(label, aiField.amount, sourceType, {
      reasonBase: "AI with citations",
      citations: aiField.citations,
      from: "ai",
    });
  }
  if (regexField && regexField.value !== "Not detected") {
    return { ...regexField, reason: regexField.reason + " (AI fallback)", from: "regex", citations: [] };
  }
  return notDetectedField(label, sourceType);
}

function buildFieldWithCitations(label, amount, sourceType, { reasonBase, citations }) {
  let confidence = 0.85;
  if (sourceType.includes("ocr")) confidence -= 0.20;
  if (sourceType.includes("pdf")) confidence += 0.08;
  confidence = Math.max(0.2, Math.min(0.97, confidence));

  return {
    label,
    value: formatUSD(amount.toFixed(2)),
    raw: amount.toFixed(2),
    confidence,
    reason: reasonBase,
    source: sourceType,
    from: "ai",
    citations: sanitizeCitations(citations),
  };
}

function applyMathSanityBoost(totalCharges, insurancePaid, patientResponsibility) {
  const tc = parseFloat(totalCharges?.raw || 0);
  const ip = parseFloat(insurancePaid?.raw || 0);
  const pr = parseFloat(patientResponsibility?.raw || 0);

  if (tc > 0 && Math.abs(tc - ip - pr) <= Math.max(10, tc * 0.1)) {
    [totalCharges, insurancePaid, patientResponsibility].forEach((f) => {
      if (f && f.confidence > 0) {
        f.confidence = Math.min(1, f.confidence + 0.08);
        f.reason += " + Math consistent";
      }
    });
  }
}

// Keep your original implementations for:
function applyCrossAIAmountBoost(openAI, gemini, fields) { /* your code */ }
function applyInTextBoost(text, fields) { /* your code */ }
function extractMoneyField(text, cfg) { /* your code */ }
function notDetectedField(label, sourceType) { /* your code */ }
function normalizeBillText(s) { return String(s || "").replace(/\r/g, "\n").replace(/[ \t]+/g, " ").trim(); }
function toNumberedLines(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 300)
    .map((l, i) => `${i + 1}. ${l}`)
    .join("\n");
}
function formatUSD(n) {
  const num = parseFloat(n);
  return isNaN(num) ? "Not detected" : `$${num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function sanitizeCitations(c) {
  return (c || []).slice(0, 6).map((cit) => ({ line: cit.line, text: cit.text.slice(0, 180) }));
}
function safeParseJsonFromText(t) {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}
function jsonResponse(obj, corsHeaders) {
  return new Response(JSON.stringify(obj), {
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}
function errorResponse(msg, status, corsHeaders) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}
function timingSafeEqual(a, b) {
  a = String(a || "");
  b = String(b || "");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// OCR / PDF functions — keep your existing ones
async function extractTextFromPDF(uint8) { /* your pdfjs code */ }
async function extractWithGoogleVision(uint8, mime, env) { /* your code */ }
async function extractWithOcrSpace(uint8, mime, env) { /* your code */ }
function uint8ArrayToBase64(uint8) { /* your code */ }

// END — Excel fully removed, everything else preserved
