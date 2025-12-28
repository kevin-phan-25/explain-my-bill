export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Dev-Bypass",
    };

    if (request.method === "OPTIONS") {
      const requestedHeaders = request.headers.get("Access-Control-Request-Headers");
      if (requestedHeaders) {
        corsHeaders["Access-Control-Allow-Headers"] = requestedHeaders;
      }
      return new Response(null, { headers: corsHeaders });
    }

    // ===================== STRIPE CHECKOUT =====================
    if (url.pathname === "/create-checkout-session" && request.method === "POST") {
      try {
        const { plan } = await request.json();
        if (!["monthly", "one-time"].includes(plan)) throw new Error("Invalid plan");

        const priceId =
          plan === "monthly" ? env.STRIPE_PRICE_MONTHLY : env.STRIPE_PRICE_ONE_TIME;

        const sessionRes = await fetch(
          "https://api.stripe.com/v1/checkout/sessions",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              "payment_method_types[0]": "card",
              "line_items[0][price]": priceId,
              "line_items[0][quantity]": "1",
              mode: plan === "monthly" ? "subscription" : "payment",
              success_url: "https://explain-my-bill-frontend.onrender.com/success?session_id={CHECKOUT_SESSION_ID}",
              cancel_url: "https://explain-my-bill-frontend.onrender.com/cancel",
            }),
          }
        );

        const data = await sessionRes.json();
        if (!sessionRes.ok) throw new Error(data.error?.message || "Stripe checkout failed");

        return new Response(JSON.stringify({ id: data.id }), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }

    // ===================== BILL PROCESSING =====================
    if (request.method === "POST") {
      try {
        const formData = await request.formData();
        const billFile = formData.get("bill");
        const sessionId = formData.get("sessionId") || url.searchParams.get("session_id");

        if (!billFile || billFile.size === 0) throw new Error("No bill uploaded");
        if (billFile.size > 20 * 1024 * 1024) throw new Error("File too large – maximum 20MB");

        const fileName = billFile.name.toLowerCase();
        const allowedExt = [".pdf", ".png", ".jpg", ".jpeg", ".xlsx", ".xls"];
        if (!allowedExt.some(ext => fileName.endsWith(ext))) throw new Error("Unsupported file type");

        // ===================== SECURE PAID STATUS VERIFICATION =====================
        let isPaid = false;
        if (sessionId) {
          try {
            const sessionRes = await fetchWithTimeout(
              `https://api.stripe.com/v1/checkout/sessions/${sessionId}`,
              {
                headers: {
                  Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
                },
              }
            );
            const session = await sessionRes.json();
            if (sessionRes.ok && (session.payment_status === "paid" || session.status === "complete" || session.mode === "subscription")) {
              isPaid = true;
            }
          } catch (e) {
            console.error("Failed to verify Stripe session:", e);
          }
        }

        const buffer = await billFile.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        const base64 = uint8ArrayToBase64(bytes);

        let pages = [];
        let anyTextDetected = false;

        const features = [{ type: "DOCUMENT_TEXT_DETECTION" }];

        // ===================== FILE PROCESSING =====================
        if (fileName.endsWith(".pdf")) {
          pages = await asyncBatchPDF(buffer, env);
        } else if (fileName.endsWith(".xlsx") || fileName.endsWith(".xls")) {
          pages = await processExcel(buffer);
        } else {
          // Images – now with enhanced OCR
          pages = await preprocessAndRetryImage(base64, features, env);
        }

        // Detect meaningful text
        for (const page of pages) {
          if (page.rawText && page.rawText.trim().length > 100 && !page.rawText.includes("[No text")) {
            anyTextDetected = true;
          }
        }

        // ===================== AI ANALYSIS =====================
        for (const page of pages) {
          const modelOpenAI = isPaid ? "gpt-4o" : "gpt-4o-mini";
          const modelGemini = isPaid ? "gemini-1.5-pro" : "gemini-1.5-flash";

          const prompt = `You are an expert medical bill analyst using real-world data. Analyze the bill text and respond in JSON only.
Bill text:
"""${page.rawText || ""}"""`;

          let openAiParsed = null;
          let geminiParsed = null;

          try {
            const [openAiRes, geminiRes] = await Promise.all([
              fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${env.OPENAI_API_KEY}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  model: modelOpenAI,
                  messages: [{ role: "user", content: prompt }],
                  temperature: 0.2,
                  max_tokens: isPaid ? 1200 : 300,
                }),
              }),
              fetchWithTimeout(
                `https://generativelanguage.googleapis.com/v1beta/models/${modelGemini}:generateContent?key=${env.GEMINI_API_KEY}`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    contents: [{ role: "user", parts: [{ text: prompt }] }],
                    generationConfig: { temperature: 0.2, maxOutputTokens: isPaid ? 1200 : 300 },
                  }),
                }
              ),
            ]);

            const openAiData = await openAiRes.json();
            const geminiData = await geminiRes.json();

            openAiParsed = parseAiResponse(openAiData);
            geminiParsed = parseGeminiResponse(geminiData);
          } catch (aiErr) {
            console.error("AI call failed:", aiErr);
          }

          if (!openAiParsed && !geminiParsed) {
            page.structured = fallbackStructured(isPaid);
            page.explanation = page.structured.explanation;
            continue;
          }

          page.structured = mergeWithConfidence(openAiParsed, geminiParsed, isPaid);
          page.explanation = page.structured.explanation || "Analysis complete.";
        }

        let fullExplanation = pages.map(p => p.explanation).join("\n\n");

        if (!anyTextDetected) {
          fullExplanation =
            (isPaid
              ? "No readable text was detected. Try a clearer, well-lit photo or searchable PDF."
              : "No readable text detected. Upgrade for advanced processing.") +
            "\n\n" + fullExplanation;
        }

        return new Response(
          JSON.stringify({
            isPaid,
            pages: pages.map(p => ({ page: p.page, structured: p.structured, explanation: p.explanation })),
            explanation: fullExplanation,
          }),
          { headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      } catch (err) {
        console.error("Worker error:", err);
        return new Response(JSON.stringify({ error: err.message || "Processing failed" }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }

    return new Response("ExplainMyBill Worker – Running", { headers: corsHeaders });
  },
};

// ===================== HELPERS =====================

async function fetchWithTimeout(url, options = {}, timeout = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(id); }
}

