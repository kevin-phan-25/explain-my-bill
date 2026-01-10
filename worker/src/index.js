// ExplainMyBill Worker — PRODUCTION-OPTIMIZED FINAL MERGED (December 30, 2025)
// ✅ Full Stripe checkout (subscription + one-time + lifetime)
// ✅ All power tools live
// ✅ Massively expanded & accurate 2025 overcharge benchmarks
// ✅ Production-hardened: concise, fast, secure
// ✅ No data retention • Not HIPAA-certified • Privacy-first
// ✅ Every line preserved and merged — nothing removed

import { buildCorsHeaders } from "./middleware/cors.js";
import { jsonResponse, errorResponse } from "./utils/response.js";

import { handleDebug } from "./routes/debug.js";
import { handleStripeCheckout } from "./routes/stripe.js";
import { handleBillProcessing } from "./routes/bill-processing.js";

import { handleEOBComparison } from "./routes/power-tools/eob.js";
import { handleAppealLetter } from "./routes/power-tools/appeal.js";
import { handleOverchargeDetection } from "./routes/power-tools/overcharge.js";
import { handlePriorAuth } from "./routes/power-tools/prior-auth.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const corsHeaders = buildCorsHeaders(request);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // === STRIPE CHECKOUT HANDLER ===
      if (url.pathname === "/create-checkout-session" && request.method === "POST") {
        return await handleStripeCheckout(request, env, corsHeaders);
      }

      // === DEBUG ENDPOINT ===
      if (url.pathname === "/debug" && request.method === "GET") {
        return await handleDebug(request, env, corsHeaders);
      }

      // === INSURANCE CLAIM POWER TOOLS ===
      if (url.pathname === "/compare-eob" && request.method === "POST") {
        return await handleEOBComparison(request, env, corsHeaders);
      }
      if (url.pathname === "/generate-appeal" && request.method === "POST") {
        return await handleAppealLetter(request, env, corsHeaders);
      }
      if (url.pathname === "/detect-overcharge" && request.method === "POST") {
        return await handleOverchargeDetection(request, env, corsHeaders);
      }
      if (url.pathname === "/prior-auth" && (request.method === "GET" || request.method === "POST")) {
        return await handlePriorAuth(request, env, corsHeaders);
      }

      // === SINGLE BILL ANALYSIS (default POST) ===
      if (request.method === "POST") {
        return await handleBillProcessing(request, env, corsHeaders);
      }

      return new Response("ExplainMyBill API Running • No data stored • Not HIPAA-certified", {
        headers: { "Content-Type": "text/plain", ...corsHeaders },
      });
    } catch (err) {
      console.error("Worker error:", err?.message || err);
      return errorResponse("Internal error", 500, corsHeaders);
    }
  },
};
