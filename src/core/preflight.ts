import { access, readFile, writeFile, appendFile, rm, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { confirm } from '@inquirer/prompts';

const execAsync = promisify(exec);

async function runCommand(cmd: string): Promise<{ stdout: string; stderr: string }> {
  return execAsync(cmd, { cwd: process.cwd() });
}

const MANIFEST_FILENAME = '.zeno-manifest.json';
const MANIFEST_GITIGNORE_ENTRY = MANIFEST_FILENAME;

export interface PreflightResult {
  passed: boolean;
  branch: string;
  manifestPath: string;
  errors: string[];
  warnings: string[];
}

export interface ZenoManifest {
  runId: string;
  branch: string;
  originalBranch: string;
  timestamp: string;
  action: string;
  persona: string;
  files: Array<{ path: string; status: string; operation: 'modified' | 'created'; testFile?: string }>;
}

function buildZenoBranchName(runStartTime: Date): string {
  const zeroPad = (n: number, len = 2) => String(n).padStart(len, '0');
  return `zeno/refactor-${runStartTime.getFullYear()}-${zeroPad(runStartTime.getMonth() + 1)}-${zeroPad(runStartTime.getDate())}-${zeroPad(runStartTime.getHours())}${zeroPad(runStartTime.getMinutes())}${zeroPad(runStartTime.getSeconds())}`;
}

async function initialiseGitRepo(cwd: string): Promise<void> {
  await execAsync('git init', { cwd });
  await execAsync('git add .', { cwd });
  await execAsync('git commit -m "chore: initial commit before zeno run"', { cwd });
}

async function rollbackFile(file: ZenoManifest['files'][number], cwd: string): Promise<void> {
  if (file.status === 'accepted') {
    if (file.operation === 'modified') {
      const isTracked = await execAsync(`git ls-files --error-unmatch "${file.path}"`, { cwd })
        .then(() => true)
        .catch(() => false);

      if (isTracked) {
        await execAsync(`git checkout HEAD -- "${file.path}"`, { cwd }).catch(err =>
          console.error(`Failed to restore ${file.path}:`, err),
        );
      } else {
        await rm(join(cwd, file.path), { force: true }).catch(err =>
          console.error(`Failed to delete untracked file ${file.path}:`, err),
        );
      }
    } else if (file.operation === 'created') {
      await rm(join(cwd, file.path), { force: true }).catch(err =>
        console.error(`Failed to delete created file ${file.path}:`, err),
      );
    }
  }
  if (file.testFile) {
    await unlink(join(cwd, file.testFile)).catch(err =>
      console.error(`Failed to delete test file ${file.testFile}:`, err),
    );
  }
}

export async function runPreflight(): Promise<PreflightResult> {
  const cwd = process.cwd();
  const errors: string[] = [];
  const warnings: string[] = [];
  let branch = '';
  let manifestPath = '';

  // 1. Git detection
  if (!existsSync(join(cwd, '.git'))) {
    const initialise = await confirm({
      message: 'No git repository found. Zeno needs git to safely roll back changes.\nInitialise git now?',
      default: true,
    });

    if (!initialise) {
      errors.push('Git initialisation declined. Run git init manually and try again.');
      return { passed: false, branch, manifestPath, errors, warnings };
    }

    await initialiseGitRepo(cwd);
  }

  // Guard against recursive branching — Zeno must never branch off itself
  const currentBranchCmd = await runCommand('git branch --show-current');
  const currentBranch = currentBranchCmd.stdout.trim();

  if (currentBranch.startsWith('zeno/')) {
    errors.push(
      `You are on a Zeno branch (${currentBranch}). Merge or discard it first:\n` +
      `  Keep changes:    git checkout main && git merge ${currentBranch}\n` +
      `  Discard changes: git checkout main && git branch -D ${currentBranch}`,
    );
    return { passed: false, branch, manifestPath, errors, warnings };
  }

  // 2. Dirty tree check — hard block
  const statusCmd = await runCommand('git status --porcelain');
  if (statusCmd.stdout.trim().length > 0) {
    errors.push('You have uncommitted changes. Please run: git add . && git commit -m "your message" — then try Zeno again.');
    return { passed: false, branch, manifestPath, errors, warnings };
  }

  // 3. Branch creation
  const { stdout: currentBranchStdout } = await execAsync('git branch --show-current', { cwd });
  const originalBranch = currentBranchStdout.trim();

  const runStartTime = new Date();
  const branchName = buildZenoBranchName(runStartTime);

  try {
    await execAsync(`git checkout -b ${branchName}`, { cwd });
    branch = branchName;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Failed to create branch ${branchName}: ${msg}`);
    return { passed: false, branch, manifestPath, errors, warnings };
  }

  // 5. Manifest creation
  manifestPath = join(cwd, MANIFEST_FILENAME);
  const manifest: ZenoManifest = {
    runId: branchName,
    branch: branchName,
    originalBranch,
    timestamp: runStartTime.toISOString(),
    action: '',
    persona: '',
    files: [],
  };

  try {
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Failed to write manifest: ${msg}`);
    return { passed: false, branch, manifestPath, errors, warnings };
  }

  // 6. Gitignore update
  const gitignorePath = join(cwd, '.gitignore');
  try {
    await access(gitignorePath);
    const gitignoreContents = await readFile(gitignorePath, 'utf8');
    if (!gitignoreContents.split('\n').some(line => line.trim() === MANIFEST_GITIGNORE_ENTRY)) {
      await appendFile(gitignorePath, `\n${MANIFEST_GITIGNORE_ENTRY}\n`, 'utf8');
    }
  } catch {
    // .gitignore doesn't exist — create it
    await writeFile(gitignorePath, `${MANIFEST_GITIGNORE_ENTRY}\n`, 'utf8');
  }

  return { passed: true, branch, manifestPath, errors, warnings };
}

export async function rollback(manifestPath: string): Promise<void> {
  try {
    const manifestContent = await readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(manifestContent) as ZenoManifest;

    // Step 1 — destroy all changes on the zeno branch
    await runCommand('git reset --hard HEAD');

    // Step 2 — return to the original branch
    await runCommand(`git checkout ${manifest.originalBranch}`);

    // Step 3 — delete the zeno branch
    await runCommand(`git branch -D ${manifest.branch}`);

    // Step 4 — delete the manifest
    await rm(manifestPath, { force: true });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Rollback failed:', msg);
    throw err;
  }
}