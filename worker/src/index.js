// ExplainMyBill Worker — FULL VERSION (DEBUGGABLE EXTRACTOR + OPTIONAL OCR DISABLE)
// Dec 29, 2025
//
// ✅ Keeps: Google Vision + OCR.space + OpenAI + Gemini + PDF text extraction + Excel support + Stripe hook
// ✅ Adds: extractionMeta in response so you can PROVE what ran
// ✅ Adds: DISABLE_OCR_SPACE="true" env toggle (keeps code but prevents usage)
// ✅ Privacy: no storage, no DB, no login, avoids logging bill text
//
// Env vars:
// - DEV_MODE = "true"                  // unlock everything for you
// - DEV_KEY = "some-long-secret"       // optional: X-Dev-Key header
// - DISABLE_OCR_SPACE = "true|false"   // optional
// - OPENAI_API_KEY
// - GEMINI_API_KEY
// - GOOGLE_VISION_API_KEY
// - OCR_SPACE_API_KEY
// - STRIPE_SECRET_KEY (optional)
// - STRIPE_PRICE_MONTHLY / STRIPE_PRICE_ONE_TIME (optional)

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
    const url = new URL(request.url);
    const debug =
      url.searchParams.get("debug") === "1" ||
      request.headers.get("X-Debug") === "true";

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
    if (!allowed.some((e) => name.endsWith(e))) {
      return errorResponse("Unsupported format", 415, cors);
    }

    const buffer = new Uint8Array(await file.arrayBuffer());

    let rawText = "";
    let usedOCR = false;
    let sourceType = "unknown";

    // NEW: extraction meta to prove what ran
    const extractionMeta = {
      usedOCR: false,
      extractorUsed: "none",
      sourceType: "unknown",
      textLen: 0,
      primary: null,
      fallback: null,
      message: "EXTRACTION:",
    };

    const ocrSpaceDisabled = String(env.DISABLE_OCR_SPACE || "").toLowerCase() === "true";

    // ---------- PDF ----------
    if (name.endsWith(".pdf")) {
      sourceType = "pdf";
      extractionMeta.sourceType = "pdf";

      const primary = await extractTextFromPDF(buffer);
      rawText = primary || "";
      extractionMeta.primary = {
        ok: !!primary,
        provider: "pdf_text",
        status: primary ? 200 : 500,
        textLen: (primary || "").length,
      };
      extractionMeta.extractorUsed = primary ? "pdf_text" : "pdf_text_failed";

      if (!rawText || rawText.trim().length < 200) {
        if (!ocrSpaceDisabled && env.OCR_SPACE_API_KEY) {
          usedOCR = true;
          extractionMeta.usedOCR = true;
          sourceType = "pdf+ocr";
          extractionMeta.sourceType = "pdf+ocr";

          const fb = await extractWithOcrSpaceDetailed(buffer, "application/pdf", env);
          rawText = fb.text || "";
          extractionMeta.fallback = fb.meta;
          extractionMeta.extractorUsed = fb.meta?.provider || "ocr_space";
        }
      }
    }

    // ---------- Excel ----------
    else if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
      sourceType = "excel";
      extractionMeta.sourceType = "excel";

      const pages = await processExcel(buffer);
      rawText = pages.map((p) => p.rawText).join("\n\n");

      extractionMeta.primary = {
        ok: true,
        provider: "xlsx",
        status: 200,
        textLen: rawText.length,
      };
      extractionMeta.extractorUsed = "xlsx";
    }

    // ---------- Image ----------
    else {
      sourceType = "image";
      extractionMeta.sourceType = "image";

      // Primary: Google Vision (DETAILED)
      const primary = await extractWithGoogleVisionDetailed(buffer, file.type, env);
      rawText = primary.text || "";
      extractionMeta.primary = primary.meta;
      extractionMeta.extractorUsed = primary.meta?.provider || "google_vision";

      // Fallback: OCR.space if Vision weak
      if (!rawText || rawText.trim().length < 200) {
        if (!ocrSpaceDisabled && env.OCR_SPACE_API_KEY) {
          usedOCR = true;
          extractionMeta.usedOCR = true;
          sourceType = "image+ocr";
          extractionMeta.sourceType = "image+ocr";

          const fb = await extractWithOcrSpaceDetailed(buffer, file.type, env);
          rawText = fb.text || "";
          extractionMeta.fallback = fb.meta;
          extractionMeta.extractorUsed = fb.meta?.provider || "ocr_space";
        }
      }
    }

    const text = normalizeBillText(rawText);
    extractionMeta.textLen = (text || "").length;

    if (!text || text.length < 60) {
      const structured = {
        summary: "We could not reliably read text from this document.",
        explanation:
          "No readable text was detected. Try a clearer photo (flat, bright, no glare) or upload the PDF directly.",
        nextSteps: [
          "Re-scan or take a clearer photo (no glare, full page, straight).",
          "If PDF: export a text-based PDF from your provider portal.",
          "Crop out background and re-upload.",
        ],
        keyAmounts: {
          totalCharges: notDetectedField("Total Charges", sourceType),
          insurancePaid: notDetectedField("Insurance Paid", sourceType),
          patientResponsibility: notDetectedField("Patient Responsibility", sourceType),
        },
        confidenceMeta: {
          sourceType,
          usedOCR,
          disclaimer:
            "This app is not HIPAA-certified. Confidence reflects extraction quality. Verify amounts before paying.",
        },
      };

      const payload = {
        isPaid,
        isDeveloper,
        devBypass: isDeveloper,
        pages: [{ page: 1, rawText: text || "No readable text detected.", structured }],
        explanation: structured.explanation,
        extractionMeta: debug ? extractionMeta : minimalExtractionMeta(extractionMeta),
      };

      return jsonResponse(payload, cors);
    }

    // ================= FIELD EXTRACTION =================
    const totalCharges = extractMoneyField(text, {
      label: "Total Charges",
      sourceType,
      lineKeywords: ["total", "charges", "amount billed", "total amount", "total charges"],
      strongRegexes: [
        /total\s*(charges?|amount\s*billed|amount)\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /amount\s*billed\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
      ],
      fallbackPick: "max",
    });

    const insurancePaid = extractMoneyField(text, {
      label: "Insurance Paid",
      sourceType,
      lineKeywords: ["insurance", "paid", "payment", "adjustment", "allowed", "plan paid"],
      strongRegexes: [
        /insurance\s*(paid|payment)\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /plan\s*(paid|payment)\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /allowed\s*amount\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /adjustments?\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
      ],
      fallbackPick: "best-near-keywords",
    });

    const patientDue = extractMoneyField(text, {
      label: "Patient Responsibility",
      sourceType,
      lineKeywords: [
        "patient responsibility",
        "patient balance",
        "balance due",
        "amount due",
        "you owe",
        "please pay",
        "total due",
      ],
      strongRegexes: [
        /(patient\s*(responsibility|balance|due|owe))\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /(balance\s*due|amount\s*due|total\s*due)\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /(please\s*pay)\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
      ],
      fallbackPick: "due",
    });

    // ================= AI =================
    const [openAIResult, geminiResult] = await Promise.all([
      analyzeWithOpenAI(text, isPaid, env),
      analyzeWithGemini(text, isPaid, env),
    ]);

    applyAIConfidenceBoost(openAIResult, geminiResult, [totalCharges, insurancePaid, patientDue]);

    const structured = {
      summary: openAIResult?.summary || geminiResult?.summary || "Bill analyzed.",
      explanation:
        openAIResult?.explanation ||
        geminiResult?.explanation ||
        "Analysis complete. Verify all amounts with your provider/insurer before paying.",
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
          "This app is not HIPAA-certified. Confidence reflects document clarity + pattern matches. Verify amounts before payment.",
      },
    };

    const payload = {
      isPaid,
      isDeveloper,
      devBypass: isDeveloper,
      pages: [{ page: 1, rawText: text, structured }],
      explanation: structured.explanation,
      extractionMeta: debug ? extractionMeta : minimalExtractionMeta(extractionMeta),
    };

    return jsonResponse(payload, cors);
  } catch (err) {
    console.error("Processing error:", err?.message || err);
    return errorResponse("Processing failed", 500, cors);
  }
}

