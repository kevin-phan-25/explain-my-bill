// ExplainMyBill Worker – FULL VERSION WITH FIELD CONFIDENCE + AI AGREEMENT
// Dec 29, 2025

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Dev-Bypass",
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

      if (request.method === "POST") {
        return await handleBillProcessing(request, env, cors);
      }

      return new Response("ExplainMyBill API Running", {
        headers: { "Content-Type": "text/plain", ...cors },
      });
    } catch (err) {
      console.error("Worker error:", err);
      return errorResponse(err.message, 500, cors);
    }
  },
};

// ======================== BILL PROCESSING ========================
async function handleBillProcessing(request, env, cors) {
  try {
    const devBypass = request.headers.get("X-Dev-Bypass") === "true";
    const form = await request.formData();
    const file = form.get("bill") || form.get("file");

    if (!file || file.size === 0) return errorResponse("No file uploaded", 400, cors);
    if (file.size > 20 * 1024 * 1024) return errorResponse("File exceeds 20MB", 413, cors);

    const name = (file.name || "").toLowerCase();
    const allowed = [".pdf", ".png", ".jpg", ".jpeg", ".xlsx", ".xls"];
    if (!allowed.some(e => name.endsWith(e))) {
      return errorResponse("Unsupported format", 415, cors);
    }

    const isPaid = devBypass;
    const buffer = new Uint8Array(await file.arrayBuffer());

    let text = "";
    let usedOCR = false;
    let sourceType = "unknown";

    // ---------- PDF ----------
    if (name.endsWith(".pdf")) {
      sourceType = "pdf";
      text = await extractTextFromPDF(buffer);
      if (!text || text.length < 120) {
        usedOCR = true;
        sourceType = "pdf+ocr";
        text = await extractWithOcrSpace(buffer, "application/pdf", env);
      }
    }

    // ---------- Excel ----------
    else if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
      sourceType = "excel";
      const pages = await processExcel(buffer);
      text = pages.map(p => p.rawText).join("\n\n");
    }

    // ---------- Image ----------
    else {
      sourceType = "image";
      text = await extractWithGoogleVision(buffer, file.type, env);
      if (!text || text.length < 120) {
        usedOCR = true;
        sourceType = "image+ocr";
        text = await extractWithOcrSpace(buffer, file.type, env);
      }
    }

    if (!text || text.length < 60) {
      text = "No readable text detected.";
    }

    // ================= FIELD EXTRACTION =================
    const totalCharges = extractAmountWithConfidence(
      text,
      [/total\s*(charges?|amount|billed|due|balance)[^\d$]*\$?\s*([\d,]+(?:\.\d{2})?)/i],
      "Total Charges",
      sourceType
    );

    const insurancePaid = extractAmountWithConfidence(
      text,
      [/insurance\s*(paid|payment|adjustment|allowed)[^\d$]*\$?\s*([\d,]+(?:\.\d{2})?)/i],
      "Insurance Paid",
      sourceType
    );

    const patientDue = extractAmountWithConfidence(
      text,
      [/patient\s*(responsibility|balance|due|owe)[^\d$]*\$?\s*([\d,]+(?:\.\d{2})?)/i],
      "Patient Responsibility",
      sourceType
    );

    // ================= AI =================
    const openAIResult = await analyzeWithOpenAI(text, isPaid, env);
    const geminiResult = await analyzeWithGemini(text, isPaid, env);

    // AI agreement boosts confidence
    applyAIConfidenceBoost(openAIResult, geminiResult, [
      totalCharges,
      insurancePaid,
      patientDue,
    ]);

    const structured = {
      summary: openAIResult?.summary || geminiResult?.summary || "Bill analyzed.",
      explanation: openAIResult?.explanation || geminiResult?.explanation || "Analysis complete.",
      nextSteps: openAIResult?.nextSteps || geminiResult?.nextSteps || [],
      keyAmounts: {
        totalCharges,
        insurancePaid,
        patientResponsibility: patientDue,
      },
      confidenceMeta: {
        sourceType,
        usedOCR,
        disclaimer:
          "Confidence scores reflect document clarity and pattern matches. Verify amounts before payment.",
      },
    };

    return new Response(
      JSON.stringify({
        isPaid,
        devBypass,
        pages: [{ page: 1, rawText: text, structured }],
        explanation: structured.explanation,
      }),
      {
        headers: { "Content-Type": "application/json", ...cors },
      }
    );
  } catch (err) {
    console.error("Processing error:", err);
    return errorResponse(err.message, 500, cors);
  }
}

