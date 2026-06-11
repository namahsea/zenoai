import chalk from 'chalk';

interface ProgressOptions {
  label: string;
  total: number;
  minDurationMs?: number;
  maxDurationMs?: number;
  showCount?: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function progressDuration(total: number, minDurationMs?: number, maxDurationMs?: number): number {
  const min = minDurationMs ?? 900;
  const max = maxDurationMs ?? 4200;
  return clamp(900 + total * 65, min, max);
}

function renderBar(label: string, current: number, total: number, showCount: boolean): void {
  const width = 26;
  const safeTotal = Math.max(total, 1);
  const ratio = clamp(current / safeTotal, 0, 1);
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  const percent = Math.round(ratio * 100);
  const count = showCount ? chalk.dim(` ${Math.min(current, total)}/${total}`) : '';

  process.stdout.write(
    `\r${chalk.bold.white('Zeno')} ${chalk.dim(label)} ` +
    `${chalk.cyan('█'.repeat(filled))}${chalk.dim('░'.repeat(empty))} ` +
    `${chalk.white(String(percent).padStart(3, ' '))}%${count}`,
  );
}

export async function runProgress<T>(
  options: ProgressOptions,
  task: () => Promise<T>,
): Promise<T> {
  const total = Math.max(options.total, 1);
  const duration = progressDuration(options.total, options.minDurationMs, options.maxDurationMs);
  const startedAt = Date.now();
  let taskDone = false;
  let taskResult: T | undefined;
  let taskError: unknown;
  let current = 0;

  task()
    .then((result) => {
      taskResult = result;
    })
    .catch((error: unknown) => {
      taskError = error;
    })
    .finally(() => {
      taskDone = true;
    });

  const showCount = options.showCount ?? true;

  renderBar(options.label, current, total, showCount);

  await new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      const timeProgress = clamp(elapsed / duration, 0, 1);
      const timedTarget = Math.floor(timeProgress * total);
      const target = taskDone && elapsed >= duration
        ? total
        : Math.min(total - 1, timedTarget);
      current = Math.max(current, target);
      renderBar(options.label, current, total, showCount);

      if (taskDone && current >= total) {
        clearInterval(interval);
        process.stdout.write('\n');
        resolve();
      }
    }, 80);
  });

  if (taskError) throw taskError;
  return taskResult as T;
}
