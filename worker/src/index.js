// worker/src/index.js - No npm dependencies needed!

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ✅ CORS headers locked to your Render frontend
    const corsHeaders = {
      "Access-Control-Allow-Origin": "https://explain-my-bill-frontend.onrender.com",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    // Handle preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Create Checkout Session using Stripe
    if (url.pathname === "/create-checkout-session" && request.method === "POST") {
      try {
        const { plan } = await request.json();
        if (!["monthly", "one-time"].includes(plan)) {
          return new Response(JSON.stringify({ error: "Invalid plan" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }

        const priceId = plan === "monthly"
          ? "price_YourMonthlyPriceID"  // Replace with real
          : "price_YourOneTimePriceID"; // Replace with real

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

        const session = await stripeRes.json();
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

    // Main: Explain Bill (OCR + AI)
    if (request.method === "POST") {
      try {
        const formData = await request.formData();
        const billFile = formData.get("bill");
        const sessionId = formData.get("sessionId") || url.searchParams.get("session_id");

        if (!billFile || billFile.size === 0) {
          return new Response(JSON.stringify({ error: "No bill file uploaded" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }

        const imageBytes = new Uint8Array(await billFile.arrayBuffer());

        const ocrRes = await env.AI.run("@cf/meta/llama-3.2-3b-instruct", {
          image: [...imageBytes],
          prompt: "Extract all visible text from this medical or dental bill exactly as shown. Include dates, procedure codes (CPT), diagnosis codes (ICD-10), descriptions, charges, insurance adjustments, patient responsibility, and totals. Preserve formatting and tables.",
          max_tokens: 1024,
        });

        const billText = ocrRes.response?.trim() || "";
        if (!billText) throw new Error("Could not extract text from the bill. Try a clearer image or PDF.");

        const isPaid = !!sessionId;

        const prompt = `You are an expert medical billing assistant.
Explain this bill in simple, easy-to-understand language.
Break down:
• Total amount owed by the patient
• Key services/procedures and what they mean
• Insurance coverage and adjustments
• Patient responsibility
• Explanation of codes (CPT, ICD-10, etc.)
• Any red flags or recommended next steps
Bill content:
${billText}
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
            max_tokens: isPaid ? 1500 : 300,
          }),
        });

        if (!aiRes.ok) {
          const errText = await aiRes.text();
          throw new Error(`OpenAI error: ${aiRes.status} – ${errText}`);
        }

        const aiData = await aiRes.json();
        const explanation = aiData.choices?.[0]?.message?.content?.trim() || "No explanation generated.";

        return new Response(JSON.stringify({ explanation, isPaid }), {
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
