import posthog from 'posthog-js';

export default function HomePage() {
  posthog.capture('landing_viewed');

  return (
    <main>
      <h1>Verified landing page</h1>
      <p>Join the early access list.</p>
      <a href="/docs">Open docs</a>
      <form action="/api/beta-updates" method="post">
        <label>
          Email
          <input type="email" name="email" placeholder="you@example.com" required />
        </label>
        <button type="submit">Join early access</button>
      </form>
    </main>
  );
}
