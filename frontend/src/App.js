// frontend/src/App.js

import React, { useState } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { createCheckoutSession, explainBill } from './api';

const stripePromise = loadStripe('pk_test_your_stripe_publishable_key_here'); // Replace with your Stripe publishable key

function App() {
  const [file, setFile] = useState(null);
  const [explanation, setExplanation] = useState('');
  const [isPaid, setIsPaid] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleFileChange = (e) => {
    setFile(e.target.files[0]);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!file) return;

    setLoading(true);
    setError('');
    setExplanation('');

    const formData = new FormData();
    formData.append('bill', file);

    try {
      const data = await explainBill(formData);
      setExplanation(data.explanation);
      setIsPaid(data.isPaid);
    } catch (err) {
      setError(err.message || 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  const handleUpgrade = async (plan) => {
    try {
      const { id } = await createCheckoutSession(plan);
      const stripe = await stripePromise;
      await stripe.redirectToCheckout({ sessionId: id });
    } catch (err) {
      setError(err.message || 'Payment failed');
    }
  };

  return (
    <div style={{ maxWidth: '600px', margin: 'auto', padding: '20px' }}>
      <h1>ExplainMyBill</h1>
      <p>Upload a bill (PDF or image) to get a simple AI explanation.</p>

      <form onSubmit={handleSubmit}>
        <input type="file" accept="image/*,.pdf" onChange={handleFileChange} required />
        <button type="submit" disabled={loading}>
          {loading ? 'Processing...' : 'Explain Bill'}
        </button>
      </form>

      {error && <p style={{ color: 'red' }}>{error}</p>}

      {explanation && (
        <div style={{ marginTop: '20px', border: '1px solid #ccc', padding: '15px' }}>
          <h2>Explanation</h2>
          <pre style={{ whiteSpace: 'pre-wrap' }}>{explanation}</pre>

          {!isPaid && (
            <div style={{ marginTop: '20px' }}>
              <p><strong>Upgrade for full detailed explanation</strong></p>
              <button onClick={() => handleUpgrade('one-time')}>One-time payment ($10)</button>
              <button onClick={() => handleUpgrade('monthly')} style={{ marginLeft: '10px' }}>Monthly subscription ($5/mo)</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default App;
