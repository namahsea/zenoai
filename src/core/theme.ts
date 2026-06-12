import chalk from 'chalk';
import type { RiskLevel, HealthLabel } from '../types.js';

export const theme = {
  title: chalk.bold.hex('#F9FAFB'),
  heading: chalk.bold.hex('#F9FAFB'),
  text: chalk.hex('#F9FAFB'),
  muted: chalk.hex('#9CA3AF'),
  info: chalk.hex('#60A5FA'),
  success: chalk.hex('#22C55E'),
  caution: chalk.hex('#F59E0B'),
  danger: chalk.hex('#EF4444'),
  file: chalk.hex('#A78BFA'),
  divider: chalk.hex('#6B7280'),
};

export function riskTone(risk: RiskLevel): (text: string) => string {
  switch (risk) {
    case 'Critical': return theme.danger;
    case 'High':     return theme.caution;
    case 'Medium':   return chalk.hex('#FBBF24');
    case 'Low':      return theme.success;
  }
}

export function healthTone(label: HealthLabel): (text: string) => string {
  switch (label) {
    case 'Critical':
    case 'Concerning': return theme.danger;
    case 'Fair':       return chalk.hex('#FBBF24');
    case 'Good':       return theme.success;
  }
}
