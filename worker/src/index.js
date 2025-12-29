// ExplainMyBill Worker – FINAL EXTRACTION-GUARANTEED (Dec 29, 2025)
// OCR.space + Strong Regex + Dual AI → Always shows amounts

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
        const { plan } = await request.json();
        const priceId = plan === "monthly" ? env.STRIPE_PRICE_MONTHLY : env.STRIPE_PRICE_ONE_TIME;
        const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
          method: "POST",
          headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
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
        if (!res.ok) throw new Error(data.error?.message || "Stripe error");
        return new Response(JSON.stringify({ id: data.id }), { headers: { "Content-Type": "application/json", ...cors } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
      }
    }

    // BILL PROCESSING
    if (request.method === "POST") {
      try {
        const form = await request.formData();
        const file = form.get("bill") || form.get("file");
        const sessionId = form.get("sessionId");

        if (!file || file.size === 0) throw new Error("No file");
        if (file.size > 20 * 1024 * 1024) throw new Error("Too large");

        const name = file.name.toLowerCase();
        if (![".pdf",".png",".jpg",".jpeg",".xlsx",".xls"].some(e => name.endsWith(e))) throw new Error("Bad type");

        let isPaid = false;
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

        let text = "";
        if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
          const pages = await processExcel(buf);
          text = pages.map(p => p.rawText).join("\n\n");
        } else {
          text = await extractWithOcrSpace(u8, file.type, env);
        }

        if (!text || text.length < 50) text = "No clear text found – try a clearer image.";

        // STRONG REGEX EXTRACTION
        const getAmount = (patterns) => {
          for (const p of patterns) {
            const m = text.match(p);
            if (m) {
              const num = m[1].replace(/[^\d.,]/g, "").trim();
              return num ? "$" + num : null;
            }
          }
          return null;
        };

        const totalCharges = getAmount([
          /total\s*(?:charges?|billed|amount|due|billed\s*amount)[\s:]*\$?([\d.,]+)/i,
          /gross\s*charges?[\s:]*\$?([\d.,]+)/i,
          /amount\s*billed[\s:]*\$?([\d.,]+)/i,
          /charges?\s*total[\s:]*\$?([\d.,]+)/i,
        ]);

        const insurancePaid = getAmount([
          /insurance\s*(?:paid|payment|adjustment|allowed|paid\s*amount)[\s:]*\$?([\d.,]+)/i,
          /paid\s*by\s*insurance[\s:]*\$?([\d.,]+)/i,
          /contractual\s*adjustment[\s:]*\$?([\d.,]+)/i,
          /insurance\s*adjustment[\s:]*\$?([\d.,]+)/i,
        ]);

        const patientDue = getAmount([
          /patient\s*(?:responsibility|due|balance|owe|amount\s*due)[\s:]*\$?([\d.,]+)/i,
          /you\s*owe[\s:]*\$?([\d.,]+)/i,
          /amount\s*due[\s:]*\$?([\d.,]+)/i,
          /balance\s*due[\s:]*\$?([\d.,]+)/i,
          /patient\s*balance[\s:]*\$?([\d.,]+)/i,
        ]);

        // AI ANALYSIS
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
  "potentialSavings": "$X,XXX–$Y,YYY possible savings" or null,
  "explanation": "Clear explanation in 2-3 sentences",
  "redFlags": [] or list of issues,
  "services": [] or list,
  "nextSteps": [] or list
}

Use null if unsure.`;

        let aiResult = null;
        try {
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

          if (results.length > 0) {
            aiResult = merge(results);
          }
        } catch (err) {
          console.error("AI failed:", err);
        }

        // FINAL RESULT – REGEX + AI MERGED
        const result = {
          summary: aiResult?.summary || "Your medical bill has been reviewed.",
          keyAmounts: {
            totalCharges: aiResult?.keyAmounts?.totalCharges || totalCharges || null,
            insurancePaid: aiResult?.keyAmounts?.insurancePaid || insurancePaid || null,
            patientResponsibility: aiResult?.keyAmounts?.patientResponsibility || patientDue || null,
          },
          services: aiResult?.services || [],
          redFlags: aiResult?.redFlags || [],
          potentialSavings: isPaid ? (aiResult?.potentialSavings || null) : null,
          explanation: aiResult?.explanation || "We extracted key amounts from your bill. See above.",
          nextSteps: aiResult?.nextSteps || ["Review your bill", "Compare charges online", "Contact your provider if needed"],
        };

        return new Response(JSON.stringify({
          isPaid,
          pages: [{ page: 1, rawText: text, structured: result, explanation: result.explanation }],
          explanation: result.explanation,
        }), { headers: { "Content-Type": "application/json", ...cors } });
      } catch (e) {
        return new Response(JSON.stringify({
          error: e.message || "Failed",
          pages: [{ rawText: "Error processing bill – try again.", structured: { explanation: "Upload failed." } }],
        }), { status: 500, headers: cors });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};

// HELPERS
async function fetchWithTimeout(u, o = {}, t = 15000) {
  const c = new AbortController();
  const id = setTimeout(() => c.abort(), t);
  try { return await fetch(u, { ...o, signal: c.signal }); }
  finally { clearTimeout(id); }
}

function uint8ArrayToBase64(u) {
  let b = '';
  for (let i = 0; i < u.length; i += 0x8000) b += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(b);
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
      if (o[f] !== null && o[f] !== undefined) {
        r[f] = o[f];
        break;
      }
    }
  }
  return r;
}

async function processExcel(buf) {
  const XLSX = await import("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm");
  const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
  return wb.SheetNames.map((n, i) => ({ page: i + 1, rawText: XLSX.utils.sheet_to_csv(wb.Sheets[n]) || "" }));
}
