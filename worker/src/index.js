// ExplainMyBill Worker — AI-FIRST STRUCTURED EXTRACTION + CITATIONS (keeps regex fallback)
// Dec 29, 2025
//
// ✅ Keeps: Google Vision + OCR.space + OpenAI + Gemini + PDF text extraction + Excel support + Stripe route
// ✅ NEW: AI-first extraction returns structured amounts WITH citations (line numbers + evidence text)
// ✅ Keeps: Regex fallback if AI fails / returns null / missing fields
// ✅ Dev: ALWAYS-PAID mode (no upgrade prompts for you)
// ✅ Privacy: no storage, no DB, no login, avoids logging bill text
//
// ENV VARS (Cloudflare Worker):
// - DEV_MODE = "true"                // makes ALL requests paid/unlocked (recommended for you)
// - DEV_KEY = "some-long-secret"     // optional; header bypass: X-Dev-Key: <DEV_KEY>
// - OPENAI_API_KEY
// - GEMINI_API_KEY
// - GOOGLE_VISION_API_KEY
// - OCR_SPACE_API_KEY
// - STRIPE_SECRET_KEY (optional; only if using checkout)
//
// Frontend (for you):
// - Send header: X-Dev-Bypass: true
//   OR: X-Dev-Key: <DEV_KEY>
//
// IMPORTANT: This is NOT HIPAA-certified. Do NOT claim HIPAA compliance.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, X-Dev-Bypass, X-Dev-Key, Authorization",
    };

    if (request.method === "OPTIONS") {
      const h = request.headers.get("Access-Control-Request-Headers");
      if (h) cors["Access-Control-Allow-Headers"] = h;
      return new Response(null, { headers: cors });
    }

    try {
      if (url.pathname === "/create-checkout-session" && request.method === "POST") {
        return await handleStripeCheckout(request, env, cors);
      }

      // Debug route: GET /debug (no bill content)
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
              STRIPE_SECRET_KEY: !!env.STRIPE_SECRET_KEY,
            },
          },
          cors
        );
      }

      if (request.method === "POST") {
        return await handleBillProcessing(request, env, cors);
      }

      return new Response("ExplainMyBill API Running", {
        headers: { "Content-Type": "text/plain", ...cors },
      });
    } catch (err) {
      console.error("Worker error:", err?.message || err);
      return errorResponse("Internal error", 500, cors);
    }
  },
};

