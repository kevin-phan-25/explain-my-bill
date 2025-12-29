import React, { useState } from "react";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

/* ================= Chevron ================= */
const ChevronDown = ({ isOpen }) => (
  <svg
    className={`w-6 h-6 text-white transition-transform ${isOpen ? "rotate-180" : ""}`}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 9l-7 7-7-7" />
  </svg>
);

/* ================= Helpers ================= */
const cleanValue = (value, fallback = "See explanation below") => {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return String(value);
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.toLowerCase().includes("null")) {
    return fallback;
  }
  return trimmed;
};

/* ================= Component ================= */
export default function ExplanationCard({ result, onUpgrade }) {
  const [openSections, setOpenSections] = useState(["explanation"]);
  const [showOcr, setShowOcr] = useState(false);

  if (!result) return null;

  const { pages = [], isPaid } = result;

  // ================= Normalize Data =================
  let structured = null;
  let explanationText = "";
  let ocrText = "";

  pages.forEach((p) => {
    if (p?.structured && !structured) structured = p.structured;
    if (p?.explanation) explanationText += `${p.explanation}\n\n`;
    if (p?.rawText) ocrText += `${p.rawText}\n\n`;
  });

  explanationText = explanationText.trim();
  ocrText = ocrText.trim();

  const keyAmounts = structured?.keyAmounts || {};
  const summaryPoints = structured?.summaryPoints || [];
  const services = structured?.services || [];
  const redFlags = structured?.redFlags || [];
  const potentialSavings = structured?.potentialSavings || null;

  // ================= FIXED VALUES (OCR-aware fallback) =================
  const totalCharges = cleanValue(keyAmounts.totalCharges, explanationText || ocrText);
  const insurancePaid = cleanValue(keyAmounts.insurancePaid, explanationText || ocrText);
  const patientResponsibility = cleanValue(keyAmounts.patientResponsibility, explanationText || ocrText);

  const finalExplanation = explanationText || structured?.summary || ocrText || "Analysis complete.";

  // ================= Rock-solid AI detection =================
  const hasAiAnalysis =
    Boolean(structured) &&
    (
      summaryPoints.length > 0 ||
      redFlags.length > 0 ||
      services.length > 0 ||
      Boolean(potentialSavings)
    );

  // ================= Appeal Letter Generator =================
  const generateAppealLetter = () => {
    const doc = new jsPDF("p", "mm", "a4");
    const margin = 20;
    let y = 30;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    doc.text("Medical Bill Appeal Letter", margin, y);
    y += 15;

    doc.setFontSize(12);
    doc.setFont("helvetica", "normal");
    doc.text(`Date: ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}`, margin, y);
    y += 20;

    doc.text("To:", margin, y);
    y += 8;
    doc.text("Insurance Company Name", margin, y);
    y += 8;
    doc.text("Claims Department", margin, y);
    y += 8;
    doc.text("Address Line 1", margin, y);
    y += 8;
    doc.text("City, State ZIP", margin, y);
    y += 20;

    doc.text("Re: Claim Number: _________________", margin, y);
    y += 8;
    doc.text("Patient: Your Name", margin, y);
    y += 8;
    doc.text("Date of Service: _________________", margin, y);
    y += 20;

    doc.text("Dear Claims Reviewer,", margin, y);
    y += 15;

    const body = [
      "I am writing to formally appeal the determination on my medical claim.",
      "",
      "Summary of Bill:",
      `- Total Billed Charges: ${totalCharges}`,
      `- Insurance Paid: ${insurancePaid}`,
      `- Patient Responsibility: ${patientResponsibility}`,
      potentialSavings ? `- Estimated Potential Savings: ${potentialSavings}` : "",
      "",
      "I believe this claim was incorrectly processed for the following reasons:",
    ];

    if (redFlags.length > 0) {
      body.push("");
      body.push("Specific Issues Identified:");
      redFlags.forEach((flag) => body.push(`• ${flag}`));
    }

    body.push("");
    body.push("I kindly request a full review and reprocessing of this claim. I have attached supporting documentation including the itemized bill and explanation of benefits.");
    body.push("");
    body.push("Thank you for your prompt attention to this matter. I look forward to your response.");
    body.push("");
    body.push("Sincerely,");
    body.push("");
    body.push("Your Name");
    body.push("Your Address");
    body.push("Your Phone Number");
    body.push("Your Email");

    doc.setFont("helvetica", "normal");
    body.forEach((line) => {
      if (y > 270) {
        doc.addPage();
        y = 30;
      }
      if (line === "") y += 8;
      else doc.text(line, margin, y), (y += 8);
    });

    doc.save("Medical_Bill_Appeal_Letter.pdf");
  };

  // ================= Excel Export (CSV) =================
  const exportToExcel = () => {
    const rows = [
      ["Category", "Value"],
      ["Total Billed Charges", totalCharges],
      ["Insurance Paid", insurancePaid],
      ["Patient Responsibility", patientResponsibility],
      ["Potential Savings", potentialSavings || (isPaid ? "Calculated" : "Upgrade to view")],
      ["", ""],
      ["Services/Procedures", ""],
    ];

    services.forEach((service) => rows.push([service, ""]));

    if (redFlags.length > 0) {
      rows.push(["", ""]);
      rows.push(["Red Flags / Issues", ""]);
      redFlags.forEach((flag) => rows.push([flag, ""]));
    }

    const csv = rows.map((row) => `"${row.join('","')}"`).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "Medical_Bill_Review.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  // ================= PDF Report =================
  const handlePDF = () => {
    const doc = new jsPDF("p", "mm", "a4");
    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 20;
    let y = 30;

    doc.setFillColor(15, 25, 60);
    doc.rect(0, 0, pageWidth, 60, "F");

    doc.setTextColor(255, 255, 255);
    doc.setFontSize(32);
    doc.setFont("helvetica", "bold");
    doc.text("Medical Bill Review Report", margin, y);
    y += 15;

    doc.setFontSize(14);
    doc.setTextColor(130, 200, 255);
    doc.text("Clear • Accurate • Patient-Focused", margin, y);
    y += 10;

    doc.setFontSize(11);
    doc.setTextColor(180, 220, 255);
    doc.text(`Report Generated: ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}`, margin, y);
    y += 20;

    // Financial Summary Table
    doc.autoTable({
      startY: y,
      head: [["Category", "Amount"]],
      body: [
        ["Total Billed Charges", totalCharges],
        ["Insurance Paid", insurancePaid],
        ["Patient Responsibility", patientResponsibility],
        ["Potential Savings", potentialSavings || (isPaid ? "Calculated" : "Upgrade to view")],
      ],
      theme: "grid",
      headStyles: { fillColor: [20, 35, 80], textColor: 255 },
      styles: { cellPadding: 5, fontSize: 12 },
      margin: { left: margin, right: margin },
    });
    y = doc.lastAutoTable.finalY + 20;

    // Services
    if (services.length > 0) {
      doc.setFillColor(25, 40, 90);
      doc.roundedRect(margin - 5, y - 10, pageWidth - 2 * margin + 10, 20 + services.length * 9, 10, 10, "F");
      y += 8;

      doc.setTextColor(255, 255, 255);
      doc.setFontSize(18);
      doc.text("Services & Procedures", margin, y);
      y += 14;

      doc.setFontSize(11);
      services.forEach((service) => {
        const lines = doc.splitTextToSize(service, pageWidth - 2 * margin - 20);
        doc.text(`• ${lines.join("\n  ")}`, margin + 8, y);
        y += lines.length * 7 + 6;
      });
      y += 10;
    }

    // Red Flags
    if (redFlags.length > 0) {
      doc.setFillColor(90, 20, 40);
      doc.roundedRect(margin - 5, y - 10, pageWidth - 2 * margin + 10, 25 + redFlags.length * 10, 10, 10, "F");
      y += 8;

      doc.setTextColor(255, 140, 140);
      doc.setFontSize(18);
      doc.text("Important Alerts / Red Flags", margin, y);
      y += 14;

      doc.setFontSize(11);
      redFlags.forEach((flag) => {
        const lines = doc.splitTextToSize(flag, pageWidth - 2 * margin - 20);
        doc.text(`• ${lines.join("\n  ")}`, margin + 8, y);
        y += lines.length * 7 + 6;
      });
      y += 10;
    }

    // Explanation
    doc.setFillColor(30, 45, 100);
    doc.roundedRect(margin - 5, y - 10, pageWidth - 2 * margin + 10, 80, 10, 10, "F");
    y += 8;

    doc.setTextColor(150, 230, 255);
    doc.setFontSize(18);
    doc.text("Detailed Explanation", margin, y);
    y += 14;

    doc.setFontSize(12);
    doc.setTextColor(220, 240, 255);
    const lines = doc.splitTextToSize(finalExplanation, pageWidth - 2 * margin - 10);
    doc.text(lines, margin + 5, y);

    // Footer
    doc.setFillColor(10, 15, 45);
    doc.rect(0, doc.internal.pageSize.getHeight() - 40, pageWidth, 40, "F");
    doc.setTextColor(160, 210, 255);
    doc.setFontSize(10);
    doc.setFont("helvetica", "italic");
    doc.text("Generated by ExplainMyBill • Clear Medical Bill Reviews", margin, doc.internal.pageSize.getHeight() - 20);
    doc.text("This report is for informational purposes only.", margin, doc.internal.pageSize.getHeight() - 10);

    doc.save("Medical_Bill_Review_Report.pdf");
  };

  // ================= UI =================
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-blue-950 to-indigo-950 py-12 px-4">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="text-center mb-14">
          <h1 className="text-5xl sm:text-6xl md:text-7xl font-black text-white mb-6 tracking-tight">
            <span className="bg-gradient-to-r from-cyan-400 to-blue-400 bg-clip-text text-transparent">
              Medical Bill Review
            </span>
          </h1>
          <p className="text-xl sm:text-2xl text-white/80 font-medium">
            Clear, Accurate, and Easy to Understand
          </p>
        </div>

        {/* Key Metrics */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8 mb-12">
          {[
            { label: "Total Billed Charges", value: totalCharges },
            { label: "Insurance Paid", value: insurancePaid },
            { label: "Patient Responsibility", value: patientResponsibility },
            { label: "Potential Savings", value: potentialSavings || (isPaid ? "Calculated" : "Upgrade to unlock") },
          ].map((item, i) => (
            <div
              key={i}
              className="relative group overflow-hidden rounded-3xl bg-white/10 backdrop-blur-xl border-2 border-white/20 shadow-2xl hover:shadow-cyan-500/40 transition-all duration-500 hover:scale-105"
            >
              <div className="absolute inset-0 bg-gradient-to-br from-cyan-600/10 to-blue-600/10 opacity-0 group-hover:opacity-100 transition-opacity duration-700" />
              <div className="relative p-8">
                <p className="text-white/70 text-sm font-bold uppercase tracking-wider mb-6">
                  {item.label}
                </p>
                <p className="text-4xl sm:text-5xl font-black text-white break-words leading-tight">
                  {item.value}
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* Accordion Sections */}
        <div className="space-y-8">
          {/* Explanation */}
          <div className="rounded-3xl bg-white/10 backdrop-blur-xl border-2 border-white/20 shadow-2xl overflow-hidden">
            <button
              onClick={() => setOpenSections((prev) => prev.includes("explanation") ? prev.filter(s => s !== "explanation") : [...prev, "explanation"])}
              className="w-full px-10 py-8 text-left flex items-center justify-between hover:bg-white/5 transition"
            >
              <span className="flex items-center gap-5 text-3xl font-bold text-white">
                <span>✅</span> Detailed Explanation
              </span>
              <ChevronDown isOpen={openSections.includes("explanation")} />
            </button>
            {openSections.includes("explanation") && (
              <div className="px-10 pb-10 text-white/90 text-lg leading-relaxed">
                {summaryPoints.length > 0 && (
                  <ul className="space-y-5 mb-8">
                    {summaryPoints.map((point, i) => (
                      <li key={i} className="flex items-start gap-5">
                        <span className="text-cyan-400 text-2xl mt-1">•</span>
                        <span>{point}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="prose prose-invert prose-lg max-w-none">
                  {finalExplanation.split("\n\n").map((para, i) => para.trim() && <p key={i} className="mb-4">{para.trim()}</p>)}
                </div>
              </div>
            )}
          </div>

          {/* Services */}
          {services.length > 0 && (
            <div className="rounded-3xl bg-white/10 backdrop-blur-xl border-2 border-white/20 shadow-2xl overflow-hidden">
              <button
                onClick={() => setOpenSections((prev) => prev.includes("services") ? prev.filter(s => s !== "services") : [...prev, "services"])}
                className="w-full px-10 py-8 text-left flex items-center justify-between hover:bg-white/5 transition"
              >
                <span className="flex items-center gap-5 text-3xl font-bold text-white">
                  <span>🩺</span> Services & Procedures
                </span>
                <ChevronDown isOpen={openSections.includes("services")} />
              </button>
              {openSections.includes("services") && (
                <div className="px-10 pb-10">
                  <ul className="space-y-4">
                    {services.map((service, i) => (
                      <li key={i} className="bg-white/5 p-4 rounded-xl text-white/90">
                        {service}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Red Flags */}
          {redFlags.length > 0 && (
            <div className="rounded-3xl bg-red-900/30 backdrop-blur-xl border-2 border-red-500/50 shadow-2xl shadow-red-500/30 overflow-hidden">
              <button
                onClick={() => setOpenSections((prev) => prev.includes("redflags") ? prev.filter(s => s !== "redflags") : [...prev, "redflags"])}
                className="w-full px-10 py-8 text-left flex items-center justify-between hover:bg-red-900/20 transition"
              >
                <span className="flex items-center gap-5 text-3xl font-bold text-red-300">
                  <span>⚠️</span> Important Alerts / Red Flags
                </span>
                <ChevronDown isOpen={openSections.includes("redflags")} />
              </button>
              {openSections.includes("redflags") && (
                <div className="px-10 pb-10">
                  <ul className="space-y-5">
                    {redFlags.map((flag, i) => (
                      <li key={i} className="bg-red-900/40 p-6 rounded-2xl border border-red-500/60 text-white/95 text-lg">
                        <span className="font-bold text-red-300">Alert:</span> {flag}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* OCR Text Viewer (when AI partial or failed) */}
          {ocrText && !hasAiAnalysis && (
            <div className="rounded-3xl bg-amber-900/30 backdrop-blur-xl border-2 border-amber-500/50 shadow-2xl overflow-hidden">
              <button
                onClick={() => setShowOcr(!showOcr)}
                className="w-full px-10 py-8 text-left flex items-center justify-between hover:bg-amber-900/20 transition"
              >
                <span className="flex items-center gap-5 text-3xl font-bold text-amber-300">
                  <span>📄</span> Raw OCR Text (Full AI Review Coming Soon)
                </span>
                <ChevronDown isOpen={showOcr} />
              </button>
              {showOcr && (
                <div className="px-10 pb-10">
                  <pre className="bg-black/30 p-6 rounded-xl text-sm text-amber-100 whitespace-pre-wrap max-h-96 overflow-auto">
                    {ocrText}
                  </pre>
                  <p className="mt-4 text-amber-200">
                    We extracted the text from your bill! Full expert analysis is processing — upgrade for instant results.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Next Steps */}
          <div className="rounded-3xl bg-white/10 backdrop-blur-xl border-2 border-white/20 shadow-2xl overflow-hidden">
            <button
              onClick={() => setOpenSections((prev) => prev.includes("nextsteps") ? prev.filter(s => s !== "nextsteps") : [...prev, "nextsteps"])}
              className="w-full px-10 py-8 text-left flex items-center justify-between hover:bg-white/5 transition"
            >
              <span className="flex items-center gap-5 text-3xl font-bold text-white">
                <span>🎯</span> Next Steps
              </span>
              <ChevronDown isOpen={openSections.includes("nextsteps")} />
            </button>
            {openSections.includes("nextsteps") && (
              <div className="px-10 pb-10">
                <ol className="space-y-6">
                  {(structured?.nextSteps?.length > 0
                    ? structured.nextSteps
                    : [
                        "Request a detailed itemized bill from your provider",
                        "Compare charges on FairHealthConsumer.org",
                        "Call your insurance using the claim number",
                        "Appeal anything that looks incorrect — many appeals are successful",
                      ]
                  ).map((step, i) => (
                    <li key={i} className="flex items-start gap-6 bg-emerald-900/20 p-6 rounded-2xl border border-emerald-500/40">
                      <span className="text-emerald-400 font-black text-2xl min-w-10">{i + 1}</span>
                      <span className="text-white/90 text-lg">{step}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        </div>

        {/* Action Buttons */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 my-20">
          <button
            onClick={handlePDF}
            className="bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-600 hover:to-blue-700 text-white font-black text-xl py-6 px-10 rounded-full shadow-2xl transition-all duration-500 hover:scale-105"
          >
            📄 Download Full Report (PDF)
          </button>

          <button
            onClick={generateAppealLetter}
            className="bg-gradient-to-r from-red-600 to-orange-600 hover:from-red-700 hover:to-orange-700 text-white font-black text-xl py-6 px-10 rounded-full shadow-2xl transition-all duration-500 hover:scale-105"
          >
            ✉️ Generate Appeal Letter (PDF)
          </button>

          <button
            onClick={exportToExcel}
            className="bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700 text-white font-black text-xl py-6 px-10 rounded-full shadow-2xl transition-all duration-500 hover:scale-105"
          >
            📊 Export to Excel (CSV)
          </button>
        </div>

        {/* Upgrade CTA */}
        {!isPaid && (
          <div className="mt-24 text-center">
            <div className="rounded-3xl bg-gradient-to-r from-orange-600/40 via-red-600/40 to-purple-800/40 backdrop-blur-xl border-2 border-orange-500/60 p-14 max-w-5xl mx-auto shadow-2xl">
              <h3 className="text-4xl sm:text-5xl md:text-6xl font-black text-white mb-8">
                Unlock Full Expert Review & Appeal Tools
              </h3>
              <p className="text-2xl text-white/90 mb-12 max-w-3xl mx-auto">
                Instant red flags • Precise savings estimates • Appeal letter generator
              </p>
              <button
                onClick={onUpgrade}
                className="bg-white text-purple-800 font-black text-3xl py-8 px-24 rounded-full shadow-2xl hover:scale-110 hover:shadow-purple-500/60 transition-all duration-500"
              >
                Upgrade Now – Save Money
              </button>
              <p className="mt-10 text-white/70 text-xl">
                30-day money-back guarantee • One-time or unlimited plans
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
