// worker/src/index.js
// ExplainMyBill Worker – Ultimate Premium Features
// Google Vision OCR (preferred) + OpenAI Vision fallback
// ALL FEATURES PRESERVED — no removals

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // -------------------
    // 1️⃣ Stripe Checkout Session
    // -------------------
    if (url.pathname === "/create-checkout-session" && request.method === "POST") {
      try {
        const { plan } = await request.json().catch(() => ({}));
        if (!["monthly", "one-time"].includes(plan)) {
          return new Response(JSON.stringify({ error: "Invalid plan" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }

        const priceId = plan === "monthly" ? "price_123monthly" : "price_123one";

        const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            "payment_method_types[0]": "card",
            "line_items[0][price]": priceId,
            "line_items[0][quantity]": "1",
            "mode": plan === "monthly" ? "subscription" : "payment",
            "success_url": "https://explain-my-bill-frontend.onrender.com/success?session_id={CHECKOUT_SESSION_ID}",
            "cancel_url": "https://explain-my-bill-frontend.onrender.com/cancel",
          }),
        });

        const session = await stripeRes.json().catch(() => ({}));
        if (!stripeRes.ok) throw new Error(session.error?.message || "Stripe error");

        return new Response(JSON.stringify({ id: session.id }), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      } catch (err) {
        console.error("Stripe error:", err);
        return new Response(JSON.stringify({ error: err.message || "Payment failed" }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }

    // -------------------
    // 2️⃣ Explain Bill – Google Vision + OpenAI Vision Fallback
    // -------------------
    if (request.method === "POST") {
      try {
        const formData = await request.formData();
        const billFile = formData.get("bill");
        const sessionId = formData.get("sessionId") || url.searchParams.get("session_id");

        if (!billFile || (billFile.size ?? 0) === 0) {
          return new Response(JSON.stringify({ error: "No bill file uploaded" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }

        const isPaid = Boolean(sessionId);
        const arrayBuffer = await billFile.arrayBuffer();
        const fileType = billFile.type;
        const fileName = billFile.name.toLowerCase();

        const MAX_FILE_SIZE = 20 * 1024 * 1024;
        if (arrayBuffer.byteLength > MAX_FILE_SIZE) {
          throw new Error("File too large (max 20MB)");
        }

        let pages = [];

        // Excel support
        if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
          pages = await processExcel(arrayBuffer);
        } else {
          const bytes = new Uint8Array(arrayBuffer);
          const base64 = btoa(String.fromCharCode(...bytes));

          let extractedText = "";

          // Try Google Vision first
          if (env.GOOGLE_VISION_API_KEY) {
            try {
              const visionRes = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${env.GOOGLE_VISION_API_KEY}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  requests: [{
                    image: { content: base64 },
                    features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
                  }],
                }),
              });

              const visionData = await visionRes.json();
              if (visionRes.ok && visionData.responses?.[0]?.fullTextAnnotation?.text) {
                extractedText = visionData.responses[0].fullTextAnnotation.text;
              }
            } catch (e) {
              console.warn("Google Vision failed, falling back to OpenAI vision:", e);
            }
          }

          // Fallback to OpenAI Vision
          if (!extractedText && env.OPENAI_API_KEY) {
            try {
              const ocrRes = await fetch("https://api.openai.com/v1/chat/completions", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
                },
                body: JSON.stringify({
                  model: "gpt-4o",
                  messages: [
                    {
                      role: "user",
                      content: [
                        { type: "text", text: "Extract all visible text from this bill exactly as shown. Preserve tables, codes, and layout." },
                        { type: "image_url", image_url: { url: `data:${fileType};base64,${base64}` } },
                      ],
                    },
                  ],
                  max_tokens: 1024,
                }),
              });

              const ocrData = await ocrRes.json();
              if (ocrRes.ok) {
                extractedText = ocrData.choices?.[0]?.message?.content?.trim() || "[No text extracted]";
              }
            } catch (e) {
              console.error("OpenAI vision fallback failed:", e);
              extractedText = "[Failed to extract text]";
            }
          }

          // Split into pages
          const pageTexts = extractedText.split(/\f/).map(t => t.trim()).filter(t => t);
          pages = pageTexts.length > 0
            ? pageTexts.map((text, i) => ({ page: i + 1, rawText: text }))
            : [{ page: 1, rawText: extractedText }];
        }

        // Generate explanations
        for (let p of pages) {
          let prompt = `You are an expert medical billing assistant.
Explain the following page/section of a medical/dental bill. Include tables, CPT/ICD codes, charges, insurance adjustments, patient responsibility, totals, and simple explanations.

Content:
${p.rawText}

`;

          if (isPaid) {
            prompt += `\n\nHighlight any red flags (high charges, denied claims, balance due) in ALL CAPS.
Explain common CPT and ICD-10 codes in simple terms.
Suggest next steps if something looks wrong.`;
          } else {
            prompt += "\n\nIMPORTANT: Provide ONLY a short teaser summary (under 150 words) and end with: 'Upgrade to get the full detailed explanation.'";
          }

          const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
              model: "gpt-4o-mini",
              messages: [{ role: "user", content: prompt }],
              temperature: 0.5,
              max_tokens: isPaid ? 1000 : 300,
            }),
          });

          const aiData = await aiRes.json();
          if (!aiRes.ok) throw new Error(`Explanation error: ${JSON.stringify(aiData)}`);

          const explanation = aiData.choices?.[0]?.message?.content?.trim() || "No explanation generated.";
          p.explanation = explanation;
          p.snippet = explanation.substring(0, 200) + (explanation.length > 200 ? "..." : "");
        }

        const fullExplanation = pages.map(p => `Page ${p.page}:\n${p.explanation}`).join("\n\n");

        let paidFeatures = {};
        if (isPaid) {
          paidFeatures = {
            downloadablePdf: true,
            redFlags: extractRedFlags(fullExplanation),
            codeExplanations: extractCodes(fullExplanation),
            costComparison: getCostComparison(fullExplanation),
            estimatedSavings: calculateSavings(fullExplanation),
            insuranceLookup: getInsuranceLookup(fullExplanation),
            prioritySupportEmail: "support@explainmybill.com",
            savedHistoryCount: 42,
            shareableLink: `https://explainmybill.com/share/${crypto.randomUUID().slice(0,8)}`,
            customAdvice: generateCustomAdvice(fullExplanation),
          };
        }

        return new Response(JSON.stringify({
          isPaid,
          pages,
          fullExplanation,
          paidFeatures
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

    return new Response("ExplainMyBill Worker API – POST a bill file to get an explanation.", {
      headers: corsHeaders,
    });
  },
};

// Helper functions (all preserved)
async function processExcel(arrayBuffer) {
  const XLSX = await import("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm");
  const workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: "array" });

  let pages = [];
  let pageIndex = 1;

  workbook.SheetNames.forEach(sheetName => {
    const worksheet = workbook.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(worksheet);
    pages.push({ page: pageIndex, rawText: csv || "[Empty sheet]" });
    pageIndex++;
  });

  return pages;
}

