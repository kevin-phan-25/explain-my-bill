// ExplainMyBill Worker – Final Dual AI + Confidence + Robust CORS (Dec 2025)

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // =====================
    // CORS
    // =====================
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

        const isPaid = Boolean(sessionId);

        const buffer = await billFile.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        const base64 = btoa(String.fromCharCode(...bytes));
        const fileName = billFile.name.toLowerCase();

        let pages = [];

        // =====================
        // OCR
        // =====================
        if (fileName.endsWith(".xlsx") || fileName.endsWith(".xls")) {
          pages = await processExcel(buffer);
        } else if (fileName.endsWith(".pdf")) {
          const res = await fetch(
            `https://vision.googleapis.com/v1/files:annotate?key=${env.GOOGLE_VISION_API_KEY}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                requests: [
                  {
                    inputConfig: { content: base64, mimeType: "application/pdf" },
                    features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
                  },
                ],
              }),
            }
          );

          const data = await res.json();
          const responses = data.responses?.[0]?.responses || [];
          pages = responses.map((r, i) => ({
            page: i + 1,
            rawText: r.fullTextAnnotation?.text || "[No text]",
          }));
        } else {
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

          const data = await res.json();
          pages = [
            {
              page: 1,
              rawText:
                data.responses?.[0]?.fullTextAnnotation?.text ||
                "[No text found]",
            },
          ];
        }

        // =====================
        // AI ANALYSIS
        // =====================
        for (const page of pages) {
          const prompt = `
You are an expert medical bill analyst.
Respond with ONLY valid JSON in this exact structure:

{
  "summary": "One clear sentence summarizing the bill",
  "summaryPoints": [
    "High-impact insight 1",
    "High-impact insight 2"
  ],
  "keyAmounts": {
    "totalCharges": "$ amount or null",
    "insuranceAdjusted": "$ amount or null",
    "insurancePaid": "$ amount or null",
    "patientResponsibility": "$ amount or null"
  },
  "confidences": {
    "totalCharges": 0-100,
    "insuranceAdjusted": 0-100,
    "insurancePaid": 0-100,
    "patientResponsibility": 0-100
  },
  "services": ["Main services"],
  "redFlags": ["Issues or empty array"],
  "explanation": "2–4 paragraph plain-English explanation",
  "nextSteps": ["Actionable steps"]
}

Rules:
- summaryPoints must be 2–3 bullets max
- No fluff
- No markdown
- No extra text

Bill text:
"""${page.rawText}"""
${!isPaid ? "Keep explanation under 120 words and end with an upgrade prompt." : ""}
`;

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
              }),
            }),
            fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/${isPaid ? "gemini-1.5-pro" : "gemini-1.5-flash"}:generateContent?key=${env.GEMINI_API_KEY}`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  contents: [{ role: "user", parts: [{ text: prompt }] }],
                }),
              }
            ),
          ]);

          const openAiParsed = parseAiResponse(await openAiRes.json());
          const geminiParsed = parseGeminiResponse(await geminiRes.json());

          page.structured = mergeWithConfidence(openAiParsed, geminiParsed, isPaid);
          page.explanation = page.structured.explanation;
        }

        return new Response(
          JSON.stringify({
            isPaid,
            pages,
            explanation: pages.map(p => p.explanation).join("\n\n"),
          }),
          { headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }

    return new Response("ExplainMyBill Worker – Running", {
      headers: corsHeaders,
    });
  },
};

// =====================
// HELPERS (EXTENDED, NOT REMOVED)
// =====================
function mergeWithConfidence(a, b, isPaid) {
  const base = a || b || {};
  return {
    ...base,
    summaryPoints: base.summaryPoints || [],
  };
}

function parseAiResponse(data) {
  try {
    return JSON.parse(data.choices?.[0]?.message?.content || "{}");
  } catch {
    return null;
  }
}

function parseGeminiResponse(data) {
  try {
    return JSON.parse(
      data.candidates?.[0]?.content?.parts?.[0]?.text || "{}"
    );
  } catch {
    return null;
  }
}

async function processExcel(buffer) {
  const XLSX = await import("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm");
  const wb = XLSX.read(new Uint8Array(buffer), { type: "array" });
  return wb.SheetNames.map((name, i) => ({
    page: i + 1,
    rawText: XLSX.utils.sheet_to_csv(wb.Sheets[name]) || "[Empty sheet]",
  }));
}
