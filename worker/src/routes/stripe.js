import { jsonResponse, errorResponse } from "../utils/response.js";

/**
 * Stripe Checkout Handler (REST API only - no SDK)
 * Updated: May 30, 2026
 */

export async function handleStripeCheckout(request, env, corsHeaders) {
  if (!env.STRIPE_SECRET_KEY) {
    return errorResponse("Stripe is not configured on this server", 500, corsHeaders);
  }

  try {
    const body = await request.json().catch(() => ({}));
    const { priceId, mode = "subscription", successUrl, cancelUrl } = body;

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

    const form = new URLSearchParams();
    form.set("mode", mode === "payment" ? "payment" : "subscription");
    form.set("payment_method_types[0]", "card");
    form.set("line_items[0][price]", priceId);
    form.set("line_items[0][quantity]", "1");
    form.set("success_url", `${successUrl || "https://explain-my-bill-frontend.onrender.com"}/success?session_id={CHECKOUT_SESSION_ID}`);
    form.set("cancel_url", cancelUrl || "https://explain-my-bill-frontend.onrender.com/cancel");
    form.set("metadata[user_agent]", request.headers.get("user-agent") || "unknown");

    const session = await stripeCreateCheckoutSession(env.STRIPE_SECRET_KEY, form);

    if (!session?.url) {
      return errorResponse("Failed to create Stripe checkout session", 500, corsHeaders);
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

  const text = await res.text();
  let json;

  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  if (!res.ok) {
    const msg = json?.error?.message || text || `Stripe HTTP ${res.status}`;
    throw new Error(msg);
  }

  return json;
}