function extractRedFlags(text) {
  const flags = [];
  if (text.match(/DENIED|REJECTED|NOT COVERED|BALANCE DUE|PATIENT RESPONSIBILITY|HIGH CHARGE|UNUSUAL/i)) {
    flags.push("Review for possible overcharge or denial");
  }
  return flags;
}

function extractCodes(text) {
  const cpt = text.match(/CPT[:\s]*(\d{5})/gi) || [];
  const icd = text.match(/ICD-10[:\s]*([A-Z]\d{2,6}(\.\d{1,2})?)/gi) || [];
  return { cpt, icd };
}

function getCostComparison(text) {
  return {
    averageCost: "$150 (national average for common visits)",
    yourCharge: text.match(/Total[:\s]*\$?([\d,]+\.?\d*)/i)?.[1] || "Unknown",
    note: "Compare your charge to fairhealthconsumer.org"
  };
}

function calculateSavings(text) {
  return {
    potentialSavings: "$200–$800",
    reason: "Common overcharges on office visits, labs, and imaging"
  };
}

function getInsuranceLookup(text) {
  const insurers = {
    "Blue Cross": "Often covers 80% after deductible",
    "UnitedHealthcare": "Check for in-network providers",
    "Aetna": "Pre-authorization required for many procedures",
    "Medicare": "Part B covers 80% of approved amounts",
  };

  for (const [name, note] of Object.entries(insurers)) {
    if (text.includes(name)) return { insurer: name, coverageNote: note };
  }

  return { insurer: "Unknown", coverageNote: "Contact your insurer for policy details" };
}

function generateAppealLetter(explanation) {
  return `Dear Insurance Provider,

I am appealing the denial/rejection of claim #XXX for services on [date].

The explanation of benefits cited [reason], but these services were medically necessary.

Please review the attached explanation and reconsider coverage.

Thank you,
[Your Name]`;
}

function generateCustomAdvice(explanation) {
  return "Next steps: Contact your provider for itemized bill. Call insurance with CPT codes. Check fairhealthconsumer.org for average costs in your area.";
}
