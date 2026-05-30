/**
 * PDF Text Extraction — Cloudflare Workers compatible
 * Uses unpdf (edge-safe, no dynamic CDN imports)
 * Updated: May 30, 2026
 */
import { extractText } from "unpdf";

export async function extractTextFromPDF(uint8) {
  try {
    const { text } = await extractText(uint8, { mergePages: true });
    return (text || "").trim();
  } catch (err) {
    console.error("PDF extraction failed:", err.message);
    return "";
  }
}
