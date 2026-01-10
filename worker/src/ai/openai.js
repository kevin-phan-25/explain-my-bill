import { safeParseJsonFromText } from "../utils/core.js";

export async function analyzeWithOpenAI_AIExtract(numberedLines, isPaid, env) {
  try {
    if (!env.OPENAI_API_KEY) return { ok: false, provider: "openai", error: "missing_key" };
    const model = isPaid ? "gpt-4o" : "gpt-4o-mini";
    const system = `You are ExplainMyBill — a trusted, careful medical bill explainer.
Return ONLY valid JSON. No markdown.
Rules:
- NEVER assume a large line-item charge (like a room charge) is what the patient owes.
- If there's no clear "Amount Due", "You Owe", "Pay This Amount", or "Patient Responsibility", use null for patientResponsibility.
- "Insurance Paid" includes both direct payments AND contractual adjustments/write-offs.
- Look for summary boxes — usually at bottom or right.
- Do NOT guess. Use null if unsure.
Few-shot examples:
1. Itemized bill only (no insurance):
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
JSON schema:
{
  "summary": string,
  "explanation": string,
  "nextSteps": string[],
  "fields": {
    "totalCharges": {"amount": number|null, "currency": "USD", "citations": [...]},
    "insurancePaid": {"amount": number|null, "currency": "USD", "citations": [...]},
    "patientResponsibility": {"amount": number|null, "currency": "USD", "citations": [...]}
  }
}`;
    const user = `Extract the three key amounts with citations and explain the bill in plain English.\n\nNUMBERED LINES:\n${numberedLines}`;
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0,
      }),
    });
    const status = res.status;
    if (!res.ok) return { ok: false, provider: "openai", status };
    const json = await res.json();
    const content = json.choices?.[0]?.message?.content || "";
    const parsed = safeParseJsonFromText(content);
    return { ok: !!parsed, provider: "openai", status, ...parsed };
  } catch (e) {
    return { ok: false, provider: "openai", error: e?.message || "error" };
  }
}

