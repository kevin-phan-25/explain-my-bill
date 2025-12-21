import { useState } from "react";
import { explainBill } from "../api";

export default function UploadBill({ sessionId }) {
  const [file, setFile] = useState(null);
  const [text, setText] = useState("");
  const [result, setResult] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setResult("");

    const formData = new FormData();
    if (file) formData.append("bill", file);
    if (text) formData.append("text", text);
    if (sessionId) formData.append("sessionId", sessionId);

    const data = await explainBill(formData);
    setResult(data.explanation || data.error || "No response");
    setLoading(false);
  };

  return (
    <div>
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: "10px" }}>
          <input type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files[0])} />
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Or paste bill text here..."
          rows={8}
          style={{ width: "100%", marginBottom: "10px" }}
        />
        <button type="submit" disabled={loading}>
          {loading ? "Processing..." : "Explain My Bill"}
        </button>
      </form>

      {result && (
        <div style={{ marginTop: "30px", padding: "20px", background: "#f9f9f9", borderRadius: "8px" }}>
          <pre style={{ whiteSpace: "pre-wrap" }}>{result}</pre>
        </div>
      )}
    </div>
  );
}
