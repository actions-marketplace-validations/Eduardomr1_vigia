import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, runCli } from './cli';
import { renderSarif, validateSarifCompliance, type SarifLog } from './sarif';
import type { AnalysisResult } from './types';

describe('renderSarif - OASIS SARIF v2.1.0 compliance', () => {
  it('generates valid SARIF with empty results when there are no findings', () => {
    const emptyResult: AnalysisResult = {
      filesAnalyzed: 5,
      findings: [],
    };

    const output = renderSarif(emptyResult);
    const parsed = JSON.parse(output) as SarifLog;

    expect(parsed.version).toBe('2.1.0');
    expect(parsed.$schema).toContain('sarif-schema-2.1.0.json');
    expect(parsed.runs).toHaveLength(1);
    expect(parsed.runs[0]?.tool.driver.name).toBe('vigia');
    expect(parsed.runs[0]?.results).toEqual([]);
    expect(parsed.runs[0]?.tool.driver.rules).toEqual([]);

    const compliance = validateSarifCompliance(parsed);
    expect(compliance.valid).toBe(true);
    expect(compliance.errors).toHaveLength(0);
  });

  it('maps findings and severities to SARIF results and rules', () => {
    const sampleResult: AnalysisResult = {
      filesAnalyzed: 2,
      findings: [
        {
          rule: 'identical-expression',
          severity: 'P1',
          file: 'tests\\auth.test.ts',
          line: 42,
          column: 5,
          message: 'expect(user.id).toBe(user.id) compares an expression against itself.',
          hint: 'Compare the result against the expected outcome.',
        },
        {
          rule: 'skipped-test',
          severity: 'P3',
          file: 'tests/billing.test.ts',
          line: 12,
          column: 1,
          message: 'Test marked as skipped.',
          hint: 'Remove skip or address the underlying failure.',
        },
      ],
    };

    const output = renderSarif(sampleResult, '1.3.0');
    const parsed = JSON.parse(output) as SarifLog;

    expect(parsed.runs[0]?.tool.driver.version).toBe('1.3.0');
    expect(parsed.runs[0]?.results).toHaveLength(2);

    // Rule 1: identical-expression -> level: error (P1)
    const res1 = parsed.runs[0]?.results[0];
    expect(res1?.ruleId).toBe('identical-expression');
    expect(res1?.ruleIndex).toBe(0);
    expect(res1?.level).toBe('error');
    expect(res1?.locations[0]?.physicalLocation.artifactLocation.uri).toBe('tests/auth.test.ts');
    expect(res1?.locations[0]?.physicalLocation.region.startLine).toBe(42);
    expect(res1?.locations[0]?.physicalLocation.region.startColumn).toBe(5);

    // Rule 2: skipped-test -> level: note (P3)
    const res2 = parsed.runs[0]?.results[1];
    expect(res2?.ruleId).toBe('skipped-test');
    expect(res2?.ruleIndex).toBe(1);
    expect(res2?.level).toBe('note');
    expect(res2?.locations[0]?.physicalLocation.artifactLocation.uri).toBe('tests/billing.test.ts');

    // Rules metadata
    const rules = parsed.runs[0]?.tool.driver.rules;
    expect(rules).toHaveLength(2);
    expect(rules?.find((r) => r.id === 'identical-expression')?.defaultConfiguration.level).toBe('error');
    expect(rules?.find((r) => r.id === 'skipped-test')?.defaultConfiguration.level).toBe('note');

    const compliance = validateSarifCompliance(parsed);
    expect(compliance.valid).toBe(true);
    expect(compliance.errors).toHaveLength(0);
  });

  it('normalizes windows backward slashes in file paths', () => {
    const result: AnalysisResult = {
      filesAnalyzed: 1,
      findings: [
        {
          rule: 'no-assertion',
          severity: 'P1',
          file: 'src\\features\\users\\user.test.ts',
          line: 10,
          column: 3,
          message: 'Test has no expect.',
          hint: 'Add an assertion.',
        },
      ],
    };

    const parsed = JSON.parse(renderSarif(result)) as SarifLog;
    expect(parsed.runs[0]?.results[0]?.locations[0]?.physicalLocation.artifactLocation.uri).toBe(
      'src/features/users/user.test.ts',
    );
    const compliance = validateSarifCompliance(parsed);
    expect(compliance.valid).toBe(true);
  });

  it('generates fully compliant SARIF covering all 10 Vigía rules and severity levels', () => {
    const allRulesResult: AnalysisResult = {
      filesAnalyzed: 10,
      findings: [
        {
          rule: 'no-assertion',
          severity: 'P1',
          file: 'tests/a.test.ts',
          line: 1,
          column: 1,
          message: 'Empty test',
          hint: 'Add assert',
        },
        {
          rule: 'expect-without-matcher',
          severity: 'P1',
          file: 'tests/b.test.ts',
          line: 2,
          column: 1,
          message: 'Dangling expect',
          hint: 'Add matcher',
        },
        {
          rule: 'tautology',
          severity: 'P1',
          file: 'tests/c.test.ts',
          line: 3,
          column: 1,
          message: 'Tautology',
          hint: 'Check value',
        },
        {
          rule: 'identical-expression',
          severity: 'P1',
          file: 'tests/d.test.ts',
          line: 4,
          column: 1,
          message: 'Self compare',
          hint: 'Check target',
        },
        {
          rule: 'skipped-test',
          severity: 'P3',
          file: 'tests/e.test.ts',
          line: 5,
          column: 1,
          message: 'Skipped',
          hint: 'Remove skip',
        },
        {
          rule: 'focused-test',
          severity: 'P1',
          file: 'tests/f.test.ts',
          line: 6,
          column: 1,
          message: 'Focused',
          hint: 'Remove only',
        },
        {
          rule: 'missing-await',
          severity: 'P1',
          file: 'tests/g.test.ts',
          line: 7,
          column: 1,
          message: 'Missing await',
          hint: 'Add await',
        },
        {
          rule: 'assertion-in-catch',
          severity: 'P2',
          file: 'tests/h.test.ts',
          line: 8,
          column: 1,
          message: 'In catch',
          hint: 'Use rejects',
        },
        {
          rule: 'orphan-negative-assertion',
          severity: 'P2',
          file: 'tests/i.test.ts',
          line: 9,
          column: 1,
          message: 'Negative only',
          hint: 'Add positive baseline',
        },
        {
          rule: 'redundant-boolean-assertion',
          severity: 'P2',
          file: 'tests/j.test.ts',
          line: 10,
          column: 1,
          message: 'Redundant bool',
          hint: 'Use direct matcher',
        },
      ],
    };

    const output = renderSarif(allRulesResult, '1.6.0');
    const parsed = JSON.parse(output) as SarifLog;

    expect(parsed.runs[0]?.tool.driver.rules).toHaveLength(10);
    expect(parsed.runs[0]?.results).toHaveLength(10);

    const compliance = validateSarifCompliance(parsed);
    expect(compliance.valid).toBe(true);
    expect(compliance.errors).toEqual([]);

    for (const rule of parsed.runs[0]?.tool.driver.rules ?? []) {
      expect(rule.id).toBeTruthy();
      expect(rule.name).toBeTruthy();
      expect(rule.shortDescription.text).toBeTruthy();
      expect(rule.fullDescription?.text).toBeTruthy();
      expect(rule.help?.markdown).toContain('https://github.com/Eduardomr1/vigia#rules');
      expect(['error', 'warning', 'note']).toContain(rule.defaultConfiguration.level);
    }
  });

  it('guarantees positive 1-based startLine and startColumn', () => {
    const result: AnalysisResult = {
      filesAnalyzed: 1,
      findings: [
        {
          rule: 'tautology',
          severity: 'P1',
          file: 'test.ts',
          line: 0,
          column: 0,
          message: 'Zero indexed line test',
          hint: 'Fix',
        },
      ],
    };

    const parsed = JSON.parse(renderSarif(result)) as SarifLog;
    const region = parsed.runs[0]?.results[0]?.locations[0]?.physicalLocation.region;
    expect(region?.startLine).toBe(1);
    expect(region?.startColumn).toBe(1);
    expect(validateSarifCompliance(parsed).valid).toBe(true);
  });
});

