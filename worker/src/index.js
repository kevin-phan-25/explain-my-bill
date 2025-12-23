// worker/src/index.js - Final Working Version
// Google Vision OCR + OpenAI Explanation + Stripe
// Fixed URL + Safe base64 encoding

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
            mode: plan === "monthly" ? "subscription" : "payment",
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
        if (!billFile || billFile.size === 0) throw new Error("No bill uploaded");
        const isPaid = Boolean(sessionId);
        const buffer = await billFile.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        const fileName = billFile.name.toLowerCase();
        let pages = [];

        // FIXED: Safe base64 encoding for binary files (no corruption)
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);

        if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
          pages = await processExcel(buffer);
        } else {
          const key = env.GOOGLE_VISION_API_KEY;
          if (!key) throw new Error("Google Vision key missing");

          // FIXED: Correct endpoint with /v1/
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
          const text = data.responses[0]?.fullTextAnnotation?.text || "[No text]";
          const pageTexts = text.split(/\f/).map(t => t.trim()).filter(t => t);
          pages = pageTexts.length > 0
            ? pageTexts.map((t, i) => ({ page: i + 1, rawText: t }))
            : [{ page: 1, rawText: text }];
        }

        // Generate explanations
        for (const p of pages) {
          const prompt = `Explain this medical bill in simple English.
Content:
${p.rawText}
${isPaid ? "Include red flags, codes, charges, and next steps." : "Give a short teaser under 150 words. End with 'Upgrade for full details.'"}`;
          const res = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env.OPENAI_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "gpt-4o-mini",
              messages: [{ role: "user", content: prompt }],
              max_tokens: isPaid ? 1000 : 300,
            }),
          });
          const data = await res.json();
          p.explanation = data.choices?.[0]?.message?.content?.trim() || "No explanation";
        }

        const fullExplanation = pages.map(p => `Page ${p.page}:\n${p.explanation}`).join("\n\n");

        let paidFeatures = {};
        if (isPaid) {
          paidFeatures = {
            redFlags: fullExplanation.includes("DENIED") ? ["Possible denial"] : [],
            appealLetter: "Dear Insurance,\n\nI am appealing the claim...\n\nThank you.",
            costComparison: { note: "Check fairhealthconsumer.org" },
            insuranceLookup: { note: "Call your insurer" },
            customAdvice: "Get an itemized bill and verify charges.",
          };
        }

        return new Response(JSON.stringify({
          isPaid,
          pages,
          fullExplanation,
          paidFeatures,
        }), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }

    return new Response("ExplainMyBill running", { headers: corsHeaders });
  },
};

async function processExcel(buffer) {
  const XLSX = await import("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm");
  const wb = XLSX.read(new Uint8Array(buffer), { type: "array" });
  return wb.SheetNames.map((name, i) => ({
    page: i + 1,
    rawText: XLSX.utils.sheet_to_csv(wb.Sheets[name]) || "[Empty]",
  }));
}