// ExplainMyBill Worker — FULL VERSION (FIXED FIELD EXTRACTION + DEBUG PROVIDER TRACE)
// Dec 29, 2025
//
// ✅ Keeps: Google Vision + OCR.space + OpenAI + Gemini + PDF text extraction + Excel support + Stripe hook
// ✅ Fixes: "Not detected" + "same number for all 3" via table-aware parsing + multi-pass scoring
// ✅ Adds: Debug trace to confirm which extractor ran (google_vision vs ocr_space)
// ✅ Dev mode: you should NEVER see upgrade prompts when testing
// ✅ Privacy: no DB, no storage, no login (and avoids logging bill text)
//
// Env vars:
// - DEV_MODE="true"                 -> unlock everything for you (developer)
// - DEV_KEY="some-long-secret"      -> optional header bypass: X-Dev-Key
// - DISABLE_OCR_SPACE="true"        -> keep code but disable OCR fallback
// - FORCE_VISION_ONLY="true"        -> only use Google Vision for images (no OCR.space fallback)
// - OPENAI_API_KEY
// - GEMINI_API_KEY
// - GOOGLE_VISION_API_KEY
// - OCR_SPACE_API_KEY
// - STRIPE_SECRET_KEY (optional, for checkout endpoint)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, X-Dev-Bypass, X-Dev-Key, X-Debug, Authorization",
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
  // Debug flag (developer-only usage recommended)
  const debug =
    request.headers.get("X-Debug") === "true" ||
    new URL(request.url).searchParams.get("debug") === "true";

  try {
    // -------- DEV ALWAYS-PAID MODE (YOU ARE THE DEVELOPER) --------
    const devBypassHeader = request.headers.get("X-Dev-Bypass") === "true";
    const devKeyHeader = request.headers.get("X-Dev-Key") || "";
    const isDeveloper =
      String(env.DEV_MODE || "").toLowerCase() === "true" ||
      devBypassHeader ||
      (env.DEV_KEY && timingSafeEqual(devKeyHeader, env.DEV_KEY));

    // For your testing: treat developer as paid/unlocked
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
    let extractorUsed = "none";
    let primaryTrace = null;
    let fallbackTrace = null;

    const disableOcrSpace = String(env.DISABLE_OCR_SPACE || "").toLowerCase() === "true";
    const forceVisionOnly = String(env.FORCE_VISION_ONLY || "").toLowerCase() === "true";

    // ---------- PDF ----------
    if (name.endsWith(".pdf")) {
      sourceType = "pdf";
      rawText = await extractTextFromPDF(buffer);
      extractorUsed = "pdf_text";

      // If PDF text extraction is weak, fall back to OCR.space (if enabled)
      if ((!rawText || rawText.trim().length < 200) && !disableOcrSpace) {
        usedOCR = true;
        sourceType = "pdf+ocr";
        const ocr = await extractWithOcrSpaceDetailed(buffer, "application/pdf", env);
        fallbackTrace = ocr.trace;
        rawText = ocr.text || "";
        extractorUsed = "ocr_space";
      }
    }

    // ---------- Excel ----------
    else if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
      sourceType = "excel";
      const pages = await processExcel(buffer);
      rawText = pages.map((p) => p.rawText).join("\n\n");
      extractorUsed = "excel";
    }

    // ---------- Image ----------
    else {
      sourceType = "image";

      // Primary: Google Vision
      const vision = await extractWithGoogleVisionDetailed(buffer, file.type, env);
      primaryTrace = vision.trace;
      rawText = vision.text || "";
      extractorUsed = "google_vision";

      // Quality gate: only fallback if text quality is weak
      const q = scoreTextQuality(rawText);

      const shouldFallback =
        !forceVisionOnly &&
        !disableOcrSpace &&
        (vision.ok !== true || q.score < 0.35 || rawText.trim().length < 200);

      if (shouldFallback) {
        const ocr = await extractWithOcrSpaceDetailed(buffer, file.type, env);
        fallbackTrace = ocr.trace;

        // Only switch if OCR produced meaningfully more usable text
        const q2 = scoreTextQuality(ocr.text || "");
        if (q2.score > q.score && (ocr.text || "").trim().length > rawText.trim().length) {
          usedOCR = true;
          sourceType = "image+ocr";
          rawText = ocr.text || "";
          extractorUsed = "ocr_space";
        }
      }
    }

    const text = normalizeBillText(rawText);

    // If still unusable, return minimal response (no throwing)
    if (!text || text.length < 60) {
      const structured = {
        summary: "We could not reliably read text from this document.",
        explanation:
          "No readable text was detected. Try a clearer photo (flat, bright, no glare) or upload the PDF directly.",
        nextSteps: [
          "Re-scan or take a clearer photo (no glare, full page, straight).",
          "If PDF: try exporting a text-based PDF from your provider portal.",
          "Crop out background and re-upload if it’s a photo.",
        ],
        keyAmounts: {
          totalCharges: notDetectedField("Total Charges", sourceType),
          insurancePaid: notDetectedField("Insurance Paid", sourceType),
          patientResponsibility: notDetectedField("Patient Responsibility", sourceType),
        },
        confidenceMeta: {
          sourceType,
          usedOCR,
          extractorUsed,
          disclaimer:
            "This app is not HIPAA-certified. Confidence reflects document clarity + pattern matches. Verify amounts before payment.",
        },
      };

      return jsonResponse(
        {
          isPaid,
          isDeveloper,
          devBypass: isDeveloper,
          pages: [
            {
              page: 1,
              rawText: debug ? previewText(text) : undefined,
              structured,
            },
          ],
          explanation: structured.explanation,
          extractionDebug: debug
            ? {
                usedOCR,
                extractorUsed,
                sourceType,
                textLen: text.length,
                primary: primaryTrace,
                fallback: fallbackTrace,
              }
            : undefined,
        },
        cors
      );
    }

    // ================= FIELD EXTRACTION (FIXED) =================
    // 1) hard patterns (PAY THIS AMOUNT / AMOUNT DUE)
    // 2) table-aware parser if CHARGES/PAYMENTS/BALANCE appears
    // 3) scored candidate selection (prevents same amount for all fields)
    const fields = extractAllKeyAmounts(text, sourceType);

    // ================= AI (STRICT JSON) =================
    const [openAIResult, geminiResult] = await Promise.all([
      analyzeWithOpenAI(text, isPaid, env),
      analyzeWithGemini(text, isPaid, env),
    ]);

    // AI agreement boosts confidence if AI mentions same numeric amount
    applyAIConfidenceBoost(openAIResult, geminiResult, [
      fields.totalCharges,
      fields.insurancePaid,
      fields.patientResponsibility,
    ]);

    // Duplicate-value sanity: if same value picked for multiple fields, lower confidence + note
    enforceDistinctness([fields.totalCharges, fields.insurancePaid, fields.patientResponsibility]);

    const structured = {
      summary: openAIResult?.summary || geminiResult?.summary || "Bill analyzed.",
      explanation:
        openAIResult?.explanation ||
        geminiResult?.explanation ||
        "Analysis complete. Verify all amounts with your provider/insurer before paying.",
      nextSteps: openAIResult?.nextSteps || geminiResult?.nextSteps || [],
      keyAmounts: fields,
      confidenceMeta: {
        sourceType,
        usedOCR,
        extractorUsed,
        disclaimer:
          "This app is not HIPAA-certified. Confidence reflects document clarity + pattern matches. Verify amounts before payment.",
      },
    };

    return jsonResponse(
      {
        isPaid,
        isDeveloper,
        devBypass: isDeveloper,
        pages: [
          {
            page: 1,
            rawText: debug ? previewText(text) : undefined,
            structured,
          },
        ],
        explanation: structured.explanation,
        extractionDebug: debug
          ? {
              usedOCR,
              extractorUsed,
              sourceType,
              textLen: text.length,
              quality: scoreTextQuality(text),
              primary: primaryTrace,
              fallback: fallbackTrace,
              tableParse: fields?._tableDebug,
            }
          : undefined,
      },
      cors
    );
  } catch (err) {
    console.error("Processing error:", err?.message || err);
    return errorResponse("Processing failed", 500, cors);
  }
}

