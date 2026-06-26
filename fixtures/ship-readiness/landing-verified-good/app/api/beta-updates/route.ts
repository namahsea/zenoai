type SignupPayload = {
  email?: FormDataEntryValue | null;
};

function isValidEmail(value: FormDataEntryValue | null | undefined): value is string {
  return typeof value === 'string' && value.includes('@');
}

async function saveSignup(_payload: { email: string }) {
  return { ok: true };
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const payload: SignupPayload = {
      email: formData.get('email'),
    };

    if (!isValidEmail(payload.email)) {
      return Response.json({ error: 'Email is required.' }, { status: 400 });
    }

    await saveSignup({ email: payload.email });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: 'Could not save signup.' }, { status: 500 });
  }
}
