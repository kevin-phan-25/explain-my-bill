// ExplainMyBill Worker – FULL PRODUCTION READY (Dec 29, 2025)
// Preserves OCR, AI explanations, Stripe, Excel + adds multi-page structured services
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

    // ================= STRIPE CHECKOUT =================
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

    // ================= BILL PROCESSING =================
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
            pages: [{ rawText: "File exceeds 20MB.", structured: { explanation: "File size limit exceeded." } }],
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

        // Check payment status
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

        // OCR: Google Vision primary
        let pages = [];
        try {
          if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
            pages = await processExcel(buf);
          } else if (env.GOOGLE_VISION_API_KEY) {
            const fullText = await extractWithGoogleVision(u8, file.type, env);
            pages = [{ page: 1, rawText: fullText }];
          }
          if (!pages || pages.length === 0 || pages[0].rawText.length < 100) {
            const fallbackText = await extractWithOcrSpace(u8, file.type, env);
            pages = [{ page: 1, rawText: fallbackText }];
          }
        } catch (err) {
          console.error("OCR failed:", err);
          pages = [{ page: 1, rawText: "We couldn't read your bill. Try a clear, well-lit photo." }];
        }

        if (!pages || pages.length === 0 || pages[0].rawText.length < 50) {
          pages = [{ page: 1, rawText: "No readable text found. Use a straight-on photo of the summary page." }];
        }

        // ================= EXTRACT KEY AMOUNTS (MULTI-PAGE) =================
        pages = pages.map(p => {
          const { totalCharges, insurancePaid, patientResponsibility, services } = extractAmountsPerService(p.rawText);
          return { ...p, structured: { totalCharges, insurancePaid, patientResponsibility, services } };
        });

        // ================= AI ANALYSIS =================
        let aiResult = null;
        try {
          const combinedText = pages.map(p=>p.rawText).join("\n\n");
          const openModel = isPaid ? "gpt-4o" : "gpt-4o-mini";
          const gemModel = isPaid ? "gemini-1.5-pro" : "gemini-1.5-flash";

          const prompt = `You are an expert bill analyst. Analyze this extracted text:
"""${combinedText}"""
Return ONLY valid JSON with confidence, summary, keyAmounts, services, redFlags, explanation, nextSteps.`;

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
            results.sort((a,b)=>b.confidence-a.confidence);
            aiResult = results[0].data;
          }
        } catch(err){
          console.error("AI failed:", err);
        }

        const explanation = aiResult?.explanation || "We extracted key amounts successfully.";

        const finalResult = {
          summary: aiResult?.summary || "Your bill was analyzed.",
          summaryPoints: aiResult?.summaryPoints || [],
          keyAmounts: {
            totalCharges: aiResult?.keyAmounts?.totalCharges || pages[0].structured.totalCharges || "Not detected",
            insurancePaid: aiResult?.keyAmounts?.insurancePaid || pages[0].structured.insurancePaid || "Not detected",
            patientResponsibility: aiResult?.keyAmounts?.patientResponsibility || pages[0].structured.patientResponsibility || "Not detected"
          },
          services: aiResult?.services || pages.flatMap(p=>p.structured.services) || [],
          redFlags: aiResult?.redFlags || [],
          potentialSavings: isPaid ? (aiResult?.potentialSavings || null) : null,
          explanation,
          nextSteps: aiResult?.nextSteps || ["Double-check amounts","Contact provider","Compare at FairHealthConsumer.org"],
        };

        return new Response(JSON.stringify({ isPaid, pages, explanation: finalResult.explanation, structured: finalResult }), { headers: { "Content-Type": "application/json", ...cors } });

      } catch (err) {
        console.error("Processing failed:", err);
        return new Response(JSON.stringify({
          error: "Processing failed",
          pages: [{ rawText: "Unable to analyze bill.", structured: { explanation: "Try a clear photo or PDF." } }],
        }), { status: 500, headers: cors });
      }
    }

    // ================= ROOT PAGE =================
    return new Response(`
<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<title>ExplainMyBill API</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:system-ui;text-align:center;padding:4rem;background:#f8fafc;color:#1e40af;}h1{font-size:3rem;margin-bottom:1rem;}p{font-size:1.25rem;color:#0369a1;max-width:600px;margin:1rem auto;}code{background:#e0f2fe;padding:.25rem .5rem;border-radius:.5rem;}a{color:#1d4ed8;text-decoration:underline;}</style>
</head><body>
<h1>🟢 ExplainMyBill Worker Running</h1>
<p>This is the secure backend for <strong>ExplainMyBill</strong>.</p>
<p>Frontend: <a href="https://explain-my-bill-frontend.onrender.com" target="_blank">explain-my-bill-frontend.onrender.com</a></p>
<p><code>POST /</code> → Upload bill<br><code>POST /create-checkout-session</code> → Upgrade</p>
<p>Status: Active • Dec 29, 2025</p>
</body></html>
`, { status:200, headers:{ "Content-Type":"text/html", ...cors } });
  },
};

