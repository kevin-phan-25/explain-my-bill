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
      return new Response("ExplainMyBill OCR Worker running", { headers: corsHeaders });
    }

    try {
      const formData = await request.formData();
      const file = formData.get("bill");

      if (!file) throw new Error("No file uploaded");
      if (file.size > 20 * 1024 * 1024) throw new Error("File too large (20MB max)");

      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const base64 = uint8ArrayToBase64(bytes);
      const fileName = file.name.toLowerCase();

      let pages = [];
      let ocrEngineUsed = "none";

      /* ================= GOOGLE VISION FIRST ================= */

      try {
        if (fileName.endsWith(".pdf")) {
          pages = await googlePdfOCR(buffer, env);
        } else {
          pages = await googleImageOCR(base64, env);
        }

        if (pages.some(p => p.rawText && p.rawText.length > 40)) {
          ocrEngineUsed = "google";
        } else {
          pages = [];
        }
      } catch (err) {
        console.error("Google OCR failed:", err);
        pages = [];
      }

      /* ================= OCR.SPACE FALLBACK ================= */

      if (pages.length === 0) {
        if (fileName.endsWith(".pdf")) {
          pages = await ocrSpacePdfOCR(base64, env);
        } else {
          pages = await ocrSpaceImageOCR(base64, env);
        }
        ocrEngineUsed = "ocr_space";
      }

      const combinedText = pages.map(p => p.rawText || "").join("\n\n").trim();
      const detected = combinedText.length > 40;

      return new Response(
        JSON.stringify({
          success: true,
          detected,
          ocrEngineUsed,
          textLength: combinedText.length,
          pages: pages.map(p => ({
            page: p.page,
            hasText: p.rawText.length > 0,
          })),
          preview: detected ? combinedText.slice(0, 600) : "",
        }),
        { headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    } catch (err) {
      console.error("Worker fatal error:", err);
      return new Response(
        JSON.stringify({ success: false, error: err.message }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }
  },
};

/* ===================================================== */
/* ================= GOOGLE VISION ===================== */
/* ===================================================== */

async function googleImageOCR(base64, env) {
  const res = await fetch(
    `https://vision.googleapis.com/v1/images:annotate?key=${env.GOOGLE_VISION_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [{
          image: { content: base64 },
          features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
          imageContext: { languageHints: ["en"] },
        }],
      }),
    }
  );

  const data = await res.json();
  const text =
    data.responses?.[0]?.fullTextAnnotation?.text ||
    data.responses?.[0]?.textAnnotations?.[0]?.description ||
    "";

  return [{ page: 1, rawText: text.trim() }];
}

async function googlePdfOCR(buffer, env) {
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
        rawText: r.fullTextAnnotation?.text?.trim() || "",
      }));
    }
  }

  return [];
}

/* ===================================================== */
/* ================= OCR.SPACE ========================= */
/* ===================================================== */

async function ocrSpaceImageOCR(base64, env) {
  const res = await fetch("https://api.ocr.space/parse/image", {
    method: "POST",
    headers: {
      apikey: env.OCR_SPACE_API_KEY,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      base64Image: `data:image/jpeg;base64,${base64}`,
      language: "eng",
      OCREngine: "2",
      scale: "true",
    }),
  });

  const data = await res.json();
  const text = data.ParsedResults?.[0]?.ParsedText || "";
  return [{ page: 1, rawText: text.trim() }];
}

async function ocrSpacePdfOCR(base64, env) {
  const res = await fetch("https://api.ocr.space/parse/image", {
    method: "POST",
    headers: {
      apikey: env.OCR_SPACE_API_KEY,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      base64Image: `data:application/pdf;base64,${base64}`,
      language: "eng",
      OCREngine: "2",
      isOverlayRequired: "false",
    }),
  });

  const data = await res.json();
  const text = data.ParsedResults?.[0]?.ParsedText || "";
  return [{ page: 1, rawText: text.trim() }];
}

/* ===================================================== */
/* ================= UTILS ============================== */
/* ===================================================== */

function uint8ArrayToBase64(arr) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < arr.length; i += chunk) {
    binary += String.fromCharCode(...arr.subarray(i, i + chunk));
  }
  return btoa(binary);
}