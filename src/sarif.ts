import type { AnalysisResult, Severity } from './types';

export interface SarifLog {
  $schema: string;
  version: string;
  runs: SarifRun[];
}

export interface SarifRun {
  tool: {
    driver: {
      name: string;
      version: string;
      informationUri: string;
      rules: SarifRule[];
    };
  };
  results: SarifResult[];
}

export interface SarifRule {
  id: string;
  name: string;
  shortDescription: { text: string };
  fullDescription?: { text: string } | undefined;
  helpUri?: string | undefined;
  help?:
    | {
        text: string;
        markdown?: string | undefined;
      }
    | undefined;
  defaultConfiguration: {
    level: 'error' | 'warning' | 'note';
  };
}

export interface SarifResult {
  ruleId: string;
  ruleIndex?: number | undefined;
  level: 'error' | 'warning' | 'note';
  message: { text: string };
  locations: {
    physicalLocation: {
      artifactLocation: { uri: string };
      region: {
        startLine: number;
        startColumn: number;
      };
    };
  }[];
}

const SEVERITY_TO_LEVEL: Record<Severity, 'error' | 'warning' | 'note'> = {
  P1: 'error',
  P2: 'warning',
  P3: 'note',
};

const RULE_DESCRIPTIONS: Record<string, string> = {
  'no-assertion': 'Test contains no assertions and cannot fail.',
  'expect-without-matcher': 'Expect call has no matcher invoked.',
  'tautology': 'Assertion compares a literal against itself.',
  'identical-expression': 'Assertion compares an identical expression against itself.',
  'skipped-test': 'Test or suite is marked as skipped and ignored.',
  'focused-test': 'Test or suite is marked as focused (only/fit) in commit.',
  'missing-await': 'Async assertion or function is missing await keyword.',
  'assertion-in-catch': 'Assertion inside catch block without rejection verification.',
  'orphan-negative-assertion': 'Negative assertion has no positive baseline assertion.',
  'redundant-boolean-assertion': 'Assertion uses redundant boolean comparison instead of a direct matcher.',
};

/**
 * Transforms Vigía analysis findings into the OASIS SARIF v2.1.0 standard,
 * enabling seamless integration with GitHub Code Scanning alerts.
 */
export function renderSarif(result: AnalysisResult, toolVersion = '1.6.0'): string {
  const rulesMap = new Map<string, SarifRule>();

  for (const f of result.findings) {
    if (!rulesMap.has(f.rule)) {
      const description = RULE_DESCRIPTIONS[f.rule] ?? `Test quality rule: ${f.rule}`;
      rulesMap.set(f.rule, {
        id: f.rule,
        name: f.rule.replace(/(?:^|-)(\w)/g, (_, c) => c.toUpperCase()),
        shortDescription: {
          text: description,
        },
        fullDescription: {
          text: description,
        },
        helpUri: 'https://github.com/Eduardomr1/vigia#rules',
        help: {
          text: `${description} Remediation: see https://github.com/Eduardomr1/vigia#rules`,
          markdown: `**${f.rule}**: ${description}\n\n[Documentation & Remediation](https://github.com/Eduardomr1/vigia#rules)`,
        },
        defaultConfiguration: {
          level: SEVERITY_TO_LEVEL[f.severity],
        },
      });
    }
  }

  const rulesList = Array.from(rulesMap.values());
  const ruleIndices = new Map<string, number>(rulesList.map((r, i) => [r.id, i]));

  const results: SarifResult[] = result.findings.map((f) => {
    const ruleIndex = ruleIndices.get(f.rule);
    return {
      ruleId: f.rule,
      ...(ruleIndex !== undefined ? { ruleIndex } : {}),
      level: SEVERITY_TO_LEVEL[f.severity],
      message: {
        text: `${f.message} (Hint: ${f.hint})`,
      },
      locations: [
        {
          physicalLocation: {
            artifactLocation: {
              uri: f.file.replace(/\\/g, '/'),
            },
            region: {
              startLine: Math.max(1, f.line),
              startColumn: Math.max(1, f.column),
            },
          },
        },
      ],
    };
  });

  const log: SarifLog = {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'vigia',
            version: toolVersion,
            informationUri: 'https://github.com/Eduardomr1/vigia',
            rules: rulesList,
          },
        },
        results,
      },
    ],
  };

  return JSON.stringify(log, null, 2);
}

export interface SarifValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

/**
 * Validates that an arbitrary object satisfies OASIS SARIF v2.1.0 compliance
 * as required by the specification and GitHub Code Scanning.
 */
