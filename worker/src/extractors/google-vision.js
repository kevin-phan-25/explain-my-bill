import { uint8ArrayToBase64 } from "../utils/core.js";

export async function extractWithGoogleVision(uint8, mimeType, env, _extraction) {
  try {
    if (!env.GOOGLE_VISION_API_KEY) return { text: "", status: 0 };
    const base64 = uint8ArrayToBase64(uint8);
    const res = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${env.GOOGLE_VISION_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [
            {
              image: { content: base64 },
              features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
            },
          ],
        }),
      }
    );
    const status = res.status;
    if (!res.ok) return { text: "", status };
    const json = await res.json();
    const text = json.responses?.[0]?.fullTextAnnotation?.text || "";
    return { text, status };
  } catch {
    return { text: "", status: 0 };
  }
}

