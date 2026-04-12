#!/usr/bin/env node

// Load .env before any module runs — overrides empty values set by global interceptors
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

try {
  const lines = readFileSync(resolve(process.cwd(), '.env'), 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key && val) process.env[key] = val; // overwrite — don't skip empty values set by interceptors
  }
} catch {
  // no .env — rely on shell environment
}

import('../dist/index.js');
