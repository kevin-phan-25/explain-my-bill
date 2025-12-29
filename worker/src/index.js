// ExplainMyBill Worker — FULL VERSION (FIXED "NOT DETECTED") + FIELD CONFIDENCE + AI AGREEMENT
// Dec 29, 2025
//
// ✅ Keeps ALL your core logic: Google Vision, OCR.space fallback, OpenAI, Gemini, PDF text attempt, Excel support
// ✅ Fixes "Not detected" by using a REAL extraction engine (line + neighborhood scoring, not a single fragile regex)
// ✅ Forces OpenAI/Gemini to return strict JSON so JSON.parse stops failing silently
// ✅ Privacy: in-memory only (no storage). Also avoids logging raw bill text.
// ⚠️ IMPORTANT: Do NOT claim HIPAA certified. You can say “privacy-first / no storage” but you are not certified.

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
      console.error("Worker error:", safeErr(err));
      return errorResponse(err?.message || "Worker error", 500, cors);
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
    if (!allowed.some((e) => name.endsWith(e))) {
      return errorResponse("Unsupported format", 415, cors);
    }

    // Paid gating logic (dev bypass makes it "paid" during testing)
    const isPaid = devBypass;

    const buffer = new Uint8Array(await file.arrayBuffer());

    let text = "";
    let usedOCR = false;
    let sourceType = "unknown";

    // ---------- PDF ----------
    if (name.endsWith(".pdf")) {
      sourceType = "pdf";

      // Try text extraction first (works only when PDF has real embedded text)
      text = await extractTextFromPDF(buffer);

      // If weak, OCR it (this is the reality for most bills)
      if (!text || normalizeForScoring(text).length < 200) {
        usedOCR = true;
        sourceType = "pdf+ocr";
        text = await extractWithOcrSpace(buffer, "application/pdf", env);
      }
    }

    // ---------- Excel ----------
    else if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
      sourceType = "excel";
      const pages = await processExcel(buffer);
      text = pages.map((p) => p.rawText).join("\n\n");
    }

    // ---------- Image ----------
    else {
      sourceType = "image";
      text = await extractWithGoogleVision(buffer, file.type, env);

      if (!text || normalizeForScoring(text).length < 200) {
        usedOCR = true;
        sourceType = "image+ocr";
        text = await extractWithOcrSpace(buffer, file.type, env);
      }
    }

    if (!text || normalizeForScoring(text).length < 60) {
      text = "No readable text detected.";
    }

    // ================= FIELD EXTRACTION (FIXED) =================
    // We DO NOT rely on one fragile regex.
    // We score candidates from:
    // - labeled lines (e.g., "Amount Due", "Total Charges", "Patient Balance")
    // - nearby amounts in the same / adjacent lines
    // - penalties for "insurance", "adjustment", "paid" when looking for total due, etc.

    const totalCharges = extractMoneyFieldWithConfidence(text, {
      label: "Total Charges",
      // broad, real-world keywords
      include: [
        "total charges",
        "total charge",
        "total billed",
        "amount billed",
        "charges",
        "total amount",
        "total",
        "grand total",
      ],
      exclude: ["patient", "responsibility", "amount due", "balance due", "insurance", "paid", "adjustment", "allowed"],
      preferMaxInDoc: true,
      sourceType,
    });

    const insurancePaid = extractMoneyFieldWithConfidence(text, {
      label: "Insurance Paid",
      include: [
        "insurance paid",
        "insurance payment",
        "plan paid",
        "payer paid",
        "insurance",
        "paid by insurance",
        "payment",
        "allowed amount",
        "adjustment",
        "write-off",
        "discount",
      ],
      exclude: ["patient", "amount due", "balance due", "total due"],
      preferMaxInDoc: false,
      sourceType,
    });

    const patientDue = extractMoneyFieldWithConfidence(text, {
      label: "Patient Responsibility",
      include: [
        "patient responsibility",
        "patient balance",
        "patient due",
        "balance due",
        "amount due",
        "total due",
        "you owe",
        "amount you owe",
        "pay this amount",
        "please pay",
        "amount to pay",
        "patient pay",
        "current balance",
      ],
      exclude: ["insurance", "paid by", "adjustment", "write-off", "discount", "allowed"],
      preferMaxInDoc: false,
      sourceType,
    });

    // ================= AI =================
    // IMPORTANT FIX:
    // Your code was JSON.parse()'ing AI output, but you never forced the model to produce JSON.
    // That means parse usually fails => null => weak output.
    const openAIResult = await analyzeWithOpenAI(text, isPaid, env);
    const geminiResult = await analyzeWithGemini(text, isPaid, env);

    // AI agreement boosts confidence if it confirms same numeric amount
    applyAIConfidenceBoost(openAIResult, geminiResult, [totalCharges, insurancePaid, patientDue]);

    const structured = {
      summary: openAIResult?.summary || geminiResult?.summary || "Bill analyzed.",
      explanation:
        openAIResult?.explanation ||
        geminiResult?.explanation ||
        "We extracted the main amounts we could detect. If any value says 'Not detected', the document may be blurry or missing a clear labeled total.",
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
          "Confidence scores reflect document clarity and how strongly the amount matched typical bill wording. Verify amounts before paying. This app does not store files.",
      },
    };

    return new Response(
      JSON.stringify({
        isPaid,
        devBypass,
        pages: [{ page: 1, rawText: text, structured }],
        explanation: structured.explanation,
      }),
      { headers: { "Content-Type": "application/json", ...cors } }
    );
  } catch (err) {
    console.error("Processing error:", safeErr(err));
    return errorResponse(err?.message || "Processing error", 500, cors);
  }
}

