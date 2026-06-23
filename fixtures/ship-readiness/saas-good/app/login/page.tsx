import { currentUser } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';

export default async function LoginPage() {
  const user = await currentUser();
  if (user) redirect('/dashboard');
  return <main>Sign in to continue</main>;
}
