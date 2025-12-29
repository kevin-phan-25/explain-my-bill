// ExplainMyBill Worker – FINAL PRODUCTION-READY (Dec 29, 2025)
// Google Vision primary • OCR.space fallback • Dual AI • Ultra-robust regex for any bill type
// In-memory only • No data retained • Paid features: savings estimates, red flags, detailed steps
// Trusted one-stop shop for understanding any bill (medical, utility, credit card, etc.)

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
        const priceId = plan === "monthly" ? env.STRIPE_PRICE_MONTHLY : plan === "lifetime" ? env.STRIPE_PRICE_LIFETIME : env.STRIPE_PRICE_ONE_TIME;
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
            mode: plan === "monthly" || plan === "lifetime" ? "subscription" : "payment",  // Lifetime as subscription with no recurring charge
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
        // TEXT EXTRACTION – Google Vision first
        try {
          if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
            const pages = await processExcel(buf);
            text = pages.map(p => p.rawText).join("\n\n");
          } else {
            if (env.GOOGLE_VISION_API_KEY) {
              text = await extractWithGoogleVision(u8, file.type, env);
            }
            if (!text || text.length < 100) {
              text = await extractWithOcrSpace(u8, file.type, env);
            }
          }
        } catch (err) {
          console.error("OCR failed:", err);
          text = "We couldn't read your bill clearly. Try a better photo.";
        }
        if (!text || text.length < 50) {
          text = "No text detected. Try a clear, well-lit photo of the summary page.";
        }
        // ULTRA-ROBUST REGEX – handles medical, utility, credit card, etc.
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
          /total\s*(?:charges?|billed|amount|due|balance|cost|fees?|bill|owed)[\s:]*\$?([\d.,]+)/i,
          /amount\s*(?:billed|charged|due|total|owed)[\s:]*\$?([\d.,]+)/i,
          /gross\s*charges?[\s:]*\$?([\d.,]+)/i,
          /subtotal[\s:]*\$?([\d.,]+)/i,
          /statement\s*balance[\s:]*\$?([\d.,]+)/i,
          /balance\s*forward[\s:]*\$?([\d.,]+)/i,
          /previous\s*balance[\s:]*\$?([\d.,]+)/i,
          /new\s*charges?[\s:]*\$?([\d.,]+)/i,
          /total\s*due[\s:]*\$?([\d.,]+)/i,
        ]);
        const insurancePaid = getAmount([
          /insurance\s*(?:paid|payment|adjustment|allowed|credit|reimbursement|benefit|discount)[\s:]*\$?([\d.,]+)/i,
          /paid\s*by\s*insurance[\s:]*\$?([\d.,]+)/i,
          /contractual\s*(?:adjustment|write.?off|discount|savings)[\s:]*\$?([\d.,]+)/i,
          /insurance\s*adjustment[\s:]*\$?([\d.,]+)/i,
          /allowed\s*amount[\s:]*\$?([\d.,]+)/i,
          /plan\s*paid[\s:]*\$?([\d.,]+)/i,
          /payments?[\s:]*\$?([\d.,]+)/i,
          /credits?[\s:]*\$?([\d.,]+)/i,
        ]);
        const patientDue = getAmount([
          /patient\s*(?:responsibility|due|balance|owe|amount\s*due|portion|liability|share|balance\s*due)[\s:]*\$?([\d.,]+)/i,
          /you\s*owe[\s:]*\$?([\d.,]+)/i,
          /amount\s*due[\s:]*\$?([\d.,]+)/i,
          /balance\s*due[\s:]*\$?([\d.,]+)/i,
          /patient\s*balance[\s:]*\$?([\d.,]+)/i,
          /your\s*responsibility[\s:]*\$?([\d.,]+)/i,
          /current\s*amount\s*due[\s:]*\$?([\d.,]+)/i,
          /please\s*pay\s*this\s*amount[\s:]*\$?([\d.,]+)/i,
          /minimum\s*payment[\s:]*\$?([\d.,]+)/i,
          /due\s*now[\s:]*\$?([\d.,]+)/i,
        ]);
        // DUAL AI ANALYSIS – general for any bill type
        let aiResult = null;
        try {
          const openModel = isPaid ? "gpt-4o" : "gpt-4o-mini";
          const gemModel = isPaid ? "gemini-1.5-pro" : "gemini-1.5-flash";
          const prompt = `You are an expert bill analyst helping users understand any type of bill (medical, utility, credit card, etc.) in plain English.

Analyze this extracted bill text:
"""${text}"""

Return ONLY valid JSON:
{
  "summary": "One clear sentence summarizing the bill",
  "summaryPoints": [
    "Key insight #1",
    "Key insight #2",
    "Key insight #3 (optional)"
  ],
  "keyAmounts": {
    "totalCharges": "Extracted total billed amount as string with $ or null",
    "insurancePaid": "Amount paid by insurance or credits as string with $ or null",
    "patientResponsibility": "Final amount owed as string with $ or null"
  },
  "services": ["Short list of main items/services or null"],
  "redFlags": ["Potential issues, errors, or overcharges (empty array if none)"],
  "potentialSavings": "Estimated savings range (e.g. '$50–$200') or null",
  "explanation": "Clear, calm explanation in 2-4 short paragraphs breaking down the bill lingo",
  "nextSteps": ["Ranked actionable steps to understand or dispute the bill"]
}

Be conservative with estimates. Use null if unsure. For paid users, provide more detailed savings and red flags.`;
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
            if (p) results.push(p);
          }
          if (geminiRes.status === "fulfilled") {
            const p = parseResponse(await geminiRes.value.json());
            if (p) results.push(p);
          }
          if (results.length > 0) aiResult = mergeResults(results);
        } catch (err) {
          console.error("AI failed:", err);
        }
        // FINAL RESULT
        let explanation = aiResult?.explanation || "";
        if (!explanation || explanation.length < 50) {
          if (totalCharges || insurancePaid || patientDue) {
            explanation = "We extracted key amounts using common bill patterns.";
          } else if (text.length > 100) {
            explanation = "We read your bill but couldn't find standard amounts. Try the summary page.";
          } else {
            explanation = "We couldn't extract clear text. Try a better photo.";
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
    return new Response("ExplainMyBill Worker – Running", { headers: cors });
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
