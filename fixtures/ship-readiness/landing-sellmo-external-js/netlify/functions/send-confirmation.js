exports.handler = async function handler() {
  const apiKey = process.env.BREVO_API_KEY;

  if (!apiKey) {
    throw new Error('Brevo API key not configured');
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
