import { LineChart } from 'recharts';

export default async function AnalyticsPage() {
  const rows = await fetch('/api/metrics');

  function exportCsv() {
    return rows;
  }

  function deleteReport() {
    return fetch('/api/reports/old', { method: 'DELETE' });
  }

  return (
    <main>
      <h1>Analytics dashboard</h1>
      <LineChart data={[]} />
      <table>
        <tbody>
          <tr><td>Revenue</td><td>100</td></tr>
        </tbody>
      </table>
      <button onClick={exportCsv}>Export CSV</button>
      <button onClick={deleteReport}>Delete report</button>
    </main>
  );
}
