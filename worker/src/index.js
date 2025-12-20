export default {
  async fetch(request) {
    try {
      const reqData = await request.json();
      const prompt = reqData.question;

      // Call OpenAI
      const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: "gpt-4",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.7
        })
      });

      const aiData = await aiRes.json();

      // Optional: Check Stripe payment status here before returning answer
      return new Response(JSON.stringify(aiData), { headers: { "Content-Type": "application/json" } });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500 });
    }
  }
};

