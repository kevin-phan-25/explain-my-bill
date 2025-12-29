// ExplainMyBill Worker – FULL FIXED VERSION (PDF SAFE FOR WORKERS)
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

      return new Response(`ExplainMyBill API Running`, {
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
    const sessionId = form.get("sessionId");

    if (!file || file.size === 0) return errorResponse("No file uploaded", 400, cors);
    if (file.size > 20 * 1024 * 1024) return errorResponse("File exceeds 20MB", 413, cors);

    const name = (file.name || "").toLowerCase();
    const allowed = [".pdf", ".png", ".jpg", ".jpeg", ".xlsx", ".xls"];
    if (!allowed.some(e => name.endsWith(e))) {
      return errorResponse("Unsupported format", 415, cors);
    }

    let isPaid = false;
    if (devBypass) {
      isPaid = true;
      console.log("DEV BYPASS ENABLED");
    }

    const buffer = new Uint8Array(await file.arrayBuffer());
    let text = "";

    // ================= PDF =================
    if (name.endsWith(".pdf")) {
      console.log("PDF detected – extracting embedded text");
      text = await extractTextFromPDF(buffer);

      if (!text || text.length < 100) {
        console.log("PDF appears scanned – OCR fallback");
        text = await extractWithOcrSpace(buffer, "application/pdf", env);
      }
    }

    // ================= EXCEL =================
    else if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
      const pages = await processExcel(buffer);
      text = pages.map(p => p.rawText).join("\n\n");
    }

    // ================= IMAGE =================
    else {
      text = await extractWithGoogleVision(buffer, file.type, env);
      if (!text || text.length < 100) {
        console.log("Image OCR fallback");
        text = await extractWithOcrSpace(buffer, file.type, env);
      }
    }

    if (!text || text.length < 50) {
      text = "No readable text detected.";
    }

    console.log("OCR TEXT LENGTH:", text.length);

    // ================= AMOUNT EXTRACTION =================
    const totalCharges = extractAmount(text, [
      /total\s*(?:charges?|amount|due|balance|billed)[^\d$]*\$?([\d,]+\.\d{2})/i,
    ]);

    const insurancePaid = extractAmount(text, [
      /insurance\s*(?:paid|payment|adjustment|allowed)[^\d$]*\$?([\d,]+\.\d{2})/i,
    ]);

    const patientDue = extractAmount(text, [
      /patient\s*(?:responsibility|balance|due|owe)[^\d$]*\$?([\d,]+\.\d{2})/i,
    ]);

    console.log("Amounts:", { totalCharges, insurancePaid, patientDue });

    // ================= AI =================
    const openAIResult = await analyzeWithOpenAI(text, isPaid, env);
    const geminiResult = await analyzeWithGemini(text, isPaid, env);
    const merged = mergeAIResults(openAIResult, geminiResult);

    return new Response(JSON.stringify({
      isPaid,
      devBypass,
      pages: [{ page: 1, rawText: text, structured: merged }],
      explanation: merged.explanation,
    }), {
      headers: { "Content-Type": "application/json", ...cors },
    });

  } catch (err) {
    console.error("Processing error:", err);
    return errorResponse(err.message, 500, cors);
  }
}

// ======================== PDF TEXT EXTRACTION (WORKER SAFE) ========================
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
  } catch (err) {
    console.error("PDF text extraction failed:", err);
    return "";
  }
}

// ======================== OCR ========================
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
            features: [{ type: "DOCUMENT_TEXT_DETECTION" }]
          }],
        }),
      }
    );
    const json = await res.json();
    return json.responses?.[0]?.fullTextAnnotation?.text || "";
  } catch (err) {
    console.warn("Vision OCR failed:", err);
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
  } catch (err) {
    console.warn("OCR.space failed:", err);
    return "";
  }
}

// ======================== EXCEL ========================
async function processExcel(buffer) {
  try {
    const XLSX = await import("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm");
    const wb = XLSX.read(buffer, { type: "array" });
    return wb.SheetNames.map((name, i) => ({
      page: i + 1,
      rawText: XLSX.utils.sheet_to_csv(wb.Sheets[name]),
    }));
  } catch {
    return [{ page: 1, rawText: "Excel read failed." }];
  }
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
        messages: [{ role: "user", content: `Analyze this bill:\n${text}` }],
        temperature: 0,
      }),
    });
    const data = await res.json();
    return parseResponse(data);
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
    return json.candidates?.[0]?.content?.parts?.[0]?.text
      ? JSON.parse(json.candidates[0].content.parts[0].text)
      : null;
  } catch {
    return null;
  }
}

// ======================== HELPERS ========================
function extractAmount(text, patterns) {
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return `$${m[1]}`;
  }
  return "Not detected";
}

function uint8ArrayToBase64(uint8) {
  let s = "";
  for (let i = 0; i < uint8.length; i += 0x8000) {
    s += String.fromCharCode(...uint8.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function parseResponse(data) {
  try {
    const c = data.choices?.[0]?.message?.content || "";
    return JSON.parse(c.replace(/```json|```/g, "").trim());
  } catch {
    return null;
  }
}

function mergeAIResults(a, b) {
  return {
    summary: a?.summary || b?.summary || "Bill analyzed",
    keyAmounts: a?.keyAmounts || b?.keyAmounts || {},
    explanation: a?.explanation || b?.explanation || "Analysis complete",
    nextSteps: a?.nextSteps || b?.nextSteps || [],
  };
}

function errorResponse(msg, status, cors) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}
