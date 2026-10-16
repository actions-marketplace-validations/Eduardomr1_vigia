export { analyzeFiles, analyzeSource, collectTestFiles, isTestFile } from './analyze';
export { countBySeverity, renderReport } from './report';
export { renderSarif, validateSarifCompliance } from './sarif';
export { rules } from './rules';
export type { AnalysisResult, Finding, Severity } from './types';
export type {
  SarifLog,
  SarifRun,
  SarifRule,
  SarifResult,
  SarifValidationResult,
} from './sarif';

