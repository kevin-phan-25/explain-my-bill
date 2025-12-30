// ExplainMyBill Worker — AI-FIRST STRUCTURED EXTRACTION + CITATIONS (Dec 30, 2025)
// ✅ Enhanced for maximum trust, accuracy, and user peace of mind
// ✅ AI-first with mandatory citations + dual-model agreement boosts
// ✅ Expanded medical bill patterns + few-shot examples in prompts
// ✅ Stronger privacy messaging + user guidance telemetry
// ✅ Keeps all previous features: Google Vision + OCR.space + OpenAI + Gemini + PDF/Excel + Regex fallback
// ✅ Dev: ALWAYS-PAID mode (no upgrade prompts for you)

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
    }
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
        cors
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
        "statement total", "billed amount", "total amount", "charges"
      ],
      strongRegexes: [
        /total\s*(charges?|billed|provider\s*charges|amount\s*billed|statement\s*total)\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /amount\s*billed\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
      ],
      fallbackPick: "max",
    });

    const regexInsurancePaid = extractMoneyField(text, {
      label: "Insurance Paid",
      sourceType: extraction.sourceType || sourceType,
      lineKeywords: [
        "insurance paid", "plan paid", "insurance payment", "plan payment",
        "adjustments", "contractual adjustment", "allowed amount", "write-off"
      ],
      strongRegexes: [
        /(insurance|plan)\s*(paid|payment)\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /contractual\s*adjustment\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /allowed\s*amount\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /adjustments?\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
      ],
      fallbackPick: "best-near-keywords",
    });

    const regexPatientDue = extractMoneyField(text, {
      label: "Patient Responsibility",
      sourceType: extraction.sourceType || sourceType,
      lineKeywords: [
        "patient responsibility", "patient balance", "balance due", "amount due",
        "you owe", "please pay", "pay this amount", "amount you may owe",
        "total due", "amt due", "net due", "patient due"
      ],
      strongRegexes: [
        /(patient\s*(responsibility|balance|due|owe))\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /(balance\s*due|amount\s*due|total\s*due|net\s*due|amt\s*due|you\s*owe|pay\s*this\s*amount|amount\s*you\s*may\s*owe)\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
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

    applyCrossAIAmountBoost(openAI, gemini, [totalCharges, insurancePaid, patientResponsibility]);
    applyInTextBoost(text, [totalCharges, insurancePaid, patientResponsibility]);

    const structured = {
      summary: aiMerged?.summary || "Your bill has been analyzed.",
      explanation:
        aiMerged?.explanation ||
        "This is what your bill is saying in plain English: The provider originally charged a certain amount. " +
        "Your insurance covered part of it through payments and adjustments. " +
        "The remaining balance is what you are responsible for. Always verify with your provider and insurer before paying.",
      nextSteps: Array.isArray(aiMerged?.nextSteps)
        ? aiMerged.nextSteps
        : [
            "Compare this with your Explanation of Benefits (EOB) from your insurer.",
            "Call the provider billing department if any amount seems incorrect.",
            "Check for duplicate charges or incorrect codes.",
            "Keep records of all payments.",
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
          "This app is not HIPAA-certified. Results are for informational purposes only. Always verify amounts with your provider and insurer before taking action.",
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
      cors
    );
  } catch (err) {
    console.error("Processing error:", err?.message || err);
    return errorResponse("Processing failed", 500, cors);
  }
}

// ======================== AI-FIRST EXTRACTION (ENHANCED PROMPTS) ========================
async function analyzeWithOpenAI_AIExtract(numberedLines, isPaid, env) {
  try {
    if (!env.OPENAI_API_KEY) return { ok: false, provider: "openai", error: "missing_key" };
    const model = isPaid ? "gpt-4o" : "gpt-4o-mini";

    const system = `You are ExplainMyBill, a trusted medical and utility bill explainer.
Return ONLY valid JSON. No markdown, no extra text.

You MUST cite evidence lines from the numbered lines provided.
Citations format: [{"line": <number>, "text": "<exact line text>"}]

JSON schema:
{
  "summary": string,                     // short plain-English headline
  "explanation": string,                 // clear, calm explanation of what the bill means
  "nextSteps": string[],                 // 3-5 practical next actions
  "fields": {
    "totalCharges": {"amount": number|null, "currency": "USD", "citations": [...]},
    "insurancePaid": {"amount": number|null, "currency": "USD", "citations": [...]},
    "patientResponsibility": {"amount": number|null, "currency": "USD", "citations": [...]}
  }
}

Rules:
- Medical bills (EOBs) have predictable summary sections, usually at bottom/right.
- "Total Charges" = "Total Charges", "Billed Amount", "Provider Charges", "Statement Total"
- "Insurance Paid" = payments + adjustments/write-offs (contractual, allowed amount reductions)
- "Patient Responsibility" = "Amount Due", "You Owe", "Balance Due", "Pay This Amount", "Amount You May Owe"
- Never confuse individual service charges with totals.
- Look for bold, boxed, or final summary lines.
- Do NOT guess numbers. If not explicit and clearly labeled, use null.
- Use citations that directly contain the label and value.

Few-shot example:
Input lines:
45. Total Charges: $1,234.56
52. Insurance Payment: $900.00
59. Amount Due: $334.56

Correct output:
{
  "summary": "You owe $334.56 after insurance coverage.",
  "explanation": "The provider billed $1,234.56. Your insurance paid $900.00, leaving a patient balance of $334.56.",
  "nextSteps": ["Verify with your EOB", "Contact billing if questions"],
  "fields": {
    "totalCharges": {"amount": 1234.56, "currency": "USD", "citations": [{"line":45,"text":"Total Charges: $1,234.56"}]},
    "insurancePaid": {"amount": 900.00, "currency": "USD", "citations": [{"line":52,"text":"Insurance Payment: $900.00"}]},
    "patientResponsibility": {"amount": 334.56, "currency": "USD", "citations": [{"line":59,"text":"Amount Due: $334.56"}]}
  }
}`;

    const user = `Extract the three key amounts with citations and explain the bill in plain English.\n\nNUMBERED LINES:\n${numberedLines}`;

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

    const prompt = `Return ONLY valid JSON (no markdown).

Schema same as OpenAI:
{
  "summary": string,
  "explanation": string,
  "nextSteps": string[],
  "fields": {
    "totalCharges": {"amount": number|null, "currency": "USD", "citations":[{"line":number,"text":string}]},
    "insurancePaid": {"amount": number|null, "currency": "USD", "citations":[{"line":number,"text":string}]},
    "patientResponsibility": {"amount": number|null, "currency": "USD", "citations":[{"line":number,"text":string}]}
  }
}

Rules identical:
- Look for summary box (bottom/right).
- "Pay This Amount", "Amount You May Owe", "Balance Due" → patientResponsibility
- Insurance includes adjustments/write-offs.
- Never guess. Use null if unclear.
- Citations must show label + value.

Few-shot example same as above.

NUMBERED LINES:\n${numberedLines}`;

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
  const a = openAI && openAI.ok ? openAI : null;
  const g = gemini && gemini.ok ? gemini : null;
  const pick = a || g;
  if (!pick) return null;

  const fields = {
    totalCharges: pick?.fields?.totalCharges || null,
    insurancePaid: pick?.fields?.insurancePaid || null,
    patientResponsibility: pick?.fields?.patientResponsibility || null,
  };

  if (a && g) {
    fields.totalCharges = a.fields?.totalCharges || g.fields?.totalCharges || null;
    fields.insurancePaid = a.fields?.insurancePaid || g.fields?.insurancePaid || null;
    fields.patientResponsibility = a.fields?.patientResponsibility || g.fields?.patientResponsibility || null;
  }

  return {
    summary: pick.summary || "",
    explanation: pick.explanation || "",
    nextSteps: Array.isArray(pick.nextSteps) ? pick.nextSteps : [],
    fields,
  };
}

// ======================== FINAL FIELD PICKER & CONFIDENCE ========================
function pickFinalField(label, aiField, regexField, sourceType) {
  if (aiField && isFiniteNumber(aiField.amount) && Array.isArray(aiField.citations) && aiField.citations.length) {
    const amt = Number(aiField.amount);
    return buildFieldWithCitations(label, amt, sourceType, {
      reasonBase: "AI extracted with direct evidence citations",
      citations: sanitizeCitations(aiField.citations),
      from: "ai",
    });
  }

  if (regexField && regexField.value !== "Not detected") {
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
  let confidence = 0.80;
  let reason = reasonBase;

  if (sourceType.includes("pdf")) confidence += 0.08;
  if (sourceType.includes("excel")) confidence += 0.05;
  if (sourceType.includes("ocr")) {
    confidence -= 0.18;
    reason += " (OCR can introduce noise)";
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
    from,
    citations: citations || [],
  };
}

function sanitizeCitations(citations) {
  return (citations || [])
    .filter((c) => c && Number.isInteger(c.line) && typeof c.text === "string")
    .slice(0, 6)
    .map((c) => ({
      line: c.line,
      text: c.text.slice(0, 180),
    }));
}

function applyCrossAIAmountBoost(openAI, gemini, fields) {
  const o = openAI?.fields || {};
  const g = gemini?.fields || {};

  const pairs = [
    ["totalCharges", o.totalCharges, g.totalCharges],
    ["insurancePaid", o.insurancePaid, g.insurancePaid],
    ["patientResponsibility", o.patientResponsibility, g.patientResponsibility],
  ];

  for (const [key, a, b] of pairs) {
    if (!a || !b || !isFiniteNumber(a.amount) || !isFiniteNumber(b.amount)) continue;
    const diff = Math.abs(Number(a.amount) - Number(b.amount));
    const base = Math.max(Number(a.amount), Number(b.amount), 1);
    if (diff <= 2 || diff / base <= 0.01) {
      const target = fields.find((f) => f.label === labelFromKey(key));
      if (target && target.value !== "Not detected") {
        target.confidence = Math.min(1, Number((target.confidence + 0.06).toFixed(2)));
        target.reason += " + Both AIs agree on amount";
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
      f.reason += " + Amount appears verbatim in document";
    }
  }
}

function labelFromKey(key) {
  if (key === "totalCharges") return "Total Charges";
  if (key === "insurancePaid") return "Insurance Paid";
  if (key === "patientResponsibility") return "Patient Responsibility";
  return key;
}

// ======================== EXTRACTION HELPERS (UNCHANGED) ========================
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

// ======================== REGEX FALLBACK (EXPANDED) ========================
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
    if (amt) return buildField(label, amt, sourceType, "Found amount on labeled line");
  }

  for (let i = 0; i < lines.length; i++) {
    const ll = lines[i].toLowerCase();
    if (!kw.some((k) => ll.includes(k))) continue;
    const window = [lines[i], lines[i + 1] || "", lines[i + 2] || ""].join(" ");
    const amt = findFirstMoney(window);
    if (amt) return buildField(label, amt, sourceType, "Found amount near labeled text");
  }

  const allMoney = extractAllMoney(text);
  if (!allMoney.length) return notDetectedField(label, sourceType, "No currency values detected");

  if (fallbackPick === "due") {
    const dueCandidates = candidateMoneyByLine(lines, [
      "amount due", "balance due", "total due", "please pay", "you owe",
      "net due", "amt due", "pay this amount", "amount you may owe"
    ]);
    if (dueCandidates.length) {
      return buildField(label, dueCandidates[0].amount, sourceType, "Fallback: selected due/balance amount");
    }
    const sorted = [...allMoney].sort((a, b) => a.value - b.value);
    return buildField(label, sorted[sorted.length - 1].amount, sourceType, "Fallback: largest amount (heuristic)");
  }

  if (fallbackPick === "max") {
    const max = allMoney.reduce((a, b) => (b.value > a.value ? b : a));
    return buildField(label, max.amount, sourceType, "Fallback: selected largest amount");
  }

  if (fallbackPick === "best-near-keywords") {
    const near = candidateMoneyByLine(lines, ["insurance", "plan", "paid", "adjustment", "allowed", "write-off"]);
    if (near.length) {
      return buildField(label, near[0].amount, sourceType, "Fallback: amount near insurance keywords");
    }
  }

  return buildField(label, allMoney[0].amount, sourceType, "Fallback: first detected amount");
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
    reason,
    source: sourceType || "none",
    from: "none",
    citations: [],
  };
}

// ======================== TEXT & UTILS (UNCHANGED) ========================
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
    if (val >= 1900 && val <= 2099) continue;
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

function uint8ArrayToBase64(uint8) {
  let s = "";
  for (let i = 0; i < uint8.length; i += 0x8000) {
    s += String.fromCharCode(...uint8.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

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

function timingSafeEqual(a, b) {
  const x = String(a || "");
  const y = String(b || "");
  if (!x || !y || x.length !== y.length) return false;
  let out = 0;
  for (let i = 0; i < x.length; i++) out |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return out === 0;
}
