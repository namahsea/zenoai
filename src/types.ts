export type RiskLevel = 'Critical' | 'High' | 'Medium' | 'Low';
export type HealthLabel = 'Critical' | 'Concerning' | 'Fair' | 'Good';

export interface RiskyFile {
  path: string;
  risk: RiskLevel;
  legibility: number;
  consequence: string;
}

export interface SuggestedAction {
  instruction: string;
  rationale: string;
}

export interface HealthReport {
  score: number;
  label: HealthLabel;
  summary: string;
  files: RiskyFile[];
  observations: string[];
  actions: SuggestedAction[];
  start: string;
}
