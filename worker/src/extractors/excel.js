/**
 * Excel File Processing
 * Updated: May 30, 2026
 */

export async function processExcel(buffer) {
  try {
    const XLSX = await import("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm");

    const wb = XLSX.read(buffer, { type: "array" });

    return wb.SheetNames.map((sheetName, i) => ({
      page: i + 1,
      sheetName: sheetName,
      rawText: XLSX.utils.sheet_to_csv(wb.Sheets[sheetName]),
    }));
  } catch (err) {
    console.error("Excel processing error:", err.message);
    return [{
      page: 1,
      sheetName: "Error",
      rawText: "Failed to parse Excel file. Please try saving as CSV or PDF instead.",
    }];
  }
}
