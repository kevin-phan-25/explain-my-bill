/**
 * PDF Text Extraction
 * Updated: May 30, 2026
 */

export async function extractTextFromPDF(uint8) {
  try {
    // Dynamic import of pdf.js (best practice on Cloudflare Workers)
    const pdfjs = await import("https://cdn.jsdelivr.net/npm/pdfjs-dist@4.5.136/+esm");

    const loadingTask = pdfjs.getDocument({ 
      data: uint8,
      // Optional: improve rendering for some scanned PDFs
      disableFontFace: true 
    });

    const pdf = await loadingTask.promise;
    let text = "";

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      
      const pageText = content.items
        .map((it) => (it?.str ? it.str : ""))
        .join(" ");

      text += pageText + "\n";
    }

    return text.trim();
  } catch (err) {
    console.error("PDF extraction failed:", err.message);
    return ""; // Return empty string so OCR fallback can trigger
  }
}
