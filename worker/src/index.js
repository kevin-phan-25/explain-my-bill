import Stripe from "stripe";

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

    const stripe = new Stripe(env.STRIPE_SECRET_KEY ?? "");

    if (url.pathname === "/create-checkout-session" && request.method === "POST") {
      try {
        const { plan } = await request.json();
        if (!["monthly", "one-time"].includes(plan)) {
          return new Response(JSON.stringify({ error: "Invalid plan" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

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
        console.error("Stripe error:", err);
        return new Response(JSON.stringify({ error: err.message || "Payment setup failed" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Main bill explanation endpoint
    if (request.method === "POST") {
      try {
        const formData = await request.formData();
        const billFile = formData.get("bill");
        const sessionId = formData.get("sessionId") || url.searchParams.get("session_id");

        let billText = "";

        if (billFile && billFile.size > 0) {
          const imageBytes = new Uint8Array(await billFile.arrayBuffer());
          const ocrRes = await env.AI.run("@cf/meta/llama-3.2-vision-instruct", {
            image: [...imageBytes],
            prompt: "Extract all visible text from this medical or dental bill exactly as shown. Include procedure codes, dates, amounts, descriptions, insurance adjustments, and patient responsibility. Preserve tables and formatting.",
            max_tokens: 1024,
          });
          billText = ocrRes.response?.trim() || "";
        }

        if (!billText) {
          throw new Error("No text extracted from bill – please upload a clear image or PDF.");
        }

        const isPaid = !!sessionId;
        const prompt = `You are an expert medical billing assistant.

Explain this bill in simple language.

Break down:
• Total patient owes
• Key services and meanings
• Insurance adjustments
• Patient responsibility
• Code explanations (CPT, ICD-10, etc.)
• Red flags or next steps

Bill text:
${billText}

${!isPaid ? "\n\nGive ONLY a short teaser (under 150 words) and end with: 'Upgrade for full detailed explanation.'" : ""}`;

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
            max_tokens: isPaid ? 1500 : 300,
          }),
        });

        if (!aiRes.ok) {
          const errText = await aiRes.text();
          throw new Error(`OpenAI API error: ${aiRes.status} – ${errText}`);
        }

        const aiData = await aiRes.json();
        const explanation = aiData.choices?.[0]?.message?.content?.trim() || "No explanation generated.";

        return new Response(JSON.stringify({ explanation, isPaid }), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      } catch (err) {
        console.error("Explanation error:", err);
        return new Response(JSON.stringify({ error: err.message || "Processing failed" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    return new Response("ExplainMyBill Worker – POST multipart/form-data with 'bill' file", {
      headers: corsHeaders,
    });
  },
};
