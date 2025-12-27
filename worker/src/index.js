export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      const formData = await request.formData();
      const file = formData.get("bill");
      if (!file) throw new Error("No file uploaded");

      const buffer = await file.arrayBuffer();
      const uint8 = new Uint8Array(buffer);
      const base64 = uint8ArrayToBase64(uint8);
      const fileName = file.name.toLowerCase();

      /* ================= OCR ================= */

      let ocrText = await ocrOCRSpace(uint8, fileName, env);

      if (ocrText.length < 40) {
        ocrText = fileName.endsWith(".pdf")
          ? await visionOCR(base64, env)
          : await visionOCR(base64, env);
      }

      if (ocrText.length < 40) {
        return json({
          explanation: "No readable text detected.",
          structured: emptyStructured(),
        }, cors);
      }

      /* ================= AI ANALYSIS ================= */

      const aiResult = env.OPENAI_API_KEY
        ? await analyzeWithOpenAI(ocrText, env)
        : await analyzeWithGemini(ocrText, env);

      return json({
        isPaid: false,
        explanation: aiResult.explanation,
        structured: aiResult.structured,
        features: {
          ocrStatus: "success",
          aiStatus: "success",
          confidence: aiResult.confidence,
        },
      }, cors);

    } catch (err) {
      return json({ error: err.message }, cors, 500);
    }
  },
};

/* ================= OCR ================= */

async function ocrOCRSpace(uint8, fileName, env) {
  const form = new FormData();
  form.append("file", new Blob([uint8]), fileName);
  form.append("language", "eng");
  form.append("OCREngine", "2");

  const res = await fetch("https://api.ocr.space/parse/image", {
    method: "POST",
    headers: { apikey: env.OCR_SPACE_API_KEY },
    body: form,
  });

  const data = await res.json();
  return data?.ParsedResults?.map(p => p.ParsedText).join("\n") || "";
}

async function visionOCR(base64, env) {
  const res = await fetch(
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

  const json = await res.json();
  return json.responses?.[0]?.fullTextAnnotation?.text || "";
}

/* ================= AI ================= */

async function analyzeWithOpenAI(text, env) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [{
        role: "system",
        content: "Extract medical bill amounts. Respond ONLY JSON.",
      },{
        role: "user",
        content: text,
      }],
    }),
  });

  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

async function analyzeWithGemini(text, env) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1/models/gemini-pro:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
      }),
    }
  );

  const data = await res.json();
  return JSON.parse(data.candidates[0].content.parts[0].text);
}

/* ================= HELPERS ================= */

function emptyStructured() {
  return {
    summary: "",
    keyAmounts: {
      totalCharges: null,
      insurancePaid: null,
      patientResponsibility: null,
    },
  };
}

function uint8ArrayToBase64(arr) {
  let binary = "";
  for (let i = 0; i < arr.length; i += 0x8000) {
    binary += String.fromCharCode(...arr.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function json(data, headers, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}