export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // =====================
    // CORS (NO STATE)
    // =====================
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Dev-Bypass",
    };

    if (request.method === "OPTIONS") {
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

        const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
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
        });

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error?.message || "Stripe error");
        }

        return new Response(JSON.stringify({ id: data.id }), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: corsHeaders,
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
        const sessionId = formData.get("sessionId");

        if (!billFile || billFile.size === 0) {
          throw new Error("No bill uploaded");
        }

        if (billFile.size > 20 * 1024 * 1024) {
          throw new Error("File too large (20MB max)");
        }

        // ---- EPHEMERAL MEMORY ONLY ----
        const buffer = await billFile.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        const base64 = uint8ArrayToBase64(bytes);

        const isPaid = Boolean(sessionId);
        let pages = [];
        let anyTextDetected = false;

        // =====================
        // GOOGLE VISION OCR (ONLY ENGINE)
        // =====================
        const visionRes = await fetch(
          `https://vision.googleapis.com/v1/images:annotate?key=${env.GOOGLE_VISION_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              requests: [
                {
                  image: { content: base64 },
                  features: [
                    { type: "DOCUMENT_TEXT_DETECTION" },
                    { type: "TEXT_DETECTION" }
                  ],
                  imageContext: {
                    languageHints: ["en"],
                  },
                },
              ],
            }),
          }
        );

        const visionData = await visionRes.json();
        if (visionData.error) {
          throw new Error(visionData.error.message || "Vision API error");
        }

        const rawText =
          visionData?.responses?.[0]?.fullTextAnnotation?.text ||
          visionData?.responses?.[0]?.textAnnotations?.[0]?.description ||
          "";

        if (rawText && rawText.trim().length > 100) {
          pages = [{ page: 1, rawText }];
          anyTextDetected = true;
        } else {
          pages = [{ page: 1, rawText: "[No readable text detected]" }];
        }

        // =====================
        // AI ANALYSIS (FULLY RE-ENABLED)
        // =====================
        for (const page of pages) {
          const prompt = buildPrompt(page.rawText, isPaid);

          let openAiParsed = null;
          let geminiParsed = null;

          try {
            const [openAiRes, geminiRes] = await Promise.all([
              fetch("https://api.openai.com/v1/chat/completions", {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${env.OPENAI_API_KEY}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  model: isPaid ? "gpt-4o" : "gpt-4o-mini",
                  messages: [{ role: "user", content: prompt }],
                  temperature: 0.2,
                  max_tokens: isPaid ? 1200 : 300,
                }),
              }),
              fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${isPaid ? "gemini-1.5-pro" : "gemini-1.5-flash"}:generateContent?key=${env.GEMINI_API_KEY}`,
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

            openAiParsed = parseOpenAI(await openAiRes.json());
            geminiParsed = parseGemini(await geminiRes.json());
          } catch (_) {}

          page.structured = mergeResults(openAiParsed, geminiParsed, isPaid);
          page.explanation = page.structured.explanation;
        }

        // ---- DATA GONE AFTER RESPONSE ----
        return new Response(
          JSON.stringify({
            isPaid,
            pages: pages.map(p => ({
              page: p.page,
              structured: p.structured,
              explanation: p.explanation,
            })),
            explanation: pages.map(p => p.explanation).join("\n\n"),
          }),
          { headers: { "Content-Type": "application/json", ...corsHeaders } }
        );

      } catch (err) {
        return new Response(
          JSON.stringify({ error: err.message || "Processing failed" }),
          { status: 500, headers: corsHeaders }
        );
      }
    }

    return new Response("ExplainMyBill Worker – Running", {
      headers: corsHeaders,
    });
  },
};

// =====================
// HELPERS (PURE FUNCTIONS)
// =====================

function uint8ArrayToBase64(uint8Array) {
  const CHUNK_SIZE = 0x8000;
  let binary = "";
  for (let i = 0; i < uint8Array.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode(...uint8Array.subarray(i, i + CHUNK_SIZE));
  }
  return btoa(binary);
}

function buildPrompt(text, isPaid) {
  return `
You are an expert medical bill analyst.

Return ONLY valid JSON with this structure:

{
  "summary": "",
  "summaryPoints": [],
  "keyAmounts": {
    "totalCharges": null,
    "insuranceAdjusted": null,
    "insurancePaid": null,
    "patientResponsibility": null
  },
  "confidences": {
    "totalCharges": 0,
    "insuranceAdjusted": 0,
    "insurancePaid": 0,
    "patientResponsibility": 0
  },
  "services": [],
  "redFlags": [],
  "potentialSavings": null,
  "explanation": "",
  "nextSteps": []
}

Rules:
- Be conservative
- Do not invent numbers
- If unclear, return nulls
- ${isPaid ? "Provide full detailed analysis." : "Limit detail and suggest upgrade at end."}

Bill text:
"""${text}"""
`;
}

function parseOpenAI(data) {
  try {
    const content = data.choices?.[0]?.message?.content || "{}";
    return JSON.parse(content.replace(/```json|```/g, "").trim());
  } catch {
    return null;
  }
}

function parseGemini(data) {
  try {
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    return JSON.parse(content.replace(/```json|```/g, "").trim());
  } catch {
    return null;
  }
}

function mergeResults(a, b, isPaid) {
  const fallback = {
    summary: "Bill analyzed.",
    summaryPoints: [],
    keyAmounts: {},
    confidences: {},
    services: [],
    redFlags: [],
    potentialSavings: null,
    explanation: isPaid
      ? "Analysis completed using AI review."
      : "Basic analysis complete. Upgrade for full review.",
    nextSteps: [],
  };

  if (!a && !b) return fallback;

  return {
    summary: a?.summary || b?.summary || fallback.summary,
    summaryPoints: [...new Set([...(a?.summaryPoints || []), ...(b?.summaryPoints || [])])],
    keyAmounts: a?.keyAmounts || b?.keyAmounts || fallback.keyAmounts,
    confidences: a?.confidences || b?.confidences || fallback.confidences,
    services: [...new Set([...(a?.services || []), ...(b?.services || [])])],
    redFlags: [...new Set([...(a?.redFlags || []), ...(b?.redFlags || [])])],
    potentialSavings: a?.potentialSavings || b?.potentialSavings || null,
    explanation:
      (a?.explanation?.length || 0) >= (b?.explanation?.length || 0)
        ? a?.explanation
        : b?.explanation,
    nextSteps: [...new Set([...(a?.nextSteps || []), ...(b?.nextSteps || [])])],
  };
}
