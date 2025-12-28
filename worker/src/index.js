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
      return new Response("ExplainMyBill Worker running", { headers: corsHeaders });
    }

    try {
      const formData = await request.formData();
      const file = formData.get("bill");
      if (!file) throw new Error("No file uploaded");
      if (file.size > 20 * 1024 * 1024) throw new Error("File too large");

      const buffer = await file.arrayBuffer();
      const base64 = uint8ArrayToBase64(new Uint8Array(buffer));
      const fileName = file.name.toLowerCase();

      let pages = [];

      if (fileName.endsWith(".pdf")) {
        pages = await ocrPdf(buffer, env);
      } else if (fileName.match(/\.(png|jpg|jpeg)$/)) {
        pages = await ocrImage(base64, env);
      } else {
        throw new Error("Unsupported file type");
      }

      const combinedText = pages.map(p => p.rawText).join("\n\n").trim();
      const ocrDetected = combinedText.length > 40;

      // ================= AI ANALYSIS =================
      let structured = null;
      let aiStatus = "skipped";

      if (ocrDetected) {
        structured = await runAIAnalysis(combinedText, env, ctx);
        aiStatus = structured ? "success" : "failed";
      }

      return new Response(
        JSON.stringify({
          explanation: structured?.explanation ||
            (ocrDetected
              ? "OCR successful. AI analysis unavailable."
              : "No readable text detected."),
          structured,
          rawTextPreview: combinedText.slice(0, 3000),
          features: {
            ocrStatus: ocrDetected ? "success" : "failed",
            aiStatus,
          },
        }),
        { headers: { "Content-Type": "application/json", ...corsHeaders } }
      );

    } catch (err) {
      console.error("Worker failure:", err);
      return new Response(
        JSON.stringify({ error: err.message || "Processing failed" }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }
  },
};

/* ================= OCR ================= */

async function ocrImage(base64, env) {
  const enhanced = await enhanceImage(base64);

  const res = await fetch(
    `https://vision.googleapis.com/v1/images:annotate?key=${env.GOOGLE_VISION_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [{
          image: { content: enhanced },
          features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
        }],
      }),
    }
  );

  const data = await res.json();
  const text = data.responses?.[0]?.fullTextAnnotation?.text || "";

  return [{ page: 1, rawText: text }];
}

async function ocrPdf(buffer, env) {
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

  for (let i = 0; i < 25; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const poll = await fetch(
      `https://vision.googleapis.com/v1/${name}?key=${env.GOOGLE_VISION_API_KEY}`
    );
    const data = await poll.json();
    if (data.done) {
      return (data.responses || []).map((r, i) => ({
        page: i + 1,
        rawText: r.fullTextAnnotation?.text || "",
      }));
    }
  }

  return [{ page: 1, rawText: "" }];
}

/* ================= AI ================= */

async function runAIAnalysis(text, env, ctx) {
  const prompt = `
You are a medical bill expert.
Respond ONLY in valid JSON matching this schema:

{
  "summary": string,
  "keyAmounts": {
    "totalCharges": number|null,
    "insurancePaid": number|null,
    "patientResponsibility": number|null
  },
  "explanation": string
}

Bill text:
"""${text}"""
`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: prompt }],
          temperature: 0,
          response_format: { type: "json_object" }, // 🔒 FORCE JSON
        }),
      });

      const data = await res.json();
      const raw = data.choices?.[0]?.message?.content || "";

      // SAFE LOG (never returned to user)
      ctx.waitUntil(logAI(raw));

      const parsed = safeJsonParse(raw);
      if (parsed) return parsed;

    } catch (err) {
      console.error("AI attempt failed:", err);
    }

    await new Promise(r => setTimeout(r, 1000 * attempt));
  }

  return null;
}

/* ================= IMAGE ENHANCE ================= */

async function enhanceImage(base64) {
  try {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const img = await createImageBitmap(new Blob([bytes]));

    const scale = Math.max(1600 / img.width, 1600 / img.height, 1.5);
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

function safeJsonParse(input) {
  try {
    return JSON.parse(
      input.replace(/```json|```/g, "").trim()
    );
  } catch {
    return null;
  }
}

async function logAI(text) {
  console.log("AI RAW OUTPUT (SAFE):", text.slice(0, 1000));
}