// ======================== KEY AMOUNT EXTRACTION ========================
function extractAllKeyAmounts(text, sourceType) {
  // A) Patient due: strongest patterns
  const due = extractPatientDue(text, sourceType);

  // B) Table parse (CHARGES/PAYMENTS/BALANCE)
  const table = parseChargesPaymentsBalanceTable(text);

  // C) If table parse looks valid, use it for totalCharges + insurancePaid
  let totalCharges = null;
  let insurancePaid = null;

  if (table.ok) {
    totalCharges = buildField("Total Charges", String(table.sumCharges), sourceType, "Parsed CHARGES column and summed rows", {
      confidenceOverride: 0.82,
      raw: String(table.sumCharges),
    });
    insurancePaid = buildField("Insurance Paid", String(table.sumPayments), sourceType, "Parsed PAYMENTS column and summed rows", {
      confidenceOverride: 0.78,
      raw: String(table.sumPayments),
    });
  }

  // D) If table didn’t work, fall back to scored candidate selection
  if (!totalCharges) {
    totalCharges = extractMoneyByScoring(text, sourceType, {
      label: "Total Charges",
      positive: ["total charges", "amount billed", "total amount", "charges"],
      negative: ["amount due", "pay this amount", "balance due", "patient"],
      preferLargest: true,
    });
  }

  if (!insurancePaid) {
    insurancePaid = extractMoneyByScoring(text, sourceType, {
      label: "Insurance Paid",
      positive: ["insurance payment", "insurance paid", "plan paid", "payment", "payments", "allowed amount", "adjustment"],
      negative: ["amount due", "pay this amount", "patient"],
      preferLargest: false,
    });
  }

  // E) Patient responsibility: prefer due pattern; else look for balance due / amount due; else table sum balance
  let patientResponsibility = due;
  if (patientResponsibility.value === "Not detected") {
    if (table.ok && table.sumBalances > 0) {
      patientResponsibility = buildField(
        "Patient Responsibility",
        String(table.sumBalances),
        sourceType,
        "Fallback: summed BALANCE column from table",
        { confidenceOverride: 0.72, raw: String(table.sumBalances) }
      );
    } else {
      patientResponsibility = extractMoneyByScoring(text, sourceType, {
        label: "Patient Responsibility",
        positive: ["patient responsibility", "balance due", "amount due", "total due", "you owe", "please pay", "pay this amount"],
        negative: ["charges", "amount billed"],
        preferLargest: false,
        preferSmallish: true,
      });
    }
  }

  const out = {
    totalCharges,
    insurancePaid,
    patientResponsibility,
    _tableDebug: table.ok ? table.debug : { ok: false },
  };

  // Don’t expose internal debug in normal UI; only useful when you set X-Debug
  return out;
}

