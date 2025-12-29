// ExplainMyBill Worker – FINAL WITH GOOGLE VISION (Best Accuracy) + Regex Fallback
// No Tesseract — avoids runtime errors

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Dev-Bypass",
    };

    if (request.method === "OPTIONS") {
      const h = request.headers.get("Access-Control-Request-Headers");
      if (h) cors["Access-Control-Allow-Headers"] = h;
      return new Response(null, { headers: cors });
    }

    // STRIPE (unchanged)
    // ... keep your Stripe code

    if (request.method === "POST") {
      try {
        const form = await request.formData();
        const file = form.get("bill") || form.get("file");
        const sessionId = form.get("sessionId");

        if (!file || file.size === 0) throw new Error("No file uploaded");

        const name = file.name.toLowerCase();
        const allowed = [".pdf",".png",".jpg",".jpeg",".xlsx",".xls"];
        if (!allowed.some(e => name.endsWith(e))) throw new Error("Unsupported file type");

        let isPaid = false;
        // ... paid check unchanged

        const buf = await file.arrayBuffer();
        const u8 = new Uint8Array(buf);

        let text = "";

        // EXCEL
        if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
          const pages = await processExcel(buf);
          text = pages.map(p => p.rawText).join("\n\n");
        } 
        // PRIMARY: Google Vision (best for medical bills)
        else if (env.GOOGLE_VISION_API_KEY) {
          text = await extractWithGoogleVision(u8, file.type, env);
        }
        // FALLBACK: OCR.space (if no Vision key)
        else {
          text = await extractWithOcrSpace(u8, file.type, env);
        }

        if (!text || text.length < 50) {
          text = "We couldn't read clear text from your bill. Try a straight, well-lit photo of the summary page.";
        }

        // ULTRA-STRONG REGEX
        const getAmount = (patterns) => {
          for (const p of patterns) {
            const m = text.match(p);
            if (m) {
              let num = m[1].replace(/[^\d.,]/g, "").trim();
              num = num.replace(/O/g, "0").replace(/o/g, "0").replace(/l/g, "1").replace(/I/g, "1").replace(/S/g, "5");
              return num ? "$" + num : null;
            }
          }
          return null;
        };

        const totalCharges = getAmount([
          /total\s*(?:charges?|billed|amount|due|balance|cost|fees?)[\s:]*\$?([\d.,]+)/i,
          /amount\s*(?:billed|charged|due|total|owed)[\s:]*\$?([\d.,]+)/i,
          /gross\s*charges?[\s:]*\$?([\d.,]+)/i,
          /subtotal[\s:]*\$?([\d.,]+)/i,
          /statement\s*balance[\s:]*\$?([\d.,]+)/i,
          /charges?\s*total[\s:]*\$?([\d.,]+)/i,
        ]);

        const insurancePaid = getAmount([
          /insurance\s*(?:paid|payment|adjustment|allowed|credit|reimbursement|benefit)[\s:]*\$?([\d.,]+)/i,
          /paid\s*by\s*insurance[\s:]*\$?([\d.,]+)/i,
          /contractual\s*(?:adjustment|write.?off|discount|savings)[\s:]*\$?([\d.,]+)/i,
          /insurance\s*adjustment[\s:]*\$?([\d.,]+)/i,
          /allowed\s*amount[\s:]*\$?([\d.,]+)/i,
          /network\s*savings[\s:]*\$?([\d.,]+)/i,
        ]);

        const patientDue = getAmount([
          /patient\s*(?:responsibility|due|balance|owe|amount\s*due|portion|liability|share)[\s:]*\$?([\d.,]+)/i,
          /you\s*owe[\s:]*\$?([\d.,]+)/i,
          /amount\s*due[\s:]*\$?([\d.,]+)/i,
          /balance\s*due[\s:]*\$?([\d.,]+)/i,
          /patient\s*balance[\s:]*\$?([\d.,]+)/i,
          /your\s*responsibility[\s:]*\$?([\d.,]+)/i,
          /current\s*amount\s*due[\s:]*\$?([\d.,]+)/i,
          /please\s*pay\s*this\s*amount[\s:]*\$?([\d.,]+)/i,
        ]);

        // AI + MERGE (same as before)
        // ... keep your AI code

        const result = {
          // ... merge AI + regex as before
          keyAmounts: {
            totalCharges: aiResult?.keyAmounts?.totalCharges || totalCharges || "Not detected",
            insurancePaid: aiResult?.keyAmounts?.insurancePaid || insurancePaid || "Not detected",
            patientResponsibility: aiResult?.keyAmounts?.patientResponsibility || patientDue || "Not detected",
          },
          // ...
        };

        // ... return response
      } catch (e) {
        // ... error handling
      }
    }
  },
};

// NEW: Google Vision OCR
async function extractWithGoogleVision(u8, mimeType, env) {
  const base64 = uint8ArrayToBase64(u8);
  try {
    const res = await fetchWithTimeout("https://vision.googleapis.com/v1/images:annotate?key=" + env.GOOGLE_VISION_API_KEY, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [{
          image: { content: base64 },
          features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
          imageContext: { languageHints: ["en"] },
        }],
      }),
    });
    const data = await res.json();
    return data.responses?.[0]?.fullTextAnnotation?.text?.trim() || "";
  } catch (err) {
    console.error("Google Vision failed:", err);
    return "";
  }
}

// Keep OCR.space as secondary fallback
// ... keep extractWithOcrSpace, processExcel, etc.
