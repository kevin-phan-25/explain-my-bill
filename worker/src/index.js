// worker/src/index.js
// ExplainMyBill Worker – Final Clean Version
// Google Vision OCR + OpenAI Explanation + Stripe
// Low-maintenance, high-value

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
    // 1️⃣ Stripe Checkout
    // -------------------
    if (url.pathname === "/create-checkout-session" && request.method === "POST") {
      try {
        const { plan } = await request.json();
        if (!["monthly", "one-time"].includes(plan)) throw new Error("Invalid plan");

        const priceId = plan === "monthly" ? "price_123monthly" : "price_123one";

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
            "mode": plan === "monthly" ? "subscription" : "payment",
            success_url: "https://explain-my-bill-frontend.onrender.com/success?session_id={CHECKOUT_SESSION_ID}",
            cancel_url: "https://explain-my-bill-frontend.onrender.com/cancel",
          }),
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error?.message || "Payment failed");

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
    // 2️⃣ Bill Processing
    // -------------------
    if (request.method === "POST") {
      try {
        const formData = await request.formData();
        const billFile = formData.get("bill");
        const sessionId = formData.get("sessionId") || url.searchParams.get("session_id");

        if (!billFile || billFile.size === 0) {
          throw new Error("No bill uploaded");
        }

        const devBypass = request.headers.get("X-Dev-Bypass") === "true" || env.DEV_MODE === "true";
        const isPaid = Boolean(sessionId) || devBypass;

        const buffer = await billFile.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        const base64 = btoa(String.fromCharCode(...bytes));
        const fileName = billFile.name.toLowerCase();

        let pages = [];

        if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
          pages = await processExcel(buffer);
        } else {
          const key = env.GOOGLE_VISION_API_KEY;
          if (!key) throw new Error("Google Vision key missing");

          const res = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${key}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              requests: [{
                image: { content: base64 },
                features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
              }],
            }),
          });

          const data = await res.json();
          if (!res.ok) throw new Error(data.error?.message || "OCR failed");

          const fullText = data.responses[0]?.fullTextAnnotation?.text || "[No text extracted]";

          const pageTexts = fullText.split(/\f/).map(t => t.trim()).filter(t => t.length > 0);
          if (pageTexts.length === 0) pageTexts.push(fullText.trim());

          pages = pageTexts.map((text, i) => ({
            page: i + 1,
            rawText: text || "[No text extracted]",
          }));
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

        // -------------------
        // Paid-only features
        // -------------------
        let paidFeatures = {};
        if (isPaid) {
          paidFeatures = {
            downloadablePdf: true,
            redFlags: extractRedFlags(fullExplanation),
            codeExplanations: extractCodes(fullExplanation),
            costComparison: getCostComparison(fullExplanation),
            estimatedSavings: calculateSavings(fullExplanation),
            appealLetter: generateAppealLetter(fullExplanation),
            insuranceLookup: getInsuranceLookup(fullExplanation),
            customAdvice: generateCustomAdvice(fullExplanation),
            savedHistory: true,
            shareableLink: `https://explainmybill.com/share/${crypto.randomUUID().slice(0,8)}`,
          };
        }

        return new Response(JSON.stringify({
          isPaid,
          pages,
          explanation: fullExplanation, // Aligned for frontend
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

// Helper functions (preserved and expanded)
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
  if (text.match(/DENIED|REJECTED|NOT COVERED/i)) flags.push("Possible denied claim");
  if (text.match(/BALANCE DUE|PATIENT RESPONSIBILITY/i)) flags.push("You may owe money");
  if (text.match(/HIGH CHARGE|UNUSUAL/i)) flags.push("Unusually high charge");
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
