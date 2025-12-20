import { useState } from "react";
import { explainBill } from "../api";

export default function UploadBill() {
  const [billText, setBillText] = useState("");
  const [response, setResponse] = useState("");

  const handleSubmit = async () => {
    const res = await explainBill(billText);
    setResponse(JSON.stringify(res, null, 2));
  };

  return (
    <div>
      <textarea value={billText} onChange={(e) => setBillText(e.target.value)} placeholder="Paste medical bill here"/>
      <button onClick={handleSubmit}>Explain Bill</button>
      <pre>{response}</pre>
    </div>
  );
}

