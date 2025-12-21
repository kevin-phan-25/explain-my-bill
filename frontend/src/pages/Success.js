import React, { useEffect, useState } from 'react';
import { explainBill } from '../api';

function Success() {
  const [explanation, setExplanation] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const sessionId = urlParams.get('session_id');

    if (sessionId) {
      const formData = new FormData();
      formData.append('sessionId', sessionId);
      // Re-use the last uploaded file or prompt to upload again
      // For simplicity, show message
      setExplanation('Payment successful! Full explanation unlocked.');
    }
    setLoading(false);
  }, []);

  return (
    <div>
      <h1>Payment Successful!</h1>
      <p>{explanation || 'You can now get full explanations.'}</p>
    </div>
  );
}

export default Success;
