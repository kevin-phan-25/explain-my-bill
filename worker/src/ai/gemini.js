import { safeParseJsonFromText } from "../utils/core.js";

export async function analyzeWithGemini_AIExtract(numberedLines, isPaid, env) {
  try {
    if (!env.GEMINI_API_KEY) return { ok: false, provider: "gemini", error: "missing_key" };
    const model = isPaid ? "gemini-1.5-pro" : "gemini-1.5-flash";
    const prompt = `Return ONLY valid JSON (no markdown).
Rules and few-shot examples identical to OpenAI above.
NUMBERED LINES:\n${numberedLines}`;
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      }
    );
    const status = res.status;
    if (!res.ok) return { ok: false, provider: "gemini", status };
    const json = await res.json();
    const out = json.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const parsed = safeParseJsonFromText(out);
    return { ok: !!parsed, provider: "gemini", status, ...parsed };
  } catch (e) {
    return { ok: false, provider: "gemini", error: e?.message || "error" };
  }
}

