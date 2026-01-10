import { jsonResponse, errorResponse } from "../../utils/response.js";

// ======================== PRIOR AUTH TRACKER ========================
export async function handlePriorAuth(request, env, corsHeaders) {
  if (request.method === "POST") {
    try {
      const data = await request.json();
      return jsonResponse({ status: "saved", priorAuth: data }, corsHeaders);
    } catch {
      return errorResponse("Invalid JSON", 400, corsHeaders);
    }
  }

  if (request.method === "GET") {
    return jsonResponse({ trackedAuths: [] }, corsHeaders);
  }

  return errorResponse("Method not allowed", 405, corsHeaders);
}

