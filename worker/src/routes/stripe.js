import { jsonResponse, errorResponse } from "../utils/response.js";

// ======================== FULL STRIPE CHECKOUT HANDLER ========================
// FIX: Cloudflare Workers cannot bundle / run the Node Stripe SDK reliably.
// We call Stripe REST API directly via fetch (Workers-native).
export async function handleStripeCheckout(request, env, corsHeaders) {
  if (!env.STRIPE_SECRET_KEY) {
    return errorResponse("Stripe not configured (missing STRIPE_SECRET_KEY)", 500, corsHeaders);
  }

  try {
    const body = await request.json().catch(() => ({}));
    const { priceId, mode = "subscription" } = body;

    if (!priceId) {
      return errorResponse("priceId is required", 400, corsHeaders);
    }

    const allowedPrices = [
      env.STRIPE_PRICE_MONTHLY,
      env.STRIPE_PRICE_LIFETIME,
      env.STRIPE_PRICE_ONE_TIME,
    ].filter(Boolean);

    if (!allowedPrices.includes(priceId)) {
      return errorResponse("Invalid priceId", 400, corsHeaders);
    }

    const successBase = body.successUrl || "https://explain-my-bill-frontend.onrender.com";
    const cancelUrl = body.cancelUrl || "https://explain-my-bill-frontend.onrender.com/cancel";

    // Stripe expects x-www-form-urlencoded
    const form = new URLSearchParams();
    form.set("mode", mode === "payment" ? "payment" : "subscription");
    form.set("payment_method_types[0]", "card");
    form.set("line_items[0][price]", priceId);
    form.set("line_items[0][quantity]", "1");
    form.set("success_url", `${successBase}/success?session_id={CHECKOUT_SESSION_ID}`);
    form.set("cancel_url", cancelUrl);
    form.set("metadata[user_agent]", request.headers.get("user-agent") || "unknown");

    const session = await stripeCreateCheckoutSession(env.STRIPE_SECRET_KEY, form);

    if (!session?.url) {
      return errorResponse("Checkout failed: Stripe did not return a session URL", 500, corsHeaders);
    }

    return jsonResponse({ url: session.url }, corsHeaders);
  } catch (err) {
    console.error("Stripe checkout error:", err);
    return errorResponse(`Checkout failed: ${err.message || "Unknown error"}`, 500, corsHeaders);
  }
}

async function stripeCreateCheckoutSession(stripeSecretKey, formUrlEncoded) {
  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${stripeSecretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formUrlEncoded.toString(),
  });

  const text = await res.text().catch(() => "");
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  if (!res.ok) {
    const msg = json?.error?.message || text || `Stripe error (${res.status})`;
    throw new Error(msg);
  }

  return json;
}

