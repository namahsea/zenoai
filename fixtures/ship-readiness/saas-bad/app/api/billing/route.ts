import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

export async function POST() {
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    success_url: 'https://example.com/success',
    cancel_url: 'https://example.com/cancel',
    line_items: [],
  });
  return Response.json({ id: session.id });
}