export function validateSarifCompliance(data: unknown): SarifValidationResult {
  const errors: string[] = [];

  if (typeof data !== 'object' || data === null) {
    return { valid: false, errors: ['SARIF root must be a non-null object.'] };
  }

  const log = data as Record<string, unknown>;

  if (log.version !== '2.1.0') {
    errors.push(`SARIF 'version' must be exactly '2.1.0', got '${String(log.version)}'.`);
  }

  if (typeof log.$schema !== 'string' || !log.$schema.includes('sarif-schema-2.1.0.json')) {
    errors.push(`SARIF '$schema' must reference the OASIS SARIF v2.1.0 schema JSON.`);
  }

  if (!Array.isArray(log.runs) || log.runs.length === 0) {
    errors.push(`SARIF 'runs' must be a non-empty array.`);
  } else {
    for (let runIdx = 0; runIdx < log.runs.length; runIdx += 1) {
      const run = log.runs[runIdx] as Record<string, unknown>;
      if (typeof run !== 'object' || run === null) {
        errors.push(`SARIF run at index ${runIdx} must be an object.`);
        continue;
      }

      const tool = run.tool as Record<string, unknown> | undefined;
      if (typeof tool !== 'object' || tool === null) {
        errors.push(`Run[${runIdx}] must contain a 'tool' object.`);
        continue;
      }

      const driver = tool.driver as Record<string, unknown> | undefined;
      if (typeof driver !== 'object' || driver === null) {
        errors.push(`Run[${runIdx}].tool must contain a 'driver' object.`);
        continue;
      }

      if (typeof driver.name !== 'string' || driver.name.trim().length === 0) {
        errors.push(`Run[${runIdx}].tool.driver.name must be a non-empty string.`);
      }

      if (typeof driver.version !== 'string' || driver.version.trim().length === 0) {
        errors.push(`Run[${runIdx}].tool.driver.version must be a non-empty string.`);
      }

      if (
        typeof driver.informationUri !== 'string' ||
        (!driver.informationUri.startsWith('https://') && !driver.informationUri.startsWith('http://'))
      ) {
        errors.push(`Run[${runIdx}].tool.driver.informationUri must be a valid HTTP(S) URI.`);
      }

      if (!Array.isArray(driver.rules)) {
        errors.push(`Run[${runIdx}].tool.driver.rules must be an array.`);
      } else {
        driver.rules.forEach((ruleItem: unknown, rIdx: number) => {
          if (typeof ruleItem !== 'object' || ruleItem === null) {
            errors.push(`Run[${runIdx}].tool.driver.rules[${rIdx}] must be an object.`);
            return;
          }
          const rule = ruleItem as Record<string, unknown>;
          if (typeof rule.id !== 'string' || rule.id.trim().length === 0) {
            errors.push(`Rule at index ${rIdx} must have a non-empty string 'id'.`);
          }
          if (typeof rule.name !== 'string' || rule.name.trim().length === 0) {
            errors.push(`Rule at index ${rIdx} must have a non-empty string 'name'.`);
          }
          const shortDesc = rule.shortDescription as Record<string, unknown> | undefined;
          if (typeof shortDesc !== 'object' || typeof shortDesc?.text !== 'string' || shortDesc.text.length === 0) {
            errors.push(`Rule at index ${rIdx} must have 'shortDescription.text'.`);
          }
          const config = rule.defaultConfiguration as Record<string, unknown> | undefined;
          if (
            typeof config !== 'object' ||
            !['error', 'warning', 'note', 'none'].includes(String(config?.level))
          ) {
            errors.push(`Rule at index ${rIdx} must have 'defaultConfiguration.level' ('error', 'warning', 'note', 'none').`);
          }
        });
      }

      if (!Array.isArray(run.results)) {
        errors.push(`Run[${runIdx}].results must be an array.`);
      } else {
        run.results.forEach((resItem: unknown, resIdx: number) => {
          if (typeof resItem !== 'object' || resItem === null) {
            errors.push(`Result at index ${resIdx} must be an object.`);
            return;
          }
          const res = resItem as Record<string, unknown>;
          if (typeof res.ruleId !== 'string' || res.ruleId.trim().length === 0) {
            errors.push(`Result at index ${resIdx} must have a non-empty string 'ruleId'.`);
          }
          if (!['error', 'warning', 'note', 'none'].includes(String(res.level))) {
            errors.push(`Result at index ${resIdx} has invalid level '${String(res.level)}'.`);
          }
          const msg = res.message as Record<string, unknown> | undefined;
          if (typeof msg !== 'object' || typeof msg?.text !== 'string' || msg.text.length === 0) {
            errors.push(`Result at index ${resIdx} must have a non-empty 'message.text'.`);
          }
          if (!Array.isArray(res.locations) || res.locations.length === 0) {
            errors.push(`Result at index ${resIdx} must have at least one location.`);
          } else {
            res.locations.forEach((locItem: unknown, locIdx: number) => {
              const loc = locItem as Record<string, unknown> | undefined;
              const phys = loc?.physicalLocation as Record<string, unknown> | undefined;
              const art = phys?.artifactLocation as Record<string, unknown> | undefined;
              const uri = art?.uri;
              if (typeof uri !== 'string' || uri.includes('\\')) {
                errors.push(`Result[${resIdx}].locations[${locIdx}] URI must use forward slashes and be a valid string.`);
              }
              const reg = phys?.region as Record<string, unknown> | undefined;
              if (typeof reg?.startLine !== 'number' || reg.startLine < 1) {
                errors.push(`Result[${resIdx}].locations[${locIdx}] region.startLine must be >= 1.`);
              }
              if (typeof reg?.startColumn !== 'number' || reg.startColumn < 1) {
                errors.push(`Result[${resIdx}].locations[${locIdx}] region.startColumn must be >= 1.`);
              }
            });
          }
        });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
