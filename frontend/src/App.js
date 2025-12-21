import { useState, useEffect } from "react";
import UploadBill from "./components/UploadBill";
import Billing from "./components/Billing";

function App() {
  const [sessionId, setSessionId] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sess = params.get("session_id");
    if (sess) {
      setSessionId(sess);
      // In prod: store in localStorage or cookie
      window.history.replaceState({}, "", "/");
    }
  }, []);

  return (
    <div style={{ maxWidth: "800px", margin: "auto", padding: "20px" }}>
      <h1>Explain My Bill</h1>
      {!sessionId && <Billing setSessionId={setSessionId} />}
      <UploadBill sessionId={sessionId} />
    </div>
  );
}

export default App;
