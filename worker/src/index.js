/**
 * ExplainMyBill — Cloudflare Worker Entry Point
 * Production-Optimized • Privacy-First • May 30, 2026
 *
 * Features:
 * - AI-Powered Bill Analysis (Medical + Utility)
 * - Power Tools (EOB Comparison, Appeal Letter, Overcharge Detection, Prior Auth)
 * - Stripe Checkout (Subscriptions + One-time + Lifetime)
 * - Zero data retention • Educational tool only • Not HIPAA-certified
 */

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

    // Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // ======================== STRIPE CHECKOUT ========================
      if (url.pathname === "/create-checkout-session" && request.method === "POST") {
        return await handleStripeCheckout(request, env, corsHeaders);
      }

      // ======================== DEBUG ENDPOINT ========================
      if (url.pathname === "/debug" && request.method === "GET") {
        return await handleDebug(request, env, corsHeaders);
      }

      // ======================== POWER TOOLS ========================
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

      // ======================== MAIN BILL ANALYSIS ========================
      if (request.method === "POST") {
        return await handleBillProcessing(request, env, corsHeaders);
      }

      // ======================== ROOT / HEALTH CHECK ========================
      return new Response(
        "ExplainMyBill API v2026 ✅\n\n" +
        "• AI-Powered Medical & Utility Bill Analyzer\n" +
        "• Privacy-first: No bills are stored or logged\n" +
        "• Educational tool only • Not HIPAA-certified\n\n" +
        "Endpoints:\n" +
        "→ POST /          → Analyze a bill\n" +
        "→ POST /detect-overcharge   → Overcharge detection\n" +
        "→ POST /compare-eob         → EOB vs Provider Bill\n" +
        "→ POST /generate-appeal     → Generate appeal letter\n" +
        "→ POST /create-checkout-session → Stripe checkout\n\n" +
        "Live at: https://explain-my-bill.explainmybill.workers.dev/",
        {
          headers: {
            "Content-Type": "text/plain",
            ...corsHeaders,
          },
        }
      );

    } catch (err) {
      console.error("Worker top-level error:", err?.message || err);
      return errorResponse("Internal server error. Please try again later.", 500, corsHeaders);
    }
  },
};