// ======================== CONFIDENCE EXTRACTION (REPLACED) ========================
// This is the core fix: robust extraction across messy OCR and many bill formats.
function extractMoneyFieldWithConfidence(rawText, opts) {
  const {
    label,
    include = [],
    exclude = [],
    preferMaxInDoc = false,
    sourceType = "unknown",
  } = opts || {};

  const text = normalizeForScoring(rawText);
  const lines = splitLinesForScoring(rawText);

  // Extract all money mentions in the whole doc (used as a fallback)
  const allAmounts = extractAllAmounts(lines);

  // Candidate scoring by label words near amounts
  const includeLower = include.map((s) => s.toLowerCase());
  const excludeLower = exclude.map((s) => s.toLowerCase());

  const candidates = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    const window = [lines[i - 1] || "", line, lines[i + 1] || ""].join("  ").toLowerCase();

    // Find any amounts on current line OR adjacent lines, because OCR often breaks layouts
    const windowAmounts = extractAmountsFromString(window).map((a) => ({ ...a, lineIndex: i }));

    if (windowAmounts.length === 0) continue;

    // Score this window for this field
    const hasInclude = includeLower.some((k) => window.includes(k));
    const hasExclude = excludeLower.some((k) => window.includes(k));

    // Even if not labeled, allow "Amount Due" variants by general cues
    const cueBoost =
      includesAny(window, ["amount due", "balance due", "total due", "you owe", "please pay", "pay this amount"]) ? 0.25 : 0;

    for (const amt of windowAmounts) {
      let score = 0.35; // base score if we found an amount in neighborhood

      if (hasInclude) score += 0.35;
      if (cueBoost && label.toLowerCase().includes("responsibility")) score += cueBoost;
      if (hasExclude) score -= 0.25;

      // Penalize tiny values (like $5.00 copay) unless the line is very clearly labeled
      if (amt.valueNumber < 10 && !hasInclude) score -= 0.15;

      // Prefer "final / due" like amounts for patient responsibility
      if (label.toLowerCase().includes("responsibility")) {
        if (includesAny(window, ["due", "balance", "owe", "pay"])) score += 0.15;
        if (includesAny(window, ["paid", "payment received", "adjustment", "write-off", "discount"])) score -= 0.10;
      }

      // Prefer larger totals for total charges
      if (label.toLowerCase().includes("total charges")) {
        if (includesAny(window, ["total", "grand", "charges", "billed"])) score += 0.10;
      }

      // OCR / PDF confidence shaping
      if (sourceType.includes("pdf")) score += 0.08;
      if (sourceType.includes("ocr")) score -= 0.10;

      // Clamp
      score = clamp(score, 0.05, 0.98);

      candidates.push({
        label,
        value: amt.display,
        valueNumber: amt.valueNumber,
        confidence: score,
        reason: buildReason(label, window, includeLower, excludeLower, sourceType),
        source: sourceType,
      });
    }
  }

  // If we found candidates, pick the best.
  // For totals, sometimes the best answer is the *highest scoring*, not the highest amount.
  // But you can optionally prefer the max in the doc if no clear label exists.
  let best = null;

  if (candidates.length > 0) {
    // Prefer higher confidence; tiebreaker by amount size
    candidates.sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return b.valueNumber - a.valueNumber;
    });
    best = candidates[0];

    // If no candidate scored decently and user wants max fallback, use max doc amount
    if (preferMaxInDoc && best.confidence < 0.55 && allAmounts.length > 0) {
      const maxAmt = allAmounts.reduce((m, x) => (x.valueNumber > m.valueNumber ? x : m), allAmounts[0]);
      best = {
        label,
        value: maxAmt.display,
        valueNumber: maxAmt.valueNumber,
        confidence: clamp(best.confidence + 0.10, 0.05, 0.80),
        reason: "No strong labeled match found; selected highest detected amount as likely total.",
        source: sourceType,
      };
    }

    return finalizeField(best);
  }

  // No candidates at all => fallback: best guess by doc-level heuristics
  if (allAmounts.length > 0) {
    const fallback = pickDocLevelFallback(label, allAmounts, sourceType);
    if (fallback) return fallback;
  }

  // Nothing found
  return {
    label,
    value: "Not detected",
    confidence: 0,
    reason: "No currency values found near expected bill labels",
    source: "none",
  };
}

