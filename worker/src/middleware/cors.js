export function buildCorsHeaders(request) {
  // === ALLOWED ORIGINS ===
  const allowedOrigins = [
    "https://explain-my-bill-frontend.onrender.com",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "https://localhost:3000",
  ];

  const origin = request.headers.get("Origin");
  const corsOrigin = allowedOrigins.includes(origin) ? origin : null;

  const corsHeaders = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Dev-Bypass, X-Dev-Key, Authorization",
    "Access-Control-Max-Age": "86400",
  };

  if (corsOrigin) {
    corsHeaders["Access-Control-Allow-Origin"] = corsOrigin;
  } else {
    corsHeaders["Access-Control-Allow-Origin"] = "*";
  }

  return corsHeaders;
}

