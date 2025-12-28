export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return new Response("ExplainMyBill Worker running – no data retained", {
        headers: corsHeaders,
      });
    }

    try {
      const url = new URL(request.url);

      /* ================= STRIPE CHECKOUT ================= */
      if (url.pathname === "/create-checkout-session") {
        const { plan } = await request.json();
        if (!["monthly", "one-time"].includes(plan)) {
          throw new Error("Invalid plan");
        }

        const priceId =
          plan === "monthly"
            ? env.STRIPE_PRICE_MONTHLY
            : env.STRIPE_PRICE_ONE_TIME;

        const stripeRes = await fetch(
          "https://api.stripe.com/v1/checkout/sessions",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              mode: plan === "monthly" ? "subscription" : "payment",
              "line_items[0][price]": priceId,
              "line_items[0][quantity]": "1",
              success_url:
                "https://explain-my-bill-frontend.onrender.com/success?session_id={CHECKOUT_SESSION_ID}",
              cancel_url:
                "https://explain-my-bill-frontend.onrender.com/cancel",
            }),
          }
        );

        const data = await stripeRes.json();
        if (!data.id) throw new Error("Failed to create checkout session");

        return new Response(JSON.stringify({ id: data.id }), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      /* ================= FILE UPLOAD WITH PRIVACY ================= */
      // Anonymous rate limiting: only counts requests per IP (no identifiers stored long-term)
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const rateKey = `rate:${ip}`;
      let attempts = (await env.KV.get(rateKey, { type: "json" })) || 0;
      if (attempts >= 12) { // ~12 free uses per hour
        return new Response(JSON.stringify({ error: "Too many requests. Please try again later." }), {
          status: 429,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      await env.KV.put(rateKey, attempts + 1, { expirationTtl: 3600 });

      const formData = await request.formData();
      const file = formData.get("bill");
      const sessionId = formData.get("sessionId") || "";

      if (!file || !(file instanceof File)) {
        throw new Error("No valid file uploaded");
      }
      if (file.size > 20 * 1024 * 1024) {
        throw new Error("File too large (max 20MB)");
      }

      const isPaid = await verifyStripe(sessionId, env);

      const buffer = await file.arrayBuffer();
      const name = file.name.toLowerCase();

      let pages = [];

      if (name.endsWith(".pdf")) {
        if (buffer.byteLength > 18 * 1024 * 1024) {
          throw new Error("PDF too large – may have too many pages");
        }
        pages = await ocrPdf(buffer, env);
      } else if (name.match(/\.(png|jpg|jpeg|webp)$/)) {
        const base64 = uint8ArrayToBase64(new Uint8Array(buffer));
        const enhanced = await enhanceImage(base64);
        pages = await ocrImage(enhanced, env);
      } else {
        throw new Error("Unsupported file type. Please upload PDF or image (PNG/JPG/WEBP).");
      }

      const combinedText = pages.map(p => p.rawText).join("\n\n").trim();
      const ocrDetected = combinedText.length > 100;

      const lineItems = extractLineItems(combinedText);

      let aiResult = null;
      if (ocrDetected) {
        aiResult = await dualAIAnalysis(combinedText, isPaid, env, ctx);
      }

      const merged = mergeAI(aiResult, lineItems);

      // Everything above is in-memory only. Nothing is logged or stored.

      return new Response(
        JSON.stringify({
          isPaid,
          explanation:
            merged.explanation ||
            (ocrDetected
              ? "We read your bill but could not generate a full explanation."
              : "No readable text found. Try a clearer photo or PDF."),
          structured: merged,
          rawTextPreview: ocrDetected ? combinedText.slice(0, 4000) : "",
          features: {
            ocrStatus: ocrDetected ? "success" : "failed",
            aiStatus: aiResult ? "success" : "failed",
          },
        }),
        { headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    } catch (err) {
      return new Response(
        JSON.stringify({ error: err.message || "Processing failed. No data was retained." }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }
  },
};

/* ================= STRIPE VERIFY ================= */
async function verifyStripe(sessionId, env) {
  if (!sessionId) return false;
  try {
    const res = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${sessionId}`,
      { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } }
    );
    if (!res.ok) return false;
    const data = await res.json();
    return data.payment_status === "paid" || data.status === "complete";
  } catch {
    return false;
  }
}

/* ================= OCR (IN-MEMORY ONLY) ================= */
async function ocrImage(base64, env) {
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

  const data = await res.json();
  if (data.error) throw new Error("OCR failed – try a clearer image");

  const annotation = data.responses?.[0]?.fullTextAnnotation;
  return [{
    page: 1,
    rawText: annotation?.text || "",
  }];
}

async function ocrPdf(buffer, env) {
  const base64 = uint8ArrayToBase64(new Uint8Array(buffer));

  const startRes = await fetch(
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

  const { name: operationName } = await startRes.json();
  if (!operationName) throw new Error("Failed to start PDF processing");

  // Poll with timeout (max ~90 seconds)
  const maxAttempts = 30;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, i < 5 ? 2000 : 4000)); // progressive delay

    const poll = await fetch(
      `https://vision.googleapis.com/v1/${operationName}?key=${env.GOOGLE_VISION_API_KEY}`
    );
    const result = await poll.json();

    if (result.done) {
      if (result.error) throw new Error("PDF OCR failed");
      return (result.responses || []).map((r, i) => ({
        page: i + 1,
        rawText: r.fullTextAnnotation?.text || "",
      }));
    }
  }

  throw new Error("PDF processing timed out – file may be too large or complex");
}

/* ================= AI ANALYSIS (IN-MEMORY ONLY) ================= */
async function dualAIAnalysis(text, isPaid, env, ctx) {
  const schema = {
    summary: "string",
    keyAmounts: {
      totalCharges: "number|null",
      insurancePaid: "number|null",
      patientResponsibility: "number|null",
    },
    confidences: {
      totalCharges: "number 0-1",
      insurancePaid: "number 0-1",
      patientResponsibility: "number 0-1",
    },
    explanation: "string",
  };

  const prompt = `Analyze this medical bill text and respond ONLY with valid JSON matching this exact schema:\n${JSON.stringify(schema)}\n\nText:\n"""${text}"""\n\nDo not add any extra text, markdown, or explanations.`;

  let openAI = null;
  let gemini = null;

  // For paid users: try both models. For free: just OpenAI (cheaper + sufficient)
  try {
    openAI = await openAIJson(prompt, env);
  } catch {}

  if (isPaid) {
    try {
      gemini = await geminiJson(prompt, env);
    } catch {}
  }

  return { openAI, gemini };
}

async function openAIJson(prompt, env) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      response_format: { type: "json_object" },
    }),
  });

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || "";
  return safeJson(content);
}

