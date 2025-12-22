// worker/src/index.js
// ExplainMyBill Worker – Full Feature + Multi-Page + Table-Aware + Live Preview + JSON Output
// OCR via Tesseract.js (robust for scanned PDFs) + GPT explanation via OpenAI
// Handles large PDFs with limits and error handling

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
    // 2️⃣ Explain Bill – Tesseract.js OCR + GPT Explanation
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

        // -------------------
        // File size and type validation (large PDF handling)
        // -------------------
        const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB limit
        const MAX_PAGES = 20; // Prevent abuse

        if (arrayBuffer.byteLength > MAX_FILE_SIZE) {
          throw new Error("File too large. Maximum 20MB allowed.");
        }

        // -------------------
        // Load Tesseract.js from CDN
        // -------------------
        const { createWorker } = Tesseract;

        const worker = await createWorker('eng', 1, {
          logger: m => console.log(m), // Optional logging
          workerPath: 'https://unpkg.com/tesseract.js@5.1.0/dist/worker.min.js',
          corePath: 'https://unpkg.com/tesseract.js-core@5.1.0/tesseract-core.wasm.js',
          langPath: 'https://tesseract.projectnaptha.com/lang-data/5.0.0_best',
        });

        let pages = [];
        let pageIndex = 1;

        // -------------------
        // Process as image or multi-page PDF
        // -------------------
        if (billFile.type === "application/pdf") {
          // Use pdf.js to extract pages as images
          const pdfjsLib = await import("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs");
          pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs";

          const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
          const numPages = Math.min(pdf.numPages, MAX_PAGES);

          if (pdf.numPages > MAX_PAGES) {
            await worker.terminate();
            throw new Error(`PDF too long. Maximum ${MAX_PAGES} pages allowed.`);
          }

          for (let i = 1; i <= numPages; i++) {
            const page = await pdf.getPage(i);
            const viewport = page.getViewport({ scale: 2.0 });

            const canvas = new OffscreenCanvas(viewport.width, viewport.height);
            await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;

            const blob = await canvas.convertToBlob({ type: "image/png" });
            const imageBuffer = await blob.arrayBuffer();

            const result = await worker.recognize(imageBuffer);
            const pageText = result.data.text.trim();

            pages.push({ page: pageIndex, rawText: pageText || "[No text extracted]" });
            pageIndex++;
          }
        } else {
          // Single image file
          const result = await worker.recognize(arrayBuffer);
          const pageText = result.data.text.trim();

          pages.push({ page: 1, rawText: pageText || "[No text extracted]" });
        }

        await worker.terminate();

        // -------------------
        // Generate per-page explanation using OpenAI
        // -------------------
        for (let p of pages) {
          const prompt = `You are an expert medical billing assistant.
Explain the following page of a medical/dental bill. Include tables, CPT/ICD codes, charges, insurance adjustments, patient responsibility, totals, and simple explanations.

Page ${p.page} content:
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
        const fullExplanation = pages.map(p => `Page ${p.page}:\n${p.explanation}`).join("\n\n");

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
