/**
 * CORS Middleware
 * Updated: May 30, 2026
 */

/**
 * Build CORS headers with secure origin validation
 */
export function buildCorsHeaders(request) {
  // === ALLOWED ORIGINS ===
  const allowedOrigins = [
    "https://explain-my-bill-frontend.onrender.com",
    "https://www.explain-my-bill-frontend.onrender.com",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "https://localhost:3000",
  ];

  const origin = request.headers.get("Origin");

  // Determine allowed origin
  let corsOrigin = null;
  if (origin && allowedOrigins.includes(origin)) {
    corsOrigin = origin;
  }

  const corsHeaders = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Dev-Bypass, X-Dev-Key, Authorization, X-Requested-With",
    "Access-Control-Max-Age": "86400",           // 24 hours
    "Access-Control-Allow-Credentials": "true",  // Allow cookies/auth if needed
  };

  // Set origin header
  if (corsOrigin) {
    corsHeaders["Access-Control-Allow-Origin"] = corsOrigin;
  } else {
    // In production, be strict. In dev, allow *
    const isDev = String(request.headers.get("X-Dev-Bypass") || "").toLowerCase() === "true";
    corsHeaders["Access-Control-Allow-Origin"] = isDev ? "*" : "https://explain-my-bill-frontend.onrender.com";
  }

  return corsHeaders;
}