// ======================== EXTRACTION DETAILS HELPERS ========================
function minimalExtractionMeta(m) {
  return {
    usedOCR: !!m.usedOCR,
    extractorUsed: m.extractorUsed,
    sourceType: m.sourceType,
    textLen: m.textLen,
    primary: m.primary ? pickMeta(m.primary) : null,
    fallback: m.fallback ? pickMeta(m.fallback) : null,
    message: m.message,
  };
}
function pickMeta(x) {
  return {
    ok: !!x.ok,
    provider: x.provider,
    status: x.status,
    textLen: x.textLen,
  };
}

// ======================== BETTER MONEY EXTRACTION (UNCHANGED) ========================
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
    const dueCandidates = candidateMoneyByLine(lines, ["amount due", "balance due", "total due", "please pay", "you owe"]);
    if (dueCandidates.length) {
      return buildField(label, dueCandidates[0].amount, sourceType, "Fallback: selected amount from a due/balance line");
    }
    const pick = [...allMoney].sort((a, b) => b.value - a.value)[0];
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

  let confidence = 0.72;
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
  };
}

function notDetectedField(label, sourceType, why = "No clear matching line found") {
  return {
    label,
    value: "Not detected",
    confidence: 0,
    reason: why,
    source: sourceType || "none",
  };
}