// ======================== BILL PROCESSING ========================
async function handleBillProcessing(request, env, cors) {
  try {
    // -------- DEV ALWAYS-PAID MODE (YOU ARE THE DEVELOPER) --------
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

    // Extraction telemetry (safe, no bill content)
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

    // ---------- PDF ----------
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

      // If weak, fallback to OCR.space
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
    }

    // ---------- Excel ----------
    else if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
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
    }

    // ---------- Image ----------
    else {
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

      // If weak, fallback to OCR.space (kept as fallback)
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

        // Prefer whichever has more usable text
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

    // Always return rawText for trust/debug (you asked for this)
    // IMPORTANT: This is transient and only returned to the client; not stored.
    const lines = toNumberedLines(text);

    // If still too little text, return helpful response
    if (!text || text.length < 60) {
      const structured = {
        summary: "We could not reliably read text from this document.",
        explanation:
          "No readable text was detected. Try a clearer photo (flat, bright, no glare) or upload the PDF directly.",
        nextSteps: [
          "Re-scan or take a clearer photo (no glare, full page, straight).",
          "If PDF: export a text-based PDF from the provider portal if available.",
          "Crop out background and re-upload (only the bill page).",
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
          pages: [{ page: 1, rawText: text || "No readable text detected.", structured }],
          explanation: structured.explanation,
        },
        cors
      );
    }

    // =========================
    // 1) AI-FIRST STRUCTURED EXTRACTION (WITH CITATIONS)
    // =========================
    const [openAI, gemini] = await Promise.all([
      analyzeWithOpenAI_AIExtract(lines, isPaid, env),
      analyzeWithGemini_AIExtract(lines, isPaid, env),
    ]);

    // Build a merged AI view (prefer OpenAI; fallback to Gemini)
    const aiMerged = mergeAIResults(openAI, gemini);

    // =========================
    // 2) REGEX FALLBACK (KEEP)
    // =========================
    const regexTotalCharges = extractMoneyField(text, {
      label: "Total Charges",
      sourceType: extraction.sourceType || sourceType,
      lineKeywords: ["total", "charges", "amount billed", "total amount", "total charges"],
      strongRegexes: [
        /total\s*(charges?|amount\s*billed|amount)\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /amount\s*billed\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
      ],
      fallbackPick: "max",
    });

    const regexInsurancePaid = extractMoneyField(text, {
      label: "Insurance Paid",
      sourceType: extraction.sourceType || sourceType,
      lineKeywords: ["insurance", "paid", "payment", "adjustment", "allowed", "plan paid"],
      strongRegexes: [
        /insurance\s*(paid|payment)\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /plan\s*(paid|payment)\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /allowed\s*amount\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /adjustments?\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
      ],
      fallbackPick: "best-near-keywords",
    });

    const regexPatientDue = extractMoneyField(text, {
      label: "Patient Responsibility",
      sourceType: extraction.sourceType || sourceType,
      lineKeywords: [
        "patient responsibility",
        "patient balance",
        "balance due",
        "amount due",
        "you owe",
        "please pay",
        "total due",
        "amt due",
        "net due",
      ],
      strongRegexes: [
        /(patient\s*(responsibility|balance|due|owe))\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /(balance\s*due|amount\s*due|total\s*due|net\s*due|amt\s*due)\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /(please\s*pay)\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
      ],
      fallbackPick: "due",
    });

    // =========================
    // 3) PICK FINAL AMOUNTS (AI-first; regex fallback)
    // =========================
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

    // Boost if both AIs agree on same amount (or very close)
    applyCrossAIAmountBoost(openAI, gemini, [totalCharges, insurancePaid, patientResponsibility]);

    // Boost if value appears in text (sanity)
    applyInTextBoost(text, [totalCharges, insurancePaid, patientResponsibility]);

    const structured = {
      summary: aiMerged?.summary || "Bill analyzed.",
      explanation:
        aiMerged?.explanation ||
        "Analysis complete. Verify all amounts with your provider/insurer before paying.",
      nextSteps: Array.isArray(aiMerged?.nextSteps) ? aiMerged.nextSteps : [],
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
          "This app is not HIPAA-certified. Confidence reflects evidence + OCR clarity. Always verify totals before payment.",
      },
      // Optional: for UI “trust” / debugging panels
      aiMeta: {
        openai_ok: !!openAI?.ok,
        gemini_ok: !!gemini?.ok,
      },
    };

    return jsonResponse(
      {
        isPaid,
        isDeveloper,
        extraction, // tells you which OCR path was used
        pages: [{ page: 1, rawText: text, structured }],
        explanation: structured.explanation,
      },
      cors
    );
  } catch (err) {
    console.error("Processing error:", err?.message || err);
    return errorResponse("Processing failed", 500, cors);
  }
}

// ======================== AI-FIRST (STRICT JSON + CITATIONS) ========================

async function analyzeWithOpenAI_AIExtract(numberedLines, isPaid, env) {
  try {
    if (!env.OPENAI_API_KEY) return { ok: false, provider: "openai", error: "missing_key" };

    const model = isPaid ? "gpt-4o" : "gpt-4o-mini";

    const system =
      `You are ExplainMyBill.\n` +
      `Return ONLY valid JSON. No markdown.\n` +
      `Do NOT guess numbers. If not explicit, use null.\n` +
      `You MUST cite evidence lines from the provided numbered lines.\n` +
      `Citations format: [{"line": <number>, "text": "<exact line text>"}].\n\n` +
      `JSON schema:\n` +
      `{\n` +
      `  "summary": string,\n` +
      `  "explanation": string,\n` +
      `  "nextSteps": string[],\n` +
      `  "fields": {\n` +
      `    "totalCharges": {"amount": number|null, "currency": "USD"|null, "citations": [{"line": number, "text": string}]},\n` +
      `    "insurancePaid": {"amount": number|null, "currency": "USD"|null, "citations": [{"line": number, "text": string}]},\n` +
      `    "patientResponsibility": {"amount": number|null, "currency": "USD"|null, "citations": [{"line": number, "text": string}]}\n` +
      `  }\n` +
      `}\n\n` +
      `Rules:\n` +
      `- If you see "PAY THIS AMOUNT", "BALANCE DUE", "AMOUNT DUE", map it to patientResponsibility.\n` +
      `- totalCharges is the total billed/charges/statement total.\n` +
      `- insurancePaid is insurer/plan payments/adjustments ONLY if explicitly stated.\n` +
      `- Use citations that actually contain the value or label.\n`;

    const user =
      `Here are numbered lines from the bill OCR/text.\n` +
      `Extract the 3 fields with citations and provide a plain-English explanation.\n\n` +
      `${numberedLines}`;

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0,
      }),
    });

    const status = res.status;
    if (!res.ok) return { ok: false, provider: "openai", status };

    const json = await res.json();
    const content = json.choices?.[0]?.message?.content || "";
    const parsed = safeParseJsonFromText(content);

    return { ok: !!parsed, provider: "openai", status, ...parsed };
  } catch (e) {
    return { ok: false, provider: "openai", error: e?.message || "error" };
  }
}

