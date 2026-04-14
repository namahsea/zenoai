export type RiskLevel = 'Critical' | 'High' | 'Medium' | 'Low';
export type HealthLabel = 'Critical' | 'Concerning' | 'Fair' | 'Good' | 'Excellent';

export interface RiskyFile {
  path: string;
  risk: RiskLevel;
  legibility: number;
  consequence: string;
}

export interface SuggestedAction {
  action: string;
  reason: string;
}

export interface HealthReport {
  healthScore: number;
  healthLabel: HealthLabel;
  healthContext: string;
  riskyFiles: RiskyFile[];
  observations: string[];
  suggestedActions: SuggestedAction[];
  startHere: string;
}