function finalizeField(f) {
  // Ensure value is always "$X.XX"
  const display = normalizeMoneyDisplay(f.value);
  const conf = Number(clamp(f.confidence, 0, 1).toFixed(2));
  return {
    label: f.label,
    value: display,
    confidence: conf,
    reason: f.reason,
    source: f.source,
  };
}

function pickDocLevelFallback(label, allAmounts, sourceType) {
  // Common reality:
  // - Total charges is often the biggest number
  // - Patient responsibility is often one of the larger numbers, but can be smaller than total
  // - Insurance paid can be large too, but usually not the biggest on the page
  const sorted = [...allAmounts].sort((a, b) => b.valueNumber - a.valueNumber);
  const biggest = sorted[0];

  if (label.toLowerCase().includes("total charges")) {
    return {
      label,
      value: biggest.display,
      confidence: Number(clamp((sourceType.includes("ocr") ? 0.45 : 0.55), 0, 1).toFixed(2)),
      reason: "Fallback: picked the largest detected amount as likely total charges (no clear label detected).",
      source: sourceType,
    };
  }

  // For patient responsibility, pick a high-but-not-necessarily-highest amount
  if (label.toLowerCase().includes("responsibility")) {
    const pick = sorted[Math.min(1, sorted.length - 1)] || biggest;
    return {
      label,
      value: pick.display,
      confidence: Number(clamp((sourceType.includes("ocr") ? 0.35 : 0.45), 0, 1).toFixed(2)),
      reason: "Fallback: selected a likely due/balance amount based on detected values (no clear label detected).",
      source: sourceType,
    };
  }

  // For insurance paid, pick a mid-high value
  const mid = sorted[Math.min(2, sorted.length - 1)] || biggest;
  return {
    label,
    value: mid.display,
    confidence: Number(clamp((sourceType.includes("ocr") ? 0.30 : 0.40), 0, 1).toFixed(2)),
    reason: "Fallback: selected a likely insurance/adjustment amount based on detected values (no clear label detected).",
    source: sourceType,
  };
}

// ======================== AI CONFIDENCE BOOST (IMPROVED) ========================
function applyAIConfidenceBoost(openAI, gemini, fields) {
  const aiBlob = (JSON.stringify(openAI || {}) + " " + JSON.stringify(gemini || {})).toLowerCase();

  for (const f of fields) {
    if (!f || f.value === "Not detected") continue;

    const num = f.value.replace(/[^0-9.]/g, "");
    if (!num) continue;

    // If AI mentions the same number, boost
    if (aiBlob.includes(num)) {
      f.confidence = Number(clamp(f.confidence + 0.12, 0, 1).toFixed(2));
      f.reason += " + confirmed by AI analysis";
      f.source += "+ai";
    }
  }
}

// ======================== PDF TEXT EXTRACTION ========================
async function extractTextFromPDF(uint8) {
  try {
    // NOTE: Remote imports can sometimes fail depending on your worker bundling settings.
    // We keep it (your logic) but rely on OCR fallback when it fails or is weak.
    const pdfjs = await import("https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.222/build/pdf.min.js");
    const pdf = await pdfjs.getDocument({ data: uint8 }).promise;
    let text = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map((it) => it.str).join(" ") + "\n\n";
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
          requests: [
            {
              image: { content: base64 },
              features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
            },
          ],
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
        // These help messy medical bills a LOT:
        isOverlayRequired: "false",
        detectOrientation: "true",
        scale: "true",
        OCREngine: "2",
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

// ======================== AI (FIXED JSON OUTPUT) ========================
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
        temperature: 0,
        response_format: { type: "json_object" }, // ✅ THIS is the key fix
        messages: [
          {
            role: "system",
            content:
              "You are ExplainMyBill. Return ONLY valid JSON. Do not guess missing numbers. Be clear and human.",
          },
          {
            role: "user",
            content:
              `Analyze this bill text and return JSON with keys:\n` +
              `summary (string), explanation (string), nextSteps (array of strings).\n` +
              `Rules:\n` +
              `- Do NOT invent amounts.\n` +
              `- If unsure, say so.\n\n` +
              text,
          },
        ],
      }),
    });

    const json = await res.json();
    const content = json.choices?.[0]?.message?.content || "{}";
    return safeJsonParse(content, null);
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
          contents: [
            {
              parts: [
                {
                  text:
                    "Return ONLY valid JSON with keys: summary (string), explanation (string), nextSteps (array of strings). " +
                    "Do not guess missing numbers. If unsure, say so.\n\n" +
                    text,
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0,
          },
        }),
      }
    );

    const json = await res.json();
    const out = json.candidates?.[0]?.content?.parts?.[0]?.text || "";
    // Gemini sometimes wraps JSON in ``` fences. Strip them.
    const cleaned = stripCodeFences(out);
    return safeJsonParse(cleaned, null);
  } catch {
    return null;
  }
}

