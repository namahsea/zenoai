'use server';

import { currentUser } from '@clerk/nextjs/server';
import { z } from 'zod';
import { prisma } from '../../src/db';

const settingsSchema = z.object({
  displayName: z.string().min(1),
});

if (!process.env.DATABASE_URL) {
  throw new Error('Missing DATABASE_URL environment variable');
}

export async function saveSettings(input: unknown) {
  const user = await currentUser();
  if (!user) throw new Error('Sign in required');

  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success) {
    return { error: 'Invalid settings' };
  }

  try {
    await prisma.user.update({
      where: { id: user.id },
      data: { displayName: parsed.data.displayName },
    });
    return { ok: true };
  } catch {
    return { error: 'Could not save settings' };
  }
}
