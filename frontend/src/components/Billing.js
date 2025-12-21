import { loadStripe } from "@stripe/stripe-js";
import { createCheckoutSession } from "../api";

const stripePromise = loadStripe("pk_test_YourStripePublishableKeyHere");

export default function Billing() {
  const handleCheckout = async (plan) => {
    const { id } = await createCheckoutSession(plan);
    const stripe = await stripePromise;
    await stripe.redirectToCheckout({ sessionId: id });
  };

  return (
    <div style={{ margin: "30px 0", padding: "20px", border: "1px solid #ccc", borderRadius: "8px" }}>
      <h2>Unlock Full Bill Explanation</h2>
      <button onClick={() => handleCheckout("one-time")} style={{ margin: "10px", padding: "10px 20px" }}>
        $4.99 – One Bill
      </button>
      <button onClick={() => handleCheckout("monthly")} style={{ margin: "10px", padding: "10px 20px" }}>
        $15.99/month – Unlimited
      </button>
    </div>
  );
}
