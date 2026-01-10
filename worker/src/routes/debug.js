import { jsonResponse } from "../utils/response.js";

export async function handleDebug(_request, env, corsHeaders) {
  return jsonResponse(
    {
      ok: true,
      devMode: String(env.DEV_MODE || "").toLowerCase() === "true",
      hasKeys: {
        OPENAI_API_KEY: !!env.OPENAI_API_KEY,
        GEMINI_API_KEY: !!env.GEMINI_API_KEY,
        GOOGLE_VISION_API_KEY: !!env.GOOGLE_VISION_API_KEY,
        OCR_SPACE_API_KEY: !!env.OCR_SPACE_API_KEY,
        STRIPE_SECRET_KEY: !!env.STRIPE_SECRET_KEY,
        STRIPE_PRICE_MONTHLY: !!env.STRIPE_PRICE_MONTHLY,
        STRIPE_PRICE_LIFETIME: !!env.STRIPE_PRICE_LIFETIME,
        STRIPE_PRICE_ONE_TIME: !!env.STRIPE_PRICE_ONE_TIME,
        DEV_KEY: !!env.DEV_KEY,
        DEV_MODE: !!env.DEV_MODE,
      },
    },
    corsHeaders
  );
}

