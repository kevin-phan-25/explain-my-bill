import { uint8ArrayToBase64 } from "../utils/core.js";

export async function extractWithOcrSpace(uint8, mimeType, env, _extraction) {
  try {
    if (!env.OCR_SPACE_API_KEY) return { text: "", status: 0 };
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
        isOverlayRequired: "false",
        scale: "true",
        OCREngine: "2",
      }),
    });
    const status = res.status;
    if (!res.ok) return { text: "", status };
    const json = await res.json();
    const text = json.ParsedResults?.[0]?.ParsedText || "";
    return { text, status };
  } catch {
    return { text: "", status: 0 };
  }
}

