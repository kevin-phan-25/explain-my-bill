// ExplainMyBill Worker – Robust Error Handling + Correct Vision Endpoints (Dec 2025)

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // =====================
    // CORS
    // =====================
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Dev-Bypass",
    };

    if (request.method === "OPTIONS") {
      const requestedHeaders = request.headers.get("Access-Control-Request-Headers");
      if (requestedHeaders) {
        corsHeaders["Access-Control-Allow-Headers"] = requestedHeaders;
      }
      return new Response(null, { headers: corsHeaders });
    }

    // =====================
    // STRIPE CHECKOUT
    // =====================
    if (url.pathname === "/create-checkout-session" && request.method === "POST") {
      // (unchanged – keep your existing Stripe code)
      // ...
    }

    // =====================
    // MAIN BILL PROCESSING
    // =====================
    if (request.method === "POST") {
      try {
        const formData = await request.formData();
        const billFile = formData.get("bill");
        const sessionId = formData.get("sessionId") || url.searchParams.get("session_id");

        if (!billFile || billFile.size === 0) {
          return new Response(JSON.stringify({ error: "No bill uploaded" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }

        const isPaid = Boolean(sessionId);

        const buffer = await billFile.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        const base64 = btoa(String.fromCharCode(...bytes));
        const fileName = billFile.name.toLowerCase();

        let pages = [];

        // =====================
        // OCR – Correct & Safe
        // =====================
        try {
          if (fileName.endsWith(".xlsx") || fileName.endsWith(".xls")) {
            pages = await processExcel(buffer);
          } else if (fileName.endsWith(".pdf") || fileName.endsWith(".tiff") || fileName.endsWith(".tif") || fileName.endsWith(".gif")) {
            const mimeType = fileName.endsWith(".pdf") ? "application/pdf" : fileName.endsWith(".gif") ? "image/gif" : "image/tiff";

            const res = await fetch(
              `https://vision.googleapis.com/v1/files:annotate?key=${env.GOOGLE_VISION_API_KEY}`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  requests: [{
                    inputConfig: { content: base64, mimeType },
                    features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
                  }],
                }),
              }
            );

            const data = await res.json();

            if (data.error) {
              throw new Error(`Vision API error: ${data.error.message || JSON.stringify(data.error)}`);
            }

            const pageResponses = data.responses?.[0]?.responses || [];
            pages = pageResponses.map((r, i) => ({
              page: i + 1,
              rawText: r.fullTextAnnotation?.text || "[No text on this page]",
            })) || [{ page: 1, rawText: "[No pages returned]" }];
          } else {
            // Single image
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

            const data = await res.json();

            if (data.error) {
              throw new Error(`Vision API error: ${data.error.message || JSON.stringify(data.error)}`);
            }

            pages = [{
              page: 1,
              rawText: data.responses?.[0]?.fullTextAnnotation?.text || "[No text found]",
            }];
          }
        } catch (ocrErr) {
          // Safe fallback – don't let OCR crash the whole worker
          console.error("OCR failed:", ocrErr.message);
          pages = [{ page: 1, rawText: "[OCR failed – check Vision API key/quota]" }];
        }

        // =====================
        // AI ANALYSIS (unchanged but wrapped safely)
        // =====================
        for (const page of pages) {
          try {
            // Your existing prompt and AI calls here...
            // (keep exactly as before)

            // If AI fails, fallback
            page.structured = fallbackStructured(isPaid);
            page.explanation = page.structured.explanation;
          } catch (aiErr) {
            console.error("AI analysis failed for page:", aiErr.message);
            page.structured = fallbackStructured(isPaid);
            page.explanation = "Analysis temporarily unavailable.";
          }
        }

        const fullExplanation = pages.map(p => p.explanation).join("\n\n");

        return new Response(JSON.stringify({
          isPaid,
          pages: pages.map(p => ({ page: p.page, structured: p.structured, explanation: p.explanation })),
          explanation: fullExplanation,
        }), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });

      } catch (err) {
        // Prevent stack overflow by safe stringification
        const safeMessage = err.message || "Unknown processing error";
        console.error("Fatal worker error:", safeMessage);

        return new Response(JSON.stringify({ error: safeMessage }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }

    return new Response("ExplainMyBill Worker – Running", { headers: corsHeaders });
  },
};

// Add this fallback to avoid null crashes
function fallbackStructured(isPaid) {
  return {
    summary: "Analysis in progress.",
    summaryPoints: ["Processing your bill", "Please wait or try again"],
    keyAmounts: { totalCharges: null, insuranceAdjusted: null, insurancePaid: null, patientResponsibility: null },
    confidences: { totalCharges: 0, insuranceAdjusted: 0, insurancePaid: 0, patientResponsibility: 0 },
    services: [],
    redFlags: [],
    explanation: isPaid 
      ? "Temporary issue with analysis. Please try again soon." 
      : "Basic analysis unavailable. Upgrade for full review.",
    nextSteps: ["Try uploading again", "Check your bill is clear and well-lit"],
  };
}

// Keep your existing helpers: parseAiResponse, parseGeminiResponse, mergeWithConfidence, processExcel
// (unchanged from previous versions)