import { useEffect } from "react";
import { loadStripe } from "@stripe/stripe-js";

const stripePromise = loadStripe("pk_test_YourStripePublicKey");

export default function Billing() {
  const handleCheckout = async (plan) => {
    const res = await fetch("/create-checkout-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan }) // "one-time" or "monthly"
    });
    const data = await res.json();
    const stripe = await stripePromise;
    stripe.redirectToCheckout({ sessionId: data.id });
  };

  return (
    <div>
      <button onClick={() => handleCheckout("one-time")}>Pay $4.99 for one bill</button>
      <button onClick={() => handleCheckout("monthly")}>Subscribe $15.99/month</button>
    </div>
  );
}

