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
    // 1️⃣ Stripe Checkout (UNCHANGED)
    // -------------------
    if (url.pathname === "/create-checkout-session" && request.method === "POST") {
      try {
        const { plan } = await request.json();
        if (!["monthly", "one-time"].includes(plan)) throw new Error("Invalid plan");

        const priceId =
          plan === "monthly" ? "price_123monthly" : "price_123one";

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
            success_url:
              "https://explain-my-bill-frontend.onrender.com/success?session_id={CHECKOUT_SESSION_ID}",
            cancel_url:
              "https://explain-my-bill-frontend.onrender.com/cancel",
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
    // 2️⃣ Bill Processing (FULL FIX)
    // -------------------
    if (request.method === "POST") {
      try {
        const formData = await request.formData();
        const billFile = formData.get("bill");
        const sessionId =
          formData.get("sessionId") || url.searchParams.get("session_id");

        if (!billFile || billFile.size === 0) {
          throw new Error("No bill uploaded");
        }

        const isPaid = Boolean(sessionId);
        const buffer = await billFile.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        const fileName = billFile.name.toLowerCase();

        let pages = [];

        // ✅ SAFE base64 encoding (kept)
        const base64 = btoa(
          Array.from(bytes, (b) => String.fromCharCode(b)).join("")
        );

        // -------------------
        // Excel handling (UNCHANGED)
        // -------------------
        if (fileName.endsWith(".xlsx") || fileName.endsWith(".xls")) {
          pages = await processExcel(buffer);
        }

        // -------------------
        // PDF handling (FIXED – no async Vision jobs)
        // -------------------
        else if (fileName.endsWith(".pdf")) {
          const key = env.GOOGLE_VISION_API_KEY;
          if (!key) throw new Error("Google Vision key missing");

          const res = await fetch(
            `https://vision.googleapis.com/v1/images:annotate?key=${key}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                requests: [
                  {
                    image: { content: base64 },
                    features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
                  },
                ],
              }),
            }
          );

          const data = await res.json();
          const text =
            data.responses?.[0]?.fullTextAnnotation?.text || "";

          if (!text.trim()) {
            throw new Error("OCR produced no readable text");
          }

          pages = [{ page: 1, rawText: text }];
        }

        // -------------------
        // Image handling (UNCHANGED)
        // -------------------
        else {
          const key = env.GOOGLE_VISION_API_KEY;
          if (!key) throw new Error("Google Vision key missing");

          const res = await fetch(
            `https://vision.googleapis.com/v1/images:annotate?key=${key}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                requests: [
                  {
                    image: { content: base64 },
                    features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
                  },
                ],
              }),
            }
          );

          const data = await res.json();
          const text =
            data.responses?.[0]?.fullTextAnnotation?.text || "";

          if (!text.trim()) {
            throw new Error("OCR produced no readable text");
          }

          pages = [{ page: 1, rawText: text }];
        }

        if (pages.length === 0) {
          throw new Error("We could not read your bill clearly");
        }

        // -------------------
        // AI Explanation (UNCHANGED)
        // -------------------
        for (const p of pages) {
          const prompt = `Explain this medical bill in simple English.

${p.rawText}

${
  isPaid
    ? "Include red flags, codes, charges, and next steps."
    : "Give a short teaser under 150 words. End with 'Upgrade for full details.'"
}`;

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
          p.explanation =
            data.choices?.[0]?.message?.content?.trim() ||
            "No explanation generated.";
        }

        const fullExplanation = pages
          .map((p) => `Page ${p.page}:\n${p.explanation}`)
          .join("\n\n");

        // ✅ ADD explanation field (frontend fix)
        return new Response(
          JSON.stringify({
            isPaid,
            pages,
            fullExplanation,
            explanation: fullExplanation,
          }),
          {
            headers: { "Content-Type": "application/json", ...corsHeaders },
          }
        );
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
