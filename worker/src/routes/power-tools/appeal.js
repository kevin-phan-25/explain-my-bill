import { jsonResponse, errorResponse } from "../../utils/response.js";
import { processSingleBill } from "../../bill/processor.js";

// ======================== APPEAL LETTER GENERATOR ========================
export async function handleAppealLetter(request, env, corsHeaders) {
  try {
    const form = await request.formData();
    const providerBill = form.get("providerBill");
    const eob = form.get("eob");
    const reason = form.get("reason") || "discrepancy in patient responsibility";

    if (!providerBill || !eob) {
      return errorResponse("Upload both provider bill and EOB", 400, corsHeaders);
    }

    const provider = await processSingleBill(providerBill, env);
    const eobResult = await processSingleBill(eob, env);

    const letter = generateAppealLetter(provider, eobResult, reason);

    return jsonResponse(
      {
        letter,
        provider,
        eob: eobResult,
        privacyNote: "Documents processed in memory only. Nothing stored.",
      },
      corsHeaders
    );
  } catch (err) {
    console.error("Appeal generation error:", err);
    return errorResponse("Appeal generation failed", 500, corsHeaders);
  }
}

function generateAppealLetter(provider, eob, reason) {
  const p = provider.structured.keyAmounts;
  const e = eob.structured.keyAmounts;

  return `
[Your Name]
[Your Address]
[City, State, ZIP Code]
[Email Address]
[Phone Number]
[Date]

[Insurance Company Name]
[Claims Appeals Department]
[Insurance Company Address]
[City, State, ZIP Code]

Re: Appeal of Claim – Policy #: [Your Policy Number]
Claim #: [Claim Number]
Patient: [Your Name]
Date of Service: [Date]

Dear Appeals Department,

I am writing to formally appeal the determination of patient responsibility on the above-referenced claim.

The provider statement indicates:
• Total Charges: ${p.totalCharges.value}
• Patient Responsibility: ${p.patientResponsibility.value || "Full billed amount"}

However, my Explanation of Benefits (EOB) from your company shows:
• Allowed Amount / Total Charges: ${e.totalCharges.value}
• Insurance Coverage (payments + adjustments): ${e.insurancePaid.value}
• Patient Responsibility: ${e.patientResponsibility.value}

This represents a ${reason}. I respectfully request that the claim be reprocessed to reflect the correct patient responsibility of ${e.patientResponsibility.value} as stated in your EOB.

Enclosed are copies of:
• Provider bill/statement
• Explanation of Benefits (EOB)

Please adjust the patient balance accordingly and send confirmation within 30 days as required by law.

Thank you for your prompt attention.

Sincerely,

[Your Full Name]
[Phone]
[Email]
`;
}

