export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Dev-Bypass",
    };

    if (request.method === "OPTIONS") {
      const h = request.headers.get("Access-Control-Request-Headers");
      if (h) corsHeaders["Access-Control-Allow-Headers"] = h;
      return new Response(null, { headers: corsHeaders });
    }

    // ---------- Stripe Checkout ----------
    if (url.pathname === "/create-checkout-session" && request.method === "POST") {
      try {
        const { plan } = await request.json().catch(() => ({}));
        if (!["monthly", "one-time", "lifetime"].includes(plan))
          return new Response(JSON.stringify({ error: "Invalid plan" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });

        let priceId =
          plan === "monthly" ? env.STRIPE_PRICE_MONTHLY :
          plan === "lifetime" ? env.STRIPE_PRICE_LIFETIME :
          env.STRIPE_PRICE_ONE_TIME;

        if (!priceId) return new Response(JSON.stringify({ error: "Payment config error" }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } });

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
            success_url: "https://explain-my-bill-frontend.onrender.com/success?session_id={CHECKOUT_SESSION_ID}",
            cancel_url: "https://explain-my-bill-frontend.onrender.com/cancel",
          }),
        });
        const data = await res.json();
        if (!res.ok) return new Response(JSON.stringify({ error: "Stripe setup failed" }), { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } });

        return new Response(JSON.stringify({ id: data.id }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
      } catch (err) {
        console.error("Stripe handler error:", err);
        return new Response(JSON.stringify({ error: "Payment error" }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } });
      }
    }

    // ---------- Bill Processing ----------
    if (request.method === "POST") {
      try {
        const form = await request.formData();
        const file = form.get("bill") || form.get("file");
        const sessionId = form.get("sessionId");
        let isPaid = false;

        if (!file || file.size === 0)
          return new Response(JSON.stringify({ error: "No file uploaded", pages: [{ rawText: "Please select a bill.", structured: { explanation: "No file received." } }] }), { status: 400, headers: corsHeaders });

        if (file.size > 20 * 1024 * 1024)
          return new Response(JSON.stringify({ error: "File too large", pages: [{ rawText: "File exceeds 20MB.", structured: { explanation: "File size limit exceeded." } }] }), { status: 413, headers: corsHeaders });

        const name = file.name.toLowerCase();
        const allowed = [".pdf", ".png", ".jpg", ".jpeg", ".xlsx", ".xls"];
        if (!allowed.some((e) => name.endsWith(e)))
          return new Response(JSON.stringify({ error: "Unsupported format", pages: [{ rawText: "Supported: PDF, PNG, JPG, Excel.", structured: { explanation: "Invalid file type." } }] }), { status: 415, headers: corsHeaders });

        // Check payment status
        if (sessionId) {
          try {
            const r = await fetchWithTimeout(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } });
            const d = await r.json();
            if (r.ok && ["paid", "complete"].includes(d.payment_status || d.status)) isPaid = true;
          } catch {}
        }

        const buf = await file.arrayBuffer();
        const u8 = new Uint8Array(buf);
        let text = "";

        // ---------- OCR ----------
        try {
          if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
            const pages = await processExcel(buf);
            text = pages.map((p) => p.rawText).join("\n\n");
          } else if (env.GOOGLE_VISION_API_KEY) {
            text = await extractWithGoogleVision(u8, file.type, env);
          }
          // Fallback OCR.space
          if (!text || text.length < 50) text = await extractWithOcrSpace(u8, file.type, env);
        } catch (err) {
          console.error("OCR failed:", err);
          text = "We couldn't read your bill. Please upload a clear, high-res image.";
        }

        // ---------- Key Amount Extraction ----------
        const getAmount = (patterns) => {
          for (const p of patterns) {
            const m = text.match(p);
            if (m) {
              let num = m[1].replace(/[^\d.,]/g, "").trim();
              num = num.replace(/[OolIS]/g, c => ({O:"0",o:"0",l:"1",I:"1",S:"5"}[c] || c));
              return num ? "$" + num : null;
            }
          }
          return null;
        };

        const totalCharges = getAmount([/total\s*(?:charges?|amount|due|balance|cost|fees?|bill|statement)[\s:]*\$?([\d.,]+)/i]);
        const insurancePaid = getAmount([/insurance\s*(?:paid|adjustment|allowed|credit|reimbursement)[\s:]*\$?([\d.,]+)/i]);
        const patientDue = getAmount([/patient\s*(?:responsibility|due|balance|owe|amount\s*due)[\s:]*\$?([\d.,]+)/i]);

        // ---------- Dual AI ----------
        let aiResult = null;
        try {
          const openModel = isPaid ? "gpt-4o" : "gpt-4o-mini";
          const gemModel = isPaid ? "gemini-1.5-pro" : "gemini-1.5-flash";
          const prompt = `Analyze this bill text and return JSON with keyAmounts, summary, summaryPoints, services, redFlags, potentialSavings, explanation, nextSteps. Text: """${text}"""`;

          const [openaiRes, geminiRes] = await Promise.allSettled([
            fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
              method: "POST",
              headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
              body: JSON.stringify({ model: openModel, messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: isPaid ? 1200 : 300 }),
            }),
            fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${gemModel}:generateContent?key=${env.GEMINI_API_KEY}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0, maxOutputTokens: isPaid ? 1200 : 300 } }),
            }),
          ]);

          const results = [];
          if (openaiRes.status === "fulfilled") {
            const p = parseResponse(await openaiRes.value.json());
            if (p) results.push({ source: "openai", confidence: p.confidence || 0.8, data: p });
          }
          if (geminiRes.status === "fulfilled") {
            const p = parseResponse(await geminiRes.value.json());
            if (p) results.push({ source: "gemini", confidence: p.confidence || 0.7, data: p });
          }
          if (results.length > 0) results.sort((a, b) => b.confidence - a.confidence), aiResult = results[0].data;
        } catch (err) {
          console.error("AI failed:", err);
        }

        // ---------- Final Result ----------
        const finalResult = {
          summary: aiResult?.summary || "Your bill was analyzed.",
          summaryPoints: aiResult?.summaryPoints || [],
          keyAmounts: {
            totalCharges: aiResult?.keyAmounts?.totalCharges || totalCharges || "Not detected",
            insurancePaid: aiResult?.keyAmounts?.insurancePaid || insurancePaid || "Not detected",
            patientResponsibility: aiResult?.keyAmounts?.patientResponsibility || patientDue || "Not detected",
          },
          services: aiResult?.services || [],
          redFlags: aiResult?.redFlags || [],
          potentialSavings: isPaid ? aiResult?.potentialSavings || null : null,
          explanation: aiResult?.explanation || "We couldn't extract a detailed explanation.",
          nextSteps: aiResult?.nextSteps || ["Double-check amounts", "Contact provider", "Compare at FairHealthConsumer.org"],
        };

        return new Response(JSON.stringify({
          isPaid,
          pages: [{ page: 1, rawText: text, structured: finalResult, explanation: finalResult.explanation }],
          explanation: finalResult.explanation,
        }), { headers: { "Content-Type": "application/json", ...corsHeaders } });

      } catch (err) {
        console.error("Critical Worker error:", err);
        return new Response(JSON.stringify({ error: "Processing failed", pages: [{ rawText: "Cannot analyze your bill.", structured: { explanation: "Try again with a clear image." } }] }), { status: 500, headers: corsHeaders });
      }
    }

    // ---------- Root Info ----------
    return new Response(`<html><body><h1>ExplainMyBill Worker Active</h1></body></html>`, { headers: { "Content-Type": "text/html", ...corsHeaders } });
  },
};

