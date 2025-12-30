// ExplainMyBill Worker — FULL VERSION (BETTER EXTRACTION + RAW TEXT + AI JSON + DEBUG META)
// Dec 29, 2025
//
// ✅ Keeps: Google Vision + OCR.space + OpenAI + Gemini + PDF text extraction + Excel support + Stripe hook
// ✅ Fixes: wrong amounts by using statement-aware extraction + AI-assisted extraction (no guessing)
// ✅ Fixes: AI JSON parsing by forcing strict JSON and extracting JSON safely
// ✅ Always returns rawText + extractionMeta (so you can prove Google Vision vs OCR.space)
// ✅ Dev always-paid mode (no upgrade prompts in dev)
// ✅ Privacy: no storage, no DB, no login, avoids logging bill text
//
// Env vars:
// - DEV_MODE = "true" (optional)
// - DEV_KEY  = "some-long-secret" (optional; header X-Dev-Key)
// - OPENAI_API_KEY
// - GEMINI_API_KEY
// - GOOGLE_VISION_API_KEY
// - OCR_SPACE_API_KEY
// - STRIPE_SECRET_KEY (optional for checkout; hook preserved)

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
    // -------- DEV ALWAYS-PAID MODE --------
    const devBypassHeader = request.headers.get("X-Dev-Bypass") === "true";
    const devKeyHeader = request.headers.get("X-Dev-Key") || "";
    const isDeveloper =
      String(env.DEV_MODE || "").toLowerCase() === "true" ||
      devBypassHeader ||
      (env.DEV_KEY && timingSafeEqual(devKeyHeader, env.DEV_KEY));

    // Developer sees everything unlocked
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

    // extraction debug meta
    const extractionMeta = {
      extractorUsed: "none",
      usedOCR: false,
      primary: null,
      fallback: null,
      sourceType: "unknown",
      textLen: 0,
    };

    // ---------- PDF ----------
    if (name.endsWith(".pdf")) {
      sourceType = "pdf";
      extractionMeta.sourceType = sourceType;

      const primary = await safeExtractPdfText(buffer);
      rawText = primary.text;
      extractionMeta.primary = primary;
      extractionMeta.extractorUsed = primary.provider;
      extractionMeta.textLen = (rawText || "").length;

      if (!rawText || rawText.trim().length < 200) {
        usedOCR = true;
        sourceType = "pdf+ocr";
        extractionMeta.sourceType = sourceType;
        extractionMeta.usedOCR = true;

        const fb = await safeExtractOcrSpace(buffer, "application/pdf", env);
        rawText = fb.text;
        extractionMeta.fallback = fb;
        extractionMeta.extractorUsed = fb.provider;
        extractionMeta.textLen = (rawText || "").length;
      }
    }

    // ---------- Excel ----------
    else if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
      sourceType = "excel";
      extractionMeta.sourceType = sourceType;

      const pages = await processExcel(buffer);
      rawText = pages.map((p) => p.rawText).join("\n\n");

      extractionMeta.primary = {
        ok: true,
        provider: "excel",
        status: 200,
        textLen: rawText.length,
      };
      extractionMeta.extractorUsed = "excel";
      extractionMeta.textLen = rawText.length;
    }

    // ---------- Image ----------
    else {
      sourceType = "image";
      extractionMeta.sourceType = sourceType;

      const primary = await safeExtractGoogleVision(buffer, file.type, env);
      rawText = primary.text;
      extractionMeta.primary = primary;
      extractionMeta.extractorUsed = primary.provider;
      extractionMeta.textLen = (rawText || "").length;

      // Only fallback if Vision is weak or failed
      if (!rawText || rawText.trim().length < 250) {
        usedOCR = true;
        sourceType = "image+ocr";
        extractionMeta.sourceType = sourceType;
        extractionMeta.usedOCR = true;

        const fb = await safeExtractOcrSpace(buffer, file.type, env);
        rawText = fb.text;
        extractionMeta.fallback = fb;
        extractionMeta.extractorUsed = fb.provider;
        extractionMeta.textLen = (rawText || "").length;
      }
    }

    const text = normalizeBillText(rawText);
    extractionMeta.textLen = text.length;

    // Always return rawText (even if empty)
    if (!text || text.length < 60) {
      const structured = {
        summary: "We could not reliably read text from this document.",
        explanation:
          "No readable text was detected. Try a clearer photo (flat, bright, no glare) or upload the PDF directly.",
        nextSteps: [
          "Re-scan or take a clearer photo (no glare, full page, straight).",
          "If PDF: download the text-based PDF from your provider portal.",
          "Crop out background and re-upload.",
        ],
        keyAmounts: {
          totalCharges: notDetectedField("Total Charges", sourceType, "No readable text"),
          insurancePaid: notDetectedField("Insurance Paid", sourceType, "No readable text"),
          patientResponsibility: notDetectedField(
            "Patient Responsibility",
            sourceType,
            "No readable text"
          ),
          _debug: { label: "_debug", value: "—", confidence: 0, source: sourceType },
        },
        confidenceMeta: {
          sourceType,
          usedOCR,
          disclaimer:
            "This app is not HIPAA-certified. Use it as an educational tool and verify amounts before paying.",
        },
      };

      return jsonResponse(
        {
          isPaid,
          isDeveloper,
          devBypass: isDeveloper,
          extractionMeta,
          pages: [{ page: 1, rawText: text || "No readable text detected.", structured }],
          explanation: structured.explanation,
        },
        cors
      );
    }

    // =======================
    // 1) STATEMENT-AWARE EXTRACTION (regex + heuristics)
    // =======================
    const statementAmounts = extractStatementAmounts(text, sourceType);

    // =======================
    // 2) AI EXTRACTION + EXPLANATION (strict JSON, no guessing)
    // =======================
    const [openAIResult, geminiResult] = await Promise.all([
      analyzeWithOpenAI(text, isPaid, env),
      analyzeWithGemini(text, isPaid, env),
    ]);

    // Normalize AI outputs to a consistent shape
    const ai = mergeAI(openAIResult, geminiResult);

    // AI-assisted amounts (only if explicit)
    const aiAmounts = normalizeAIAmounts(ai?.keyAmounts || {});

    // =======================
    // 3) MERGE amounts safely:
    // - prefer statement-aware regex hits with higher confidence
    // - allow AI to fill missing fields if explicit
    // - add AI agreement boost when both mention same number
    // =======================
    const merged = mergeAmounts(statementAmounts, aiAmounts, sourceType);

    // AI agreement confidence boost
    applyAIConfidenceBoost(openAIResult, geminiResult, [
      merged.totalCharges,
      merged.insurancePaid,
      merged.patientResponsibility,
    ]);

    const structured = {
      summary: ai?.summary || "Bill analyzed.",
      explanation:
        ai?.explanation ||
        "Analysis complete. Verify all amounts with your provider/insurer before paying.",
      summaryPoints: ai?.summaryPoints || [],
      nextSteps: ai?.nextSteps || [],
      keyAmounts: {
        totalCharges: merged.totalCharges,
        insurancePaid: merged.insurancePaid,
        patientResponsibility: merged.patientResponsibility,
        _debug: merged._debug,
      },
      confidenceMeta: {
        sourceType,
        usedOCR,
        disclaimer:
          "This app is not HIPAA-certified. Confidence reflects document clarity + explicit matches. Verify amounts before payment.",
      },
    };

    return jsonResponse(
      {
        isPaid,
        isDeveloper,
        devBypass: isDeveloper,
        extractionMeta,
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

// ======================== STATEMENT-AWARE AMOUNT EXTRACTION ========================
// This is the critical fix: on table-heavy bills, NEVER use "largest number found".
// We prioritize "PAY THIS AMOUNT / AMOUNT DUE / BALANCE DUE / NET DUE" etc.
// Insurance Paid often is NOT shown on simple statements; keep it Not detected unless explicit.
function extractStatementAmounts(text, sourceType) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  const patientDue = findAmountNearLabels(lines, [
    "pay this amount",
    "amount due",
    "balance due",
    "net due",
    "total due",
    "patient due",
    "please pay",
    "amt due",
  ]);

  const totalCharges = findAmountNearLabels(lines, [
    "total charges",
    "amount billed",
    "total amount",
    "total billed",
    "charges",
    "billed",
  ]);

  const insurancePaid = findAmountNearLabels(lines, [
    "insurance paid",
    "plan paid",
    "payer paid",
    "insurance payment",
    "adjustment",
    "allowed amount",
    "insurance",
  ]);

  // Build fields with confidence tuned for match quality
  const fPatient = patientDue.found
    ? buildField("Patient Responsibility", patientDue.amount, sourceType, patientDue.reason, patientDue.matchLine, patientDue.method)
    : notDetectedField("Patient Responsibility", sourceType, "No explicit Amount Due / Balance Due / Pay This Amount found");

  const fTotal = totalCharges.found
    ? buildField("Total Charges", totalCharges.amount, sourceType, totalCharges.reason, totalCharges.matchLine, totalCharges.method)
    : notDetectedField("Total Charges", sourceType, "No explicit Total Charges / Amount Billed found");

  // Insurance Paid: if only table numbers exist, do NOT guess.
  const fIns = insurancePaid.found
    ? buildField("Insurance Paid", insurancePaid.amount, sourceType, insurancePaid.reason, insurancePaid.matchLine, insurancePaid.method)
    : notDetectedField("Insurance Paid", sourceType, "Not explicitly stated (common on statements)");

  // Debug: show top candidates found around these labels
  const dbg = {
    label: "_debug",
    value: "—",
    confidence: 0,
    reason: "debug meta",
    source: sourceType,
    meta: {
      patientDueCandidate: patientDue,
      totalChargesCandidate: totalCharges,
      insurancePaidCandidate: insurancePaid,
    },
  };

  return {
    totalCharges: fTotal,
    insurancePaid: fIns,
    patientResponsibility: fPatient,
    _debug: dbg,
  };
}

// Finds an amount on the same line as label OR within next 2 lines.
// Also avoids grabbing random table columns by preferring:
// - lines that contain a label
// - amounts that appear right after the label
function findAmountNearLabels(lines, labels) {
  const kws = labels.map((x) => x.toLowerCase());

  // Pass A: same-line label + amount
  for (const line of lines) {
    const ll = line.toLowerCase();
    if (!kws.some((k) => ll.includes(k))) continue;

    const amt = findMoneyClosestToLabel(line, kws);
    if (amt) {
      return {
        found: true,
        amount: amt,
        reason: "Found amount on labeled line",
        matchLine: line,
        method: "label_same_line",
      };
    }
  }

  // Pass B: label line then amount in next 1–2 lines (common on statements)
  for (let i = 0; i < lines.length; i++) {
    const ll = lines[i].toLowerCase();
    if (!kws.some((k) => ll.includes(k))) continue;

    const window = [lines[i], lines[i + 1] || "", lines[i + 2] || ""].join(" ");
    const amt = findMoneyClosestToLabel(window, kws);
    if (amt) {
      return {
        found: true,
        amount: amt,
        reason: "Found amount near label (within 2 lines)",
        matchLine: window.slice(0, 240),
        method: "label_nearby",
      };
    }
  }

  return { found: false };
}

// Prefer amounts that appear AFTER label position in a line/window.
// If none after, fallback to first plausible amount.
function findMoneyClosestToLabel(str, kws) {
  const s = String(str);
  const lower = s.toLowerCase();

  // Find the earliest label index
  let bestIdx = Infinity;
  for (const k of kws) {
    const idx = lower.indexOf(k);
    if (idx !== -1 && idx < bestIdx) bestIdx = idx;
  }

  const moneyMatches = [...s.matchAll(/\$?\s*([\d]{1,3}(?:,[\d]{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)/g)];
  if (!moneyMatches.length) return null;

  // Prefer the first money match that occurs AFTER the label
  if (bestIdx !== Infinity) {
    for (const m of moneyMatches) {
      if (typeof m.index === "number" && m.index > bestIdx) {
        const amt = normalizeAmount(m[1]);
        const val = Number(amt);
        if (isFinite(val) && val > 0 && !looksLikeYear(val)) return amt;
      }
    }
  }

  // Otherwise: first plausible money
  for (const m of moneyMatches) {
    const amt = normalizeAmount(m[1]);
    const val = Number(amt);
    if (isFinite(val) && val > 0 && !looksLikeYear(val)) return amt;
  }

  return null;
}

function looksLikeYear(v) {
  return v >= 1900 && v <= 2099;
}

// ======================== MERGE AMOUNTS (regex + AI) ========================
function mergeAmounts(statementAmounts, aiAmounts, sourceType) {
  const out = {
    totalCharges: statementAmounts.totalCharges,
    insurancePaid: statementAmounts.insurancePaid,
    patientResponsibility: statementAmounts.patientResponsibility,
    _debug: statementAmounts._debug,
  };

  // If statement returned Not detected but AI explicitly provided a value, use AI (lower confidence).
  out.totalCharges = mergeOne(out.totalCharges, aiAmounts.totalCharges, sourceType, "ai_fill");
  out.insurancePaid = mergeOne(out.insurancePaid, aiAmounts.insurancePaid, sourceType, "ai_fill");
  out.patientResponsibility = mergeOne(out.patientResponsibility, aiAmounts.patientResponsibility, sourceType, "ai_fill");

  return out;
}

function mergeOne(primary, aiField, sourceType, mode) {
  const primaryHas = primary && primary.value && primary.value !== "Not detected";
  const aiHas = aiField && aiField.value && aiField.value !== "Not detected";

  if (primaryHas) return primary;

  if (aiHas) {
    // AI fill should be cautious unless it cites an explicit label
    const c = clamp((aiField.confidence || 0.55) - (sourceType.includes("ocr") ? 0.1 : 0), 0.25, 0.85);
    return {
      ...aiField,
      confidence: Number(c.toFixed(2)),
      reason: (aiField.reason || "Provided by AI from explicit text") + " (AI-extracted)",
      source: (aiField.source || sourceType) + "+ai",
      matchMethod: aiField.matchMethod || mode,
    };
  }

  return primary;
}

// ======================== FIELD BUILDING ========================
function buildField(label, amountStr, sourceType, reasonBase, matchLine, matchMethod) {
  const cleaned = normalizeAmount(amountStr);

  let confidence = 0.78; // higher base because we now require label proximity
  let reason = reasonBase;

  if (sourceType.includes("pdf")) confidence += 0.08;
  if (sourceType.includes("excel")) confidence += 0.05;
  if (sourceType.includes("ocr")) {
    confidence -= 0.18;
    reason += " (OCR text can be noisy)";
  }

  confidence = clamp(confidence, 0.2, 0.95);

  return {
    label,
    value: formatUSD(cleaned),
    confidence: Number(confidence.toFixed(2)),
    reason,
    source: sourceType,
    raw: cleaned,
    matchLine: matchLine ? String(matchLine).slice(0, 260) : null,
    matchMethod: matchMethod || "unknown",
  };
}

function notDetectedField(label, sourceType, why = "No clear matching line found") {
  return {
    label,
    value: "Not detected",
    confidence: 0,
    reason: why,
    source: sourceType || "none",
    raw: null,
    matchLine: null,
    matchMethod: "none",
  };
}

// ======================== AI MERGE + AI AMOUNTS NORMALIZE ========================
function mergeAI(openAI, gemini) {
  // prefer OpenAI if present; otherwise Gemini
  const base = openAI || gemini || null;
  if (!base) return null;

  // If one has fields missing, fill from the other
  const other = base === openAI ? gemini : openAI;

  return {
    summary: base.summary || other?.summary || "",
    explanation: base.explanation || other?.explanation || "",
    summaryPoints: base.summaryPoints || other?.summaryPoints || [],
    nextSteps: base.nextSteps || other?.nextSteps || [],
    keyAmounts: base.keyAmounts || other?.keyAmounts || {},
  };
}

function normalizeAIAmounts(keyAmounts) {
  // Expected AI schema:
  // {
  //   totalCharges: { value: "111.41" or "$111.41" or null, reason: "...", confidence: 0.6 },
  //   insurancePaid: ...,
  //   patientResponsibility: ...
  // }
  const norm = {};
  for (const k of ["totalCharges", "insurancePaid", "patientResponsibility"]) {
    const v = keyAmounts?.[k];
    if (!v || v.value == null) {
      norm[k] = { value: "Not detected", confidence: 0, reason: "AI did not find explicit value", source: "ai" };
      continue;
    }
    const cleaned = normalizeAmount(String(v.value));
    if (!cleaned) {
      norm[k] = { value: "Not detected", confidence: 0, reason: "AI value not parseable", source: "ai" };
      continue;
    }
    norm[k] = {
      label: k,
      value: formatUSD(cleaned),
      raw: cleaned,
      confidence: clamp(Number(v.confidence ?? 0.6), 0.25, 0.85),
      reason: v.reason || "AI found an explicit labeled value",
      source: "ai",
      matchLine: v.matchLine ? String(v.matchLine).slice(0, 260) : null,
      matchMethod: "ai",
    };
  }
  return norm;
}

// ======================== CONFIDENCE BOOST VIA AI AGREEMENT ========================
function applyAIConfidenceBoost(openAI, gemini, fields) {
  const aiText = (safeStringify(openAI) + " " + safeStringify(gemini)).toLowerCase();

  for (const f of fields) {
    if (!f || !f.raw || f.value === "Not detected") continue;

    const raw = String(f.raw).replace(/,/g, "");
    const raw2 = raw.replace(/\.00$/, "");
    const asDollars = String(f.value).replace(/\$/g, "").replace(/,/g, "");

    if (aiText.includes(raw) || aiText.includes(raw2) || aiText.includes(asDollars)) {
      f.confidence = Math.min(1, Number((f.confidence + 0.08).toFixed(2)));
      f.reason += " + mentioned by AI analysis";
      f.source += "+ai";
    }
  }
}

// ======================== PDF TEXT EXTRACTION ========================
async function safeExtractPdfText(uint8) {
  try {
    const text = await extractTextFromPDF(uint8);
    return { ok: true, provider: "pdf_text", status: 200, textLen: (text || "").length, text };
  } catch (e) {
    return { ok: false, provider: "pdf_text", status: 500, textLen: 0, text: "" };
  }
}

async function extractTextFromPDF(uint8) {
  try {
    const pdfjs = await import("https://cdn.jsdelivr.net/npm/pdfjs-dist@4.5.136/+esm");
    const loadingTask = pdfjs.getDocument({ data: uint8 });
    const pdf = await loadingTask.promise;

    let text = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map((it) => (it?.str ? it.str : "")).join(" ") + "\n";
    }
    return text.trim();
  } catch {
    return "";
  }
}

// ======================== OCR / EXCEL / HELPERS ========================
async function safeExtractGoogleVision(uint8, mimeType, env) {
  try {
    const text = await extractWithGoogleVision(uint8, mimeType, env);
    return {
      ok: true,
      provider: "google_vision",
      status: 200,
      textLen: (text || "").length,
      text,
    };
  } catch {
    return { ok: false, provider: "google_vision", status: 500, textLen: 0, text: "" };
  }
}

async function extractWithGoogleVision(uint8, mimeType, env) {
  try {
    if (!env.GOOGLE_VISION_API_KEY) return "";

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

    if (!res.ok) return "";
    const json = await res.json();
    return json.responses?.[0]?.fullTextAnnotation?.text || "";
  } catch {
    return "";
  }
}

async function safeExtractOcrSpace(uint8, mimeType, env) {
  try {
    const text = await extractWithOcrSpace(uint8, mimeType, env);
    return { ok: true, provider: "ocr_space", status: 200, textLen: (text || "").length, text };
  } catch {
    return { ok: false, provider: "ocr_space", status: 500, textLen: 0, text: "" };
  }
}

async function extractWithOcrSpace(uint8, mimeType, env) {
  try {
    if (!env.OCR_SPACE_API_KEY) return "";

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

    if (!res.ok) return "";
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

// ======================== AI (STRICT JSON + AMOUNTS) ========================
async function analyzeWithOpenAI(text, isPaid, env) {
  try {
    if (!env.OPENAI_API_KEY) return null;

    const model = isPaid ? "gpt-4o" : "gpt-4o-mini";

    const system =
      `You are ExplainMyBill.\n` +
      `Return ONLY valid JSON (no markdown, no extra text).\n` +
      `Do NOT guess amounts. Only extract amounts if explicitly present in the text.\n` +
      `If a value is not clearly labeled, use null.\n\n` +
      `Schema:\n` +
      `{\n` +
      `  "summary": string,\n` +
      `  "summaryPoints": string[],\n` +
      `  "explanation": string,\n` +
      `  "nextSteps": string[],\n` +
      `  "keyAmounts": {\n` +
      `     "totalCharges": { "value": string|null, "reason": string, "confidence": number, "matchLine": string|null },\n` +
      `     "insurancePaid": { "value": string|null, "reason": string, "confidence": number, "matchLine": string|null },\n` +
      `     "patientResponsibility": { "value": string|null, "reason": string, "confidence": number, "matchLine": string|null }\n` +
      `  }\n` +
      `}`;

    const user =
      `Simplify this medical bill for a normal person.\n` +
      `1) Explain what this statement is\n` +
      `2) Explain what "pay this amount / amount due" means\n` +
      `3) Provide practical next steps (itemized bill, payment plan, insurance EOB, dispute)\n` +
      `4) Extract labeled amounts ONLY if explicit.\n\n` +
      `BILL TEXT:\n${text}`;

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
      `Return ONLY valid JSON (no markdown, no extra text).\n` +
      `Do NOT guess amounts. Only extract if explicitly labeled.\n` +
      `Schema:\n` +
      `{\n` +
      `  "summary": string,\n` +
      `  "summaryPoints": string[],\n` +
      `  "explanation": string,\n` +
      `  "nextSteps": string[],\n` +
      `  "keyAmounts": {\n` +
      `     "totalCharges": { "value": string|null, "reason": string, "confidence": number, "matchLine": string|null },\n` +
      `     "insurancePaid": { "value": string|null, "reason": string, "confidence": number, "matchLine": string|null },\n` +
      `     "patientResponsibility": { "value": string|null, "reason": string, "confidence": number, "matchLine": string|null }\n` +
      `  }\n` +
      `}\n\n` +
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

function normalizeAmount(a) {
  return String(a || "").replace(/,/g, "").replace(/[^\d.]/g, "").trim();
}

function formatUSD(numericString) {
  const n = Number(numericString);
  if (!isFinite(n)) return "Not detected";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