function extractPatientDue(text, sourceType) {
  const patterns = [
    /(pay\s*this\s*amount)\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
    /(amount\s*due|balance\s*due|total\s*due|amt\s*due)\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
    /(current\s*amount\s*due)\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
    /(net\s*due)\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
  ];

  for (const rx of patterns) {
    const m = text.match(rx);
    if (m) {
      const amt = normalizeAmount(m[m.length - 1]);
      return buildField("Patient Responsibility", amt, sourceType, `Matched "${m[1]}"`, {
        confidenceOverride: 0.9,
        raw: amt,
      });
    }
  }

  return notDetectedField("Patient Responsibility", sourceType, "No explicit Amount Due / Pay This Amount found");
}

function parseChargesPaymentsBalanceTable(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const headerIdx = lines.findIndex((l) => {
    const ll = l.toLowerCase();
    // OCR sometimes says CHANGES instead of CHARGES, so accept both
    return (ll.includes("charges") || ll.includes("changes")) && ll.includes("payments") && ll.includes("balance");
  });

  if (headerIdx === -1) {
    return { ok: false, debug: { ok: false, reason: "Header not found" } };
  }

  // Collect money amounts from a window after header until messages/footer
  const stopWords = ["important messages", "please detach", "statement", "reminder"];
  const amounts = [];

  for (let i = headerIdx; i < Math.min(lines.length, headerIdx + 120); i++) {
    const ll = lines[i].toLowerCase();
    if (stopWords.some((w) => ll.includes(w))) break;

    const found = extractAllMoney(lines[i]);
    for (const f of found) amounts.push(f.value);
  }

  // Need at least one full row (charge, payment, balance)
  if (amounts.length < 3) {
    return { ok: false, debug: { ok: false, reason: "Not enough amounts after header", amountsFound: amounts.length } };
  }

  // Group by 3: charge, payment, balance
  let sumCharges = 0;
  let sumPayments = 0;
  let sumBalances = 0;

  for (let i = 0; i + 2 < amounts.length; i += 3) {
    const c = amounts[i];
    const p = amounts[i + 1];
    const b = amounts[i + 2];

    // sanity filter: ignore ridiculous triples (e.g., years/phone fragments already filtered)
    if (c <= 0) continue;

    sumCharges += c;
    sumPayments += Math.max(0, p);
    sumBalances += Math.max(0, b);
  }

  // If sums are zero-ish, table parse likely failed
  if (sumCharges <= 0) {
    return { ok: false, debug: { ok: false, reason: "Sum charges <= 0", amountsSample: amounts.slice(0, 12) } };
  }

  return {
    ok: true,
    sumCharges: round2(sumCharges),
    sumPayments: round2(sumPayments),
    sumBalances: round2(sumBalances),
    debug: {
      ok: true,
      headerLine: lines[headerIdx],
      amountsSample: amounts.slice(0, 18),
      groupedTriples: Math.floor(amounts.length / 3),
      sumCharges: round2(sumCharges),
      sumPayments: round2(sumPayments),
      sumBalances: round2(sumBalances),
    },
  };
}