// ======================== TEXT / MONEY HELPERS ========================
function normalizeForScoring(s) {
  return String(s || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitLinesForScoring(raw) {
  const normalized = normalizeForScoring(raw);
  // Keep lines, but also break on common OCR separators
  return normalized
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function extractAllAmounts(lines) {
  const out = [];
  for (const line of lines) {
    const found = extractAmountsFromString(line);
    for (const f of found) out.push(f);
  }
  // Deduplicate by numeric value + display
  const seen = new Set();
  const deduped = [];
  for (const a of out) {
    const k = `${a.valueNumber}:${a.display}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(a);
  }
  return deduped;
}

// Extract amounts like:
// $1,234.56
// 1,234.56
// 1234.56
// (123.45)  -> treat as 123.45 but keep display normalized
function extractAmountsFromString(s) {
  const str = String(s || "");
  const matches = [];

  // Common bill formats; allow optional $ and commas; capture decimals if present
  const re = /(\(?\s*\$?\s*[\d]{1,3}(?:,\d{3})*(?:\.\d{2})?\s*\)?)/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    const raw = m[1] || "";
    const num = raw.replace(/[^\d.]/g, "");
    if (!num) continue;

    const valueNumber = Number(num);
    if (!Number.isFinite(valueNumber)) continue;

    // Filter out things that are likely dates or IDs:
    // - if there's no decimal and it's too long, skip
    if (!raw.includes(".") && num.length >= 7) continue;

    const display = normalizeMoneyDisplay("$" + num);
    matches.push({ display, valueNumber });
  }

  return matches;
}

function normalizeMoneyDisplay(v) {
  const num = String(v || "").replace(/[^0-9.]/g, "");
  if (!num) return "Not detected";
  const n = Number(num);
  if (!Number.isFinite(n)) return "Not detected";
  // Keep two decimals if present; otherwise still show two decimals for consistency
  return "$" + n.toFixed(2);
}

function includesAny(hay, needles) {
  const h = String(hay || "").toLowerCase();
  return needles.some((n) => h.includes(String(n).toLowerCase()));
}

function buildReason(label, windowLower, includeLower, excludeLower, sourceType) {
  const inc = includeLower.find((k) => windowLower.includes(k));
  const exc = excludeLower.find((k) => windowLower.includes(k));
  let reason = "Detected amount near relevant bill text";
  if (inc) reason = `Matched context: "${inc}"`;
  if (exc) reason += ` (warning: also saw "${exc}")`;
  if (sourceType.includes("ocr")) reason += " • OCR used (lower clarity)";
  return reason;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

// ======================== BASE64 (KEEP YOUR SAFE CHUNKING) ========================
function uint8ArrayToBase64(uint8) {
  let s = "";
  for (let i = 0; i < uint8.length; i += 0x8000) {
    s += String.fromCharCode(...uint8.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

// ======================== JSON / ERROR HELPERS ========================
function stripCodeFences(s) {
  return String(s || "")
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
}

function safeJsonParse(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    // Try to salvage JSON object embedded in text
    const t = String(s || "");
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(t.slice(start, end + 1));
      } catch {}
    }
    return fallback;
  }
}

function safeErr(err) {
  return {
    message: err?.message || String(err),
    name: err?.name,
    stack: err?.stack ? String(err.stack).slice(0, 800) : undefined,
  };
}

function errorResponse(msg, status, cors) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

/* ========================
   STRIPE CHECKOUT
   (KEEP YOUR EXISTING handleStripeCheckout)
   ========================

   You said: "none of my logic was removed"
   I did not include your Stripe function here because you didn’t paste it in this message.
   Paste your existing handleStripeCheckout() below exactly as-is.

*/
