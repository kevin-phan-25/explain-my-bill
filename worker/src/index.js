// ExplainMyBill Worker – FINAL PRODUCTION-READY (Dec 29, 2025)
// Primary: Google Vision OCR • Fallback: OCR.space • Dual AI with confidence merge
// Supports: Medical, Utility, Credit Card bills • In-memory only • Privacy-first
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Dev-Bypass",
    };
    if (request.method === "OPTIONS") {
      const h = request.headers.get("Access-Control-Request-Headers");
      if (h) cors["Access-Control-Allow-Headers"] = h;
      return new Response(null, { headers: cors });
    }
    // STRIPE CHECKOUT
    if (url.pathname === "/create-checkout-session" && request.method === "POST") {
      try {
        const { plan } = await request.json().catch(() => ({}));
        if (!["monthly", "one-time", "lifetime"].includes(plan)) {
          return new Response(JSON.stringify({ error: "Invalid plan selected" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...cors },
          });
        }
        let priceId;
        if (plan === "monthly") priceId = env.STRIPE_PRICE_MONTHLY;
        else if (plan === "lifetime") priceId = env.STRIPE_PRICE_LIFETIME;
        else priceId = env.STRIPE_PRICE_ONE_TIME;
        if (!priceId) {
          return new Response(JSON.stringify({ error: "Payment configuration error — contact support" }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...cors },
          });
        }
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
        if (!res.ok) {
          console.error("Stripe error:", data);
          return new Response(JSON.stringify({ error: "Payment setup failed — please try again later" }), {
            status: 502,
            headers: { "Content-Type": "application/json", ...cors },
          });
        }
        return new Response(JSON.stringify({ id: data.id }), {
          headers: { "Content-Type": "application/json", ...cors },
        });
      } catch (err) {
        console.error("Stripe handler error:", err);
        return new Response(JSON.stringify({ error: "Payment error — please try again" }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...cors },
        });
      }
    }
    // BILL PROCESSING
    if (request.method === "POST") {
      let text = "";
      let isPaid = false;
      try {
        const form = await request.formData();
        const file = form.get("bill") || form.get("file");
        const sessionId = form.get("sessionId");
        if (!file || file.size === 0) {
          return new Response(JSON.stringify({
            error: "No file uploaded",
            pages: [{ rawText: "Please select a bill to analyze.", structured: { explanation: "No file received." } }],
          }), { status: 400, headers: cors });
        }
        if (file.size > 20 * 1024 * 1024) {
          return new Response(JSON.stringify({
            error: "File too large",
            pages: [{ rawText: "File exceeds 20MB. Try a screenshot of the summary page.", structured: { explanation: "File size limit exceeded." } }],
          }), { status: 413, headers: cors });
        }
        const name = file.name.toLowerCase();
        const allowed = [".pdf",".png",".jpg",".jpeg",".xlsx",".xls"];
        if (!allowed.some(e => name.endsWith(e))) {
          return new Response(JSON.stringify({
            error: "Unsupported format",
            pages: [{ rawText: "Supported: PDF, PNG, JPG, Excel.", structured: { explanation: "Invalid file type." } }],
          }), { status: 415, headers: cors });
        }
        // Paid status
        if (sessionId) {
          try {
            const r = await fetchWithTimeout(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
              headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
            });
            const d = await r.json();
            if (r.ok && (d.payment_status === "paid" || d.status === "complete")) isPaid = true;
          } catch {}
        }
        const buf = await file.arrayBuffer();
        const u8 = new Uint8Array(buf);
        // PRIMARY OCR: Google Vision (best accuracy)
        try {
          if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
            const pages = await processExcel(buf);
            text = pages.map(p => p.rawText).join("\n\n");
          } else if (env.GOOGLE_VISION_API_KEY) {
            text = await extractWithGoogleVision(u8, file.type, env);
            console.log("Google Vision extracted:", text.length, "characters");
          }
          // Fallback OCR.space only if Vision failed or returned little text
          if (!text || text.length < 100) {
            console.log("Falling back to OCR.space");
            text = await extractWithOcrSpace(u8, file.type, env);
          }
        } catch (err) {
          console.error("All OCR failed:", err);
          text = "We couldn't read your bill. Try a clear, well-lit photo of the summary page.";
        }
        if (!text || text.length < 50) {
          text = "No readable text found. Use a straight-on photo of the summary page.";
        }
        // ROBUST REGEX – medical, utility, credit card
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
        const totalCharges = getAmount([
          /total\s*(?:charges?|billed|amount|due|balance|cost|fees?|bill|owed|usage|statement)[\s:]*\$?([\d.,]+)/i,
          /amount\s*(?:billed|charged|due|total|owed|payable|current)[\s:]*\$?([\d.,]+)/i,
          /current\s*charges?[\s:]*\$?([\d.,]+)/i,
          /new\s*charges?[\s:]*\$?([\d.,]+)/i,
          /balance\s*due[\s:]*\$?([\d.,]+)/i,
          /total\s*due[\s:]*\$?([\d.,]+)/i,
        ]);
        const insurancePaid = getAmount([
          /insurance\s*(?:paid|payment|adjustment|allowed|credit|reimbursement|benefit)[\s:]*\$?([\d.,]+)/i,
          /paid\s*by\s*insurance[\s:]*\$?([\d.,]+)/i,
          /contractual\s*(?:adjustment|write.?off|discount|savings)[\s:]*\$?([\d.,]+)/i,
          /payments?[\s:]*\$?([\d.,]+)/i,
          /credits?[\s:]*\$?([\d.,]+)/i,
        ]);
        const patientDue = getAmount([
          /patient\s*(?:responsibility|due|balance|owe|amount\s*due|portion|liability|share)[\s:]*\$?([\d.,]+)/i,
          /you\s*owe[\s:]*\$?([\d.,]+)/i,
          /amount\s*due[\s:]*\$?([\d.,]+)/i,
          /balance\s*due[\s:]*\$?([\d.,]+)/i,
          /current\s*amount\s*due[\s:]*\$?([\d.,]+)/i,
          /please\s*pay[\s:]*\$?([\d.,]+)/i,
          /minimum\s*payment[\s:]*\$?([\d.,]+)/i,
          /payment\s*due[\s:]*\$?([\d.,]+)/i,
          /total\s*amount\s*due[\s:]*\$?([\d.,]+)/i,
        ]);
        // DUAL AI – with confidence merging
        let aiResult = null;
        try {
          const openModel = isPaid ? "gpt-4o" : "gpt-4o-mini";
          const gemModel = isPaid ? "gemini-1.5-pro" : "gemini-1.5-flash";
          const prompt = `You are an expert bill analyst. Analyze this extracted text from any type of bill (medical, utility, credit card, etc.).
Text:
"""${text}"""
Return ONLY valid JSON:
{
  "confidence": 0.0 to 1.0 (how sure you are about the extraction),
  "summary": "One sentence summary",
  "summaryPoints": ["Key insight 1", "Key insight 2"],
  "keyAmounts": {
    "totalCharges": "$X,XXX.XX" or null,
    "insurancePaid": "$X,XXX.XX" or null,
    "patientResponsibility": "$X,XXX.XX" or null
  },
  "services": ["List of main items or null"],
  "redFlags": ["Potential errors, overcharges, or disputes"],
  "potentialSavings": "$X–$Y estimated savings or null",
  "explanation": "2-3 paragraph plain English breakdown",
  "nextSteps": ["1. Dispute this charge", "2. Call provider", etc.]
}
Be accurate. Use null if unsure.`;
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
          if (results.length > 0) {
            // Merge by highest confidence
            results.sort((a, b) => b.confidence - a.confidence);
            aiResult = results[0].data;
          }
        } catch (err) {
          console.error("AI failed:", err);
        }
        // FINAL RESULT
        let explanation = aiResult?.explanation || "";
        if (!explanation || explanation.length < 50) {
          if (totalCharges || insurancePaid || patientDue) {
            explanation = "We successfully extracted key amounts using reliable patterns from your bill.";
          } else if (text.length > 100) {
            explanation = "We read text from your bill but couldn't identify standard amount labels. The format may be non-standard — try uploading the page with 'Total Charges' or 'Amount Due'.";
          } else {
            explanation = "We couldn't extract clear text from your bill. Please try a well-lit, high-resolution photo of the summary page.";
          }
        }
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
          potentialSavings: isPaid ? (aiResult?.potentialSavings || null) : null,
          explanation,
          nextSteps: aiResult?.nextSteps || [
            "Double-check amounts on your original bill",
            "Contact provider to dispute charges",
            "Compare at FairHealthConsumer.org or your state's rate tool",
          ],
        };
        return new Response(JSON.stringify({
          isPaid,
          pages: [{ page: 1, rawText: text, structured: finalResult, explanation: finalResult.explanation }],
          explanation: finalResult.explanation,
        }), { headers: { "Content-Type": "application/json", ...cors } });
      } catch (err) {
        console.error("Critical worker error:", err);
        return new Response(JSON.stringify({
          error: "Processing failed",
          pages: [{
            rawText: "We're having trouble analyzing your bill right now.",
            structured: { explanation: "Please try again in a few minutes or use a different photo." },
          }],
        }), { status: 500, headers: cors });
      }
    }
    // FRIENDLY ROOT PAGE
    return new Response(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>ExplainMyBill API</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: system-ui, sans-serif; text-align: center; padding: 4rem; background: #f8fafc; color: #1e40af; }
    h1 { font-size: 3rem; margin-bottom: 1rem; }
    p { font-size: 1.25rem; color: #0369a1; max-width: 600px; margin: 1rem auto; }
    code { background: #e0f2fe; padding: 0.25rem 0.5rem; border-radius: 0.5rem; }
    a { color: #1d4ed8; text-decoration: underline; }
  </style>
</head>
<body>
  <h1>🟢 ExplainMyBill Worker Running</h1>
  <p>This is the secure backend for <strong>ExplainMyBill</strong>.</p>
  <p>Frontend: <a href="https://explain-my-bill-frontend.onrender.com" target="_blank">explain-my-bill-frontend.onrender.com</a></p>
  <p><code>POST /</code> → Upload bill<br><code>POST /create-checkout-session</code> → Upgrade</p>
  <p>Status: Active • Dec 29, 2025</p>
</body>
</html>
    `, {
      status: 200,
      headers: { "Content-Type": "text/html", ...cors },
    });
  },
};
// HELPERS
async function fetchWithTimeout(url, opts = {}, timeout = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}
function uint8ArrayToBase64(uint8) {
  let binary = '';
  for (let i = 0; i < uint8.length; i += 0x8000) {
    binary += String.fromCharCode(...uint8.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
// OPTIMIZED GOOGLE VISION CALL
async function extractWithGoogleVision(uint8, mimeType, env) {
  const base64 = uint8ArrayToBase64(uint8);
  try {
    const res = await fetchWithTimeout(`https://vision.googleapis.com/v1/images:annotate?key=${env.GOOGLE_VISION_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [{
          image: { content: base64 },
          features: [{ type: "DOCUMENT_TEXT_DETECTION", maxResults: 1 }],
          imageContext: { languageHints: ["en"] },
        }],
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error("Vision API error:", res.status, err);
      throw new Error(`Vision failed: ${res.status}`);
    }
    const data = await res.json();
    return data.responses?.[0]?.fullTextAnnotation?.text?.trim() || "";
  } catch (err) {
    console.error("Google Vision failed:", err.message || err);
    return "";
  }
}
async function extractWithOcrSpace(uint8, mimeType, env) {
  const base64 = uint8ArrayToBase64(uint8);
  try {
    const res = await fetch("https://api.ocr.space/parse/image", {
      method: "POST",
      headers: {
        apikey: env.OCR_SPACE_API_KEY,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        base64Image: `data:${mimeType};base64,${base64}`,
        language: "eng",
        scale: "true",
        isTable: "true",
        OCREngine: "2",
      }),
    });
    const json = await res.json();
    return json.ParsedResults?.[0]?.ParsedText?.trim() || "";
  } catch (err) {
    console.error("OCR.space failed:", err);
    return "";
  }
}
function parseResponse(data) {
  try {
    let content = data.choices?.[0]?.message?.content || data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    content = content.replace(/^```json\n?/i, "").replace(/\n?```$/i, "").trim();
    return JSON.parse(content);
  } catch {
    return null;
  }
}
function mergeResults(results) {
  const merged = {};
  const fields = ["summary", "summaryPoints", "explanation", "potentialSavings", "services", "redFlags", "nextSteps", "keyAmounts"];
  for (const field of fields) {
    for (const result of results) {
      if (result[field] !== null && result[field] !== undefined) {
        merged[field] = result[field];
        break;
      }
    }
  }
  return merged;
}
async function processExcel(buffer) {
  try {
    const XLSX = await import("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm");
    const wb = XLSX.read(new Uint8Array(buffer), { type: "array" });
    return wb.SheetNames.map((name, i) => ({
      page: i + 1,
      rawText: XLSX.utils.sheet_to_csv(wb.Sheets[name]) || "",
    }));
  } catch (err) {
    console.error("Excel processing failed:", err);
    return [{ page: 1, rawText: "Could not read Excel file." }];
  }
}
