import { currentUser } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';

export default async function DashboardPage() {
  const user = await currentUser();
  if (!user) redirect('/login');

  const isLoading = false;
  const error = null;
  const projects = [{ id: 'p1', name: 'Launch plan' }];

  if (isLoading) return <div>Loading dashboard...</div>;
  if (error) return <div>Error loading dashboard</div>;
  if (projects.length === 0) return <div>No data yet</div>;

  return (
    <main>
      <h1>Dashboard</h1>
      <table>
        <tbody>{projects.map(project => <tr key={project.id}><td>{project.name}</td></tr>)}</tbody>
      </table>
    </main>
  );
}