async function analyzeWithGemini_AIExtract(numberedLines, isPaid, env) {
  try {
    if (!env.GEMINI_API_KEY) return { ok: false, provider: "gemini", error: "missing_key" };

    const model = isPaid ? "gemini-1.5-pro" : "gemini-1.5-flash";

    const prompt =
      `Return ONLY valid JSON (no markdown). Do NOT guess numbers.\n` +
      `You MUST cite evidence lines from the provided numbered lines.\n` +
      `Schema:\n` +
      `{\n` +
      ` "summary": string,\n` +
      ` "explanation": string,\n` +
      ` "nextSteps": string[],\n` +
      ` "fields": {\n` +
      `  "totalCharges": {"amount": number|null, "currency": "USD"|null, "citations":[{"line":number,"text":string}]},\n` +
      `  "insurancePaid": {"amount": number|null, "currency": "USD"|null, "citations":[{"line":number,"text":string}]},\n` +
      `  "patientResponsibility": {"amount": number|null, "currency": "USD"|null, "citations":[{"line":number,"text":string}]}\n` +
      ` }\n` +
      `}\n\n` +
      `Rules:\n` +
      `- "PAY THIS AMOUNT"/"BALANCE DUE"/"AMOUNT DUE" => patientResponsibility.\n` +
      `- Use citations that actually show the value/label.\n\n` +
      `NUMBERED LINES:\n${numberedLines}`;

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      }
    );

    const status = res.status;
    if (!res.ok) return { ok: false, provider: "gemini", status };

    const json = await res.json();
    const out = json.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const parsed = safeParseJsonFromText(out);

    return { ok: !!parsed, provider: "gemini", status, ...parsed };
  } catch (e) {
    return { ok: false, provider: "gemini", error: e?.message || "error" };
  }
}

function mergeAIResults(openAI, gemini) {
  // Prefer OpenAI when ok, else Gemini
  const a = openAI && openAI.ok ? openAI : null;
  const g = gemini && gemini.ok ? gemini : null;

  const pick = a || g;
  if (!pick) return null;

  // If both exist, keep OpenAI’s narrative but fill missing from Gemini
  const fields = {
    totalCharges: pick?.fields?.totalCharges || null,
    insurancePaid: pick?.fields?.insurancePaid || null,
    patientResponsibility: pick?.fields?.patientResponsibility || null,
  };

  if (a && g) {
    fields.totalCharges = a.fields?.totalCharges || g.fields?.totalCharges || null;
    fields.insurancePaid = a.fields?.insurancePaid || g.fields?.insurancePaid || null;
    fields.patientResponsibility =
      a.fields?.patientResponsibility || g.fields?.patientResponsibility || null;
  }

  return {
    summary: pick.summary || "",
    explanation: pick.explanation || "",
    nextSteps: Array.isArray(pick.nextSteps) ? pick.nextSteps : [],
    fields,
  };
}

// ======================== FINAL FIELD PICKER ========================

function pickFinalField(label, aiField, regexField, sourceType) {
  // If AI gave a real number AND has citations, trust it first
  if (aiField && isFiniteNumber(aiField.amount) && Array.isArray(aiField.citations) && aiField.citations.length) {
    const amt = Number(aiField.amount);
    return buildFieldWithCitations(label, amt, sourceType, {
      reasonBase: "AI extracted with citations",
      citations: sanitizeCitations(aiField.citations),
      from: "ai",
    });
  }

  // Otherwise fallback to regex result (already formatted)
  if (regexField && regexField.value !== "Not detected") {
    // Add a placeholder citation if we can’t guarantee exact line
    // (Regex is still useful, but citations are AI-first feature.)
    return {
      ...regexField,
      reason: (regexField.reason || "Regex extraction") + " (AI missing/uncertain)",
      from: "regex",
      citations: [],
    };
  }

  return notDetectedField(label, sourceType, "AI + regex could not confidently locate this field");
}

