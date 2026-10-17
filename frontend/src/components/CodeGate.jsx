import React, { useState } from 'react';
import './CodeGate.css';

export default function CodeGate({ error, onSubmit }) {
  const [value, setValue] = useState('');

  const submit = (e) => {
    e.preventDefault();
    if (value.trim()) onSubmit(value.trim());
  };

  return (
    <div className="gate-wrap">
      <form className="gate-card" onSubmit={submit}>
        <h1 className="gate-title">Enter your code</h1>
        <p className="gate-text">This space is private. Use the code you were given.</p>
        <input
          className="gate-input"
          type="password"
          autoComplete="off"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label="Access code"
        />
        {error && <p className="gate-error" role="alert">{error}</p>}
        <button className="gate-submit" type="submit" disabled={!value.trim()}>
          Continue
        </button>
      </form>
    </div>
  );
}
