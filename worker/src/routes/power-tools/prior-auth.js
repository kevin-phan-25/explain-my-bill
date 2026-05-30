import { jsonResponse, errorResponse } from "../../utils/response.js";

/**
 * Prior Authorization Tracker
 * Updated: May 30, 2026
 */

export async function handlePriorAuth(request, env, corsHeaders) {
  if (request.method === "POST") {
    try {
      const data = await request.json();

      if (!data || typeof data !== "object") {
        return errorResponse("Invalid request body", 400, corsHeaders);
      }

      // TODO: In future, you can save to KV/D1 here if you want persistence
      return jsonResponse({
        status: "saved",
        message: "Prior authorization tracked successfully",
        priorAuth: data,
      }, corsHeaders);

    } catch (err) {
      return errorResponse("Invalid JSON payload", 400, corsHeaders);
    }
  }

  if (request.method === "GET") {
    // TODO: In future, return user's tracked auths from storage
    return jsonResponse({
      trackedAuths: [],
      message: "No prior authorizations tracked yet (storage coming soon)",
    }, corsHeaders);
  }

  return errorResponse("Method not allowed", 405, corsHeaders);
}
