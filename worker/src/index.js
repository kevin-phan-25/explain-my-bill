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
      if (requestedHeaders) corsHeaders["Access-Control-Allow-Headers"] = requestedHeaders;
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // ===================== BASIC RATE LIMIT =====================
    if (request.method === "POST" && url.pathname !== "/create-checkout-session") {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const rateKey = `rate:${ip}`;
      let count = Number(await env.RATE_KV?.get(rateKey)) || 0;
      if (count >= 15) {
        return new Response(JSON.stringify({ error: "Too many requests – try again later." }), {
          status: 429,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      count++;
      ctx.waitUntil(env.RATE_KV?.put(rateKey, String(count), { expirationTtl: 60 }));
    }

    // ===================== STRIPE CHECKOUT =====================
    if (url.pathname === "/create-checkout-session" && request.method === "POST") {
      try {
        const { plan } = await request.json();
        if (!["monthly", "one-time"].includes(plan)) throw new Error("Invalid plan");
        const priceId = plan === "monthly" ? env.STRIPE_PRICE_MONTHLY : env.STRIPE_PRICE_ONE_TIME;

        const sessionRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
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
        });

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
        let sessionId = formData.get("sessionId") || url.searchParams.get("session_id");

        if (!billFile || billFile.size === 0) throw new Error("No bill uploaded");
        if (billFile.size > 20 * 1024 * 1024) throw new Error("File too large – maximum 20MB");

        const fileName = billFile.name.toLowerCase();
        const allowedExt = [".pdf", ".png", ".jpg", ".jpeg", ".xlsx", ".xls"];
        if (!allowedExt.some(ext => fileName.endsWith(ext))) throw new Error("Unsupported file type");

        // ===================== VERIFY PAID STATUS =====================
        let isPaid = false;
        if (sessionId) {
          try {
            const sessionRes = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
              headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
            });
            const session = await sessionRes.json();
            if (sessionRes.ok && (session.payment_status === "paid" || session.status === "complete")) {
              isPaid = true;
            }
          } catch (e) {
            console.error("Stripe session verify failed:", e);
          }
        }

        const buffer = await billFile.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        const base64 = uint8ArrayToBase64(bytes);

        let pages = [];
        let anyTextDetected = false;

        // ===================== PROCESS FILE =====================
        if (fileName.endsWith(".pdf")) {
          pages = await asyncBatchPDF(buffer, env);
        } else if (fileName.endsWith(".xlsx") || fileName.endsWith(".xls")) {
          pages = await processExcel(buffer);
        } else {
          // Images
          pages = await preprocessAndRetryImage(base64, env);
        }

        // Check if any meaningful text was extracted
        for (const page of pages) {
          if (page.rawText && page.rawText.trim().length > 100 && !page.rawText.includes("[No text")) {
            anyTextDetected = true;
          }
        }

        // ===================== AI ANALYSIS PER PAGE =====================
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
                `https://generativelanguage.googleapis.com/v1/models/${modelGemini}:generateContent?key=${env.GEMINI_API_KEY}`,
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
              ? "No readable text was detected. Try a clearer scan or searchable PDF."
              : "No readable text detected. Upgrade for advanced OCR and analysis.") +
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
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

function uint8ArrayToBase64(uint8Array) {
  let binary = '';
  const CHUNK_SIZE = 0x8000;
  for (let i = 0; i < uint8Array.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode(...uint8Array.subarray(i, i + CHUNK_SIZE));
  }
  return btoa(binary);
}

