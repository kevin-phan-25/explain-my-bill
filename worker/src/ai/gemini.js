import { safeParseJsonFromText } from "../utils/core.js";

/**
 * Google Gemini Bill Analysis
 * Updated: May 30, 2026
 */

export async function analyzeWithGemini_AIExtract(numberedLines, isPaid, env) {
  try {
    if (!env.GEMINI_API_KEY) {
      return { ok: false, provider: "gemini", error: "missing_key" };
    }

    const model = isPaid ? "gemini-1.5-pro" : "gemini-1.5-flash";

    const prompt = `You are ExplainMyBill — a trusted, careful, and conservative medical bill explainer.
Return ONLY valid JSON. No markdown, no extra text, no explanations outside the JSON.

Strict Rules:
- NEVER assume a large line-item charge (like a room charge or procedure fee) is what the patient owes.
- Only set patientResponsibility if you see clear language like "Amount Due", "You Owe", "Pay This Amount", "Patient Responsibility", "Balance Due", or "Amount You May Owe".
- "Insurance Paid" should include actual payments + contractual adjustments/write-offs.
- If unsure about any field, use null.
- Look for summary sections usually at the bottom or in boxed areas.

Few-shot examples:

1. Itemized bill only (no insurance info):
Lines:
120. TOTAL CHARGES $14,561.73
Correct: totalCharges: 14561.73, insurancePaid: null, patientResponsibility: null

2. EOB with adjustments:
Lines:
45. Total Charges: $8,450.00
48. Contractual Adjustments: -$6,200.00
52. Insurance Payment: $1,800.00
59. Amount You Owe: $450.00
Correct: totalCharges: 8450.00, insurancePaid: 8000.00, patientResponsibility: 450.00

3. Patient statement:
Lines:
30. Original Charges: $5,230.50
33. Insurance Paid: $5,000.00
38. Pay This Amount: $230.50
Correct: totalCharges: 5230.50, insurancePaid: 5000.00, patientResponsibility: 230.50

JSON schema to follow exactly:
{
  "summary": string,
  "explanation": string,
  "nextSteps": string[],
  "fields": {
    "totalCharges": {"amount": number|null, "currency": "USD", "citations": [...]},
    "insurancePaid": {"amount": number|null, "currency": "USD", "citations": [...]},
    "patientResponsibility": {"amount": number|null, "currency": "USD", "citations": [...]}
  }
}

NUMBERED LINES:
${numberedLines}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 28000); // 28 second timeout

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 2048,
            responseMimeType: "application/json"
          }
        }),
        signal: controller.signal,
      }
    );

    clearTimeout(timeout);

    const status = res.status;
    if (!res.ok) {
      console.error(`Gemini API error ${status}`);
      return { ok: false, provider: "gemini", status, error: "api_error" };
    }

    const json = await res.json();
    const out = json.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const parsed = safeParseJsonFromText(out);

    return { 
      ok: !!parsed, 
      provider: "gemini", 
      status, 
      ...parsed 
    };

  } catch (e) {
    if (e.name === "AbortError") {
      console.error("Gemini request timed out");
    } else {
      console.error("Gemini analysis error:", e.message);
    }
    return { 
      ok: false, 
      provider: "gemini", 
      error: e?.message || "unknown_error" 
    };
  }
}
