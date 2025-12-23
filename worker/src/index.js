// ExplainMyBill Worker – Fully Fixed & Structured JSON Output (Dec 2025)

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Dev-Bypass",
    };

    // Handle OPTIONS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // -------------------
    // Stripe Checkout Session Creation
    // -------------------
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

    // -------------------
    // Main Bill Processing (OCR + AI → Structured JSON)
    // -------------------
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

        // Excel files
        if (fileName.endsWith(".xlsx") || fileName.endsWith(".xls")) {
          pages = await processExcel(buffer);
        }
        // PDF files
        else if (fileName.endsWith(".pdf")) {
          const key = env.GOOGLE_VISION_API_KEY;
          if (!key) throw new Error("Google Vision API key missing");

          const res = await fetch(
            `https://vision.googleapis.com/v1/files:annotate?key=${key}`,
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
          if (data.error) throw new Error(data.error.message);

          const responses = data.responses?.[0]?.responses || [];
          pages = responses.map((r, i) => ({
            page: i + 1,
            rawText: r.fullTextAnnotation?.text || "[No text on this page]",
          }));
        }
        // Image files (jpg, png, etc.)
        else {
          const key = env.GOOGLE_VISION_API_KEY;
          if (!key) throw new Error("Google Vision API key missing");

          const res = await fetch(
            `https://vision.googleapis.com/v1/images:annotate?key=${key}`,
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
          if (data.error) throw new Error(data.error.message);

          const text = data.responses?.[0]?.fullTextAnnotation?.text || "[No text found]";
          pages = [{ page: 1, rawText: text }];
        }

        // AI Analysis – Force Valid JSON Output
        for (const page of pages) {
          const model = isPaid ? "gpt-4o" : "gpt-4o-mini";
          const maxTokens = isPaid ? 1200 : 300;

          const prompt = `You are an expert medical bill analyst. Respond with ONLY valid JSON in this exact structure. No markdown, no extra text.

{
  "summary": "One clear sentence summarizing the bill page",
  "keyAmounts": {
    "totalCharges": "Extracted total amount billed (e.g. '$10,000.00') or null",
    "insuranceAdjusted": "Amount adjusted/written off or null",
    "insurancePaid": "Amount insurance paid or null",
    "patientResponsibility": "Final amount patient owes or null"
  },
  "services": ["Short list of main services/procedures"],
  "redFlags": ["Potential issues or overcharges (empty array if none)"],
  "explanation": "Simple, clear explanation in 2-4 paragraphs",
  "nextSteps": ["Bullet-point actions for the patient"]
}

Bill text:
"""${page.rawText}"""

${!isPaid ? "Keep explanation under 120 words and end with: 'Upgrade for full expert review, red flags, and appeal tools.'" : ""}
`;

          const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env.OPENAI_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model,
              messages: [{ role: "user", content: prompt }],
              temperature: 0.2,
              max_tokens: maxTokens,
            }),
          });

          const aiData = await aiRes.json();
          let raw = aiData.choices?.[0]?.message?.content?.trim() || "{}";

          // Clean common wrapper issues
          raw = raw.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();

          let structured;
          try {
            structured = JSON.parse(raw);
          } catch (e) {
            // Fallback if JSON is invalid
            structured = {
              summary: "Bill analysis completed.",
              keyAmounts: {
                totalCharges: null,
                insuranceAdjusted: null,
                insurancePaid: null,
                patientResponsibility: null,
              },
              services: ["Medical services"],
              redFlags: [],
              explanation: isPaid
                ? raw.slice(0, 800) + "\n\n[Structured analysis partially failed]"
                : raw.slice(0, 150) + "\n\nUpgrade for full details.",
              nextSteps: isPaid
                ? ["Request itemized bill", "Compare at FairHealthConsumer.org", "Contact insurance"]
                : ["Upgrade for personalized guidance"],
            };
          }

          page.structured = structured;
          page.explanation = structured.explanation;
        }

        const fullExplanation = pages
          .map((p) => `Page ${p.page}:\n${p.explanation}`)
          .join("\n\n");

        return new Response(
          JSON.stringify({
            isPaid,
            pages: pages.map((p) => ({
              page: p.page,
              structured: p.structured,
              explanation: p.explanation,
            })),
            fullExplanation,
            explanation: fullExplanation,
          }),
          {
            headers: { "Content-Type": "application/json", ...corsHeaders },
          }
        );
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }

    // Default response
    return new Response("ExplainMyBill Worker v2 running – Structured JSON ready", {
      headers: corsHeaders,
    });
  },
};

// MUST be outside the export default block
async function processExcel(buffer) {
  const XLSX = await import("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm");
  const wb = XLSX.read(new Uint8Array(buffer), { type: "array" });
  return wb.SheetNames.map((name, i) => ({
    page: i + 1,
    rawText: XLSX.utils.sheet_to_csv(wb.Sheets[name]) || "[Empty sheet]",
  }));
}