async function geminiJson(prompt, env) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0 },
      }),
    }
  );

  const data = await res.json();
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return safeJson(content);
}

/* ================= MERGE & EXTRACT ================= */
function mergeAI(ai, lineItems) {
  const a = ai?.openAI;
  const b = ai?.gemini;

  const pick = (field) => {
    if (!a && !b) return null;
    if (!b || (a?.confidences?.[field] ?? 0) >= (b?.confidences?.[field] ?? 0)) {
      return a?.keyAmounts?.[field] ?? null;
    }
    return b?.keyAmounts?.[field] ?? null;
  };

  return {
    summary: a?.summary || b?.summary || "Medical bill summary unavailable",
    explanation: a?.explanation || b?.explanation || "",
    keyAmounts: {
      totalCharges: pick("totalCharges"),
      insurancePaid: pick("insurancePaid"),
      patientResponsibility: pick("patientResponsibility"),
    },
    confidences: {
      totalCharges: Math.max(a?.confidences?.totalCharges || 0, b?.confidences?.totalCharges || 0),
      insurancePaid: Math.max(a?.confidences?.insurancePaid || 0, b?.confidences?.insurancePaid || 0),
      patientResponsibility: Math.max(a?.confidences?.patientResponsibility || 0, b?.confidences?.patientResponsibility || 0),
    },
    lineItems,
  };
}

function extractLineItems(text) {
  const lines = text.split("\n");
  const amountPattern = /\$[\d,]+(\.\d{2})?/g;

  return lines
    .filter(line => amountPattern.test(line))
    .slice(0, 30)
    .map(line => ({
      description: line.trim().replace(amountPattern, "").trim() || "Charge item",
      rawLine: line.trim(),
    }));
}

/* ================= IMAGE ENHANCEMENT ================= */
async function enhanceImage(base64) {
  try {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const img = await createImageBitmap(new Blob([bytes]));
    const scale = Math.max(1600 / Math.max(img.width, 1), 1600 / Math.max(img.height, 1), 1.5);

    const canvas = new OffscreenCanvas(img.width * scale, img.height * scale);
    const ctx = canvas.getContext("2d");
    ctx.filter = "contrast(1.7) brightness(1.25) sharpen(1)";
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.93 });
    return uint8ArrayToBase64(new Uint8Array(await blob.arrayBuffer()));
  } catch {
    return base64; // fallback
  }
}

/* ================= UTILS ================= */
function uint8ArrayToBase64(arr) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < arr.length; i += chunkSize) {
    binary += String.fromCharCode(...arr.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function safeJson(str) {
  try {
    const cleaned = str.replace(/```json|```/g, "").trim();
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}