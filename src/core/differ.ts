import { writeFile, readFile, unlink } from 'node:fs/promises'; // readFile imported but currently unused — remove if no planned use
import { execSync } from 'node:child_process';
import chalk from 'chalk';
import { confirm } from '@inquirer/prompts';
import type { ValidatorResult } from './validator.js';
import { rollback } from './preflight.js';

const FILE_ENCODING = 'utf8' as const;
const REPORT_PATH_COL_WIDTH = 40;

interface ZenoManifest {
  runId: string;
  branch: string;
  originalBranch: string;
  timestamp: string;
  action: string;
  persona: string;
  files: Array<{
    path: string;
    status: 'accepted' | 'skipped';
    operation: 'modified' | 'created';
    confidenceScore: number;
    testFile?: string;
    linesChanged?: number;
    skipReason?: string;
  }>;
}

export interface DifferResult {
  approved: boolean;
  merged: boolean;
  appliedFiles: string[];
  skippedFiles: string[];
}

function formatConfidenceScore(score: number): string {
  return `score ${score.toFixed(2)}`;
}

function mergeAndCleanBranch(sourceBranch: string, targetBranch: string): void {
  execSync(`git checkout ${targetBranch}`, { stdio: 'inherit' });
  execSync(`git merge ${sourceBranch}`, { stdio: 'inherit' });
  execSync(`git branch -D ${sourceBranch}`, { stdio: 'inherit' });
}

export async function runDiffer(
  results: ValidatorResult[],
  manifest: ZenoManifest,
  manifestPath: string,
): Promise<DifferResult> {
  const appliedFiles: string[] = [];
  const skippedFiles: string[] = [];

  // Step 1 — write accepted files to disk, build manifest entries
  for (const result of results) {
    if (result.status === 'accepted' && result.refactoredSource !== undefined) {
      await writeFile(result.filePath, result.refactoredSource, FILE_ENCODING);
      appliedFiles.push(result.filePath);

      manifest.files.push({
        path: result.filePath,
        status: 'accepted',
        operation: 'modified',
        confidenceScore: result.confidenceScore,
        linesChanged: result.linesChanged,
      });

      if (result.testFile) {
        manifest.files.push({
          path: result.testFile,
          status: 'accepted',
          operation: 'created',
          confidenceScore: result.confidenceScore,
          testFile: result.testFile,
        });
      }
    } else {
      skippedFiles.push(result.filePath);

      manifest.files.push({
        path: result.filePath,
        status: 'skipped',
        operation: 'modified',
        confidenceScore: result.confidenceScore,
        skipReason: result.skipReason,
      });
    }
  }

  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), FILE_ENCODING);

  const acceptedPaths = results
    .filter(r => r.status === 'accepted')
    .map(r => r.filePath);

  if (acceptedPaths.length > 0) {
    execSync(`git add ${acceptedPaths.map(p => `"${p}"`).join(' ')}`);
    execSync(`git commit -m "chore: zeno humanise — ${acceptedPaths.length} files refactored"`);
  }

  // Step 2 — print report
  console.log('\n' + chalk.cyan('━━━  ZENOAI REFACTOR REPORT  ━━━'));
  console.log(chalk.dim(`Action: ${manifest.action}`));
  console.log(chalk.dim(`Branch: ${manifest.branch}`));
  console.log(chalk.cyan('─────────────────────────────────'));

  const acceptedResults = results.filter(result => result.status === 'accepted');
  const skippedResults = results.filter(result => result.status === 'skipped');

  console.log(chalk.bold.white(`\nACCEPTED (${acceptedResults.length} files)\n`));
  for (const result of acceptedResults) {
    const score = formatConfidenceScore(result.confidenceScore);
    const lines = result.linesChanged !== undefined ? `+${result.linesChanged} lines` : '';
    console.log(`  ${chalk.cyan(result.filePath.padEnd(REPORT_PATH_COL_WIDTH))} ${chalk.green(score)}   ${chalk.dim(lines)}`);
  }

  console.log(chalk.bold.white(`\nSKIPPED (${skippedResults.length} files)\n`));
  for (const result of skippedResults) {
    const score = formatConfidenceScore(result.confidenceScore);
    const reason = result.skipReason ?? '';
    console.log(`  ${chalk.cyan(result.filePath.padEnd(REPORT_PATH_COL_WIDTH))} ${chalk.red(score)}   ${chalk.dim(reason)}`);
  }

  console.log('\n' + chalk.cyan('─────────────────────────────────') + '\n');

  // Step 3 — pause and review prompt
  console.log(chalk.green(`✓ Changes staged on branch: ${manifest.branch}`));
  console.log(chalk.dim(`  Review in your IDE or run: git diff ${manifest.originalBranch}..${manifest.branch}\n`));

  const keepChanges = await confirm({ message: 'Keep these changes?', default: true });

  if (!keepChanges) {
    // Step 4 — user declined; rollback
    await rollback(manifestPath);
    console.log(chalk.red('✗ Changes discarded. Your codebase is unchanged.'));
    return { approved: false, merged: false, appliedFiles: [], skippedFiles };
  }

  // Step 5 — approved; ask about merge
  const mergeNow = await confirm({
    message: `Merge into ${manifest.originalBranch} now?`,
    default: false,
  });

  if (mergeNow) {
    mergeAndCleanBranch(manifest.branch, manifest.originalBranch);
    await unlink(manifestPath).catch((err: unknown) => {
      console.warn(chalk.dim(`Warning: could not remove manifest file: ${err}`));
    });
    console.log(chalk.green(`✓ Merged into ${manifest.originalBranch}. Branch cleaned up.`));
    console.log(chalk.green('  Your codebase is updated.'));
    return { approved: true, merged: true, appliedFiles, skippedFiles };
  }

  console.log(chalk.green(`✓ Changes are on branch: ${manifest.branch}`));
  console.log(chalk.dim(`  Merge when ready:    git checkout ${manifest.originalBranch} && git merge ${manifest.branch}`));
  console.log(chalk.dim(`  Discard if needed:   git checkout ${manifest.originalBranch} && git branch -D ${manifest.branch}`));
  return { approved: true, merged: false, appliedFiles, skippedFiles };
}