// ======================== CONFIDENCE EXTRACTION ========================
function extractAmountWithConfidence(text, patterns, label, sourceType) {
  let match = null;

  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      match = m;
      break;
    }
  }

  if (!match) {
    return {
      label,
      value: "Not detected",
      confidence: 0,
      reason: "No clear matching line found",
      source: "none",
    };
  }

  let confidence = 0.65;
  let reason = "Matched labeled currency pattern";

  if (sourceType.includes("pdf")) confidence += 0.15;
  if (sourceType.includes("ocr")) {
    confidence -= 0.15;
    reason = "Detected via OCR; text clarity reduced";
  }

  confidence = Math.max(0.15, Math.min(0.95, confidence));

  return {
    label,
    value: `$${match[2]}`,
    confidence: Number(confidence.toFixed(2)),
    reason,
    source: sourceType,
  };
}

function applyAIConfidenceBoost(openAI, gemini, fields) {
  const aiText = (
    JSON.stringify(openAI || "") +
    JSON.stringify(gemini || "")
  ).toLowerCase();

  for (const f of fields) {
    if (
      f.value !== "Not detected" &&
      aiText.includes(f.value.replace("$", ""))
    ) {
      f.confidence = Math.min(1, Number((f.confidence + 0.1).toFixed(2)));
      f.reason += " + confirmed by AI analysis";
      f.source += "+ai";
    }
  }
}

// ======================== PDF TEXT EXTRACTION ========================
async function extractTextFromPDF(uint8) {
  try {
    const pdfjs = await import(
      "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.222/build/pdf.min.js"
    );
    const pdf = await pdfjs.getDocument({ data: uint8 }).promise;
    let text = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map(i => i.str).join(" ") + "\n\n";
    }
    return text.trim();
  } catch {
    return "";
  }
}

// ======================== OCR / EXCEL / AI / HELPERS ========================
async function extractWithGoogleVision(uint8, mimeType, env) {
  try {
    const base64 = uint8ArrayToBase64(uint8);
    const res = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${env.GOOGLE_VISION_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [{
            image: { content: base64 },
            features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
          }],
        }),
      }
    );
    const json = await res.json();
    return json.responses?.[0]?.fullTextAnnotation?.text || "";
  } catch {
    return "";
  }
}

async function extractWithOcrSpace(uint8, mimeType, env) {
  try {
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
      }),
    });
    const json = await res.json();
    return json.ParsedResults?.[0]?.ParsedText || "";
  } catch {
    return "";
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

// ======================== AI ========================
async function analyzeWithOpenAI(text, isPaid, env) {
  try {
    const model = isPaid ? "gpt-4o" : "gpt-4o-mini";
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{
          role: "user",
          content:
            "Analyze this medical bill and summarize key amounts without guessing.\n\n" +
            text,
        }],
        temperature: 0,
      }),
    });
    const json = await res.json();
    return JSON.parse(json.choices?.[0]?.message?.content || "{}");
  } catch {
    return null;
  }
}

async function analyzeWithGemini(text, isPaid, env) {
  try {
    const model = isPaid ? "gemini-1.5-pro" : "gemini-1.5-flash";
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text }] }],
        }),
      }
    );
    const json = await res.json();
    const out = json.candidates?.[0]?.content?.parts?.[0]?.text;
    return out ? JSON.parse(out) : null;
  } catch {
    return null;
  }
}

function uint8ArrayToBase64(uint8) {
  let s = "";
  for (let i = 0; i < uint8.length; i += 0x8000) {
    s += String.fromCharCode(...uint8.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function errorResponse(msg, status, cors) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}