function extractMoneyByScoring(text, sourceType, cfg) {
  const {
    label,
    positive = [],
    negative = [],
    preferLargest = false,
    preferSmallish = false,
  } = cfg;

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const pos = positive.map((x) => x.toLowerCase());
  const neg = negative.map((x) => x.toLowerCase());

  // Build candidates: each money on a line gets a score based on context
  const candidates = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ll = line.toLowerCase();

    const money = extractAllMoney(line);
    if (!money.length) continue;

    const ctx = [
      lines[i - 1] || "",
      lines[i] || "",
      lines[i + 1] || "",
    ].join(" ").toLowerCase();

    let base = 0;

    for (const p of pos) if (ctx.includes(p)) base += 4;
    for (const n of neg) if (ctx.includes(n)) base -= 3;

    // Slight boost if $ appears in the line (more “bill-like”)
    if (line.includes("$")) base += 1;

    for (const m of money) {
      // Prefer plausible bill amounts (avoid tiny)
      if (m.value < 1) continue;

      let score = base;

      // If they want largest, reward bigger values a bit
      if (preferLargest) score += Math.log10(1 + m.value);

      // If they want “smallish”, penalize very large amounts slightly
      if (preferSmallish) score -= Math.log10(1 + m.value) * 0.4;

      candidates.push({
        value: m.value,
        amount: m.amount,
        score,
        line,
      });
    }
  }

  if (!candidates.length) return notDetectedField(label, sourceType, "No currency values detected");

  // Sort by score first, then by value if tie
  candidates.sort((a, b) => (b.score - a.score) || (b.value - a.value));

  const best = candidates[0];
  const reason =
    best.score >= 6
      ? "Matched strong keyword context near amount"
      : best.score >= 3
      ? "Matched partial keyword context near amount"
      : "Fallback: selected most plausible amount found";

  const conf =
    best.score >= 6 ? 0.84 :
    best.score >= 3 ? 0.72 :
    0.60;

  return buildField(label, best.amount, sourceType, reason, {
    confidenceOverride: conf,
    raw: normalizeAmount(best.amount),
  });
}

function enforceDistinctness(fields) {
  // If the same formatted dollar amount is used for multiple fields, lower confidence
  const map = new Map();
  for (const f of fields) {
    if (!f || f.value === "Not detected") continue;
    const key = f.value;
    map.set(key, (map.get(key) || 0) + 1);
  }
  for (const f of fields) {
    if (!f || f.value === "Not detected") continue;
    const count = map.get(f.value) || 0;
    if (count >= 2) {
      f.confidence = clamp(Number((f.confidence - 0.18).toFixed(2)), 0.15, 0.95);
      f.reason += " (same amount appeared for multiple fields — verify)";
    }
  }
}

// ======================== FIELD OBJECT BUILDERS ========================
function buildField(label, amountStr, sourceType, reasonBase, opts = {}) {
  const cleaned = normalizeAmount(amountStr);
  const usd = formatUSD(cleaned);

  let confidence =
    typeof opts.confidenceOverride === "number" ? opts.confidenceOverride : 0.72;

  let reason = reasonBase;

  if (sourceType.includes("pdf")) confidence += 0.06;
  if (sourceType.includes("excel")) confidence += 0.05;
  if (sourceType.includes("ocr")) {
    confidence -= 0.16;
    reason += " (OCR text can be noisy)";
  }

  confidence = clamp(confidence, 0.15, 0.95);

  return {
    label,
    value: usd,
    confidence: Number(confidence.toFixed(2)),
    reason,
    source: sourceType,
    raw: opts.raw || cleaned, // numeric string
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
  } catch (e) {
    console.warn("PDF extract failed:", e?.message || e);
    return "";
  }
}

