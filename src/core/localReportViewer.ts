import { execFile } from 'node:child_process';

export function manualOpenCommand(filePath: string): string {
  const quoted = `"${filePath.replace(/"/g, '\\"')}"`;
  if (process.platform === 'darwin') return `open ${quoted}`;
  if (process.platform === 'win32') return `start "" ${quoted}`;
  return `xdg-open ${quoted}`;
}

export function openFileInBrowser(filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.platform === 'darwin') {
      execFile('open', [filePath], (err) => err ? reject(err) : resolve());
      return;
    }

    if (process.platform === 'win32') {
      execFile('cmd', ['/c', 'start', '', filePath], (err) => err ? reject(err) : resolve());
      return;
    }

    execFile('xdg-open', [filePath], (err) => err ? reject(err) : resolve());
  });
}
