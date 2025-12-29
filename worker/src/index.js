// ExplainMyBill Worker – FULL PDF-to-Image + Dual AI (Dec 29, 2025)

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

    if (url.pathname === "/create-checkout-session" && request.method === "POST") {
      return await handleStripeCheckout(request, env, cors);
    }

    if (request.method === "POST") {
      return await handleBillProcessing(request, env, cors);
    }

    // Root Page
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
    `, { status: 200, headers: { "Content-Type": "text/html", ...cors } });
  },
};

// ======================== Stripe Checkout ========================
async function handleStripeCheckout(request, env, cors) {
  try {
    const { plan } = await request.json().catch(() => ({}));
    if (!["monthly", "one-time", "lifetime"].includes(plan)) {
      return errorResponse("Invalid plan selected", 400, cors);
    }

    const priceMap = {
      monthly: env.STRIPE_PRICE_MONTHLY,
      lifetime: env.STRIPE_PRICE_LIFETIME,
      "one-time": env.STRIPE_PRICE_ONE_TIME,
    };

    const priceId = priceMap[plan];
    if (!priceId) return errorResponse("Payment config error", 500, cors);

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
    if (!res.ok) return errorResponse("Stripe error: " + JSON.stringify(data), 502, cors);

    return new Response(JSON.stringify({ id: data.id }), {
      headers: { "Content-Type": "application/json", ...cors },
    });
  } catch (err) {
    console.error(err);
    return errorResponse("Stripe checkout failed", 500, cors);
  }
}

// ======================== Bill Processing ========================
async function handleBillProcessing(request, env, cors) {
  try {
    const form = await request.formData();
    const file = form.get("bill") || form.get("file");
    const sessionId = form.get("sessionId");

    if (!file || file.size === 0) return errorResponse("No file uploaded", 400, cors);
    if (file.size > 20 * 1024 * 1024) return errorResponse("File exceeds 20MB", 413, cors);

    const name = file.name.toLowerCase();
    const allowed = [".pdf", ".png", ".jpg", ".jpeg", ".xlsx", ".xls"];
    if (!allowed.some(e => name.endsWith(e))) {
      return errorResponse("Unsupported format", 415, cors);
    }

    let isPaid = false;
    if (sessionId) {
      try {
        const r = await fetchWithTimeout(
          `https://api.stripe.com/v1/checkout/sessions/${sessionId}`,
          { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } }
        );
        const d = await r.json();
        if (r.ok && (d.payment_status === "paid" || d.status === "complete")) {
          isPaid = true;
        }
      } catch {}
    }

    const buf = await file.arrayBuffer();
    const u8 = new Uint8Array(buf);

    let text = "";
    if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
      const pages = await processExcel(buf);
      text = pages.map(p => p.rawText).join("\n\n");
    } else if (name.endsWith(".pdf")) {
      text = await extractTextFromPDFasImages(u8, env);
      if (!text || text.length < 100) {
        text = await extractWithOcrSpace(u8, "application/pdf", env);
      }
    } else {
      text = await extractWithGoogleVision(u8, file.type, env);
      if (!text || text.length < 100) {
        text = await extractWithOcrSpace(u8, file.type, env);
      }
    }

    if (!text || text.length < 50) {
      text = "No readable text found. Use a straight-on photo of the summary page.";
    }

    const totalCharges = extractAmount(text, [
      /total\s*(?:charges?|billed|amount|due|balance|cost|fees?|bill|owed)[\s:]*\$?([\d.,]+)/i,
    ]);
    const insurancePaid = extractAmount(text, [
      /insurance\s*(?:paid|payment|adjustment|allowed|credit|benefit)[\s:]*\$?([\d.,]+)/i,
    ]);
    const patientDue = extractAmount(text, [
      /patient\s*(?:responsibility|due|balance|owe|amount\s*due)[\s:]*\$?([\d.,]+)/i,
    ]);

    const aiResult = await analyzeWithAI(text, isPaid, env);

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
      explanation: aiResult?.explanation || "Bill analyzed successfully.",
      nextSteps: aiResult?.nextSteps || [],
    };

    return new Response(JSON.stringify({
      isPaid,
      pages: [{ page: 1, rawText: text, structured: finalResult }],
      explanation: finalResult.explanation,
    }), {
      headers: { "Content-Type": "application/json", ...cors },
    });

  } catch (err) {
    console.error("Critical worker error:", err);
    return errorResponse("Processing failed", 500, cors);
  }
}

// ======================== PDF-to-Image OCR ========================
async function extractTextFromPDFasImages(u8, env) {
  try {
    const pdfjs = await import("https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.222/es5/build/pdf.js");
    const pdf = await pdfjs.getDocument({ data: u8 }).promise;
    let fullText = "";

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = new OffscreenCanvas(viewport.width, viewport.height);
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport }).promise;

      const blob = await canvas.convertToBlob({ type: "image/png" });
      const pageText = await extractWithGoogleVision(
        new Uint8Array(await blob.arrayBuffer()),
        "image/png",
        env
      );
      fullText += pageText + "\n\n";
    }

    return fullText.trim();
  } catch (err) {
    console.error("PDF-to-image OCR failed:", err);
    return "";
  }
}

// ======================== Helpers ========================
function errorResponse(msg, status, cors) {
  return new Response(JSON.stringify({
    error: msg,
    pages: [{ rawText: msg }],
  }), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

function extractAmount(text, patterns) {
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return "$" + m[1];
  }
  return null;
}

async function analyzeWithAI(text, isPaid, env) {
  try {
    const model = isPaid ? "gpt-4o" : "gpt-4o-mini";
    const prompt = `Analyze this bill text and return JSON only:\n"""${text}"""`;

    const res = await fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
      }),
    });

    const data = await res.json();
    return parseResponse(data);
  } catch {
    return null;
  }
}

async function extractWithGoogleVision(uint8, mimeType, env) {
  const base64 = uint8ArrayToBase64(uint8);
  try {
    const res = await fetchWithTimeout(
      `https://vision.googleapis.com/v1/images:annotate?key=${env.GOOGLE_VISION_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [{
            image: { content: base64 },
            features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
          }],
        }),
      }
    );
    const data = await res.json();
    return data.responses?.[0]?.fullTextAnnotation?.text || "";
  } catch {
    return "";
  }
}

async function extractWithOcrSpace(uint8, mimeType, env) {
  const base64 = uint8ArrayToBase64(uint8);
  const res = await fetch("https://api.ocr.space/parse/image", {
    method: "POST",
    headers: {
      apikey: env.OCR_SPACE_API_KEY,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      base64Image: `data:${mimeType};base64,${base64}`,
      language: "eng",
    }),
  });
  const json = await res.json();
  return json.ParsedResults?.[0]?.ParsedText || "";
}

function uint8ArrayToBase64(uint8) {
  let s = "";
  for (let i = 0; i < uint8.length; i += 0x8000) {
    s += String.fromCharCode(...uint8.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function parseResponse(data) {
  try {
    let c = data.choices?.[0]?.message?.content || "";
    c = c.replace(/^```json/i, "").replace(/```$/, "").trim();
    return JSON.parse(c);
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url, opts = {}, timeout = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
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
    console.error("Excel failed:", err);
    return [{ page: 1, rawText: "Could not read Excel file." }];
  }
}
