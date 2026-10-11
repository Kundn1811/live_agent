import React from 'react';
import './NotFound.css';

export default function NotFound() {
  return (
    <div className="nf-wrap">
      <h1 className="nf-title">Page not found</h1>
      <a className="nf-link" href="/">Go to the start</a>
    </div>
  );
}
