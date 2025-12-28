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
      return new Response("ExplainMyBill Worker – secure & private", {
        headers: corsHeaders,
      });
    }

    try {
      const url = new URL(request.url);

      /* ================= STRIPE CHECKOUT ================= */
      if (url.pathname === "/create-checkout-session") {
        const { plan } = await request.json();
        if (!["monthly", "one-time"].includes(plan)) {
          throw new Error("Invalid plan selected");
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
        if (!data.id) {
          throw new Error("Failed to create payment session");
        }

        return new Response(JSON.stringify({ id: data.id }), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      /* ================= FILE UPLOAD – SAFE PARSING ================= */
      // Anonymous rate limiting (12 per hour per IP)
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const rateKey = `rate:${ip}`;
      let attempts = (await env.KV.get(rateKey, { type: "json" })) || 0;
      if (attempts >= 12) {
        return new Response(
          JSON.stringify({ error: "Too many requests. Please wait an hour and try again." }),
          { status: 429, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }
      await env.KV.put(rateKey, attempts + 1, { expirationTtl: 3600 });

      // Safely parse form data
      let formData;
      try {
        formData = await request.formData();
      } catch (parseErr) {
        throw new Error("Failed to read uploaded file. Please try a smaller file or different browser.");
      }

      if (!formData || typeof formData.get !== "function") {
        throw new Error("Invalid upload data received");
      }

      const file = formData.get("bill");
      const sessionId = formData.get("sessionId") || "";

      if (!file || !(file instanceof File)) {
        throw new Error("No valid bill file uploaded");
      }
      if (file.size === 0) {
        throw new Error("Uploaded file is empty");
      }
      if (file.size > 20 * 1024 * 1024) {
        throw new Error("File too large – maximum 20MB");
      }

      const isPaid = await verifyStripe(sessionId, env);

      const buffer = await file.arrayBuffer();
      if (buffer.byteLength === 0) {
        throw new Error("File content is empty");
      }

      const name = file.name?.toLowerCase() || "";
      let pages = [];

      if (name.endsWith(".pdf")) {
        pages = await ocrPdf(buffer, env);
      } else if (name.match(/\.(png|jpg|jpeg|webp)$/)) {
        const base64 = uint8ArrayToBase64(new Uint8Array(buffer));
        const enhanced = await enhanceImage(base64);
        pages = await ocrImage(enhanced, env);
      } else {
        throw new Error("Unsupported file type. Please upload PDF, PNG, JPG, or WEBP.");
      }

      const combinedText = pages.map(p => p.rawText).join("\n\n").trim();
      const ocrDetected = combinedText.length > 100;

      const lineItems = extractLineItems(combinedText);

      let aiResult = null;
      if (ocrDetected) {
        aiResult = await dualAIAnalysis(combinedText, isPaid, env, ctx);
      }

      const merged = mergeAI(aiResult, lineItems);

      return new Response(
        JSON.stringify({
          isPaid,
          explanation:
            merged.explanation ||
            (ocrDetected
              ? "We read your bill successfully, but full AI explanation requires upgrade."
              : "No readable text detected. Try a clearer scan or PDF."),
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
      // User-friendly error, no sensitive data leaked
      return new Response(
        JSON.stringify({
          error: err.message || "Processing failed. No data was saved.",
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        }
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

/* ================= OCR ================= */
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
  if (data.error) throw new Error("Image analysis failed");

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

  const startData = await startRes.json();
  const operationName = startData.name;
  if (!operationName) throw new Error("Failed to start PDF processing");

  const maxAttempts = 30;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, i < 5 ? 2000 : 4000));

    const poll = await fetch(
      `https://vision.googleapis.com/v1/${operationName}?key=${env.GOOGLE_VISION_API_KEY}`
    );
    const result = await poll.json();

    if (result.done) {
      if (result.error) throw new Error("PDF processing failed");
      return (result.responses || []).map((r, i) => ({
        page: i + 1,
        rawText: r.fullTextAnnotation?.text || "",
      }));
    }
  }

  throw new Error("PDF processing timed out. Try a smaller file.");
}

/* ================= AI ANALYSIS ================= */
async function dualAIAnalysis(text, isPaid, env, ctx) {
  const prompt = `Analyze this medical bill and respond ONLY with valid JSON matching this schema exactly:\n` +
    JSON.stringify({
      summary: "string",
      keyAmounts: { totalCharges: "number|null", insurancePaid: "number|null", patientResponsibility: "number|null" },
      confidences: { totalCharges: "number 0-1", insurancePaid: "number 0-1", patientResponsibility: "number 0-1" },
      explanation: "string",
    }) +
    `\n\nText:\n"""${text}"""\n\nNo extra text or markdown.`;

  let openAI = null;
  try {
    openAI = await openAIJson(prompt, env);
  } catch {}

  let gemini = null;
  if (isPaid) {
    try {
      gemini = await geminiJson(prompt, env);
    } catch {}
  }

  return { openAI, gemini: isPaid ? gemini : null };
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
  return safeJson(data.choices?.[0]?.message?.content || "");
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
  return safeJson(data.candidates?.[0]?.content?.parts?.[0]?.text || "");
}

/* ================= MERGE & UTILS ================= */
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
    summary: a?.summary || b?.summary || "Medical bill analysis",
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
  return text
    .split("\n")
    .filter(line => /\$[\d,]+(\.\d{2})?/.test(line))
    .slice(0, 30)
    .map(line => ({
      description: line.replace(/\$[\d,]+(\.\d{2})?/, "").trim() || "Charge",
      rawLine: line.trim(),
    }));
}

async function enhanceImage(base64) {
  try {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const img = await createImageBitmap(new Blob([bytes]));
    const scale = Math.max(1600 / Math.max(img.width, 1), 1600 / Math.max(img.height, 1), 1.5);

    const canvas = new OffscreenCanvas(img.width * scale, img.height * scale);
    const ctx = canvas.getContext("2d");
    ctx.filter = "contrast(1.7) brightness(1.25)";
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.93 });
    return uint8ArrayToBase64(new Uint8Array(await blob.arrayBuffer()));
  } catch {
    return base64;
  }
}

function uint8ArrayToBase64(arr) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < arr.length; i += chunk) {
    binary += String.fromCharCode(...arr.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function safeJson(str) {
  try {
    return JSON.parse(str.replace(/```json|```/g, "").trim());
  } catch {
    return null;
  }
}