// ======================== CONFIDENCE BOOST VIA AI AGREEMENT (UNCHANGED) ========================
function applyAIConfidenceBoost(openAI, gemini, fields) {
  const aiText = (safeStringify(openAI) + " " + safeStringify(gemini)).toLowerCase();
  for (const f of fields) {
    if (!f || !f.raw || f.value === "Not detected") continue;

    const raw = String(f.raw).replace(/,/g, "");
    const raw2 = raw.replace(/\.00$/, "");
    const asDollars = String(f.value).replace(/\$/g, "").replace(/,/g, "");

    if (aiText.includes(raw) || aiText.includes(raw2) || aiText.includes(asDollars)) {
      f.confidence = Math.min(1, Number((f.confidence + 0.1).toFixed(2)));
      f.reason += " + confirmed by AI analysis";
      f.source += "+ai";
    }
  }
}

// ======================== PDF TEXT EXTRACTION (UNCHANGED) ========================
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
  } catch (e) {
    console.warn("PDF extract failed:", e?.message || e);
    return "";
  }
}

// ======================== OCR / EXCEL / AI / HELPERS ========================

// NEW: Detailed Vision extractor (proves status/provider)
async function extractWithGoogleVisionDetailed(uint8, mimeType, env) {
  const meta = {
    ok: false,
    provider: "google_vision",
    status: 0,
    textLen: 0,
  };
  try {
    if (!env.GOOGLE_VISION_API_KEY) {
      meta.status = 0;
      return { text: "", meta };
    }

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

    meta.status = res.status;
    if (!res.ok) return { text: "", meta };

    const json = await res.json();
    const text = json.responses?.[0]?.fullTextAnnotation?.text || "";
    meta.ok = !!text;
    meta.textLen = text.length;
    return { text, meta };
  } catch {
    return { text: "", meta };
  }
}

// NEW: Detailed OCR.space extractor
async function extractWithOcrSpaceDetailed(uint8, mimeType, env) {
  const meta = {
    ok: false,
    provider: "ocr_space",
    status: 0,
    textLen: 0,
  };
  try {
    if (!env.OCR_SPACE_API_KEY) return { text: "", meta };

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

    meta.status = res.status;
    if (!res.ok) return { text: "", meta };

    const json = await res.json();
    const text = json.ParsedResults?.[0]?.ParsedText || "";
    meta.ok = !!text;
    meta.textLen = text.length;
    return { text, meta };
  } catch {
    return { text: "", meta };
  }
}

// Preserved non-detailed functions (so nothing is “removed”)
async function extractWithGoogleVision(uint8, mimeType, env) {
  const out = await extractWithGoogleVisionDetailed(uint8, mimeType, env);
  return out.text || "";
}
async function extractWithOcrSpace(uint8, mimeType, env) {
  const out = await extractWithOcrSpaceDetailed(uint8, mimeType, env);
  return out.text || "";
}

async function processExcel(buffer) {
  const XLSX = await import("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm");
  const wb = XLSX.read(buffer, { type: "array" });
  return wb.SheetNames.map((n, i) => ({
    page: i + 1,
    rawText: XLSX.utils.sheet_to_csv(wb.Sheets[n]),
  }));
}

// ======================== AI (STRICT JSON) ========================
async function analyzeWithOpenAI(text, isPaid, env) {
  try {
    if (!env.OPENAI_API_KEY) return null;

    const model = isPaid ? "gpt-4o" : "gpt-4o-mini";

    const system =
      `You are ExplainMyBill. Return ONLY valid JSON (no markdown). ` +
      `Do not guess numbers. If a value isn't explicit, set it to null.\n\n` +
      `Schema: {"summary": string, "explanation": string, "nextSteps": string[]}`;

    const user =
      `Simplify this bill for a normal person. Provide practical next steps.\n\nBILL TEXT:\n${text}`;

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

    if (!res.ok) return null;
    const json = await res.json();
    const content = json.choices?.[0]?.message?.content || "";
    return safeParseJsonFromText(content);
  } catch {
    return null;
  }
}

async function analyzeWithGemini(text, isPaid, env) {
  try {
    if (!env.GEMINI_API_KEY) return null;

    const model = isPaid ? "gemini-1.5-pro" : "gemini-1.5-flash";

    const prompt =
      `Return ONLY valid JSON (no markdown). Do not guess numbers.\n` +
      `Schema: {"summary": string, "explanation": string, "nextSteps": string[]}\n\n` +
      `BILL TEXT:\n${text}`;

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
        }),
      }
    );

    if (!res.ok) return null;
    const json = await res.json();
    const out = json.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return safeParseJsonFromText(out);
  } catch {
    return null;
  }
}

// ======================== TEXT + MONEY HELPERS ========================
function normalizeBillText(s) {
  if (!s) return "";
  return String(s)
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[•·]/g, "-")
    .trim();
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
    if (val >= 1900 && val <= 2099) continue;
    out.push({ amount: amt, value: val });
    if (out.length > 200) break;
  }
  return out;
}

function normalizeAmount(a) {
  return String(a || "")
    .replace(/,/g, "")
    .replace(/[^\d.]/g, "")
    .trim();
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

function safeStringify(x) {
  try {
    return JSON.stringify(x || "");
  } catch {
    return "";
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