describe('validateSarifCompliance', () => {
  it('detects missing or invalid SARIF root properties', () => {
    expect(validateSarifCompliance(null).valid).toBe(false);
    expect(validateSarifCompliance({ version: '2.0.0' }).valid).toBe(false);
    expect(validateSarifCompliance({ version: '2.1.0', $schema: 'invalid' }).valid).toBe(false);
  });

  it('detects malformed runs, tools, drivers and results', () => {
    const invalidLog = {
      $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
      version: '2.1.0',
      runs: [
        {
          tool: {
            driver: {
              name: '',
              version: '',
              informationUri: 'not-a-url',
              rules: [
                {
                  id: '',
                  name: '',
                  shortDescription: { text: '' },
                  defaultConfiguration: { level: 'critical' },
                },
              ],
            },
          },
          results: [
            {
              ruleId: '',
              level: 'fatal',
              message: { text: '' },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: 'path\\with\\backslashes' },
                    region: { startLine: 0, startColumn: -1 },
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    const report = validateSarifCompliance(invalidLog);
    expect(report.valid).toBe(false);
    expect(report.errors.length).toBeGreaterThan(5);
  });
});

describe('CLI --format sarif and output options (-o, --output)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigia-sarif-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors on windows locks
    }
  });

  describe('parseArgs', () => {
    it('parses --format sarif and case-insensitive --format=SARIF', () => {
      const args1 = parseArgs(['--format', 'sarif']);
      expect(args1.format).toBe('sarif');

      const args2 = parseArgs(['--format=SARIF']);
      expect(args2.format).toBe('SARIF');
    });

    it('parses -o and --output with space and equals syntax', () => {
      const args1 = parseArgs(['-o', 'out.sarif']);
      expect(args1.output).toBe('out.sarif');

      const args2 = parseArgs(['--output', 'results.sarif']);
      expect(args2.output).toBe('results.sarif');

      const args3 = parseArgs(['-o=out.sarif']);
      expect(args3.output).toBe('out.sarif');

      const args4 = parseArgs(['--output=results.sarif']);
      expect(args4.output).toBe('results.sarif');
    });

    it('handles mixed flags and does not absorb consecutive flags', () => {
      const args = parseArgs(['--format', 'sarif', '-o', 'out.sarif', '--src', './src']);
      expect(args.format).toBe('sarif');
      expect(args.output).toBe('out.sarif');
      expect(args.sourceRoot).toBe('./src');

      const flagsWithoutValues = parseArgs(['-o', '--format', 'sarif']);
      expect(flagsWithoutValues.output).toBeUndefined();
      expect(flagsWithoutValues.format).toBe('sarif');
    });
  });

  describe('runCli with --format sarif', () => {
    it('outputs compliant SARIF string when format is sarif', () => {
      const fixtureFile = path.join(tmpDir, 'sample.test.ts');
      fs.writeFileSync(
        fixtureFile,
        `describe('suite', () => { it('empty', () => {}); });`,
        'utf8',
      );

      const result = runCli(['--files', fixtureFile, '--format', 'sarif'], { writeStdout: false });
      expect(result.exitCode).toBe(1); // no-assertion is P1 -> exit 1

      const parsed = JSON.parse(result.outputText) as SarifLog;
      const compliance = validateSarifCompliance(parsed);
      expect(compliance.valid).toBe(true);
      expect(parsed.runs[0]?.results).toHaveLength(1);
      expect(parsed.runs[0]?.results[0]?.ruleId).toBe('no-assertion');
    });

    it('redirects SARIF output to file using -o and creates parent directories', () => {
      const fixtureFile = path.join(tmpDir, 'valid.test.ts');
      fs.writeFileSync(
        fixtureFile,
        `describe('suite', () => { it('works', () => { expect(1).toBe(1); }); });`,
        'utf8',
      );

      const nestedOutputFile = path.join(tmpDir, 'nested', 'reports', 'scan.sarif');
      const result = runCli(
        ['--files', fixtureFile, '--format', 'sarif', '-o', nestedOutputFile],
        { writeStdout: false },
      );

      // tautology expect(1).toBe(1) is P1 -> exit 1
      expect(result.exitCode).toBe(1);
      expect(fs.existsSync(nestedOutputFile)).toBe(true);

      const content = fs.readFileSync(nestedOutputFile, 'utf8');
      const parsed = JSON.parse(content) as SarifLog;
      const compliance = validateSarifCompliance(parsed);
      expect(compliance.valid).toBe(true);
      expect(compliance.errors).toHaveLength(0);
      expect(parsed.runs[0]?.results[0]?.ruleId).toBe('tautology');
    });

    it('redirects SARIF output using --output=path syntax', () => {
      const fixtureFile = path.join(tmpDir, 'clean.test.ts');
      fs.writeFileSync(
        fixtureFile,
        `describe('clean', () => { it('valid', () => { expect(getUser()).toBe('admin'); }); });`,
        'utf8',
      );

      const outputFile = path.join(tmpDir, 'output.sarif');
      const result = runCli(
        ['--files', fixtureFile, '--format=sarif', `--output=${outputFile}`],
        { writeStdout: false },
      );

      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(outputFile)).toBe(true);

      const parsed = JSON.parse(fs.readFileSync(outputFile, 'utf8')) as SarifLog;
      expect(validateSarifCompliance(parsed).valid).toBe(true);
      expect(parsed.runs[0]?.results).toHaveLength(0);
    });
  });
});

