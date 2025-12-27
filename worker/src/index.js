export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return new Response("ExplainMyBill worker running", { headers: corsHeaders });
    }

    try {
      const formData = await request.formData();
      const file = formData.get("bill");
      if (!file) throw new Error("No file uploaded");
      if (file.size > 20 * 1024 * 1024) throw new Error("File too large (20MB max)");

      const buffer = await file.arrayBuffer();
      const base64 = uint8ArrayToBase64(new Uint8Array(buffer));
      const fileName = file.name.toLowerCase();

      let pages = [];

      if (fileName.endsWith(".pdf")) {
        pages = await ocrPdf(buffer, env);
      } else {
        pages = await ocrImage(base64, env);
      }

      const combinedText = pages.map(p => p.rawText || "").join("\n").trim();
      const ocrDetected = combinedText.length > 40;

      // ---- REGEX FALLBACK (NO AI)
      const regexAmounts = extractDollarAmounts(combinedText);

      let structured = fallbackStructured();
      structured.keyAmounts = regexAmounts;

      let explanation = ocrDetected
        ? "Text detected. Analyzing your bill..."
        : "No readable text detected. Try a clearer scan or PDF.";

      // ---- AI ANALYSIS (RESTORED)
      let aiExplanation = null;

      if (ocrDetected) {
        aiExplanation = await analyzeWithAI(combinedText, env);
      }

      return new Response(
        JSON.stringify({
          isPaid: false,
          explanation: aiExplanation || explanation,
          features: {
            ocrStatus: ocrDetected ? "success" : "failed",
            confidence: aiExplanation ? "medium" : "low",
            textLength: combinedText.length,
          },
          pages: pages.map(p => ({ page: p.page, hasText: !!p.rawText })),
          rawTextPreview: combinedText.slice(0, 800),
          structured,
        }),
        { headers: { "Content-Type": "application/json", ...corsHeaders } }
      );

    } catch (err) {
      console.error("Worker fatal error:", err);
      return new Response(
        JSON.stringify({ error: err.message || "Processing failed" }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }
  },
};

/* ================= OCR ================= */

async function ocrImage(base64, env) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const enhanced = await upscaleImage(base64);

      const res = await fetch(
        `https://vision.googleapis.com/v1/images:annotate?key=${env.GOOGLE_VISION_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requests: [{
              image: { content: enhanced },
              features: [
                { type: "DOCUMENT_TEXT_DETECTION" },
                { type: "TEXT_DETECTION" },
              ],
              imageContext: { languageHints: ["en"] },
            }],
          }),
        }
      );

      const data = await res.json();
      const r = data.responses?.[0];
      if (!r) continue;

      const docText = r.fullTextAnnotation?.text || "";
      const fallback = r.textAnnotations?.map(t => t.description).join("\n") || "";
      const best = docText.length > fallback.length ? docText : fallback;

      if (best.trim().length > 40) {
        return [{ page: 1, rawText: best.trim() }];
      }
    } catch (e) {
      console.error("Image OCR attempt failed:", e);
    }
  }
  return [{ page: 1, rawText: "" }];
}

async function ocrPdf(buffer, env) {
  try {
    const base64 = uint8ArrayToBase64(new Uint8Array(buffer));

    const start = await fetch(
      `https://vision.googleapis.com/v1/files:asyncBatchAnnotate?key=${env.GOOGLE_VISION_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [{
            inputConfig: { content: base64, mimeType: "application/pdf" },
            features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
          }],
        }),
      }
    );

    const { name } = await start.json();

    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 1500));

      const poll = await fetch(
        `https://vision.googleapis.com/v1/${name}?key=${env.GOOGLE_VISION_API_KEY}`
      );

      const data = await poll.json();
      if (data.done && data.responses) {
        return data.responses.map((r, i) => ({
          page: i + 1,
          rawText: r.fullTextAnnotation?.text || "",
        }));
      }
    }
  } catch (e) {
    console.error("PDF OCR failed:", e);
  }

  return [{ page: 1, rawText: "" }];
}

/* ================= AI ================= */

async function analyzeWithAI(text, env) {
  try {
    // ---- OpenAI (primary)
    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You explain medical bills clearly. Do not hallucinate numbers." },
          { role: "user", content: text.slice(0, 12000) },
        ],
        temperature: 0.2,
      }),
    });

    if (openaiRes.ok) {
      const data = await openaiRes.json();
      return data.choices?.[0]?.message?.content;
    }
  } catch (e) {
    console.warn("OpenAI failed, falling back to Gemini");
  }

  // ---- Gemini fallback
  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text }] }],
        }),
      }
    );

    const data = await geminiRes.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text;
  } catch {
    return "AI analysis unavailable. OCR text extracted successfully.";
  }
}

/* ================= IMAGE ENHANCEMENT ================= */

async function upscaleImage(base64) {
  try {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const img = await createImageBitmap(new Blob([bytes]));

    const scale = Math.max(1600 / img.width, 1600 / img.height, 1.3);
    const canvas = new OffscreenCanvas(img.width * scale, img.height * scale);
    const ctx = canvas.getContext("2d");

    ctx.filter = "contrast(1.6) brightness(1.2)";
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
    return uint8ArrayToBase64(new Uint8Array(await blob.arrayBuffer()));
  } catch {
    return base64;
  }
}

/* ================= UTILS ================= */

function uint8ArrayToBase64(arr) {
  let binary = "";
  for (let i = 0; i < arr.length; i += 0x8000) {
    binary += String.fromCharCode(...arr.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function extractDollarAmounts(text) {
  const nums = [...text.matchAll(/\$?\s*([\d,]+\.?\d{0,2})/g)]
    .map(m => parseFloat(m[1].replace(/,/g, "")))
    .filter(n => n > 0)
    .sort((a, b) => b - a);

  return {
    totalCharges: nums[0] || null,
    insurancePaid: nums[1] || null,
    patientResponsibility: nums[2] || null,
  };
}

function fallbackStructured() {
  return {
    summary: "OCR-based bill review",
    keyAmounts: {
      totalCharges: null,
      insurancePaid: null,
      patientResponsibility: null,
    },
  };
}