function buildFieldWithCitations(label, amountNumber, sourceType, { reasonBase, citations, from }) {
  let confidence = 0.80; // AI with citations starts higher than raw regex
  let reason = reasonBase;

  if (sourceType.includes("pdf")) confidence += 0.08;
  if (sourceType.includes("excel")) confidence += 0.05;
  if (sourceType.includes("ocr")) {
    confidence -= 0.18;
    reason += " (OCR text can be noisy)";
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
    from, // "ai" or "regex"
    citations: citations || [],
  };
}

function sanitizeCitations(citations) {
  // ensure we never return huge text
  return (citations || [])
    .filter((c) => c && Number.isInteger(c.line) && typeof c.text === "string")
    .slice(0, 6)
    .map((c) => ({
      line: c.line,
      text: c.text.slice(0, 180),
    }));
}

// ======================== CONFIDENCE BOOSTS ========================

function applyCrossAIAmountBoost(openAI, gemini, fields) {
  const o = openAI?.fields || {};
  const g = gemini?.fields || {};

  const pairs = [
    ["totalCharges", o.totalCharges, g.totalCharges],
    ["insurancePaid", o.insurancePaid, g.insurancePaid],
    ["patientResponsibility", o.patientResponsibility, g.patientResponsibility],
  ];

  for (const [key, a, b] of pairs) {
    if (!a || !b) continue;
    if (!isFiniteNumber(a.amount) || !isFiniteNumber(b.amount)) continue;

    const diff = Math.abs(Number(a.amount) - Number(b.amount));
    const base = Math.max(Number(a.amount), Number(b.amount), 1);

    // If within 1% or within $2, boost
    if (diff <= 2 || diff / base <= 0.01) {
      const f = fields.find((x) => (x.label || "").toLowerCase().includes(key.replace(/([A-Z])/g, " $1").toLowerCase().split(" ")[0]));
      // safer: match by label exact
      const target = fields.find((x) => x.label === labelFromKey(key));
      if (target && target.value !== "Not detected") {
        target.confidence = Math.min(1, Number((target.confidence + 0.06).toFixed(2)));
        target.reason += " + OpenAI & Gemini agree";
        target.source += "+ai2";
      }
    }
  }
}

function applyInTextBoost(text, fields) {
  const t = String(text || "").replace(/,/g, "");
  for (const f of fields) {
    if (!f || !f.raw || f.value === "Not detected") continue;
    const raw = String(f.raw).replace(/,/g, "");
    if (raw && t.includes(raw)) {
      f.confidence = Math.min(1, Number((f.confidence + 0.04).toFixed(2)));
      f.reason += " + amount appears in extracted text";
    }
  }
}

function labelFromKey(key) {
  if (key === "totalCharges") return "Total Charges";
  if (key === "insurancePaid") return "Insurance Paid";
  if (key === "patientResponsibility") return "Patient Responsibility";
  return key;
}

// ======================== PDF TEXT EXTRACTION ========================
async function extractTextFromPDF(uint8) {
  try {
    const pdfjs = await import("https://cdn.jsdelivr.net/npm/pdfjs-dist@4.5.136/+esm");
    const loadingTask = pdfjs.getDocument({ data: uint8 });
    const pdf = await loadingTask.promise;

    let text = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map((it) => (it?.str ? it.str : "")).join(" ");
      text += pageText + "\n";
    }
    return text.trim();
  } catch {
    return "";
  }
}

// ======================== OCR / EXCEL ========================
async function extractWithGoogleVision(uint8, mimeType, env, extraction) {
  try {
    if (!env.GOOGLE_VISION_API_KEY) return { text: "", status: 0 };

    const base64 = uint8ArrayToBase64(uint8);
    const res = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${env.GOOGLE_VISION_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [
            {
              image: { content: base64 },
              features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
            },
          ],
        }),
      }
    );

    const status = res.status;
    if (!res.ok) return { text: "", status };

    const json = await res.json();
    const text = json.responses?.[0]?.fullTextAnnotation?.text || "";
    return { text, status };
  } catch {
    return { text: "", status: 0 };
  }
}

