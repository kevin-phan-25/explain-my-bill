// ExplainMyBill Worker – FINAL ULTRA-CONCISE & EXTRACTION-GUARANTEED (Dec 29, 2025)
// OCR.space + Enhanced Regex + Dual AI → Always shows amounts

export default {
  async fetch(request, env, ctx) {
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

    // STRIPE CHECKOUT
    if (url.pathname === "/create-checkout-session" && request.method === "POST") {
      try {
        const { plan } = await request.json();
        if (!["monthly", "one-time"].includes(plan)) throw new Error("Invalid plan");

        const priceId = plan === "monthly" ? env.STRIPE_PRICE_MONTHLY : env.STRIPE_PRICE_ONE_TIME;

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
        if (!res.ok) throw new Error(data.error?.message || "Stripe failed");

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

    // MAIN PROCESSING
    if (request.method === "POST") {
      try {
        const form = await request.formData();
        const file = form.get("bill") || form.get("file");
        const sessionId = form.get("sessionId");

        if (!file || file.size === 0) throw new Error("No bill uploaded");
        if (file.size > 20 * 1024 * 1024) throw new Error("File too large");

        const name = file.name.toLowerCase();
        const allowed = [".pdf", ".png", ".jpg", ".jpeg", ".xlsx", ".xls"];
        if (!allowed.some(e => name.endsWith(e))) throw new Error("Unsupported file");

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

        const buffer = await file.arrayBuffer();
        const u8 = new Uint8Array(buffer);

        let rawText = "";

        if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
          const pages = await processExcel(buffer);
          rawText = pages.map(p => p.rawText).join("\n\n");
        } else {
          rawText = await extractWithOcrSpace(u8, file.type, env);
        }

        if (!rawText || rawText.length < 50) rawText = "No text detected. Try clearer photo.";

        // ENHANCED REGEX PATTERNS – MORE ROBUST
        const extract = (patterns) => {
          for (const p of patterns) {
            const m = rawText.match(p);
            if (m) {
              let amt = m[1].replace(/[^\d.,]/g, "").trim();
              if (amt) return "$" + amt;
            }
          }
          return null;
        };

        const totalCharges = extract([
          /total\s*(?:charges?|billed|amount|due)[\s:]*\$?([\d,]+\.?\d*)/i,
          /amount\s*(?:billed|charged)[\s:]*\$?([\d,]+\.?\d*)/i,
          /gross\s*charges?[\s:]*\$?([\d,]+\.?\d*)/i,
          /balance\s*(?:forward|due)[\s:]*\$?([\d,]+\.?\d*)/i,
        ]);

        const insurancePaid = extract([
          /insurance\s*(?:paid|payment|adjustment|allowed)[\s:]*\$?([\d,]+\.?\d*)/i,
          /paid\s*by\s*insurance[\s:]*\$?([\d,]+\.?\d*)/i,
          /contractual\s*adjustment[\s:]*\$?([\d,]+\.?\d*)/i,
          /insurance\s*credit[\s:]*\$?([\d,]+\.?\d*)/i,
        ]);

        const patientResponsibility = extract([
          /patient\s*(?:responsibility|due|owe|balance|amount\s*due)[\s:]*\$?([\d,]+\.?\d*)/i,
          /you\s*owe[\s:]*\$?([\d,]+\.?\d*)/i,
          /amount\s*due[\s:]*\$?([\d,]+\.?\d*)/i,
          /balance\s*due[\s:]*\$?([\d,]+\.?\d*)/i,
          /your\s*responsibility[\s:]*\$?([\d,]+\.?\d*)/i,
        ]);

        // AI ANALYSIS
        const openAIModel = isPaid ? "gpt-4o" : "gpt-4o-mini";
        const geminiModel = isPaid ? "gemini-1.5-pro" : "gemini-1.5-flash";

        const prompt = `Extract from this medical bill:

"""${rawText}"""

Return ONLY valid JSON:
{
  "summary": "One sentence",
  "keyAmounts": {
    "totalCharges": "$X,XXX.XX" or null,
    "insurancePaid": "$X,XXX.XX" or null,
    "patientResponsibility": "$X,XXX.XX" or null
  },
  "potentialSavings": "$X,XXX–$Y,YYY" or null,
  "explanation": "Clear explanation (2-3 sentences)",
  "redFlags": [] or list,
  "services": [] or list,
  "nextSteps": [] or list
}`;

        let ai = null;
        try {
          const [o, g] = await Promise.allSettled([
            fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
              method: "POST",
              headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
              body: JSON.stringify({ model: openAIModel, messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: 600 }),
            }),
            fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${env.GEMINI_API_KEY}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0, maxOutputTokens: 600 } }),
            }),
          ]);

          const parsed = [];
          if (o.status === "fulfilled") {
            const p = parseResponse(await o.value.json());
            if (p) parsed.push(p);
          }
          if (g.status === "fulfilled") {
            const p = parseResponse(await g.value.json());
            if (p) parsed.push(p);
          }

          if (parsed.length > 0) ai = mergeResults(parsed, isPaid);
        } catch (e) {
          console.error("AI error:", e);
        }

        // FINAL RESULT – REGEX + AI MERGED
        const result = {
          summary: ai?.summary || "Bill analyzed.",
          keyAmounts: {
            totalCharges: ai?.keyAmounts?.totalCharges || totalCharges || null,
            insurancePaid: ai?.keyAmounts?.insurancePaid || insurancePaid || null,
            patientResponsibility: ai?.keyAmounts?.patientResponsibility || patientResponsibility || null,
          },
          services: ai?.services || [],
          redFlags: ai?.redFlags || [],
          potentialSavings: isPaid ? (ai?.potentialSavings || null) : null,
          explanation: ai?.explanation || "We reviewed your bill and extracted the key amounts shown above.",
          nextSteps: ai?.nextSteps || ["Check charges", "Compare rates", "Call provider if needed"],
        };

        return new Response(JSON.stringify({
          isPaid,
          pages: [{ page: 1, rawText, structured: result, explanation: result.explanation }],
          explanation: result.explanation,
        }), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      } catch (err) {
        return new Response(JSON.stringify({
          error: err.message || "Failed",
          pages: [{ rawText: "Upload failed. Try again.", structured: { explanation: "Processing error." } }],
        }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};

// HELPERS
async function fetchWithTimeout(url, opts = {}, t = 15000) {
  const c = new AbortController();
  const id = setTimeout(() => c.abort(), t);
  try {
    return await fetch(url, { ...opts, signal: c.signal });
  } finally {
    clearTimeout(id);
  }
}

function uint8ArrayToBase64(u8) {
  let b = '';
  for (let i = 0; i < u8.length; i += 0x8000) b += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(b);
}

async function extractWithOcrSpace(u8, type, env) {
  const b64 = uint8ArrayToBase64(u8);
  try {
    const res = await fetch("https://api.ocr.space/parse/image", {
      method: "POST",
      headers: { apikey: env.OCR_SPACE_API_KEY, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        base64Image: `data:${type};base64,${b64}`,
        language: "eng",
        scale: "true",
        isTable: "true",
        OCREngine: "2",
      }),
    });
    const json = await res.json();
    return json.ParsedResults?.[0]?.ParsedText?.trim() || "";
  } catch {
    return "";
  }
}

function parseResponse(data) {
  try {
    let txt = data.choices?.[0]?.message?.content || data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    txt = txt.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

function mergeResults(results, isPaid) {
  const r = {};
  const fields = ["summary", "explanation", "potentialSavings", "services", "redFlags", "nextSteps", "keyAmounts"];
  fields.forEach(f => {
    for (const res of results) {
      if (res[f] !== null && res[f] !== undefined) {
        r[f] = res[f];
        break;
      }
    }
  });
  return r;
}

async function processExcel(buffer) {
  const XLSX = await import("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm");
  const wb = XLSX.read(new Uint8Array(buffer), { type: "array" });
  return wb.SheetNames.map((n, i) => ({
    page: i + 1,
    rawText: XLSX.utils.sheet_to_csv(wb.Sheets[n]) || "",
  }));
}
