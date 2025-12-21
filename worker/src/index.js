import Stripe from 'stripe';

const stripe = new Stripe(STRIPE_SECRET_KEY); // From Worker secrets

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

    // Create Checkout Session
    if (url.pathname === "/create-checkout-session" && request.method === "POST") {
      try {
        const { plan } = await request.json();
        const priceId = plan === "monthly" 
          ? "price_YourMonthlyPriceIdHere" 
          : "price_YourOneTimePriceIdHere";

        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          line_items: [{ price: priceId, quantity: 1 }],
          mode: plan === "monthly" ? "subscription" : "payment",
          success_url: `${url.origin}/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${url.origin}/cancel`,
        });

        return new Response(JSON.stringify({ id: session.id }), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // Webhook (optional but recommended for production)
    if (url.pathname === "/webhook" && request.method === "POST") {
      // Add your STRIPE_WEBHOOK_SECRET and handle checkout.session.completed
      return new Response("OK");
    }

    // Main API: Explain bill
    if (request.method === "POST") {
      try {
        const formData = await request.formData();
        const billFile = formData.get("bill");
        const sessionId = formData.get("sessionId") || new URLSearchParams(url.search).get("session_id");

        let billText = formData.get("text") || "";

        if (billFile && billFile.size > 0) {
          const ocrRes = await env.AI.run("@cf/meta/llama-3.2-vision-instruct", {
            image: [...new Uint8Array(await billFile.arrayBuffer())],
            prompt: "Extract all text from this medical/dental bill exactly as shown, including codes, dates, amounts, and descriptions.",
            max_tokens: 1024,
          });
          billText = ocrRes.response || billText;
        }

        // Simple paywall (in prod: check KV or database)
        const isPaid = !!sessionId; // For demo: any successful redirect = paid

        const prompt = `You are an expert medical billing assistant. Explain this bill clearly and simply.

Break down:
- Total owed
- Key charges and what they mean
- Insurance coverage/adjustments
- Patient responsibility
- Important codes/terms
- Any red flags or next steps

Bill text:
${billText}

${!isPaid ? "Give only a short teaser (under 150 words) and say full explanation requires payment." : ""}`;

        const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: "gpt-4o",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.5,
          }),
        });

        const aiData = await aiRes.json();
        const explanation = aiData.choices?.[0]?.message?.content || "Error generating explanation.";

        return new Response(JSON.stringify({ explanation, isPaid }), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    return new Response("ExplainMyBill API", { status: 200 });
  },
};
