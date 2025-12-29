// ExplainMyBill Worker – FINAL CONCISE & ROBUST (Dec 29, 2025)
// OCR + Dual AI + Stripe + Excel – minimal, reliable, production-ready

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Dev-Bypass",
    };

    if (request.method === "OPTIONS") {
      const reqHeaders = request.headers.get("Access-Control-Request-Headers");
      if (reqHeaders) corsHeaders["Access-Control-Allow-Headers"] = reqHeaders;
      return new Response(null, { headers: corsHeaders });
    }

    // STRIPE CHECKOUT
    if (url.pathname === "/create-checkout-session" && request.method === "POST") {
      try {
        const { plan } = await request.json();
        if (!["monthly", "one-time"].includes(plan)) throw new Error("Invalid plan");

        const priceId = plan === "monthly" ? env.STRIPE_PRICE_MONTHLY : env.STRIPE_PRICE_ONE_TIME;

        const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
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

        const data = await res.json();
        if (!res.ok) throw new Error(data.error?.message || "Stripe checkout failed");

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

    // MAIN BILL PROCESSING
    if (request.method === "POST") {
      try {
        const formData = await request.formData();
        const billFile = formData.get("bill");
        const sessionId = formData.get("sessionId") || url.searchParams.get("session_id");

        if (!billFile || billFile.size === 0) throw new Error("No bill uploaded");
        if (billFile.size > 20 * 1024 * 1024) throw new Error("File too large – maximum 20MB");

        const fileName = billFile.name.toLowerCase();
        const allowed = [".pdf", ".png", ".jpg", ".jpeg", ".xlsx", ".xls"];
        if (!allowed.some(ext => fileName.endsWith(ext))) throw new Error("Unsupported file type");

        let isPaid = false;
        if (sessionId) {
          try {
            const res = await fetchWithTimeout(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
              headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
            });
            const data = await res.json();
            if (res.ok && (data.payment_status === "paid" || data.status === "complete")) isPaid = true;
          } catch {}
        }

        const buffer = await billFile.arrayBuffer();
        const pages = fileName.endsWith(".xlsx") || fileName.endsWith(".xls")
          ? await processExcel(buffer)
          : await preprocessAndRetryImage(buffer, env);

        // AI ANALYSIS
        for (const page of pages) {
          const rawText = page.rawText?.trim() || "";
          if (rawText.length < 50 || rawText.includes("[No readable text")) {
            page.structured = fallbackStructured(isPaid);
            page.explanation = "No readable text detected. Try a clearer photo or searchable PDF.";
            continue;
          }

          const modelOpenAI = isPaid ? "gpt-4o" : "gpt-4o-mini";
          const modelGemini = isPaid ? "gemini-1.5-pro" : "gemini-1.5-flash";

          const prompt = `Extract key amounts from this medical bill text:

"""${rawText}"""

Respond with ONLY valid JSON:

{
  "summary": "Brief summary",
  "keyAmounts": {
    "totalCharges": "$X,XXX.XX" or null,
    "insurancePaid": "$X,XXX.XX" or null,
    "patientResponsibility": "$X,XXX.XX" or null
  },
  "potentialSavings": "$X,XXX–$Y,YYY possible savings" or null,
  "explanation": "Clear explanation in 2-3 sentences",
  "redFlags": [] or issues,
  "services": [] or list,
  "nextSteps": [] or steps
}

Use null if unsure.`;

          let structured = fallbackStructured(isPaid);

          try {
            const [openAiRes, geminiRes] = await Promise.allSettled([
              fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
                method: "POST",
                headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
                body: JSON.stringify({ model: modelOpenAI, messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: isPaid ? 800 : 400 }),
              }),
              fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${modelGemini}:generateContent?key=${env.GEMINI_API_KEY}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0, maxOutputTokens: isPaid ? 800 : 400 } }),
              }),
            ]);

            const results = [];
            if (openAiRes.status === "fulfilled") {
              const parsed = parseAiResponse(await openAiRes.value.json());
              if (parsed) results.push(parsed);
            }
            if (geminiRes.status === "fulfilled") {
              const parsed = parseGeminiResponse(await geminiRes.value.json());
              if (parsed) results.push(parsed);
            }

            if (results.length > 0) {
              structured = mergeWithConfidence(...results, isPaid);
            }
          } catch (err) {
            console.error("AI failed:", err);
          }

          page.structured = structured;
          page.explanation = structured.explanation || "Analysis complete.";
        }

        const fullExplanation = pages.map(p => p.explanation).join("\n\n");

        return new Response(JSON.stringify({
          isPaid,
          pages: pages.map(p => ({
            page: p.page,
            structured: p.structured,
            explanation: p.explanation,
            rawText: p.rawText
          })),
          explanation: fullExplanation || "Analysis complete.",
        }), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
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

// HELPERS
async function fetchWithTimeout(url, opts = {}, timeout = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

function uint8ArrayToBase64(arr) {
  let binary = '';
  for (let i = 0; i < arr.length; i += 0x8000) {
    binary += String.fromCharCode(...arr.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function parseAiResponse(data) {
  try {
    let content = data.choices?.[0]?.message?.content || "";
    content = content.replace(/^```json\n?/i, "").replace(/\n?```$/i, "").trim();
    return JSON.parse(content);
  } catch { return null; }
}

function parseGeminiResponse(data) {
  try {
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const cleaned = content.replace(/^```json\n?/i, "").replace(/\n?```$/i, "").trim();
    return JSON.parse(cleaned);
  } catch { return null; }
}

function fallbackStructured(isPaid) {
  return {
    summary: "Basic analysis complete.",
    summaryPoints: [],
    keyAmounts: { totalCharges: null, insurancePaid: null, patientResponsibility: null },
    confidences: { totalCharges: 0, insurancePaid: 0, patientResponsibility: 0 },
    services: [],
    redFlags: [],
    potentialSavings: null,
    explanation: isPaid
      ? "Full analysis completed."
      : "Basic analysis complete. Upgrade for detailed breakdown and savings estimates.",
    nextSteps: ["Review itemized bill", "Compare at FairHealthConsumer.org", "Contact insurance"],
  };
}

function mergeWithConfidence(...results) {
  if (results.length === 0) return fallbackStructured(false);

  // Pick result with most filled keyAmounts
  let best = results.reduce((a, b) => {
    const aCount = Object.values(a.keyAmounts || {}).filter(v => v).length;
    const bCount = Object.values(b.keyAmounts || {}).filter(v => v).length;
    return bCount > aCount ? b : a;
  });

  return best;
}

async function processExcel(buffer) {
  const XLSX = await import("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm");
  const wb = XLSX.read(new Uint8Array(buffer), { type: "array" });
  return wb.SheetNames.map((name, i) => ({
    page: i + 1,
    rawText: XLSX.utils.sheet_to_csv(wb.Sheets[name]) || "[Empty sheet]",
  }));
}

async function preprocessAndRetryImage(buffer, env) {
  let best = "";
  const filters = ["", "contrast(1.5) brightness(1.2)", "contrast(1.8) brightness(1.3)", "contrast(2.1) brightness(1.4) saturate(1.2)", "contrast(2.4) brightness(1.5)"];

  for (const filter of filters) {
    try {
      const base64 = filter ? await enhanceImageBuffer(buffer, filter) : uint8ArrayToBase64(new Uint8Array(buffer));
      const res = await fetchWithTimeout(`https://vision.googleapis.com/v1/images:annotate?key=${env.GOOGLE_VISION_API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [{ image: { content: base64 }, features: [{ type: "DOCUMENT_TEXT_DETECTION" }], imageContext: { languageHints: ["en"] } }],
        }),
      });
      const data = await res.json();
      if (data.error) continue;
      const text = data.responses?.[0]?.fullTextAnnotation?.text?.trim() || "";
      if (text.length > best.length) best = text;
      if (best.length > 200) break;
    } catch (err) {
      console.error("OCR attempt failed:", err);
    }
  }

  return [{ page: 1, rawText: best || "[No readable text detected]" }];
}

async function enhanceImageBuffer(buffer, filter) {
  const img = await createImageBitmap(new Blob([buffer]));
  const scale = Math.max(2000 / Math.min(img.width, img.height), 1.5);
  const canvas = new OffscreenCanvas(img.width * scale, img.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.filter = filter;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  ctx.globalCompositeOperation = "overlay";
  ctx.globalAlpha = 0.3;
  ctx.drawImage(canvas, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.95 });
  const arr = await blob.arrayBuffer();
  return uint8ArrayToBase64(new Uint8Array(arr));
}