async function extractWithOcrSpace(uint8, mimeType, env) {
  try {
    if (!env.OCR_SPACE_API_KEY) return { text: "", status: 0 };

    const base64 = uint8ArrayToBase64(uint8);
    const res = await fetch("https://api.ocr.space/parse/image", {
      method: "POST",
      headers: {
        apikey: env.OCR_SPACE_API_KEY,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        base64Image: `data:${mimeType};base64,${base64}`,
        language: "eng",
        isOverlayRequired: "false",
        scale: "true",
        OCREngine: "2",
      }),
    });

    const status = res.status;
    if (!res.ok) return { text: "", status };

    const json = await res.json();
    const text = json.ParsedResults?.[0]?.ParsedText || "";
    return { text, status };
  } catch {
    return { text: "", status: 0 };
  }
}

async function processExcel(buffer) {
  const XLSX = await import("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm");
  const wb = XLSX.read(buffer, { type: "array" });
  return wb.SheetNames.map((n, i) => ({
    page: i + 1,
    rawText: XLSX.utils.sheet_to_csv(wb.Sheets[n]),
  }));
}

// ======================== REGEX FALLBACK (PRESERVED) ========================
function extractMoneyField(text, cfg) {
  const { label, sourceType, strongRegexes = [], lineKeywords = [], fallbackPick } = cfg;

  for (const rx of strongRegexes) {
    const m = text.match(rx);
    if (m) {
      const amt = pickAmountGroup(m);
      if (amt) return buildField(label, amt, sourceType, "Matched strong labeled pattern");
    }
  }

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const kw = lineKeywords.map((k) => k.toLowerCase());

  const candidateLines = lines.filter((l) => {
    const ll = l.toLowerCase();
    return kw.some((k) => ll.includes(k));
  });

  for (const line of candidateLines) {
    const amt = findFirstMoney(line);
    if (amt) return buildField(label, amt, sourceType, "Found amount on a labeled line");
  }

  for (let i = 0; i < lines.length; i++) {
    const ll = lines[i].toLowerCase();
    if (!kw.some((k) => ll.includes(k))) continue;

    const window = [lines[i], lines[i + 1] || "", lines[i + 2] || ""].join(" ");
    const amt = findFirstMoney(window);
    if (amt) return buildField(label, amt, sourceType, "Found amount near labeled text");
  }

  const allMoney = extractAllMoney(text);
  if (!allMoney.length) return notDetectedField(label, sourceType, "No currency values detected anywhere");

  if (fallbackPick === "due") {
    const dueCandidates = candidateMoneyByLine(lines, [
      "amount due",
      "balance due",
      "total due",
      "please pay",
      "you owe",
      "net due",
      "amt due",
      "pay this amount",
    ]);
    if (dueCandidates.length) {
      return buildField(label, dueCandidates[0].amount, sourceType, "Fallback: selected amount from a due/balance line");
    }
    const sorted = [...allMoney].sort((a, b) => a.value - b.value);
    const pick = sorted[sorted.length - 1];
    return buildField(label, pick.amount, sourceType, "Fallback: picked likely amount (heuristic)");
  }

  if (fallbackPick === "max") {
    const max = allMoney.reduce((a, b) => (b.value > a.value ? b : a));
    return buildField(label, max.amount, sourceType, "Fallback: selected largest amount found");
  }

  if (fallbackPick === "best-near-keywords") {
    const near = candidateMoneyByLine(lines, ["insurance", "plan", "paid", "adjustment", "allowed"]);
    if (near.length) {
      return buildField(label, near[0].amount, sourceType, "Fallback: selected amount near insurance keywords");
    }
  }

  return buildField(label, allMoney[0].amount, sourceType, "Fallback: selected first detected amount");
}

function candidateMoneyByLine(lines, keywords) {
  const out = [];
  const kw = keywords.map((k) => k.toLowerCase());

  for (const line of lines) {
    const ll = line.toLowerCase();
    if (!kw.some((k) => ll.includes(k))) continue;
    const money = extractAllMoney(line);
    for (const m of money) out.push(m);
  }

  out.sort((a, b) => b.value - a.value);
  return out;
}

