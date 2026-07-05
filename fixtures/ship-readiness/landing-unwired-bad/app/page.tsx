'use client';

import { useState } from 'react';

export default function HomePage() {
  const [email, setEmail] = useState('');

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setEmail('');
  }

  return (
    <main>
      <h1>Join the early access waitlist</h1>
      <form onSubmit={handleSubmit}>
        <input
          type="email"
          name="email"
          placeholder="Email for early access"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <button type="submit">Join waitlist</button>
      </form>
    </main>
  );
}
