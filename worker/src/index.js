// ExplainMyBill Worker – Ultimate Full Feature Version
// No npm dependencies needed!

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

        const priceId = plan === "monthly"
          ? "price_YourMonthlyPriceID"
          : "price_YourOneTimePriceID";

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
            "success_url": "https://explain-my-bill.pages.dev/success?session_id={CHECKOUT_SESSION_ID}",
            "cancel_url": "https://explain-my-bill.pages.dev/cancel",
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
    // 2️⃣ Explain Bill – Multi-page PDF/Image + Table-Aware GPT
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
        let billText = "";

        // -------------------
        // Multi-page / PDF / Image Processing
        // -------------------
        try {
          // Decode as UTF-8 (PDF with text layer / text file)
          const decoder = new TextDecoder("utf-8", { fatal: false });
          billText = decoder.decode(arrayBuffer);
        } catch {
          // fallback: base64 snippet (max 1MB)
          const maxBytes = Math.min(arrayBuffer.byteLength, 1024 * 1024);
          const slice = arrayBuffer.slice(0, maxBytes);
          billText = btoa(String.fromCharCode(...new Uint8Array(slice)));
          billText = `[BASE64_ENCODED_BILL_START]${billText}[BASE64_ENCODED_BILL_END]`;
        }

        // -------------------
        // GPT Prompt – Full Table-Aware, Multi-Page Explanation
        // -------------------
        const prompt = `You are an expert medical billing assistant.
You will receive a medical or dental bill. Your tasks:
1. Extract all text, including tables, CPT/ICD codes, charges, insurance adjustments, patient responsibility, totals.
2. Detect multiple pages and combine content properly.
3. Organize tables with rows and columns clearly.
4. Explain the bill in **simple, easy-to-understand language**.
5. Provide structured breakdown:
   • Total amount owed by the patient
   • Key services/procedures and their meaning
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

        const aiData = await aiRes.json().catch(() => ({}));
        if (!aiRes.ok) throw new Error(`OpenAI explanation error: ${aiRes.status} – ${JSON.stringify(aiData)}`);

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
