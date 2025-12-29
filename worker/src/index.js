// ExplainMyBill Worker – FINAL PRODUCTION-READY (Dec 29, 2025)
// Google Vision primary • OCR.space fallback • Dual AI • Strong regex • Full error handling

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
        if (!["monthly", "one-time"].includes(plan)) {
          return new Response(JSON.stringify({ error: "Invalid plan selected" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...cors },
          });
        }

        const priceId = plan === "monthly" ? env.STRIPE_PRICE_MONTHLY : env.STRIPE_PRICE_ONE_TIME;
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
            pages: [{ rawText: "Please select a medical bill to analyze.", structured: { explanation: "No file received." } }],
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
            pages: [{ rawText: "Please upload PDF, image, or Excel file.", structured: { explanation: "Invalid file type." } }],
          }), { status: 415, headers: cors });
        }

        // Paid check
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

        // TEXT EXTRACTION – Google Vision first (best quality)
        try {
          if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
            const pages = await processExcel(buf);
            text = pages.map(p => p.rawText).join("\n\n");
          } else {
            // Primary: Google Vision (if key exists)
            if (env.GOOGLE_VISION_API_KEY) {
              text = await extractWithGoogleVision(u8, file.type, env);
              console.log("Vision text length:", text.length);
            }

            // Fallback: OCR.space if Vision failed or returned little text
            if (!text || text.length < 100) {
              console.log("Falling back to OCR.space");
              text = await extractWithOcrSpace(u8, file.type, env);
            }
          }
        } catch (err) {
          console.error("All OCR failed:", err);
          text = "We couldn't extract text from your bill. Please try a clearer, well-lit photo.";
        }

        if (!text || text.length < 50) {
          text = "No readable text detected. Try a straight-on, high-resolution photo of the summary page.";
        }

        // STRONG REGEX EXTRACTION
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
          /total\s*(?:charges?|billed|amount|due|balance|cost|fees?)[\s:]*\$?([\d.,]+)/i,
          /amount\s*(?:billed|charged|due|total|owed)[\s:]*\$?([\d.,]+)/i,
          /gross\s*charges?[\s:]*\$?([\d.,]+)/i,
          /subtotal[\s:]*\$?([\d.,]+)/i,
          /statement\s*balance[\s:]*\$?([\d.,]+)/i,
        ]);

        const insurancePaid = getAmount([
          /insurance\s*(?:paid|payment|adjustment|allowed|credit|reimbursement|benefit)[\s:]*\$?([\d.,]+)/i,
          /paid\s*by\s*insurance[\s:]*\$?([\d.,]+)/i,
          /contractual\s*(?:adjustment|write.?off|discount|savings)[\s:]*\$?([\d.,]+)/i,
          /insurance\s*adjustment[\s:]*\$?([\d.,]+)/i,
        ]);

        const patientDue = getAmount([
          /patient\s*(?:responsibility|due|balance|owe|amount\s*due|portion|liability|share)[\s:]*\$?([\d.,]+)/i,
          /you\s*owe[\s:]*\$?([\d.,]+)/i,
          /amount\s*due[\s:]*\$?([\d.,]+)/i,
          /balance\s*due[\s:]*\$?([\d.,]+)/i,
          /current\s*amount\s*due[\s:]*\$?([\d.,]+)/i,
          /please\s*pay\s*this\s*amount[\s:]*\$?([\d.,]+)/i,
        ]);

        // DUAL AI ANALYSIS
        let aiResult = null;
        try {
          const openModel = isPaid ? "gpt-4o" : "gpt-4o-mini";
          const gemModel = isPaid ? "gemini-1.5-pro" : "gemini-1.5-flash";

          const prompt = `Extract key information from this medical bill text:

"""${text}"""

Return ONLY valid JSON:
{
  "summary": "One sentence summary",
  "keyAmounts": {
    "totalCharges": "$X,XXX.XX" or null,
    "insurancePaid": "$X,XXX.XX" or null,
    "patientResponsibility": "$X,XXX.XX" or null
  },
  "potentialSavings": "$X,XXX–$Y,YYY possible savings" or null,
  "explanation": "Clear explanation in 2-3 sentences",
  "redFlags": [] or list,
  "services": [] or list,
  "nextSteps": [] or list
}

Use null if unsure.`;

          const [openaiRes, geminiRes] = await Promise.allSettled([
            fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
              method: "POST",
              headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
              body: JSON.stringify({ model: openModel, messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: 600 }),
            }),
            fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${gemModel}:generateContent?key=${env.GEMINI_API_KEY}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0, maxOutputTokens: 600 } }),
            }),
          ]);

          const results = [];
          if (openaiRes.status === "fulfilled") {
            const parsed = parseResponse(await openaiRes.value.json());
            if (parsed) results.push(parsed);
          }
          if (geminiRes.status === "fulfilled") {
            const parsed = parseResponse(await geminiRes.value.json());
            if (parsed) results.push(parsed);
          }

          if (results.length > 0) aiResult = mergeResults(results);
        } catch (err) {
          console.error("AI analysis failed:", err);
        }

        // FINAL EXPLANATION & RESULT
        let explanation = aiResult?.explanation || "";
        if (!explanation || explanation.length < 50) {
          if (totalCharges || insurancePaid || patientDue) {
            explanation = "We successfully extracted key amounts using reliable patterns from your bill.";
          } else if (text.length > 100) {
            explanation = "We read text from your bill but couldn't identify standard amounts. The format may be non-standard — try uploading just the summary page.";
          } else {
            explanation = "We couldn't extract clear text from your bill. Please try a well-lit, high-resolution photo of the summary page.";
          }
        }

        const finalResult = {
          summary: aiResult?.summary || "Your medical bill was analyzed.",
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
            "Compare charges at FairHealthConsumer.org",
            "Contact your provider if anything seems off",
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

async function extractWithGoogleVision(uint8, mimeType, env) {
  const base64 = uint8ArrayToBase64(uint8);
  try {
    const res = await fetchWithTimeout(`https://vision.googleapis.com/v1/images:annotate?key=${env.GOOGLE_VISION_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [{
          image: { content: base64 },
          features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
          imageContext: { languageHints: ["en"] },
        }],
      }),
    });

    if (!res.ok) throw new Error(`Vision API error: ${res.status}`);
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
  const fields = ["summary", "explanation", "potentialSavings", "services", "redFlags", "nextSteps", "keyAmounts"];
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