function buildField(label, amountStr, sourceType, reasonBase) {
  const cleaned = normalizeAmount(amountStr);
  let confidence = 0.70;
  let reason = reasonBase;

  if (sourceType.includes("pdf")) confidence += 0.10;
  if (sourceType.includes("excel")) confidence += 0.05;
  if (sourceType.includes("ocr")) {
    confidence -= 0.18;
    reason += " (OCR text can be noisy)";
  }

  confidence = clamp(confidence, 0.15, 0.95);

  return {
    label,
    value: formatUSD(cleaned),
    confidence: Number(confidence.toFixed(2)),
    reason,
    source: sourceType,
    raw: cleaned,
    from: "regex",
    citations: [],
  };
}

function notDetectedField(label, sourceType, why = "No clear matching line found") {
  return {
    label,
    value: "Not detected",
    confidence: 0,
    reason: why,
    source: sourceType || "none",
    from: "none",
    citations: [],
  };
}

// ======================== TEXT HELPERS ========================
function normalizeBillText(s) {
  if (!s) return "";
  return String(s)
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[•·]/g, "-")
    .trim();
}

function toNumberedLines(text) {
  const lines = String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  // Keep it bounded (cost + prompt size)
  const capped = lines.slice(0, 300);

  return capped.map((l, i) => `${i + 1}. ${l}`).join("\n");
}

function findFirstMoney(s) {
  const m = String(s).match(/\$?\s*([\d]{1,3}(?:,[\d]{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)/);
  if (!m) return null;

  const amt = normalizeAmount(m[1]);
  const val = Number(amt);
  if (!isFinite(val) || val <= 0) return null;
  return amt;
}

function extractAllMoney(s) {
  const out = [];
  const rx = /\$?\s*([\d]{1,3}(?:,[\d]{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)/g;
  const str = String(s);
  let m;
  while ((m = rx.exec(str))) {
    const amt = normalizeAmount(m[1]);
    const val = Number(amt);
    if (!isFinite(val) || val <= 0) continue;
    if (val >= 1900 && val <= 2099) continue; // ignore years
    out.push({ amount: amt, value: val });
    if (out.length > 250) break;
  }
  return out;
}

function normalizeAmount(a) {
  return String(a || "").replace(/,/g, "").replace(/[^\d.]/g, "").trim();
}

function formatUSD(numericString) {
  const n = Number(numericString);
  if (!isFinite(n)) return "Not detected";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pickAmountGroup(matchArray) {
  for (let i = matchArray.length - 1; i >= 1; i--) {
    const candidate = normalizeAmount(matchArray[i]);
    if (candidate && /^\d+(\.\d{2})?$/.test(candidate)) return candidate;
    if (candidate && /^\d+(\.\d+)?$/.test(candidate)) return candidate;
  }
  return null;
}

function isFiniteNumber(x) {
  const n = Number(x);
  return Number.isFinite(n);
}

// ======================== BASE64 (SAFE) ========================
function uint8ArrayToBase64(uint8) {
  let s = "";
  for (let i = 0; i < uint8.length; i += 0x8000) {
    s += String.fromCharCode(...uint8.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

// ======================== JSON SAFETY ========================
function safeParseJsonFromText(text) {
  try {
    return JSON.parse(text);
  } catch {
    const s = String(text || "").trim();
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

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function jsonResponse(obj, cors) {
  return new Response(JSON.stringify(obj), {
    headers: { "Content-Type": "application/json", ...cors },
  });
}

function errorResponse(msg, status, cors) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

// ======================== STRIPE (PRESERVED HOOK) ========================
async function handleStripeCheckout(_request, env, cors) {
  if (!env.STRIPE_SECRET_KEY) {
    return new Response(
      JSON.stringify({
        error:
          "Stripe is not configured (missing STRIPE_SECRET_KEY). In DEV_MODE you don’t need checkout.",
      }),
      { status: 400, headers: { "Content-Type": "application/json", ...cors } }
    );
  }

  return new Response(
    JSON.stringify({
      error:
        "Stripe handler not included in this snippet. Paste your existing Stripe code and I’ll merge it in without removing anything.",
    }),
    { status: 400, headers: { "Content-Type": "application/json", ...cors } }
  );
}

// ======================== TIMING SAFE ========================
function timingSafeEqual(a, b) {
  const x = String(a || "");
  const y = String(b || "");
  if (!x || !y || x.length !== y.length) return false;
  let out = 0;
  for (let i = 0; i < x.length; i++) out |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return out === 0;
}
