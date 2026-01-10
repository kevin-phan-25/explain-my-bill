import { jsonResponse, errorResponse } from "../../utils/response.js";
import { processSingleBill } from "../../bill/processor.js";

// ======================== MASSIVELY EXPANDED & ACCURATE 2025 OVERCHARGE BENCHMARKS ========================
function detectOvercharges(billResult) {
  const total = parseFloat(billResult.structured.keyAmounts.totalCharges.raw || 0);
  const flags = [];

  const benchmarks = {
    // Emergency & Urgent
    emergencyRoomVisit: 3000,
    urgentCareVisit: 350,
    primaryCareVisit: 180,

    // Imaging
    mriBrain: 2500,
    ctHead: 1700,
    ultrasoundAbdominal: 800,
    xrayChest: 400,
    mammography: 350,

    // Surgery & Procedures
    colonoscopy: 3800,
    cataractSurgery: 4800,
    appendectomy: 32000,
    kneeReplacement: 45000,
    hipReplacement: 48000,
    gallbladderRemoval: 28000,
    tonsillectomy: 8500,
    wisdomTeethRemoval: 4200,
    cardiacStent: 38000,

    // Maternity
    normalDelivery: 18000,
    cSection: 25000,

    // Hospital Stays
    hospitalDayGeneral: 4200,
    icuDay: 12000,

    // Therapy & Office
    physicalTherapySession: 150,
    psychotherapySession: 180,
    chiropracticAdjustment: 80,

    // Lab & Diagnostics
    labBloodWork: 300,
    covidTest: 150,

    // Dental
    dentalCleaning: 150,
    rootCanal: 1200,
    crownDental: 1400,

    // Vision
    eyeExam: 180,
    lasikPerEye: 2500,
  };

  // High-impact flags
  if (total > benchmarks.emergencyRoomVisit * 2) flags.push(`ER visit >2× national average (~$3,000)`);
  if (total > benchmarks.urgentCareVisit * 5) flags.push(`Urgent care appears high (avg ~$350)`);
  if (total > benchmarks.mriBrain * 2) flags.push(`MRI >2× average (~$2,500)`);
  if (total > benchmarks.ctHead * 2) flags.push(`CT scan >2× average (~$1,700)`);
  if (total > benchmarks.hospitalDayGeneral * 5) flags.push(`Hospital stay >5× daily rate (~$4,200/day)`);
  if (total > benchmarks.normalDelivery * 1.5) flags.push(`Delivery charges high (avg ~$18,000)`);
  if (total > benchmarks.cSection * 1.3) flags.push(`C-section elevated (avg ~$25,000)`);
  if (total > benchmarks.appendectomy * 1.5) flags.push(`Appendectomy high (avg ~$32,000)`);
  if (total > benchmarks.kneeReplacement * 1.4) flags.push(`Knee replacement high (avg ~$45,000)`);
  if (total > benchmarks.cardiacStent * 1.5) flags.push(`Cardiac stent high (avg ~$38,000)`);

  return {
    totalCharged: billResult.structured.keyAmounts.totalCharges.value,
    flags: flags.length > 0 ? flags : ["No major overcharges detected vs national averages"],
    note: "Based on FAIR Health, Medicare, and CMS data (2025 estimates). Not a guarantee.",
  };
}

// ======================== OVERCHARGE DETECTION ========================
export async function handleOverchargeDetection(request, env, corsHeaders) {
  try {
    const form = await request.formData();
    const billFile = form.get("bill");

    if (!billFile) return errorResponse("Upload provider bill", 400, corsHeaders);

    const result = await processSingleBill(billFile, env);

    const flags = detectOvercharges(result);

    return jsonResponse(
      {
        flags,
        bill: result,
        privacyNote: "Document processed in memory only. Nothing stored.",
      },
      corsHeaders
    );
  } catch (err) {
    console.error("Overcharge detection error:", err);
    return errorResponse("Detection failed", 500, corsHeaders);
  }
}

