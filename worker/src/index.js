// worker/src/index.js - Google Vision OCR + OpenAI + Stripe

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

    // Stripe Checkout
    if (url.pathname === "/create-checkout-session" && request.method === "POST") {
      // ... your existing Stripe code (unchanged)
    }

    // Bill Processing
    if (request.method === "POST") {
      try {
        const formData = await request.formData();
        const billFile = formData.get("bill");
        const sessionId = formData.get("sessionId") || url.searchParams.get("session_id");

        if (!billFile || billFile.size === 0) {
          throw new Error("No bill file uploaded");
        }

        const isPaid = Boolean(sessionId);

        const buffer = await billFile.arrayBuffer();
        const bytes = new Uint8Array(buffer);

        // Safety: Google Vision has ~10MB limit
        if (bytes.length > 9 * 1024 * 1024) {
          throw new Error("File too large. Please upload under 9MB.");
        }

        const base64 = btoa(String.fromCharCode(...bytes));

        const googleKey = env.GOOGLE_VISION_API_KEY;
        if (!googleKey) {
          throw new Error("OCR service not configured");
        }

        const visionRes = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${googleKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requests: [{
              image: { content: base64 },
              features: [{ type: "DOCUMENT_TEXT_DETECTION", maxResults: 1 }],
            }],
          }),
        });

        const visionData = await visionRes.json();

        if (!visionRes.ok || visionData.error) {
          console.error("Google Vision error:", visionData.error);
          throw new Error("Could not read bill text. Try a clearer image or PDF.");
        }

        const fullText = visionData.responses[0]?.fullTextAnnotation?.text || "";
        if (!fullText.trim()) {
          throw new Error("No readable text found in bill. Try a higher quality image.");
        }

        // Split into pages if form feeds detected
        const pageTexts = fullText.split('\f').map(t => t.trim()).filter(t => t);
        const pages = pageTexts.length > 0 
          ? pageTexts.map((t, i) => ({ page: i + 1, text: t }))
          : [{ page: 1, text: fullText }];

        // Generate explanation with OpenAI
        const prompt = `You are a medical billing expert. Explain this bill in simple, clear English.

Bill text:
${fullText}

${isPaid 
  ? "Provide a complete breakdown: charges, codes, insurance adjustments, patient responsibility, red flags, and next steps." 
  : "Give a short teaser summary (under 150 words). End with: 'Upgrade for full details, red flags, and appeal help.'"
}`;

        const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.3,
            max_tokens: isPaid ? 1200 : 250,
          }),
        });

        const openaiData = await openaiRes.json();
        const explanation = openaiData.choices?.[0]?.message?.content?.trim() || "No explanation generated.";

        // Optional: Add paid features (red flags, savings, etc.)
        const paidFeatures = isPaid ? {
          redFlags: fullText.includes("DENIED") ? ["Claim denied – appeal possible"] : [],
          estimatedSavings: { potentialSavings: "$100–$800", reason: "Common billing errors" },
          appealLetter: "Dear Insurance Provider,\n\nI am writing to appeal...\n\nThank you.",
          customAdvice: "Get an itemized bill. Check fairhealthconsumer.org for average costs.",
        } : {};

        return new Response(JSON.stringify({
          explanation,
          isPaid,
          paidFeatures,
          pages: pages.map(p => ({ page: p.page, text: p.text.substring(0, 500) + "..." })),
        }), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });

      } catch (err) {
        console.error("Worker error:", err);
        return new Response(JSON.stringify({ 
          error: err.message || "Failed to process bill. Please try a clearer image or PDF."
        }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }

    return new Response("ExplainMyBill Worker – Ready", { headers: corsHeaders });
  },
};
