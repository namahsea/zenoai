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

export type ReviewIntent =
  | 'ship_readiness'
  | 'risk_scan'
  | 'codebase_explanation'
  | 'cleanup_plan'
  | 'safe_refactor';

export type ProjectType =
  | 'landing_page'
  | 'saas_app'
  | 'dashboard'
  | 'ecommerce_payment_app'
  | 'auth_app'
  | 'backend_api'
  | 'cli_tooling'
  | 'unknown';

export type IssueSeverity = 'Critical' | 'High' | 'Medium' | 'Low';

export interface ShipReadinessIssue {
  issue: string;
  evidence: string;
  risk: string;
  suggestedFix: string;
  severity: IssueSeverity;
}

export interface ShipReadinessDecision {
  answer: 'Yes' | 'Maybe' | 'No';
  reason: string;
}

export interface HealthReport {
  score: number;
  label: HealthLabel;
  summary: string;
  files: RiskyFile[];
  observations: string[];
  actions: SuggestedAction[];
  start: string;
  reviewIntent?: ReviewIntent;
  projectType?: ProjectType;
  confidence?: 'High' | 'Medium' | 'Low';
  founderSummary?: string;
  hardBlockers?: ShipReadinessIssue[];
  softBlockers?: ShipReadinessIssue[];
  codeOwnershipRisks?: ShipReadinessIssue[];
  evidence?: string[];
  privatePreview?: ShipReadinessDecision;
  publicLaunch?: ShipReadinessDecision;
  paidTraffic?: ShipReadinessDecision;
}
