// worker/src/index.js
// ExplainMyBill Worker – Full Feature + Multi-Page + Table-Aware + Live Preview + JSON Output
// OCR via Google Cloud Vision API (superior accuracy for bills) + GPT explanation via OpenAI
// Excel support via SheetJS

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
    // 2️⃣ Explain Bill – Google Vision OCR + GPT Explanation + Excel Support
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

        const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
        if (arrayBuffer.byteLength > MAX_FILE_SIZE) {
          throw new Error("File too large (max 20MB)");
        }

        let pages = [];

        if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
          // Excel support (unchanged)
          pages = await processExcel(arrayBuffer);
        } else {
          // Image or PDF — use Google Vision OCR
          const bytes = new Uint8Array(arrayBuffer);
          const base64 = btoa(String.fromCharCode(...bytes));

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
          if (!visionRes.ok) {
            throw new Error(`Google Vision error: ${JSON.stringify(visionData)}`);
          }

          const fullText = visionData.responses[0]?.fullTextAnnotation?.text || "[No text extracted]";

          // Split by form feed for multi-page (Vision separates pages with \f)
          const pageTexts = fullText.split(/\f/).map(t => t.trim()).filter(t => t);
          if (pageTexts.length === 0) pageTexts.push(fullText.trim());

          pages = pageTexts.map((text, i) => ({
            page: i + 1,
            rawText: text || "[No text extracted]",
          }));
        }

        // -------------------
        // Generate per-page explanation using OpenAI
        // -------------------
        for (let p of pages) {
          const prompt = `You are an expert medical billing assistant.
Explain the following page/section of a medical/dental bill. Include tables, CPT/ICD codes, charges, insurance adjustments, patient responsibility, totals, and simple explanations.

Content:
${p.rawText}

${!isPaid ? "\n\nIMPORTANT: Provide ONLY a short teaser summary (under 150 words) and end with: 'Upgrade to get the full detailed explanation.'" : ""}`;

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

        // -------------------
        // Combine full document explanation
        // -------------------
        const fullExplanation = pages.map(p => `Section ${p.page}:\n${p.explanation}`).join("\n\n");

        return new Response(JSON.stringify({
          isPaid,
          pages,
          fullExplanation
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

// Modular: Process Excel (preserved)
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