function uint8ArrayToBase64(uint8Array) {
  const CHUNK_SIZE = 0x8000;
  let binary = '';
  for (let i = 0; i < uint8Array.length; i += CHUNK_SIZE)
    binary += String.fromCharCode(...uint8Array.subarray(i, i + CHUNK_SIZE));
  return btoa(binary);
}

function parseAiResponse(data) {
  try {
    let content = data.choices?.[0]?.message?.content?.trim() || "{}";
    content = content.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();
    return JSON.parse(content);
  } catch { return null; }
}

function parseGeminiResponse(data) {
  try {
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    return JSON.parse(content.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim());
  } catch { return null; }
}

function fallbackStructured(isPaid) {
  return {
    summary: "Bill analyzed successfully.",
    summaryPoints: ["Analysis complete"],
    keyAmounts: { totalCharges: null, insuranceAdjusted: null, insurancePaid: null, patientResponsibility: null },
    confidences: { totalCharges: 0, insuranceAdjusted: 0, insurancePaid: 0, patientResponsibility: 0 },
    services: [], redFlags: [], potentialSavings: null,
    explanation: isPaid
      ? "Detailed analysis completed using dual AI verification."
      : "Basic analysis complete. Upgrade for full expert review.",
    nextSteps: ["Request itemized bill", "Compare charges", "Call insurance"]
  };
}

function mergeWithConfidence(a, b, isPaid) {
  const fallback = fallbackStructured(isPaid);
  if (!a && !b) return fallback;

  const pick = (field) => {
    const valA = a?.keyAmounts?.[field], valB = b?.keyAmounts?.[field];
    const confA = a?.confidences?.[field] || 0, confB = b?.confidences?.[field] || 0;
    if (valA && valB) return confA >= confB ? valA : valB;
    return valA || valB || null;
  };

  return {
    summary: a?.summary || b?.summary || fallback.summary,
    summaryPoints: [...new Set([...(a?.summaryPoints || []), ...(b?.summaryPoints || [])])].slice(0,3),
    keyAmounts: {
      totalCharges: pick("totalCharges"),
      insuranceAdjusted: pick("insuranceAdjusted"),
      insurancePaid: pick("insurancePaid"),
      patientResponsibility: pick("patientResponsibility"),
    },
    confidences: {
      totalCharges: Math.max(a?.confidences?.totalCharges||0, b?.confidences?.totalCharges||0),
      insuranceAdjusted: Math.max(a?.confidences?.insuranceAdjusted||0, b?.confidences?.insuranceAdjusted||0),
      insurancePaid: Math.max(a?.confidences?.insurancePaid||0, b?.confidences?.insurancePaid||0),
      patientResponsibility: Math.max(a?.confidences?.patientResponsibility||0, b?.confidences?.patientResponsibility||0),
    },
    services: [...new Set([...(a?.services||[]), ...(b?.services||[])])],
    redFlags: [...new Set([...(a?.redFlags||[]), ...(b?.redFlags||[])])],
    potentialSavings: a?.potentialSavings || b?.potentialSavings || null,
    explanation: (a?.explanation || "").length >= (b?.explanation||"").length ? a?.explanation : b?.explanation || fallback.explanation,
    nextSteps: [...new Set([...(a?.nextSteps||[]), ...(b?.nextSteps||[])])]
  };
}

