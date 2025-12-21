// worker/src/index.js

import Stripe from 'stripe';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Initialize Stripe with secret from env (set in dashboard)
    const stripe = new Stripe(env.STRIPE_SECRET_KEY);

    // Create Checkout Session for payment
    if (url.pathname === "/create-checkout-session" && request.method === "POST") {
      try {
        const { plan } = await request.json();

        // Replace these with your actual Stripe Price IDs
        const priceId = plan === "monthly"
          ? "price_1YourMonthlyPriceIDHere"
          : "price_1YourOneTimePriceIDHere";

        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          line_items: [{ price: priceId, quantity: 1 }],
          mode: plan === "monthly" ? "subscription" : "payment",
          success_url: `https://explainmybill.pages.dev/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `https://explainmybill.pages.dev/cancel`,
        });

        return new Response(JSON.stringify({ id: session.id }), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: corsHeaders,
        });
      }
    }

    // Optional webhook endpoint (for production use later)
    if (url.pathname === "/webhook" && request.method === "POST") {
      return new Response("Webhook received", { status: 200 });
    }

    // Main endpoint: Explain the bill
    if (request.method === "POST") {
      try {
        const formData = await request.formData();
        const billFile = formData.get("bill");
        const sessionId = formData.get("sessionId") || new URLSearchParams(url.search).get("session_id");

        let billText = formData.get("text") || "";

        // OCR: Extract text from uploaded image/PDF using Workers AI Vision model
        if (billFile && billFile.size > 0) {
          const imageBytes = new Uint8Array(await billFile.arrayBuffer());
          const ocrRes = await env.AI.run("@cf/meta/llama-3.2-vision-instruct", {
            image: [...imageBytes],
            prompt: "Extract all visible text from this medical or dental bill exactly as shown. Include procedure codes, dates, amounts, descriptions, insurance adjustments, and patient responsibility.",
            max_tokens: 1024,
          });
          billText = ocrRes.response?.trim() || billText;
        }

        // Simple paywall logic (upgrade later with KV for real persistence)
        const isPaid = !!sessionId;

        const prompt = `You are an expert medical billing assistant helping patients understand their bills.

Explain this bill in simple, easy-to-understand language.

Break it down clearly:
• Total amount owed by patient
• Key charges and what each service means
• Insurance coverage and adjustments
• Patient responsibility
• Explanation of important codes (CPT, ICD-10, etc.)
• Any red flags or recommended next steps

Bill content:
${billText}

${!isPaid ? "\n\nIMPORTANT: Give ONLY a short teaser summary (under 150 words) and end with: 'Full detailed explanation requires payment.'" : ""}`;

        // Call OpenAI using secret from env
        const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: "gpt-4o",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.5,
            max_tokens: 1500,
          }),
        });

        const aiData = await aiRes.json();
        const explanation = aiData.choices?.[0]?.message?.content?.trim() || "Sorry, I couldn't generate an explanation at this time.";

        return new Response(
          JSON.stringify({ explanation, isPaid }),
          {
            headers: { "Content-Type": "application/json", ...corsHeaders },
          }
        );
      } catch (err) {
        return new Response(
          JSON.stringify({ error: "Something went wrong: " + err.message }),
          { status: 500, headers: corsHeaders }
        );
      }
    }

    // Default response
    return new Response("ExplainMyBill API – POST a bill to explain it", {
      status: 200,
      headers: corsHeaders,
    });
  },
};