// ================= HELPER FUNCTIONS =================
async function fetchWithTimeout(url, opts = {}, timeout = 15000){
  const controller = new AbortController();
  const id = setTimeout(()=>controller.abort(), timeout);
  try { return await fetch(url, {...opts, signal:controller.signal}); } finally { clearTimeout(id); }
}

function uint8ArrayToBase64(uint8){
  let binary='';
  for(let i=0;i<uint8.length;i+=0x8000){ binary += String.fromCharCode(...uint8.subarray(i,i+0x8000)); }
  return btoa(binary);
}

async function extractWithGoogleVision(uint8, mimeType, env){
  const base64 = uint8ArrayToBase64(uint8);
  try {
    const res = await fetchWithTimeout(`https://vision.googleapis.com/v1/images:annotate?key=${env.GOOGLE_VISION_API_KEY}`,{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ requests:[{ image:{content:base64}, features:[{type:"DOCUMENT_TEXT_DETECTION"}], imageContext:{languageHints:["en"]}}] }),
    });
    if(!res.ok){ const err = await res.text(); console.error("Vision API error:",res.status,err); throw new Error(`Vision failed: ${res.status}`); }
    const data = await res.json();
    return data.responses?.[0]?.fullTextAnnotation?.text?.trim()||"";
  } catch(err){ console.error("Google Vision failed:", err); return ""; }
}

async function extractWithOcrSpace(uint8, mimeType, env){
  const base64 = uint8ArrayToBase64(uint8);
  try {
    const res = await fetch("https://api.ocr.space/parse/image",{ method:"POST", headers:{apikey:env.OCR_SPACE_API_KEY,"Content-Type":"application/x-www-form-urlencoded"}, body: new URLSearchParams({ base64Image:`data:${mimeType};base64,${base64}`, language:"eng", scale:"true", isTable:"true", OCREngine:"2" }) });
    const json = await res.json();
    return json.ParsedResults?.[0]?.ParsedText?.trim()||"";
  } catch(err){ console.error("OCR.space failed:", err); return ""; }
}

function parseResponse(data){
  try{
    let content = data.choices?.[0]?.message?.content || data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    content = content.replace(/^```json\n?/i,"").replace(/\n?```$/i,"").trim();
    return JSON.parse(content);
  }catch{ return null; }
}

async function processExcel(buffer){
  try{
    const XLSX = await import("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm");
    const wb = XLSX.read(new Uint8Array(buffer), { type:"array" });
    return wb.SheetNames.map((name,i)=>({ page:i+1, rawText:XLSX.utils.sheet_to_csv(wb.Sheets[name])||"" }));
  }catch(err){ console.error("Excel processing failed:",err); return [{page:1, rawText:"Could not read Excel file."}]; }
}

// ================= KEY AMOUNT EXTRACTION (MULTI-PAGE) =================
function extractAmountsPerService(text){
  const lines = text.split(/\r?\n/).map(l=>l.trim()).filter(l=>l);
  const services = [];
  let current = null;

  for(let i=0;i<lines.length;i++){
    const l = lines[i];
    const amtMatch = l.match(/\$?[\d,.]+/);
    if(/^[0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4}/.test(l)){ // Date line
      if(current) services.push(current);
      current = { date:l, description:"", charges:"", insurancePaid:"", patientResponsibility:"" };
    } else if(current){
      if(amtMatch){
        if(!current.charges) current.charges = amtMatch[0].replace(/[^\d.,]/g,"");
        else if(!current.patientResponsibility) current.patientResponsibility = amtMatch[0].replace(/[^\d.,]/g,"");
      } else {
        current.description += (current.description?" ":"")+l;
      }
    }
  }
  if(current) services.push(current);

  // Aggregate totals
  const totalCharges = services.reduce((a,s)=>a+(parseFloat(s.charges?.replace(/,/g,""))||0),0);
  const patientResponsibility = services.reduce((a,s)=>a+(parseFloat(s.patientResponsibility?.replace(/,/g,""))||0),0);
  const insurancePaid = totalCharges - patientResponsibility;

  return {
    services,
    totalCharges: totalCharges?`$${totalCharges.toFixed(2)}`:null,
    insurancePaid: insurancePaid?`$${insurancePaid.toFixed(2)}`:null,
    patientResponsibility: patientResponsibility?`$${patientResponsibility.toFixed(2)}`:null
  };
}