// ---------- Helper Functions ----------
async function fetchWithTimeout(url, opts = {}, timeout = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try { return await fetch(url, { ...opts, signal: controller.signal }); }
  finally { clearTimeout(id); }
}

function uint8ArrayToBase64(uint8) {
  let binary = '';
  for (let i = 0; i < uint8.length; i += 0x8000) binary += String.fromCharCode(...uint8.subarray(i, i + 0x8000));
  return btoa(binary);
}

async function extractWithGoogleVision(uint8, mimeType, env) {
  const base64 = uint8ArrayToBase64(uint8);
  const res = await fetchWithTimeout(`https://vision.googleapis.com/v1/images:annotate?key=${env.GOOGLE_VISION_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requests: [{ image: { content: base64 }, features: [{ type: "DOCUMENT_TEXT_DETECTION" }] }] }),
  });
  const data = await res.json();
  return data.responses?.[0]?.fullTextAnnotation?.text?.trim() || "";
}

async function extractWithOcrSpace(uint8, mimeType, env) {
  const base64 = uint8ArrayToBase64(uint8);
  const res = await fetch("https://api.ocr.space/parse/image", {
    method: "POST",
    headers: { apikey: env.OCR_SPACE_API_KEY, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ base64Image: `data:${mimeType};base64,${base64}`, language: "eng", scale: "true", isTable: "true", OCREngine: "2" }),
  });
  const json = await res.json();
  return json.ParsedResults?.[0]?.ParsedText?.trim() || "";
}

function parseResponse(data) {
  try {
    let content = data.choices?.[0]?.message?.content || data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    content = content.replace(/^```json\n?/i, "").replace(/\n?```$/i, "").trim();
    return JSON.parse(content);
  } catch { return null; }
}

async function processExcel(buffer) {
  try {
    const XLSX = await import("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm");
    const wb = XLSX.read(new Uint8Array(buffer), { type: "array" });
    return wb.SheetNames.map((name, i) => ({ page: i + 1, rawText: XLSX.utils.sheet_to_csv(wb.Sheets[name]) || "" }));
  } catch { return [{ page: 1, rawText: "Could not read Excel file." }]; }
}
