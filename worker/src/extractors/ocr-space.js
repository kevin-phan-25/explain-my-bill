import { uint8ArrayToBase64 } from "../utils/core.js";

/**
 * OCR.space Text Extraction
 * Updated: May 30, 2026
 */

/**
 * Extract text from images/PDFs using OCR.space API
 * @param {Uint8Array} uint8 - File buffer
 * @param {string} mimeType - MIME type (e.g. "image/jpeg", "application/pdf")
 * @param {Object} env - Environment variables (contains OCR_SPACE_API_KEY)
 */
export async function extractWithOcrSpace(uint8, mimeType, env) {
  try {
    if (!env.OCR_SPACE_API_KEY) {
      console.warn("OCR.space API key is missing");
      return { text: "", status: 0, error: "missing_key" };
    }

    const base64 = uint8ArrayToBase64(uint8);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000); // 25 second timeout

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
        OCREngine: "2",           // Higher accuracy engine
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const status = res.status;

    if (!res.ok) {
      console.error(`OCR.space API error: ${status}`);
      return { text: "", status, error: "api_error" };
    }

    const json = await res.json();
    const text = json.ParsedResults?.[0]?.ParsedText || "";

    return { 
      text, 
      status,
      provider: "ocr-space"
    };

  } catch (err) {
    if (err.name === "AbortError") {
      console.error("OCR.space request timed out");
    } else {
      console.error("OCR.space extraction failed:", err.message);
    }
    return { 
      text: "", 
      status: 0, 
      error: err?.message || "unknown_error" 
    };
  }
}
