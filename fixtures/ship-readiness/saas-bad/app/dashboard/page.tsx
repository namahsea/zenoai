export default async function DashboardPage() {
  const data = await fetch('/api/projects');
  return (
    <main>
      <h1>Dashboard</h1>
      <button>Delete project</button>
      <button>Cancel subscription</button>
      <pre>{JSON.stringify(data)}</pre>
    </main>
  );
}
