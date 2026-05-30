import { uint8ArrayToBase64 } from "../utils/core.js";

/**
 * Google Vision OCR Extraction
 * Updated: May 30, 2026
 */

/**
 * Extract text from images using Google Cloud Vision API
 * @param {Uint8Array} uint8 - Image buffer
 * @param {string} mimeType - MIME type of the image
 * @param {Object} env - Environment variables (contains GOOGLE_VISION_API_KEY)
 */
export async function extractWithGoogleVision(uint8, mimeType, env) {
  try {
    if (!env.GOOGLE_VISION_API_KEY) {
      console.warn("Google Vision API key is missing");
      return { text: "", status: 0, error: "missing_key" };
    }

    const base64 = uint8ArrayToBase64(uint8);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000); // 20 second timeout

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
              // Optional: can add imageContext for better results on some bills
              // imageContext: { languageHints: ["en"] }
            },
          ],
        }),
        signal: controller.signal,
      }
    );

    clearTimeout(timeout);

    const status = res.status;

    if (!res.ok) {
      console.error(`Google Vision API error: ${status}`);
      return { text: "", status, error: "api_error" };
    }

    const json = await res.json();
    const text = json.responses?.[0]?.fullTextAnnotation?.text || "";

    return { 
      text, 
      status,
      provider: "google-vision"
    };

  } catch (err) {
    if (err.name === "AbortError") {
      console.error("Google Vision request timed out");
    } else {
      console.error("Google Vision extraction failed:", err.message);
    }
    return { 
      text: "", 
      status: 0, 
      error: err?.message || "unknown_error" 
    };
  }
}
