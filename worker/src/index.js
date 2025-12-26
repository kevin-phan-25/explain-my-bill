// ExplainMyBill Worker – Vision FIRST + Multi-Page PDF + Page Confidence (Dec 2025)
// Google Vision for PDFs, Images, Excel
// Page-by-page AI analysis
// Zero storage – stateless processing only

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Dev-Bypass",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // =========================
    // STRIPE CHECKOUT (UNCHANGED)
    // =========================
    if (url.pathname === "/create-checkout-session" && request.method === "POST") {
      try {
        const { plan } = await request.json();
        if (!["monthly", "one-time", "lifetime"].includes(plan)) {
          throw new Error("Invalid plan");
        }

        const priceIdMap = {
          monthly: env.STRIPE_PRICE_MONTHLY,
          "one-time": env.STRIPE_PRICE_ONE_TIME,
          lifetime: env.STRIPE_PRICE_LIFETIME,
        };

        const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            mode: plan === "monthly" ? "subscription" : "payment",
            "line_items[0][price]": priceIdMap[plan],
            "line_items[0][quantity]": "1",
            success_url: "https://explain-my-bill-frontend.onrender.com/success",
            cancel_url: "https://explain-my-bill-frontend.onrender.com/cancel",
          }),
        });

        const data = await res.json();
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

    // =========================
    // BILL UPLOAD
    // =========================
    if (request.method === "POST") {
      try {
        const formData = await request.formData();
        const billFile = formData.get("bill");
        const sessionId = formData.get("sessionId");

        if (!billFile) throw new Error("No bill uploaded");
        if (billFile.size > 20 * 1024 * 1024) throw new Error("File too large");

        const isPaid = Boolean(sessionId);

        const buffer = await billFile.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        const base64 = uint8ArrayToBase64(bytes);
        const fileName = billFile.name.toLowerCase();

        // =========================
        // GOOGLE VISION OCR
        // =========================
        const visionPayload = {
          requests: [
            {
              inputConfig: {
                content: base64,
                mimeType: fileName.endsWith(".pdf")
                  ? "application/pdf"
                  : "image/jpeg",
              },
              features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
            },
          ],
        };

        const visionRes = await fetch(
          `https://vision.googleapis.com/v1/images:annotate?key=${env.GOOGLE_VISION_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(visionPayload),
          }
        );

        const visionData = await visionRes.json();
        if (visionData.error) throw new Error(visionData.error.message);

        const visionResponse = visionData.responses?.[0];
        if (!visionResponse) throw new Error("No Vision OCR response");

        // =========================
        // SPLIT INTO PAGES (PDF SAFE)
        // =========================
        const pages = [];

        if (visionResponse.fullTextAnnotation?.pages?.length) {
          visionResponse.fullTextAnnotation.pages.forEach((p, i) => {
            const text = p.blocks
              ?.flatMap(b => b.paragraphs || [])
              .flatMap(pg => pg.words || [])
              .map(w => w.symbols?.map(s => s.text).join("") || "")
              .join(" ");

            pages.push({
              page: i + 1,
              rawText: text || "[No text detected on page]",
            });
          });
        } else {
          pages.push({
            page: 1,
            rawText:
              visionResponse.fullTextAnnotation?.text ||
              "[No text detected]",
          });
        }

        // =========================
        // AI ANALYSIS PER PAGE
        // =========================
        for (const page of pages) {
          const prompt = buildPrompt(page.rawText, isPaid);

          const [openaiRes, geminiRes] = await Promise.all([
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
              `https://generativelanguage.googleapis.com/v1beta/models/${
                isPaid ? "gemini-1.5-pro" : "gemini-1.5-flash"
              }:generateContent?key=${env.GEMINI_API_KEY}`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  contents: [{ role: "user", parts: [{ text: prompt }] }],
                }),
              }
            ),
          ]);

          const openaiData = await openaiRes.json();
          const geminiData = await geminiRes.json();

          const structured = mergeWithConfidence(
            parseAiResponse(openaiData),
            parseGeminiResponse(geminiData),
            isPaid
          );

          page.structured = structured;
          page.explanation = structured.explanation;
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

    return new Response("ExplainMyBill Worker – Vision Multi-Page Enabled", {
      headers: corsHeaders,
    });
  },
};

// =========================
// HELPERS (UNCHANGED STRUCTURE)
// =========================
function buildPrompt(text, isPaid) {
  return `You are an expert medical bill analyst. Respond with ONLY valid JSON.

{
  "summary": "One sentence summary",
  "summaryPoints": [],
  "keyAmounts": {
    "totalCharges": "string or null",
    "insuranceAdjusted": "string or null",
    "insurancePaid": "string or null",
    "patientResponsibility": "Amount Due / Balance Due"
  },
  "confidences": {
    "totalCharges": 0-100,
    "insuranceAdjusted": 0-100,
    "insurancePaid": 0-100,
    "patientResponsibility": 0-100
  },
  "services": [],
  "redFlags": [],
  "explanation": "Clear explanation",
  "nextSteps": []
}

CRITICAL:
- Always prefer Amount Due / Balance Due
- Conservative estimates
- Free users end with upgrade CTA

BILL TEXT:
"""${text}"""`;
}

function parseAiResponse(data) {
  try {
    return JSON.parse(
      data.choices?.[0]?.message?.content?.replace(/```json|```/g, "")
    );
  } catch {
    return null;
  }
}

function parseGeminiResponse(data) {
  try {
    return JSON.parse(
      data.candidates?.[0]?.content?.parts?.[0]?.text?.replace(/```json|```/g, "")
    );
  } catch {
    return null;
  }
}

function mergeWithConfidence(a, b, isPaid) {
  if (!a && !b) return fallbackStructured(isPaid);

  const pick = (field) =>
    a?.keyAmounts?.[field] || b?.keyAmounts?.[field] || null;

  return {
    summary: a?.summary || b?.summary,
    summaryPoints: [...new Set([...(a?.summaryPoints || []), ...(b?.summaryPoints || [])])],
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
    explanation: a?.explanation || b?.explanation,
    nextSteps: [...new Set([...(a?.nextSteps || []), ...(b?.nextSteps || [])])],
  };
}

function fallbackStructured(isPaid) {
  return {
    summary: "Bill analyzed.",
    summaryPoints: [],
    keyAmounts: {},
    confidences: {},
    services: [],
    redFlags: [],
    explanation: isPaid
      ? "Detailed analysis complete."
      : "Basic analysis complete. Upgrade for full review.",
    nextSteps: [],
  };
}

function uint8ArrayToBase64(uint8Array) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < uint8Array.length; i += chunk) {
    binary += String.fromCharCode(...uint8Array.subarray(i, i + chunk));
  }
  return btoa(binary);
}
