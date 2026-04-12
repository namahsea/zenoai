import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { select, input } from '@inquirer/prompts';
import chalk from 'chalk';

const CONFIG_DIR = join(homedir(), '.zenoai');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

export type Provider = 'anthropic' | 'gemini' | 'openrouter' | 'openai';

export interface ZenoConfig {
  provider: Provider;
  apiKey: string;
}

async function readConfig(): Promise<ZenoConfig | null> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ZenoConfig>;
    if (
      parsed.provider &&
      ['anthropic', 'gemini', 'openrouter', 'openai'].includes(parsed.provider) &&
      parsed.apiKey?.trim()
    ) {
      return { provider: parsed.provider, apiKey: parsed.apiKey.trim() };
    }
    return null;
  } catch {
    return null;
  }
}

async function saveConfig(config: ZenoConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic: 'Anthropic (Claude)',
  gemini: 'Google AI Studio (Gemini)',
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
};

const KEY_HINTS: Record<Provider, string> = {
  anthropic: 'console.anthropic.com/settings/keys',
  gemini: 'aistudio.google.com/app/apikey',
  openrouter: 'openrouter.ai/settings/keys',
  openai: 'platform.openai.com/api-keys',
};

export async function ensureConfig(): Promise<ZenoConfig> {
  const existing = await readConfig();
  if (existing) return existing;

  console.log(chalk.bold.cyan('\n  Welcome to zenoai!\n'));
  console.log(
    chalk.dim(
      '  zenoai needs an AI provider API key to analyse your codebase.\n' +
      '  Your key is stored only in ~/.zenoai/config.json and is never\n' +
      '  logged or sent anywhere other than the provider you choose.\n',
    ),
  );

  const provider = await select<Provider>({
    message: 'Choose your AI provider:',
    choices: (Object.keys(PROVIDER_LABELS) as Provider[]).map((p) => ({
      value: p,
      name: PROVIDER_LABELS[p],
    })),
  });

  console.log(chalk.dim(`\n  Get your key at: ${KEY_HINTS[provider]}\n`));

  const apiKey = await input({
    message: `${PROVIDER_LABELS[provider]} API key:`,
    validate: (value) => (value.trim() ? true : 'API key cannot be empty.'),
    transformer: (value) => '*'.repeat(value.length),
  });

  const config: ZenoConfig = { provider, apiKey: apiKey.trim() };
  await saveConfig(config);
  console.log(chalk.green('\n  Config saved to ~/.zenoai/config.json\n'));

  return config;
}
