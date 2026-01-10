export function jsonResponse(obj, corsHeaders) {
  return new Response(JSON.stringify(obj), {
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

export function errorResponse(msg, status, corsHeaders) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

