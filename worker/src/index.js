// worker/src/index.js
// ExplainMyBill Worker – Full Feature + Multi-Page + Table-Aware + Live Preview + JSON Output
// OCR via optimized Tesseract.js + Excel support via SheetJS + GPT explanation via OpenAI

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
    // 2️⃣ Explain Bill – Modular Processing (PDF, Image, Excel)
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
        const fileType = billFile.type;
        const fileName = billFile.name.toLowerCase();

        const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
        if (arrayBuffer.byteLength > MAX_FILE_SIZE) {
          throw new Error("File too large (max 20MB)");
        }

        let pages = [];

        // Load Tesseract.js once (optimized)
        const { createWorker } = Tesseract;
        const tesseractWorker = await createWorker({
          workerPath: 'https://unpkg.com/tesseract.js@5.1.0/dist/worker.min.js',
          langPath: 'https://tesseract.projectnaptha.com/lang-data/5.0.0_best',
          corePath: 'https://unpkg.com/tesseract.js-core@5.1.0/tesseract-core.wasm.js',
        });
        await tesseractWorker.load();
        await tesseractWorker.loadLanguage('eng');
        await tesseractWorker.initialize('eng');
        // Optimized settings for bills
        await tesseractWorker.setParameters({
          tessedit_pageseg_mode: '6', // Assume uniform block of text
          preserve_interword_spaces: '1',
        });

        try {
          if (fileType === "application/pdf" || fileName.endsWith('.pdf')) {
            pages = await processPDF(arrayBuffer, tesseractWorker);
          } else if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
            pages = await processExcel(arrayBuffer);
          } else {
            // Single image
            const result = await tesseractWorker.recognize(arrayBuffer);
            pages = [{ page: 1, rawText: result.data.text.trim() || "[No text extracted]" }];
          }
        } finally {
          await tesseractWorker.terminate();
        }

        // -------------------
        // Generate per-page explanation using OpenAI
        // -------------------
        for (let p of pages) {
          const prompt = `You are an expert medical billing assistant.
Explain the following page/section of a medical/dental bill. Include tables, CPT/ICD codes, charges, insurance adjustments, patient responsibility, totals, and simple explanations.

Content:
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
        const fullExplanation = pages.map(p => `Section ${p.page}:\n${p.explanation}`).join("\n\n");

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

// Modular: Process PDF
async function processPDF(arrayBuffer, tesseractWorker) {
  const pdfjsLib = await import("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs");
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs";

  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
  const numPages = Math.min(pdf.numPages, 20); // Limit to 20 pages

  let pages = [];
  for (let i = 1; i <= numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 2.0 });

    const canvas = new OffscreenCanvas(viewport.width, viewport.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;

    const blob = await canvas.convertToBlob({ type: "image/png" });
    const imageBuffer = await blob.arrayBuffer();

    const result = await tesseractWorker.recognize(imageBuffer);
    const pageText = result.data.text.trim();

    pages.push({ page: i, rawText: pageText || "[No text extracted]" });
  }

  return pages;
}

// Modular: Process Excel
async function processExcel(arrayBuffer) {
  const XLSX = await import("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm");
  const workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: "array" });

  let pages = [];
  let pageIndex = 1;

  workbook.SheetNames.forEach(sheetName => {
    const worksheet = workbook.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(worksheet);
    pages.push({ page: pageIndex, rawText: csv || "[Empty sheet]" });
    pageIndex++;
  });

  return pages;
}
