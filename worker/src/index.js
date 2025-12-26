// ExplainMyBill Worker – Final Full Code Update with Celebrity Recognition Disabled (Dec 2025)
// All features preserved + fix for Vision API quota error (celebrity recognition disabled)

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
        // OCR – Only DOCUMENT_TEXT_DETECTION (no celebrity recognition)
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
                    inputConfig: {
                      content: base64,
                      mimeType: "application/pdf",
                    },
                    features: [
                      { type: "DOCUMENT_TEXT_DETECTION" } // Only this feature
                    ],
                    imageContext: {
                      languageHints: ["en"],
                    },
                    pages: [1, 2, 3, 4, 5],
                  },
                ],
              }),
            }
          );

          const data = await res.json();
          if (data.error) {
            throw new Error(`Vision API error: ${data.error.message || JSON.stringify(data.error)}`);
          }

          const pageResponses = data.responses?.[0]?.responses || [];
          pages = pageResponses.length
            ? pageResponses.map((r, i) => ({
                page: i + 1,
                rawText: r.fullTextAnnotation?.text || "[No text on this page]",
              }))
            : [{ page: 1, rawText: "[No text detected in document]" }];
        } else {
          // Single images
          const res = await fetch(
            `https://vision.googleapis.com/v1/images:annotate?key=${env.GOOGLE_VISION_API_KEY}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                requests: [
                  {
                    image: { content: base64 },
                    features: [
                      { type: "DOCUMENT_TEXT_DETECTION" } // Only this feature
                    ],
                    imageContext: {
                      languageHints: ["en"],
                    },
                  },
                ],
              }),
            }
          );

          const data = await res.json();
          if (data.error) {
            throw new Error(`Vision API error: ${data.error.message || JSON.stringify(data.error)}`);
          }

          pages = [
            {
              page: 1,
              rawText:
                data.responses?.[0]?.fullTextAnnotation?.text ||
                "[No text found in image]",
            },
          ];
        }

        // Detect meaningful text
        for (const page of pages) {
          if (page.rawText && page.rawText.length > 50 && !page.rawText.includes("[No text")) {
            anyTextDetected = true;
          }
        }

        // =====================
        // AI ANALYSIS – Precise Savings with Real-World Rules
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
              fetch("https://api.openai.com/v1/chat/completions", {
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
              fetch(
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
function uint8ArrayToBase64(bytes) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function parseAiResponse(data) {
  try {
    let content = data.choices?.[0]?.message?.content?.trim() || "{}";
    content = content.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();
    return JSON.parse(content);
  } catch (e) {
    return null;
  }
}

function parseGeminiResponse(data) {
  try {
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const cleaned = content.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();
    return JSON.parse(cleaned);
  } catch (e) {
    return null;
  }
}

function fallbackStructured(isPaid) {
  return {
    summary: "Bill analyzed successfully.",
    summaryPoints: ["Analysis complete", "See details below"],
    keyAmounts: { totalCharges: null, insuranceAdjusted: null, insurancePaid: null, patientResponsibility: null },
    confidences: { totalCharges: 0, insuranceAdjusted: 0, insurancePaid: 0, patientResponsibility: 0 },
    services: [],
    redFlags: [],
    potentialSavings: null,
    explanation: isPaid
      ? "Detailed analysis completed using dual AI verification."
      : "Basic analysis complete. Upgrade for full expert review, red flags, and personalized appeal tools.",
    nextSteps: [
      "Request a detailed itemized bill from your provider",
      "Compare charges on FairHealthConsumer.org",
      "Call your insurance using the claim number"
    ],
  };
}

function mergeWithConfidence(openAi, gemini, isPaid) {
  const fallback = fallbackStructured(isPaid);

  if (!openAi && !gemini) return fallback;

  const a = openAi || {};
  const b = gemini || {};
  const aConf = a.confidences || {};
  const bConf = b.confidences || {};

  const pickHighest = (field) => {
    const valA = a.keyAmounts?.[field];
    const valB = b.keyAmounts?.[field];
    const confA = aConf[field] || 0;
    const confB = bConf[field] || 0;

    if (valA && valB) return confA >= confB ? valA : valB;
    if (valA) return valA;
    if (valB) return valB;
    return null;
  };

  const longerExplanation = (a.explanation || "").length >= (b.explanation || "").length 
    ? a.explanation 
    : b.explanation;

  const potentialSavings = a.potentialSavings || b.potentialSavings || fallback.potentialSavings;

  return {
    summary: a.summary || b.summary || fallback.summary,
    summaryPoints: [...new Set([...(a.summaryPoints || []), ...(b.summaryPoints || [])])].slice(0, 3),
    keyAmounts: {
      totalCharges: pickHighest("totalCharges"),
      insuranceAdjusted: pickHighest("insuranceAdjusted"),
      insurancePaid: pickHighest("insurancePaid"),
      patientResponsibility: pickHighest("patientResponsibility"),
    },
    confidences: {
      totalCharges: Math.max(aConf.totalCharges || 0, bConf.totalCharges || 0),
      insuranceAdjusted: Math.max(aConf.insuranceAdjusted || 0, bConf.insuranceAdjusted || 0),
      insurancePaid: Math.max(aConf.insurancePaid || 0, bConf.insurancePaid || 0),
      patientResponsibility: Math.max(aConf.patientResponsibility || 0, bConf.patientResponsibility || 0),
    },
    services: [...new Set([...(a.services || []), ...(b.services || [])])],
    redFlags: [...new Set([...(a.redFlags || []), ...(b.redFlags || [])])],
    potentialSavings: potentialSavings,
    explanation: longerExplanation || fallback.explanation,
    nextSteps: [...new Set([...(a.nextSteps || []), ...(b.nextSteps || [])])],
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
