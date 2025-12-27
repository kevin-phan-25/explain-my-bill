export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return new Response("ExplainMyBill – Google Vision OCR Worker", {
        headers: corsHeaders,
      });
    }

    try {
      const formData = await request.formData();
      const file = formData.get("bill");

      if (!file) throw new Error("No file uploaded");
      if (file.size > 10 * 1024 * 1024)
        throw new Error("File too large (max 10MB for Vision)");

      const fileName = file.name.toLowerCase();
      const buffer = await file.arrayBuffer();
      const base64 = safeBase64(new Uint8Array(buffer));

      let pages = [];

      if (fileName.endsWith(".pdf")) {
        pages = await ocrPdf(base64, env);
      } else if (fileName.match(/\.(jpg|jpeg|png)$/)) {
        pages = await ocrImage(base64, env);
      } else {
        throw new Error("Unsupported file type");
      }

      const combinedText = pages.map(p => p.rawText).join("\n\n").trim();
      const detected = combinedText.length > 30;

      return new Response(
        JSON.stringify({
          ocrDetected: detected,
          textLength: combinedText.length,
          pages,
          preview: detected ? combinedText.slice(0, 600) + "..." : "",
        }),
        {
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
        }
      );
    } catch (err) {
      console.error(err);
      return new Response(
        JSON.stringify({ error: err.message }),
        {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        }
      );
    }
  },
};

/* ================= GOOGLE VISION ================= */

async function ocrImage(base64, env) {
  const res = await fetch(
    `https://vision.googleapis.com/v1/images:annotate?key=${env.GOOGLE_VISION_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [
          {
            image: { content: base64 },
            features: [
              { type: "DOCUMENT_TEXT_DETECTION" },
              { type: "TEXT_DETECTION" },
            ],
            imageContext: { languageHints: ["en"] },
          },
        ],
      }),
    }
  );

  const data = await res.json();
  const resp = data.responses?.[0];

  const full =
    resp?.fullTextAnnotation?.text ||
    resp?.textAnnotations?.map(t => t.description).join("\n") ||
    "";

  return [{ page: 1, rawText: full.trim() }];
}

async function ocrPdf(base64, env) {
  const res = await fetch(
    `https://vision.googleapis.com/v1/files:annotate?key=${env.GOOGLE_VISION_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [
          {
            inputConfig: {
              content: base64,
              mimeType: "application/pdf",
            },
            features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
            pages: [1, 2, 3, 4, 5],
          },
        ],
      }),
    }
  );

  const data = await res.json();
  const responses = data.responses?.[0]?.responses || [];

  if (!responses.length) {
    return [{ page: 1, rawText: "" }];
  }

  return responses.map((r, i) => ({
    page: i + 1,
    rawText: r.fullTextAnnotation?.text?.trim() || "",
  }));
}

/* ================= SAFE BASE64 ================= */

function safeBase64(uint8) {
  let binary = "";
  const chunk = 0x4000;
  for (let i = 0; i < uint8.length; i += chunk) {
    binary += String.fromCharCode(...uint8.subarray(i, i + chunk));
  }
  return btoa(binary);
}