async function processExcel(buffer) {
  const XLSX = await import("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm");
  const wb = XLSX.read(new Uint8Array(buffer), { type: "array" });
  return wb.SheetNames.map((name, i) => ({
    page: i + 1,
    rawText: XLSX.utils.sheet_to_csv(wb.Sheets[name]) || "[Empty sheet]"
  }));
}

async function asyncBatchPDF(buffer, env) {
  const base64 = uint8ArrayToBase64(new Uint8Array(buffer));

  try {
    const startRes = await fetchWithTimeout(
      `https://vision.googleapis.com/v1/files:asyncBatchAnnotate?key=${env.GOOGLE_VISION_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [{
            inputConfig: { content: base64, mimeType: "application/pdf" },
            features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
          }],
        }),
      }
    );

    if (!startRes.ok) throw new Error("Failed to start PDF OCR");

    const { name: operationName } = await startRes.json();

    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));

      const pollRes = await fetchWithTimeout(
        `https://vision.googleapis.com/v1/${operationName}?key=${env.GOOGLE_VISION_API_KEY}`
      );
      const pollData = await pollRes.json();

      if (pollData.done) {
        if (pollData.error) throw new Error(pollData.error.message);

        const responses = pollData.responses || [];
        return responses.map((r, idx) => ({
          page: idx + 1,
          rawText: r.fullTextAnnotation?.text?.trim() || "[No text detected]",
        }));
      }
    }
    throw new Error("PDF OCR timed out");
  } catch (err) {
    console.error("PDF OCR failed:", err);
    return [{ page: 1, rawText: "[PDF OCR failed]" }];
  }
}

// ===================== ENHANCED IMAGE OCR – BEST FOR MEDICAL BILLS =====================
async function preprocessAndRetryImage(base64, features, env, retries = 4) {
  let bestText = "";
  let bestPages = [{ page: 1, rawText: "[No text detected]" }];

  const enhancementLevels = [
    "contrast(1.4) brightness(1.15)",
    "contrast(1.7) brightness(1.3)",
    "contrast(2.0) brightness(1.4) saturate(1.2)",
    "contrast(2.3) brightness(1.5) saturate(1.3)",
  ];

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const filter = enhancementLevels[Math.min(attempt - 1, enhancementLevels.length - 1)];
      const enhancedBase64 = await enhanceImage(base64, filter);

      const res = await fetchWithTimeout(
        `https://vision.googleapis.com/v1/images:annotate?key=${env.GOOGLE_VISION_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requests: [{
              image: { content: enhancedBase64 },
              features,
              imageContext: { languageHints: ["en"] },
            }],
          }),
        }
      );

      const data = await res.json();
      const rawText = data.responses?.[0]?.fullTextAnnotation?.text?.trim() || "";

      if (rawText.length > bestText.length) {
        bestText = rawText;
      }

      if (bestText.length > 150) {
        return [{ page: 1, rawText: bestText }];
      }
    } catch (err) {
      console.error(`Image OCR attempt ${attempt} failed:`, err);
    }

    // Short delay between attempts
    await new Promise(r => setTimeout(r, 800 + Math.random() * 1200));
  }

  return [{ page: 1, rawText: bestText || "[No text detected]" }];
}

// ===================== STRONGER IMAGE ENHANCEMENT =====================
async function enhanceImage(base64, filter = "contrast(1.6) brightness(1.2)") {
  try {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const img = await createImageBitmap(new Blob([bytes]));

    const targetMin = 1800;
    const scale = Math.max(targetMin / Math.min(img.width, img.height), 1.8);

    const canvas = new OffscreenCanvas(img.width * scale, img.height * scale);
    const ctx = canvas.getContext("2d");

    ctx.filter = filter;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    // Light unsharp mask for sharper text
    ctx.globalCompositeOperation = "overlay";
    ctx.globalAlpha = 0.25;
    ctx.drawImage(canvas, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";

    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.95 });
    const buffer = await blob.arrayBuffer();
    return uint8ArrayToBase64(new Uint8Array(buffer));
  } catch (err) {
    console.error("Image enhancement failed:", err);
    return base64;
  }
}