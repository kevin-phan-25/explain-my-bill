const WORKER_URL = "https://explain-my-bill.<your-subdomain>.workers.dev";

export async function explainBill(billText) {
  const res = await fetch(WORKER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: billText })
  });
  return res.json();
}
