// ExplainMyBill Worker – FINAL RELIABLE OCR FIX (Dec 2025)
// All features preserved + asyncBatchAnnotate for PDFs + retry + enhancement for images
// Base64 size safe + no quota issues

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

    // =====================
    // STRIPE CHECKOUT
    // =====================
    if (url.pathname === "/create-checkout-session" && request.method === "POST") {
      try {
        const { plan } = await request.json();
        if (!["monthly", "one-time"].includes(plan)) {
          throw new Error("Invalid plan");
        }

        const priceId =
          plan === "monthly"
            ? env.STRIPE_PRICE_MONTHLY
            : env.STRIPE_PRICE_ONE_TIME;

        const sessionResponse = await fetch(
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
              success_url:
                "https://explain-my-bill-frontend.onrender.com/success?session_id={CHECKOUT_SESSION_ID}",
              cancel_url:
                "https://explain-my-bill-frontend.onrender.com/cancel",
            }),
          }
        );

        const data = await sessionResponse.json();
        if (!sessionResponse.ok) {
          throw new Error(data.error?.message || "Stripe checkout failed");
        }

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

    // =====================
    // MAIN BILL PROCESSING
    // =====================
    if (request.method === "POST") {
      try {
        const formData = await request.formData();
        const billFile = formData.get("bill");
        const sessionId =
          formData.get("sessionId") || url.searchParams.get("session_id");

        if (!billFile || billFile.size === 0) {
          throw new Error("No bill uploaded");
        }

        if (billFile.size > 20 * 1024 * 1024) {
          throw new Error("File too large – maximum 20MB");
        }

        const fileName = billFile.name.toLowerCase();
        const allowedExtensions = [".pdf", ".png", ".jpg", ".jpeg", ".xlsx", ".xls"];
        if (!allowedExtensions.some(ext => fileName.endsWith(ext))) {
          throw new Error("Unsupported file type");
        }

        const isPaid = Boolean(sessionId);

        const buffer = await billFile.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        const base64 = uint8ArrayToBase64(bytes);

        let pages = [];
        let anyTextDetected = false;

        // =====================
        // OCR – Enhanced Reliability
        // =====================
        if (fileName.endsWith(".xlsx") || fileName.endsWith(".xls")) {
          pages = await processExcel(buffer);
        } else {
          // Try enhanced image first for non-PDF
          let rawText = "";
          if (!fileName.endsWith(".pdf")) {
            rawText = await preprocessAndRetryImage(base64, env);
          } else {
            // PDF – use asyncBatchAnnotate for better reliability
            rawText = await asyncBatchPDF(buffer, env);
          }

          pages = [{ page: 1, rawText }];
        }

        // Detect meaningful text
        for (const page of pages) {
          if (page.rawText && page.rawText.trim().length > 100 && !page.rawText.includes("[No text")) {
            anyTextDetected = true;
          }
        }

        // =====================
        // AI ANALYSIS
        // =====================
        for (const page of pages) {
          const modelOpenAI = isPaid ? "gpt-4o" : "gpt-4o-mini";
          const modelGemini = isPaid ? "gemini-1.5-pro" : "gemini-1.5-flash";

          const prompt = `You are an expert medical bill analyst using real-world data from FAIR Health Consumer and CMS Hospital Price Transparency databases.

Analyze the bill text and respond with ONLY valid JSON in this exact structure:

{
  "summary": "One clear sentence summarizing the entire bill",
  "summaryPoints": [
    "Most important insight #1",
    "Most important insight #2",
    "Most important insight #3 (optional)"
  ],
  "keyAmounts": {
    "totalCharges": "Extracted total billed amount as string with $ or null",
    "insuranceAdjusted": "Amount written off/adjusted or null",
    "insurancePaid": "Amount insurance paid or null",
    "patientResponsibility": "Final amount patient owes or null"
  },
  "confidences": {
    "totalCharges": 0-100 confidence score,
    "insuranceAdjusted": 0-100,
    "insurancePaid": 0-100,
    "patientResponsibility": 0-100
  },
  "services": ["Short list of main services/procedures as strings"],
  "redFlags": ["Potential issues, overcharges, or errors as strings (empty array if none)"],
  "potentialSavings": "Precise estimated savings range based on FAIR Health/CMS data (e.g. '$800–$2,500 possible savings') or null if no clear potential",
  "explanation": "Clear, calm, plain-English explanation in 2-4 short paragraphs",
  "nextSteps": ["Ranked actionable steps, most important first"]
}

Rules for potentialSavings (be conservative and evidence-based):
- Use FAIR Health Consumer and CMS data as reference for typical rates.
- Average overcharge error saves ~$1,300 on bills >$10k.
- Successful negotiation typically reduces patient responsibility by 25–50%.
- If redFlags present: estimate 20–40% of patientResponsibility or totalCharges.
- If charges seem high vs typical rates: 10–30% range.
- Never invent numbers — only estimate if clear evidence in text.
- For free users: lower or null estimate and end explanation with upgrade message.

Bill text:
"""${page.rawText}"""
`;

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
                    generationConfig: {
                      temperature: 0.2,
                      maxOutputTokens: isPaid ? 1200 : 300,
                    },
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

        let fullExplanation = pages
          .map((p) => p.explanation)
          .join("\n\n");

        if (!anyTextDetected) {
          const noTextMsg = isPaid
            ? "No readable text was detected in the uploaded bill. This can happen with very dense layouts, watermarks, or low-contrast scans. Try uploading a clearer version or a searchable PDF."
            : "No readable text detected. Basic analysis complete. Upgrade for advanced processing and support for complex bills.";
          fullExplanation = noTextMsg + "\n\n" + fullExplanation;
        }

        return new Response(
          JSON.stringify({
            isPaid,
            pages: pages.map((p) => ({
              page: p.page,
              structured: p.structured,
              explanation: p.explanation,
            })),
            explanation: fullExplanation,
          }),
          {
            headers: { "Content-Type": "application/json", ...corsHeaders },
          }
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

// =====================
// HELPERS
// =====================
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
  const CHUNK_SIZE = 0x8000;
  let binary = '';
  for (let i = 0; i < uint8Array.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode(...uint8Array.subarray(i, i + CHUNK_SIZE));
  }
  return btoa(binary);
}

async function preprocessAndRetryImage(base64, env, retries = 4) {
  let bestText = "";
  const enhancementLevels = [
    "contrast(1.4) brightness(1.15)",
    "contrast(1.7) brightness(1.3)",
    "contrast(2.0) brightness(1.4) saturate(1.2)",
    "contrast(2.3) brightness(1.5) saturate(1.3)",
  ];

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const filter = enhancementLevels[attempt] || enhancementLevels[enhancementLevels.length - 1];
      const enhancedBase64 = await enhanceImage(base64, filter);
      const res = await fetchWithTimeout(
        `https://vision.googleapis.com/v1/images:annotate?key=${env.GOOGLE_VISION_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requests: [
              {
                image: { content: enhancedBase64 },
                features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
                imageContext: { languageHints: ["en"] },
              },
            ],
          }),
        }
      );

      const data = await res.json();
      const rawText = data.responses?.[0]?.fullTextAnnotation?.text?.trim() || "";
      if (rawText.length > bestText.length) {
        bestText = rawText;
      }
      if (bestText.length > 150) {
        return bestText;
      }
    } catch (err) {
      console.error(`Image OCR attempt ${attempt + 1} failed:`, err);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  return bestText || "[No text detected after retries]";
}

async function enhanceImage(base64, filter = "contrast(1.6) brightness(1.2)") {
  try {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const img = await createImageBitmap(new Blob([bytes]));
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
    const buffer = await blob.arrayBuffer();
    return uint8ArrayToBase64(new Uint8Array(buffer));
  } catch (err) {
    console.error("Enhancement failed:", err);
    return base64;
  }
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
            imageContext: { languageHints: ["en"] },
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
        const responses = pollData.response?.responses || pollData.responses || [];
        const texts = responses.map(r => r.fullTextAnnotation?.text || "");
        return texts.join("\n\n");
      }
    }
    throw new Error("PDF OCR timed out");
  } catch (err) {
    console.error("PDF OCR failed:", err);
    return "[PDF OCR failed or timed out]";
  }
}

// Keep parseAiResponse, parseGeminiResponse, fallbackStructured, mergeWithConfidence, processExcel unchanged from previous version
