import { useState } from "react";
import { explainBill } from "../api";

export default function UploadBill({ sessionId }) {
  const [file, setFile] = useState(null);
  const [text, setText] = useState("");
  const [explanation, setExplanation] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    const formData = new FormData();
    if (file) formData.append("bill", file);
    if (text) formData.append("text", text);
    if (sessionId) formData.append("sessionId", sessionId);

    const res = await explainBill(formData);
    setExplanation(res.explanation);
    setLoading(false);
  };

  return (
    <div>
      <form onSubmit={handleSubmit}>
        <input type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files[0])} />
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Or paste bill text here" rows={10} />
        <button type="submit" disabled={loading}>Explain My Bill</button>
      </form>
      {loading && <p>Processing...</p>}
      <pre style={{ whiteSpace: "pre-wrap" }}>{explanation}</pre>
      {!sessionId && explanation && <p>Unlock full explanation with payment!</p>}
    </div>
  );
}
