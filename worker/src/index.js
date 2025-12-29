// ExplainMyBill Worker — FINAL FIX (Jan 2026)
// GUARANTEES OCR + STRUCTURED FALLBACK ALWAYS
// No more "Not detected"

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    try {
      const formData = await request.formData();
      const file = formData.get("bill");
      if (!file) throw new Error("No file uploaded");

      const buffer = await file.arrayBuffer();
      const base64 = uint8ArrayToBase64(new Uint8Array(buffer));
      const isPaid = Boolean(formData.get("sessionId"));

      /* ================= OCR ================= */
      let pages = [];
      const ocrRes = await fetch(
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

      const ocrData = await ocrRes.json();
      const rawText =
        ocrData?.responses?.[0]?.fullTextAnnotation?.text ||
        "";

      pages.push({
        page: 1,
        rawText: rawText || "[No readable text detected]",
      });

      /* ================= FALLBACK STRUCTURE (CRITICAL) ================= */
      const fallbackStructured = {
        summary: "Unable to confidently summarize this bill automatically.",
        summaryPoints: [],
        keyAmounts: {
          totalCharges: null,
          insuranceAdjusted: null,
          insurancePaid: null,
          patientResponsibility: null,
        },
        confidences: {
          totalCharges: 0,
          insuranceAdjusted: 0,
          insurancePaid: 0,
          patientResponsibility: 0,
        },
        services: [],
        redFlags: [],
        potentialSavings: null,
        explanation:
          "We were unable to fully analyze this bill automatically. The raw OCR text is provided below so you can still review the charges.",
        nextSteps: [
          "Review the OCR text for totals and insurance payments",
          "Compare charges with your Explanation of Benefits (EOB)",
          "Contact the provider billing department for clarification",
        ],
      };

      /* ================= AI ANALYSIS ================= */
      if (rawText.trim().length > 50) {
        try {
          const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env.OPENAI_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: isPaid ? "gpt-4o" : "gpt-4o-mini",
              messages: [
                {
                  role: "system",
                  content:
                    "Return ONLY valid JSON using the provided structure. No markdown.",
                },
                {
                  role: "user",
                  content: `
Analyze the medical bill and extract structured data.

JSON schema:
${JSON.stringify(fallbackStructured, null, 2)}

Bill text:
"""${rawText}"""
`,
                },
              ],
              temperature: 0.2,
            }),
          });

          const aiData = await aiRes.json();
          const parsed = JSON.parse(
            aiData.choices?.[0]?.message?.content || "{}"
          );

          pages[0].structured = {
            ...fallbackStructured,
            ...parsed,
            keyAmounts: {
              ...fallbackStructured.keyAmounts,
              ...(parsed.keyAmounts || {}),
            },
            confidences: {
              ...fallbackStructured.confidences,
              ...(parsed.confidences || {}),
            },
          };

          pages[0].explanation =
            parsed.explanation || fallbackStructured.explanation;
        } catch (err) {
          // AI failed — KEEP FALLBACK
          pages[0].structured = fallbackStructured;
          pages[0].explanation = fallbackStructured.explanation;
        }
      } else {
        pages[0].structured = fallbackStructured;
        pages[0].explanation = fallbackStructured.explanation;
      }

      /* ================= RESPONSE ================= */
      return new Response(
        JSON.stringify({
          pages,
          isPaid,
        }),
        {
          headers: { "Content-Type": "application/json", ...cors },
        }
      );
    } catch (err) {
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: 500, headers: cors }
      );
    }
  },
};

/* ================= UTIL ================= */
function uint8ArrayToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
