import { jsonResponse, errorResponse } from "../../utils/response.js";
import { processSingleBill } from "../../bill/processor.js";

/**
 * Overcharge Detection Power Tool
 * Updated: May 30, 2026
 */

// Updated 2026 national average benchmarks (approximate, based on FAIR Health, CMS, and industry data)
const benchmarks = {
  emergencyRoomVisit: 3200,
  urgentCareVisit: 380,
  primaryCareVisit: 190,
  mriBrain: 2600,
  ctHead: 1800,
  ultrasoundAbdominal: 850,
  xrayChest: 420,
  mammography: 380,
  colonoscopy: 4000,
  cataractSurgery: 5200,
  appendectomy: 34000,
  kneeReplacement: 48000,
  hipReplacement: 51000,
  gallbladderRemoval: 29000,
  normalDelivery: 19500,
  cSection: 27000,
  hospitalDayGeneral: 4500,
  icuDay: 13500,
  physicalTherapySession: 160,
};

function detectOvercharges(billResult) {
  const totalRaw = billResult.structured.keyAmounts.totalCharges.raw || "0";
  const total = parseFloat(totalRaw);
  const flags = [];
  const suggestions = [];

  if (!total || total <= 0) {
    return { totalCharged: "Not detected", flags: ["Unable to read total charges"], note: "Analysis unavailable" };
  }

  // High-impact flags with better logic
  if (total > benchmarks.emergencyRoomVisit * 1.8) {
    flags.push(`Emergency Room visit significantly above national average (≈ $${benchmarks.emergencyRoomVisit})`);
    suggestions.push("Request itemized breakdown and compare line items to Medicare rates.");
  }
  if (total > benchmarks.mriBrain * 1.9) {
    flags.push(`MRI appears high (national avg ≈ $${benchmarks.mriBrain})`);
  }
  if (total > benchmarks.hospitalDayGeneral * 4) {
    flags.push(`Hospital stay charges appear elevated (daily avg ≈ $${benchmarks.hospitalDayGeneral})`);
  }
  if (total > benchmarks.appendectomy * 1.4) {
    flags.push(`Appendectomy charges high vs national average`);
  }
  if (total > benchmarks.kneeReplacement * 1.35) {
    flags.push(`Knee replacement significantly above typical range`);
  }
  if (total > benchmarks.cSection * 1.25) {
    flags.push(`C-section charges above typical range`);
  }

  const severity = flags.length > 2 ? "High" : flags.length > 0 ? "Medium" : "Low";

  return {
    totalCharged: billResult.structured.keyAmounts.totalCharges.value,
    severity,
    flags: flags.length > 0 ? flags : ["No major red flags detected compared to 2026 national averages"],
    suggestions: suggestions.length > 0 ? suggestions : ["Review line-by-line charges if you have the full itemized bill"],
    note: "Benchmarks are approximate (FAIR Health / CMS 2026 estimates). Always verify with your insurer.",
  };
}

export async function handleOverchargeDetection(request, env, corsHeaders) {
  try {
    const form = await request.formData();
    const billFile = form.get("bill");

    if (!billFile) {
      return errorResponse("Please upload a provider bill", 400, corsHeaders);
    }

    const result = await processSingleBill(billFile, env);
    const analysis = detectOvercharges(result);

    return jsonResponse({
      success: true,
      analysis,
      billSummary: {
        totalCharges: result.structured.keyAmounts.totalCharges.value,
        patientResponsibility: result.structured.keyAmounts.patientResponsibility.value,
      },
      privacyNote: "Document processed in memory only. Nothing is stored.",
    }, corsHeaders);

  } catch (err) {
    console.error("Overcharge detection error:", err);
    return errorResponse("Overcharge analysis failed. Please try again.", 500, corsHeaders);
  }
}
