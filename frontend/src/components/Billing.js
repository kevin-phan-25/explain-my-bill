import { loadStripe } from "@stripe/stripe-js";
import { createCheckoutSession } from "../api";

const stripePromise = loadStripe("pk_test_YourPublishableKey");

export default function Billing({ setSessionId }) {
  const handleCheckout = async (plan) => {
    const { id } = await createCheckoutSession(plan);
    const stripe = await stripePromise;
    const { error } = await stripe.redirectToCheckout({ sessionId: id });
    if (error) console.error(error);
  };

  return (
    <div>
      <h2>Unlock Full Explanations</h2>
      <button onClick={() => handleCheckout("one-time")}>$4.99 – One Bill Explanation</button>
      <button onClick={() => handleCheckout("monthly")}>$15.99/month – Unlimited</button>
    </div>
  );
}