function parseAiResponse(data) {
  try {
    let content = data.choices?.[0]?.message?.content?.trim() || "{}";
    content = content.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function parseGeminiResponse(data) {
  try {
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const cleaned = text.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
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
    nextSteps: ["Request itemized bill", "Compare charges", "Call insurance"],
  };
}

function mergeWithConfidence(a, b, isPaid) {
  const fallback = fallbackStructured(isPaid);
  if (!a && !b) return fallback;

  const pick = (field) => {
    const valA = a?.keyAmounts?.[field];
    const valB = b?.keyAmounts?.[field];
    const confA = a?.confidences?.[field] || 0;
    const confB = b?.confidences?.[field] || 0;
    if (valA !== undefined && valB !== undefined) return confA >= confB ? valA : valB;
    return valA ?? valB ?? null;
  };

  return {
    summary: a?.summary || b?.summary || fallback.summary,
    summaryPoints: [...new Set([...(a?.summaryPoints || []), ...(b?.summaryPoints || [])])].slice(0, 3),
    keyAmounts: {
      totalCharges: pick("totalCharges"),
      insuranceAdjusted: pick("insuranceAdjusted"),
      insurancePaid: pick("insurancePaid"),
      patientResponsibility: pick("patientResponsibility"),
    },
    confidences: {
      totalCharges: Math.max(a?.confidences?.totalCharges || 0, b?.confidences?.totalCharges || 0),
      insuranceAdjusted: Math.max(a?.confidences?.insuranceAdjusted || 0, b?.confidences?.insuranceAdjusted || 0),
      insurancePaid: Math.max(a?.confidences?.insurancePaid || 0, b?.confidences?.insurancePaid || 0),
      patientResponsibility: Math.max(a?.confidences?.patientResponsibility || 0, b?.confidences?.patientResponsibility || 0),
    },
    services: [...new Set([...(a?.services || []), ...(b?.services || [])])],
    redFlags: [...new Set([...(a?.redFlags || []), ...(b?.redFlags || [])])],
    potentialSavings: a?.potentialSavings ?? b?.potentialSavings ?? null,
    explanation: (a?.explanation || "").length >= (b?.explanation || "").length ? a?.explanation : b?.explanation || fallback.explanation,
    nextSteps: [...new Set([...(a?.nextSteps || []), ...(b?.nextSteps || [])])],
  };
}

async function processExcel(buffer) {
  const XLSX = await import("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm");
  const wb = XLSX.read(new Uint8Array(buffer), { type: "array" });
  return wb.SheetNames.map((name, i) => ({
    page: i + 1,
    rawText: XLSX.utils.sheet_to_csv(wb.Sheets[name]) || "[Empty sheet]",
  }));
}

// ===================== PDF OCR – ASYNC BATCH =====================
async function asyncBatchPDF(buffer, env) {
  const base64 = uint8ArrayToBase64(new Uint8Array(buffer));

  const initiateRes = await fetchWithTimeout(
    `https://vision.googleapis.com/v1/files:asyncBatchAnnotate?key=${env.GOOGLE_VISION_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [{
          inputConfig: { content: base64, mimeType: "application/pdf" },
          features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
          pages: [],
        }],
      }),
    }
  );

  const initiateData = await initiateRes.json();
  if (!initiateRes.ok) throw new Error("Failed to start PDF OCR");

  const operationName = initiateData.name;
  const maxPolls = 15;
  const pages = [];

  for (let i = 0; i < maxPolls; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const pollRes = await fetchWithTimeout(
      `https://vision.googleapis.com/v1/${operationName}?key=${env.GOOGLE_VISION_API_KEY}`,
      {},
      10000
    );
    const pollData = await pollRes.json();

    if (pollData.done) {
      const responses = pollData.responses || [];
      return responses.map((resp, idx) => ({
        page: idx + 1,
        rawText: resp.fullTextAnnotation?.text || "[No text detected on this page]",
      }));
    }
  }

  // Timeout fallback
  return [{ page: 1, rawText: "[PDF OCR timed out]" }];
}

// ===================== IMAGE OCR WITH PREPROCESSING & RETRY =====================
async function preprocessAndRetryImage(base64, env, retries = 2) {
  let lastResult = [{ page: 1, rawText: "[No text detected]" }];

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const enhancedBase64 = await upscaleImage(base64);

      const res = await fetchWithTimeout(
        `https://vision.googleapis.com/v1/images:annotate?key=${env.GOOGLE_VISION_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requests: [{
              image: { content: enhancedBase64 },
              features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
              imageContext: { languageHints: ["en"] },
            }],
          }),
        },
        12000 // 12s max
      );

      const data = await res.json();
      const text = data.responses?.[0]?.fullTextAnnotation?.text || "";

      if (text.trim().length > 20) {
        return [{ page: 1, rawText: text }];
      }
    } catch (err) {
      console.error(`Vision attempt ${attempt} failed:`, err);
    }

    await new Promise(r => setTimeout(r, 500 + Math.random() * 1000));
  }

  return lastResult;
}

// ===================== IMAGE UPSCALE & ENHANCE =====================
async function upscaleImage(base64) {
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  const blob = new Blob([bytes]);
  const img = await createImageBitmap(blob);

  const targetMin = 1600;
  const scale = Math.max(targetMin / img.width, targetMin / img.height, 1.5);

  const canvas = new OffscreenCanvas(img.width * scale, img.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.filter = "contrast(1.4) brightness(1.15)";
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const newBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
  const buffer = await newBlob.arrayBuffer();
  return uint8ArrayToBase64(new Uint8Array(buffer));
}