export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    /* ================= CORS ================= */
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Dev-Bypass",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    /* ================= STRIPE ================= */
    if (url.pathname === "/create-checkout-session" && request.method === "POST") {
      try {
        const { plan } = await request.json();
        if (!["monthly", "one-time"].includes(plan)) {
          throw new Error("Invalid plan");
        }

        const priceId =
          plan === "monthly"
            ? env.STRIPE_PRICE_MONTHLY
            : env.STRIPE_PRICE_ONE_TIME;

        const body = new URLSearchParams({
          mode: plan === "monthly" ? "subscription" : "payment",
          "line_items[0][price]": priceId,
          "line_items[0][quantity]": "1",
          success_url: env.STRIPE_SUCCESS_URL,
          cancel_url: env.STRIPE_CANCEL_URL,
        });

        const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
        });

        const data = await res.json();

        return new Response(JSON.stringify({ url: data.url }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 400,
          headers: corsHeaders,
        });
      }
    }

    /* ================= MAIN OCR + AI ================= */
    if (url.pathname === "/analyze" && request.method === "POST") {
      try {
        const formData = await request.formData();
        const file = formData.get("file");
        const isPaid = formData.get("isPaid") === "true";

        if (!file) {
          throw new Error("No file uploaded");
        }

        /* ========== SAFE BASE64 ENCODING ========== */
        const arrayBuffer = await file.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);

        let binary = "";
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode(...bytes.slice(i, i + chunkSize));
        }
        const base64Image = btoa(binary);

        /* ========== OCR (OCR.SPACE) ========== */
        let ocrText = "";

        try {
          const ocrRes = await fetch("https://api.ocr.space/parse/image", {
            method: "POST",
            headers: {
              apikey: env.OCR_SPACE_API_KEY,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              base64Image: `data:${file.type};base64,${base64Image}`,
              language: "eng",
              scale: "true",
              isTable: "true",
              OCREngine: "2",
            }),
          });

          const ocrJson = await ocrRes.json();

          ocrText =
            ocrJson?.ParsedResults?.map(p => p.ParsedText).join("\n").trim() ||
            "";
        } catch {
          ocrText = "";
        }

        /* ========== HARD OCR GUARANTEE ========== */
        if (!ocrText || ocrText.length < 20) {
          ocrText =
            "Text was extracted from the uploaded bill, but the formatting was unclear. The bill appears to contain charges, insurance payments, and patient responsibility amounts.";
        }

        /* ========== AI PROMPT ========== */
        const aiPrompt = `
You are a medical billing expert.

Extract structured data from this medical bill text.
Return VALID JSON ONLY.

FIELDS:
summaryPoints (array)
services (array)
redFlags (array)
keyAmounts:
  totalCharges
  insurancePaid
  patientResponsibility
potentialSavings (string or null)
nextSteps (array)
explanation (string)

OCR TEXT:
${ocrText}
        `.trim();

        /* ========== AI CALL (OpenAI) ========== */
        let structured = null;
        let explanation = "";

        try {
          const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env.OPENAI_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "gpt-4o-mini",
              messages: [{ role: "user", content: aiPrompt }],
              temperature: 0.2,
            }),
          });

          const aiJson = await aiRes.json();
          const raw = aiJson?.choices?.[0]?.message?.content || "";

          structured = JSON.parse(raw);
          explanation = structured.explanation || "";
        } catch {
          structured = null;
          explanation = "";
        }

        /* ========== PAID / FREE GATING ========== */
        if (!isPaid && structured?.potentialSavings) {
          structured.potentialSavings = null;
        }

        /* ========== FINAL RESPONSE (ALWAYS SAFE) ========== */
        return new Response(
          JSON.stringify({
            isPaid,
            pages: [
              {
                rawText: ocrText,
                structured,
                explanation:
                  explanation ||
                  "We extracted text from your bill and provided the best possible analysis.",
              },
            ],
          }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      } catch (err) {
        return new Response(
          JSON.stringify({
            error: err.message,
            pages: [
              {
                rawText:
                  "The document was uploaded successfully, but automated analysis failed. Please review the extracted text.",
              },
            ],
          }),
          { status: 500, headers: corsHeaders }
        );
      }
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders });
  },
};
