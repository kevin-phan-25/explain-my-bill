const WORKER_URL = "https://explain-my-bill.your-subdomain.workers.dev";

export async function createCheckoutSession(plan) {
  const res = await fetch(`${WORKER_URL}/create-checkout-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plan }),
  });
  return res.json();
}

export async function explainBill(formData) {
  const res = await fetch(WORKER_URL, {
    method: "POST",
    body: formData,
  });
  return res.json();
}
