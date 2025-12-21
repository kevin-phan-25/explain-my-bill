// frontend/src/api.js

const WORKER_URL = "https://explain-my-bill.explainmybill.workers.dev";

export async function createCheckoutSession(plan) {
  const res = await fetch(`${WORKER_URL}/create-checkout-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plan }),
  });
  if (!res.ok) throw new Error("Payment setup failed");
  return res.json();
}

export async function explainBill(formData) {
  const res = await fetch(WORKER_URL, {
    method: "POST",
    body: formData,
  });
  if (!res.ok) throw new Error("Explanation failed");
  return res.json();
}