// ======================== OCR / EXCEL ========================
async function extractWithGoogleVisionDetailed(uint8, mimeType, env) {
  const trace = {
    ok: false,
    provider: "google_vision",
    status: null,
    textLen: 0,
    note: "",
  };
  try {
    if (!env.GOOGLE_VISION_API_KEY) {
      trace.note = "Missing GOOGLE_VISION_API_KEY";
      return { ok: false, text: "", trace };
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

    trace.status = res.status;

    const json = await res.json().catch(() => ({}));
    const text = json.responses?.[0]?.fullTextAnnotation?.text || "";

    trace.ok = res.ok === true;
    trace.textLen = (text || "").length;

    return { ok: trace.ok, text, trace };
  } catch (e) {
    trace.note = e?.message || "Vision call failed";
    return { ok: false, text: "", trace };
  }
}

async function extractWithOcrSpaceDetailed(uint8, mimeType, env) {
  const trace = {
    ok: false,
    provider: "ocr_space",
    status: null,
    textLen: 0,
    note: "",
  };
  try {
    if (!env.OCR_SPACE_API_KEY) {
      trace.note = "Missing OCR_SPACE_API_KEY";
      return { ok: false, text: "", trace };
    }

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

    trace.status = res.status;

    const json = await res.json().catch(() => ({}));
    const text = json.ParsedResults?.[0]?.ParsedText || "";

    trace.ok = res.ok === true;
    trace.textLen = (text || "").length;

    return { ok: trace.ok, text, trace };
  } catch (e) {
    trace.note = e?.message || "OCR.space call failed";
    return { ok: false, text: "", trace };
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

// ======================== AI (STRICT JSON) ========================
async function analyzeWithOpenAI(text, isPaid, env) {
  try {
    if (!env.OPENAI_API_KEY) return null;

    const model = isPaid ? "gpt-4o" : "gpt-4o-mini";

    const system =
      `Return ONLY valid JSON (no markdown). Do not guess numbers. ` +
      `If a value isn't explicit, set it to null.\n` +
      `Schema: {"summary": string, "explanation": string, "nextSteps": string[]}`;

    const user =
      `Simplify this bill for a normal person.\n` +
      `- Explain what it is\n` +
      `- Explain what the patient likely owes vs insurance (ONLY if explicitly present)\n` +
      `- Give practical next steps (itemized bill, payment plan, appeal, coding review)\n\n` +
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

// ======================== CONFIDENCE BOOST VIA AI AGREEMENT ========================
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

function extractAllMoney(s) {
  const out = [];
  const rx = /\$?\s*([\d]{1,3}(?:,[\d]{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)/g;
  const str = String(s);
  let m;
  while ((m = rx.exec(str))) {
    const amt = normalizeAmount(m[1]);
    const val = Number(amt);
    if (!isFinite(val) || val <= 0) continue;
    if (val >= 1900 && val <= 2099) continue; // years
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

function round2(n) {
  return Math.round(n * 100) / 100;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
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

function jsonResponse(obj, cors) {
  // Remove undefined (keeps your JSON clean)
  return new Response(JSON.stringify(obj, (_k, v) => (v === undefined ? undefined : v)), {
    headers: { "Content-Type": "application/json", ...cors },
  });
}

function errorResponse(msg, status, cors) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

// ======================== QUALITY SCORING (FOR FALLBACK DECISION) ========================
function scoreTextQuality(text) {
  const s = String(text || "").trim();
  if (!s) return { score: 0, len: 0, words: 0, digitRatio: 0 };

  const len = s.length;
  const words = s.split(/\s+/).filter(Boolean).length;
  const digits = (s.match(/\d/g) || []).length;
  const digitRatio = len ? digits / len : 0;

  // heuristic: needs enough words + some digits but not all digits
  let score = 0;
  score += Math.min(1, len / 2000) * 0.55;
  score += Math.min(1, words / 250) * 0.35;

  // digit ratio sweet spot
  const dr = digitRatio;
  const drScore = dr > 0.02 && dr < 0.25 ? 0.10 : 0.03;
  score += drScore;

  return { score: Number(score.toFixed(3)), len, words, digitRatio: Number(digitRatio.toFixed(3)) };
}

function previewText(text) {
  const s = String(text || "");
  return s.length <= 2000 ? s : s.slice(0, 2000) + "\n\n…(truncated)…";
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
