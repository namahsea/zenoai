import { prisma } from '../../../src/db';

const databaseUrl = process.env.DATABASE_URL;

export async function POST(request: Request) {
  const body = await request.json();
  await prisma.project.create({ data: body });
  return Response.json({ ok: true, databaseUrl });
}
