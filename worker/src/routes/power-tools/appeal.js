import { jsonResponse, errorResponse } from "../../utils/response.js";
import { processSingleBill } from "../../bill/processor.js";

/**
 * Appeal Letter Generator Power Tool
 * Updated: May 30, 2026
 */

export async function handleAppealLetter(request, env, corsHeaders) {
  try {
    const form = await request.formData();
    const providerBill = form.get("providerBill");
    const eob = form.get("eob");
    const reason = form.get("reason") || "discrepancy between billed amount and EOB allowed amount";

    if (!providerBill) return errorResponse("Provider bill is required", 400, corsHeaders);
    if (!eob) return errorResponse("EOB is required", 400, corsHeaders);

    const provider = await processSingleBill(providerBill, env);
    const eobResult = await processSingleBill(eob, env);

    const letter = generateAppealLetter(provider, eobResult, reason);

    return jsonResponse({
      success: true,
      letter,
      providerSummary: provider.structured.keyAmounts,
      eobSummary: eobResult.structured.keyAmounts,
      privacyNote: "Documents processed in memory only. Nothing is stored.",
    }, corsHeaders);

  } catch (err) {
    console.error("Appeal generation error:", err);
    return errorResponse("Failed to generate appeal letter", 500, corsHeaders);
  }
}

function generateAppealLetter(provider, eob, reason) {
  const p = provider.structured.keyAmounts;
  const e = eob.structured.keyAmounts;

  return `Your Name
Your Address
City, State, ZIP Code
Email Address
Phone Number
[Date]

[Insurance Company Name]
Claims Appeals Department
[Insurance Company Address]
City, State, ZIP Code

Re: Appeal of Claim Denial / Patient Responsibility
Policy Number: [Your Policy Number]
Claim Number: [Claim Number]
Patient Name: [Your Full Name]
Date of Service: [Date of Service]

Dear Appeals Coordinator,

I am writing to formally appeal the determination of patient responsibility on the claim referenced above.

According to the provider's statement, the Total Charges were ${p.totalCharges.value}, with a Patient Responsibility of ${p.patientResponsibility.value || "the full amount"}.

However, your Explanation of Benefits (EOB) shows:
• Allowed Amount: ${e.totalCharges.value}
• Insurance Paid / Adjustments: ${e.insurancePaid.value}
• Patient Responsibility: ${e.patientResponsibility.value}

This discrepancy constitutes ${reason}. I respectfully request that you reprocess this claim according to the contracted rate and adjust the patient balance to match the EOB determination of ${e.patientResponsibility.value}.

I have enclosed:
1. Copy of the provider bill/statement
2. Copy of the Explanation of Benefits (EOB)
3. Any supporting medical records (if applicable)

Please review and respond within 30 days as required under the Patient Protection and Affordable Care Act and applicable state law.

Thank you for your prompt attention to this matter.

Sincerely,

[Your Full Name]
[Your Phone Number]
[Your Email Address]
[Your Policy Number]`;
}
