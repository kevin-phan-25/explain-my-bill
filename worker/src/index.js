// ExplainMyBill Worker – FINAL PRODUCTION-READY (Dec 29, 2025)
// Full error handling • Privacy-first • Reliable extraction

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
          return new Response(JSON.stringify({ error: "Payment not configured — contact support" }), {
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
          return new Response(JSON.stringify({ error: "Payment setup failed — try again later" }), {
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

        // TEXT EXTRACTION
        try {
          if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
            const pages = await processExcel(buf);
            text = pages.map(p => p.rawText).join("\n\n");
          } else if (env.GOOGLE_VISION_API_KEY) {
            text = await extractWithGoogleVision(u8, file.type, env);
            if (text.length < 100) text = await extractWithOcrSpace(u8, file.type, env);
          } else {
            text = await extractWithOcrSpace(u8, file.type, env);
          }
        } catch (err) {
          console.error("OCR failed:", err);
          text = "Text extraction failed — please try a clearer image.";
        }

        if (!text || text.length < 50) {
          text = "No readable text found. Use a clear photo of the bill summary.";
        }

        // REGEX EXTRACTION
        const getAmount = (patterns) => {
          for (const p of patterns) {
            const m = text.match(p);
            if (m) {
              let num = m[1].replace(/[^\d.,]/g, "").trim();
              num = num.replace(/O/g, "0").replace(/l/g, "1").replace(/I/g, "1").replace(/S/g, "5");
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
        ]);

        const insurancePaid = getAmount([
          /insurance\s*(?:paid|payment|adjustment|allowed|credit|reimbursement|benefit)[\s:]*\$?([\d.,]+)/i,
          /paid\s*by\s*insurance[\s:]*\$?([\d.,]+)/i,
          /contractual\s*(?:adjustment|write.?off|discount|savings)[\s:]*\$?([\d.,]+)/i,
        ]);

        const patientDue = getAmount([
          /patient\s*(?:responsibility|due|balance|owe|amount\s*due|portion|liability|share)[\s:]*\$?([\d.,]+)/i,
          /you\s*owe[\s:]*\$?([\d.,]+)/i,
          /amount\s*due[\s:]*\$?([\d.,]+)/i,
          /balance\s*due[\s:]*\$?([\d.,]+)/i,
          /current\s*amount\s*due[\s:]*\$?([\d.,]+)/i,
        ]);

        // AI
        let aiResult = null;
        try {
          const openModel = isPaid ? "gpt-4o" : "gpt-4o-mini";
          const gemModel = isPaid ? "gemini-1.5-pro" : "gemini-1.5-flash";

          const prompt = `Extract from this medical bill text:

"""${text}"""

Return ONLY valid JSON:
{
  "summary": "One sentence summary",
  "keyAmounts": {
    "totalCharges": "$X,XXX.XX" or null,
    "insurancePaid": "$X,XXX.XX" or null,
    "patientResponsibility": "$X,XXX.XX" or null
  },
  "potentialSavings": "$X,XXX–$Y,YYY" or null,
  "explanation": "Clear explanation in 2-3 sentences",
  "redFlags": [] or list,
  "services": [] or list,
  "nextSteps": [] or list
}`;

          const [o, g] = await Promise.allSettled([
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
          if (o.status === "fulfilled") {
            const p = parse(await o.value.json());
            if (p) results.push(p);
          }
          if (g.status === "fulfilled") {
            const p = parse(await g.value.json());
            if (p) results.push(p);
          }

          if (results.length > 0) aiResult = merge(results);
        } catch (err) {
          console.error("AI failed:", err);
        }

        // FINAL RESULT
        let explanation = aiResult?.explanation || "";
        if (!explanation || explanation.length < 50) {
          if (totalCharges || insurancePaid || patientDue) {
            explanation = "We found key amounts using standard billing patterns. These are the most likely values from your bill.";
          } else if (text.length > 100) {
            explanation = "We read your bill but couldn't identify standard amounts. The format may be unusual — try uploading just the summary page.";
          } else {
            explanation = "We couldn't read clear text from your bill. Please try a well-lit photo of the summary page.";
          }
        }

        const result = {
          summary: aiResult?.summary || "Bill analyzed.",
          keyAmounts: {
            totalCharges: aiResult?.keyAmounts?.totalCharges || totalCharges || "Not detected",
            insurancePaid: aiResult?.keyAmounts?.insurancePaid || insurancePaid || "Not detected",
            patientResponsibility: aiResult?.keyAmounts?.patientResponsibility || patientDue || "Not detected",
          },
          services: aiResult?.services || [],
          redFlags: aiResult?.redFlags || [],
          potentialSavings: isPaid ? (aiResult?.potentialSavings || null) : null,
          explanation,
          nextSteps: aiResult?.nextSteps || ["Review amounts", "Compare at FairHealthConsumer.org", "Contact provider if needed"],
        };

        return new Response(JSON.stringify({
          isPaid,
          pages: [{ page: 1, rawText: text, structured: result, explanation: result.explanation }],
          explanation: result.explanation,
        }), { headers: { "Content-Type": "application/json", ...cors } });

      } catch (err) {
        console.error("Critical error:", err);
        return new Response(JSON.stringify({
          error: "Processing failed",
          pages: [{
            rawText: "We're having trouble analyzing your bill.",
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
async function fetchWithTimeout(u, o = {}, t = 15000) {
  const c = new AbortController();
  const id = setTimeout(() => c.abort(), t);
  try { return await fetch(u, { ...o, signal: c.signal }); }
  catch { throw new Error("Request failed"); }
  finally { clearTimeout(id); }
}

async function extractWithGoogleVision(u8, type, env) {
  const b64 = uint8ArrayToBase64(u8);
  try {
    const res = await fetchWithTimeout(`https://vision.googleapis.com/v1/images:annotate?key=${env.GOOGLE_VISION_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [{ image: { content: b64 }, features: [{ type: "DOCUMENT_TEXT_DETECTION" }], imageContext: { languageHints: ["en"] } }],
      }),
    });
    const data = await res.json();
    return data.responses?.[0]?.fullTextAnnotation?.text?.trim() || "";
  } catch { return ""; }
}

async function extractWithOcrSpace(u8, type, env) {
  const b64 = uint8ArrayToBase64(u8);
  try {
    const res = await fetch("https://api.ocr.space/parse/image", {
      method: "POST",
      headers: { apikey: env.OCR_SPACE_API_KEY, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ base64Image: `data:${type};base64,${b64}`, language: "eng", scale: "true", isTable: "true", OCREngine: "2" }),
    });
    const j = await res.json();
    return j.ParsedResults?.[0]?.ParsedText?.trim() || "";
  } catch { return ""; }
}

function uint8ArrayToBase64(u) {
  let b = '';
  for (let i = 0; i < u.length; i += 0x8000) b += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(b);
}

function parse(d) {
  try {
    let t = d.choices?.[0]?.message?.content || d.candidates?.[0]?.content?.parts?.[0]?.text || "";
    t = t.replace(/^```json\n?/i, "").replace(/\n?```$/i, "").trim();
    return JSON.parse(t);
  } catch { return null; }
}

function merge(arr) {
  const r = {};
  const fields = ["summary","explanation","potentialSavings","services","redFlags","nextSteps","keyAmounts"];
  for (const f of fields) {
    for (const o of arr) {
      if (o[f] !== null && o[f] !== undefined) { r[f] = o[f]; break; }
    }
  }
  return r;
}

async function processExcel(buf) {
  try {
    const XLSX = await import("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm");
    const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
    return wb.SheetNames.map((n, i) => ({ page: i + 1, rawText: XLSX.utils.sheet_to_csv(wb.Sheets[n]) || "" }));
  } catch {
    return [{ page: 1, rawText: "Could not read Excel file." }];
  }
}
