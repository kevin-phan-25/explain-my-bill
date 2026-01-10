import { jsonResponse, errorResponse } from "../../utils/response.js";
import { processSingleBill } from "../../bill/processor.js";

// ======================== EOB COMPARISON (FIXED: NO DUPLICATE "eob") ========================
export async function handleEOBComparison(request, env, corsHeaders) {
  try {
    const form = await request.formData();
    const providerBillFile = form.get("providerBill");
    const eobFile = form.get("eob");

    if (!providerBillFile || !eobFile) {
      return errorResponse("Please upload both provider bill and EOB", 400, corsHeaders);
    }

    const [providerResult, eobResult] = await Promise.all([
      processSingleBill(providerBillFile, env),
      processSingleBill(eobFile, env),
    ]);

    const comparison = compareBills(providerResult, eobResult);

    return jsonResponse(
      {
        comparison,
        providerBill: providerResult,
        eob: eobResult,
        privacyNote: "Both documents processed in memory only. Nothing stored.",
      },
      corsHeaders
    );
  } catch (err) {
    console.error("EOB comparison error:", err);
    return errorResponse("Comparison failed", 500, corsHeaders);
  }
}

function compareBills(provider, eob) {
  const p = provider.structured.keyAmounts;
  const e = eob.structured.keyAmounts;

  const pTotal = parseFloat(p.totalCharges.raw || 0);
  const eTotal = parseFloat(e.totalCharges.raw || 0);
  const ePatient = parseFloat(e.patientResponsibility.raw || 0);
  const pPatient = parseFloat(p.patientResponsibility.raw || 0);

  const discrepancies = [];
  let mainMessage = "";
  let severity = "info";

  if (Math.abs(pTotal - eTotal) > 5) {
    discrepancies.push(`Total charges differ: Provider says ${p.totalCharges.value}, EOB says ${e.totalCharges.value}`);
  }

  if (e.patientResponsibility.value !== "Not detected") {
    if (pPatient === 0 || pPatient > ePatient + 5) {
      mainMessage = `GOOD NEWS: Your insurance says you only owe ${e.patientResponsibility.value} — not the full billed amount!`;
      severity = "success";
    } else if (pPatient > 0 && Math.abs(pPatient - ePatient) > 5) {
      mainMessage = `ALERT: The provider and EOB disagree on what you owe (${p.patientResponsibility.value} vs ${e.patientResponsibility.value}).`;
      severity = "warning";
    } else {
      mainMessage = `Your responsibility is ${e.patientResponsibility.value} according to your insurance.`;
      severity = "success";
    }
  } else {
    mainMessage = "We found your EOB but couldn't locate the final patient responsibility. Look for 'Amount You Owe' or 'Patient Balance'.";
    severity = "warning";
  }

  return {
    mainMessage,
    severity,
    discrepancies,
    providerSummary: provider.structured.summary,
    eobSummary: eob.structured.summary,
    providerAmounts: p,
    eobAmounts: e,
  };
}

