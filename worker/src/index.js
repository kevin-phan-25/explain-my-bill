import Stripe from 'stripe';

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

    const stripe = new Stripe(env.STRIPE_SECRET_KEY ?? '');

    // Create Checkout Session
    if (url.pathname === "/create-checkout-session" && request.method === "POST") {
      try {
        const { plan } = await request.json();

        const priceId = plan === "monthly"
          ? "price_REPLACE_WITH_YOUR_MONTHLY_PRICE_ID"
          : "price_REPLACE_WITH_YOUR_ONE_TIME_PRICE_ID";

        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          line_items: [{ price: priceId, quantity: 1 }],
          mode: plan === "monthly" ? "subscription" : "payment",
          success_url: "https://explainmybill.pages.dev/success?session_id={CHECKOUT_SESSION_ID}",
          cancel_url: "https://explainmybill.pages.dev/cancel",
        });

        return new Response(JSON.stringify({ id: session.id }), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Main bill explanation
    if (request.method === "POST") {
      try {
        const formData = await request.formData();
        const billFile = formData.get("bill");
        const sessionId = formData.get("sessionId") || url.searchParams.get("session_id");

        if (!billFile || billFile.size === 0) {
          return new Response(JSON.stringify({ error: "No bill file uploaded" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const imageBytes = new Uint8Array(await billFile.arrayBuffer());

        // Improved OCR prompt for medical bills
        const ocrRes = await env.AI.run("@cf/meta/llama-3.2-3b-instruct", {
          image: [...imageBytes],
          prompt: "Extract ALL text from this medical/dental/utility bill exactly as shown. Include dates, procedure codes (CPT), diagnosis codes (ICD-10), charges, insurance adjustments, patient responsibility, and totals. Preserve table structure.",
          max_tokens: 1024,
        });

        const billText = ocrRes.response?.trim() || "";

        if (!billText) {
          throw new Error("Failed to extract text from bill");
        }

        const isPaid = !!sessionId;  // TODO: Verify with KV + webhook later

        const prompt = `You are an expert billing assistant.

Explain this bill in simple terms:
- Total patient owes
- Key charges and meanings
- Insurance coverage/adjustments
- Patient responsibility
- Code explanations
- Red flags/next steps

Bill text:
${billText}

${!isPaid ? "\n\nGive ONLY a short teaser (<150 words) ending with: 'Upgrade for full explanation.'" : ""}`;

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

        if (!aiRes.ok) throw new Error(`OpenAI error: ${await aiRes.text()}`);

        const data = await aiRes.json();
        const explanation = data.choices?.[0]?.message?.content?.trim() || "No explanation.";

        return new Response(JSON.stringify({ explanation, isPaid }), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    return new Response("ExplainMyBill Worker – POST bill file for explanation", { headers: corsHeaders });
  },
};
