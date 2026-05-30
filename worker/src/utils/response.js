/**
 * HTTP Response Utilities
 * Updated: May 30, 2026
 */

export function jsonResponse(obj, corsHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 
      "Content-Type": "application/json",
      ...corsHeaders 
    },
  });
}

export function errorResponse(msg, status = 400, corsHeaders = {}) {
  return new Response(JSON.stringify({ 
    error: msg,
    success: false 
  }), {
    status,
    headers: { 
      "Content-Type": "application/json",
      ...corsHeaders 
    },
  });
}
