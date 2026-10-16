/**
 * Rules that detect tests incapable of failing.
 *
 * They all start from the same principle: a test that can't fail is worse
 * than no test at all, because it occupies the place of one that would
 * actually verify something and earns confidence nobody has won.
 *
 * The analysis uses the TypeScript AST instead of regular expressions: an
 * `expect` inside a comment or a string isn't an assertion, and only the
 * syntax tree tells the difference.
 */

import ts from 'typescript';

import type { Finding, Severity } from './types';

const TEST_NAMES = new Set(['it', 'test']);
const SUITE_NAMES = new Set(['describe']);

export interface RuleContext {
  readonly file: string;
  readonly source: ts.SourceFile;
}

export type Rule = (context: RuleContext) => Finding[];

/** Converts an AST position into a 1-based line and column. */
function locate(source: ts.SourceFile, node: ts.Node): { line: number; column: number } {
  const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return { line: line + 1, column: character + 1 };
}

function finding(
  context: RuleContext,
  node: ts.Node,
  rule: string,
  severity: Severity,
  message: string,
  hint: string,
): Finding {
  return { rule, severity, file: context.file, ...locate(context.source, node), message, hint };
}

/** Invoked name, following chains like `it.each(...)` or `describe.skip`. */
function calleeName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return calleeName(expression.expression);
  if (ts.isCallExpression(expression)) return calleeName(expression.expression);
  if (ts.isTaggedTemplateExpression(expression)) return calleeName(expression.tag);
  return null;
}

/** Chained modifiers: `it.skip.each` returns ['skip', 'each']. */
function modifiers(expression: ts.Expression): string[] {
  if (ts.isPropertyAccessExpression(expression)) {
    return [...modifiers(expression.expression), expression.name.text];
  }
  if (ts.isCallExpression(expression)) return modifiers(expression.expression);
  return [];
}

function isTestCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const name = calleeName(node.expression);
  return name !== null && (TEST_NAMES.has(name) || name === 'xit' || name === 'xtest');
}

function isSuiteCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const name = calleeName(node.expression);
  return name !== null && (SUITE_NAMES.has(name) || name === 'xdescribe');
}

function titleOf(call: ts.CallExpression): string {
  const first = call.arguments[0];
  if (first && ts.isStringLiteralLike(first)) return first.text;
  return '(untitled)';
}

function bodyOf(call: ts.CallExpression): ts.Node | null {
  for (const argument of call.arguments) {
    if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) {
      return argument.body;
    }
  }
  return null;
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/**
 * Assertion forms recognized beyond `expect`.
 *
 * Cypress asserts with `.should()` and `.and()`; Chai also offers `assert.*`.
 * Without this, every Cypress test would be reported as "no assertion": a
 * false positive that would make the tool unusable on those projects.
 */
const ASSERTION_METHODS = new Set(['should', 'and']);

/** Does the node contain at least one assertion, in any of its forms? */
function containsAssertion(node: ts.Node): boolean {
  let found = false;

  walk(node, (current) => {
    if (found || !ts.isCallExpression(current)) return;

    const callee = current.expression;
    if (calleeName(callee) === 'expect') {
      found = true;
      return;
    }

    if (ts.isPropertyAccessExpression(callee)) {
      // .should(...) / .and(...) from Cypress
      if (ASSERTION_METHODS.has(callee.name.text)) {
        found = true;
        return;
      }
      // assert.equal(...) and the rest, from Chai
      if (ts.isIdentifier(callee.expression) && callee.expression.text === 'assert') {
        found = true;
      }
    }
  });

  return found;
}

// ---------------------------------------------------------------- rules

/** A test with no `expect` always passes: it verifies nothing. */
export const noAssertion: Rule = (context) => {
  const findings: Finding[] = [];

  walk(context.source, (node) => {
    if (!isTestCall(node)) return;
    const body = bodyOf(node);
    if (!body || containsAssertion(body)) return;

    findings.push(
      finding(
        context,
        node,
        'no-assertion',
        'P1',
        `Test "${titleOf(node)}" contains no assertion.`,
        'Add an expect, or delete the test: right now it passes even if the code is broken.',
      ),
    );
  });

  return findings;
};

/** `expect(x)` with no matcher chained checks nothing. */
export const expectWithoutMatcher: Rule = (context) => {
  const findings: Finding[] = [];

  walk(context.source, (node) => {
    if (!ts.isExpressionStatement(node)) return;
    const { expression } = node;
    if (!ts.isCallExpression(expression)) return;
    if (calleeName(expression.expression) !== 'expect') return;
    // A useful expect always shows up inside a property access
    // (expect(x).toBe), never as a bare statement.
    if (!ts.isIdentifier(expression.expression)) return;

    findings.push(
      finding(
        context,
        node,
        'expect-without-matcher',
        'P1',
        'expect() with no matcher chained.',
        'Chain a matcher, e.g. .toBe(...) or .toHaveLength(...).',
      ),
    );
  });

  return findings;
};

/** Comparing a literal against itself checks the language, not the code. */
export const tautology: Rule = (context) => {
  const findings: Finding[] = [];

  walk(context.source, (node) => {
    if (!ts.isCallExpression(node)) return;
    if (!ts.isPropertyAccessExpression(node.expression)) return;

    const matcher = node.expression.name.text;
    if (matcher !== 'toBe' && matcher !== 'toEqual' && matcher !== 'toStrictEqual') return;

    const receiver = node.expression.expression;
    if (!ts.isCallExpression(receiver)) return;
    if (calleeName(receiver.expression) !== 'expect') return;

    const actual = receiver.arguments[0];
    const expected = node.arguments[0];
    if (!actual || !expected) return;
    if (!isLiteral(actual) || !isLiteral(expected)) return;
    if (actual.getText(context.source) !== expected.getText(context.source)) return;

    findings.push(
      finding(
        context,
        node,
        'tautology',
        'P1',
        `expect(${actual.getText(context.source)}) compared against itself.`,
        'Compare the result of the code under test, not a literal against itself.',
      ),
    );
  });

  return findings;
};

function isLiteral(node: ts.Node): boolean {
  return (
    ts.isStringLiteralLike(node) ||
    ts.isNumericLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  );
}

function capitalize(str: string): string {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function singularize(str: string): string {
  if (str.endsWith('ies')) return str.slice(0, -3) + 'y';
  if (str.endsWith('ses')) return str.slice(0, -2);
  if (str.endsWith('s') && !str.endsWith('ss')) return str.slice(0, -1);
  return str;
}

interface ParsedIdenticalAssertion {
  readonly actual: ts.Expression;
  readonly expected: ts.Expression;
  readonly matcher: string;
  readonly asyncModifier?: string | undefined;
  readonly isChaiAssert?: boolean | undefined;
}

function parseIdenticalAssertion(node: ts.CallExpression): ParsedIdenticalAssertion | null {
  // Pattern 1: expect(actual).toBe(expected) or expect(actual).resolves.toBe(expected)
  if (ts.isPropertyAccessExpression(node.expression)) {
    const matcher = node.expression.name.text;
    if (matcher === 'toBe' || matcher === 'toEqual' || matcher === 'toStrictEqual') {
      let receiver: ts.Expression = node.expression.expression;
      let asyncModifier: string | undefined;

      if (
        ts.isPropertyAccessExpression(receiver) &&
        (receiver.name.text === 'resolves' || receiver.name.text === 'rejects')
      ) {
        asyncModifier = receiver.name.text;
        receiver = receiver.expression;
      }

      if (ts.isCallExpression(receiver) && calleeName(receiver.expression) === 'expect') {
        const actual = receiver.arguments[0];
        const expected = node.arguments[0];
        if (actual && expected) {
          return { actual, expected, matcher, asyncModifier, isChaiAssert: false };
        }
      }
    }
  }

  // Pattern 2: Chai assert.equal(actual, expected) / assert.strictEqual / assert.deepEqual
  if (
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'assert'
  ) {
    const matcher = node.expression.name.text;
    if (matcher === 'equal' || matcher === 'strictEqual' || matcher === 'deepEqual') {
      const actual = node.arguments[0];
      const expected = node.arguments[1];
      if (actual && expected) {
        return { actual, expected, matcher, isChaiAssert: true };
      }
    }
  }

  return null;
}

function getIdenticalExpressionHint(
  actualNode: ts.Expression,
  matcher: string,
  source: ts.SourceFile,
  asyncModifier?: string,
  isChaiAssert?: boolean,
): string {
  const actualText = actualNode.getText(source).replace(/\s+/g, ' ').trim();
  const formatFix = (replacement: string) => {
    if (isChaiAssert) {
      return `assert.${matcher}(${actualText}, ${replacement})`;
    }
    const prefix = asyncModifier
      ? `expect(${actualText}).${asyncModifier}`
      : `expect(${actualText})`;
    return `${prefix}.${matcher}(${replacement})`;
  };

  // 1. PropertyAccessExpression (e.g., user.id, data.status, response.data.items, actualUser.id)
  if (ts.isPropertyAccessExpression(actualNode)) {
    const propName = actualNode.name.text;
    const objExpr = actualNode.expression;
    const objText = objExpr.getText(source).replace(/\s+/g, ' ').trim();

    // If the object name starts or ends with 'actual' (e.g. actualUser.id or actual.id)
    if (objText.startsWith('actual') || objText.endsWith('Actual')) {
      let suggestedObj = objText;
      if (objText === 'actual') {
        suggestedObj = 'expected';
      } else if (objText.startsWith('actual')) {
        suggestedObj = 'expected' + objText.slice(6);
      } else if (objText.endsWith('Actual')) {
        suggestedObj = objText.slice(0, -6) + 'Expected';
      }
      const fix = formatFix(`${suggestedObj}.${propName}`);
      return `Likely copy-paste error. Replace '${actualText}' with '${suggestedObj}.${propName}' (e.g. ${fix}) instead of comparing '${actualText}' with itself.`;
    }

    // Standard property access: user.id -> suggest expectedId or expectedUser.id
    const capitalizedProp = capitalize(propName);
    const shortExpected = `expected${capitalizedProp}`;
    const baseObj = objText.split('.').pop() || '';
    const objExpected = baseObj ? `expected${capitalize(baseObj)}.${propName}` : '';

    const fix1 = formatFix(shortExpected);
    const fix2 = objExpected ? formatFix(objExpected) : '';
    const examples = fix2 ? `${fix1} or ${fix2}` : fix1;

    return `Likely copy-paste error. Replace '${actualText}' with the expected value (e.g. ${examples}) instead of comparing '${actualText}' with itself.`;
  }

  // 2. Identifier (e.g., data, user, actualData, actual, total)
  if (ts.isIdentifier(actualNode)) {
    const name = actualNode.text;
    let suggestedVar = '';

    if (name === 'actual') {
      suggestedVar = 'expected';
    } else if (name.startsWith('actual') && name.length > 6) {
      suggestedVar = 'expected' + name.slice(6);
    } else if (name.endsWith('Actual')) {
      suggestedVar = name.slice(0, -6) + 'Expected';
    } else {
      suggestedVar = `expected${capitalize(name)}`;
    }

    const fix = formatFix(suggestedVar);
    return `Likely copy-paste error. Replace '${actualText}' with the expected outcome (e.g. ${fix} or a fixture/literal) instead of comparing '${actualText}' with itself.`;
  }

  // 3. CallExpression (e.g., calculateTotal(), getUser(1), service.getData())
  if (ts.isCallExpression(actualNode)) {
    const callee = actualNode.expression;
    let baseName = 'Result';

    if (ts.isIdentifier(callee)) {
      baseName = callee.text;
    } else if (ts.isPropertyAccessExpression(callee)) {
      baseName = callee.name.text;
    }

    for (const prefix of ['get', 'calculate', 'compute', 'fetch', 'find', 'create', 'build', 'load']) {
      if (baseName.startsWith(prefix) && baseName.length > prefix.length) {
        baseName = baseName.slice(prefix.length);
        break;
      }
    }

    const suggestedVar = `expected${capitalize(baseName)}`;
    const fix = formatFix(suggestedVar);
    return `Likely copy-paste error. Replace '${actualText}' with the expected result (e.g. ${fix}) instead of invoking '${actualText}' on both sides.`;
  }

  // 4. ElementAccessExpression (e.g., items[0], list[i])
  if (ts.isElementAccessExpression(actualNode)) {
    const objText = actualNode.expression.getText(source).replace(/\s+/g, ' ').trim();
    const argText = actualNode.argumentExpression
      ? actualNode.argumentExpression.getText(source).replace(/\s+/g, ' ').trim()
      : '0';

    if (objText.startsWith('actual')) {
      const suggestedObj = objText === 'actual' ? 'expected' : 'expected' + objText.slice(6);
      const fix = formatFix(`${suggestedObj}[${argText}]`);
      return `Likely copy-paste error. Replace '${actualText}' with '${suggestedObj}[${argText}]' (e.g. ${fix}) instead of comparing '${actualText}' with itself.`;
    }

    const baseName = objText.split('.').pop() || 'items';
    const singularName = singularize(baseName);
    const fix1 = formatFix(`expected${capitalize(singularName)}`);
    const fix2 = formatFix(`expected${capitalize(baseName)}[${argText}]`);

    return `Likely copy-paste error. Replace '${actualText}' with the expected element (e.g. ${fix1} or ${fix2}) instead of comparing '${actualText}' with itself.`;
  }

  // 5. BinaryExpression (e.g., a + b)
  if (ts.isBinaryExpression(actualNode)) {
    const fix = formatFix('expectedResult');
    return `Likely copy-paste error. Replace '${actualText}' with the expected calculation result (e.g. ${fix}) instead of evaluating '${actualText}' on both sides.`;
  }

  // 6. Generic fallback
  const fix = formatFix('expectedValue');
  return `Likely copy-paste error. Replace '${actualText}' with the expected outcome (e.g. ${fix}) instead of comparing '${actualText}' with itself.`;
}

/**
 * Asserting that an expression equals itself checks nothing and conceals copy-paste typos.
 * E.g., `expect(user.id).toBe(user.id)` or `expect(data.status).toEqual(data.status)`.
 */
export const identicalExpression: Rule = (context) => {
  const findings: Finding[] = [];

  walk(context.source, (node) => {
    if (!ts.isCallExpression(node)) return;

    const parsed = parseIdenticalAssertion(node);
    if (!parsed) return;

    const { actual, expected, matcher, asyncModifier, isChaiAssert } = parsed;

    let actualCleanNode = actual;
    while (ts.isParenthesizedExpression(actualCleanNode)) {
      actualCleanNode = actualCleanNode.expression;
    }

    let expectedCleanNode = expected;
    while (ts.isParenthesizedExpression(expectedCleanNode)) {
      expectedCleanNode = expectedCleanNode.expression;
    }

    // Literals are handled by the 'tautology' rule
    if (isLiteral(actualCleanNode) && isLiteral(expectedCleanNode)) return;

    const actualCleanText = actualCleanNode.getText(context.source).replace(/\s+/g, ' ').trim();
    const expectedCleanText = expectedCleanNode.getText(context.source).replace(/\s+/g, ' ').trim();
    if (actualCleanText !== expectedCleanText) return;

    const fullAssertion = isChaiAssert
      ? `assert.${matcher}(${actualCleanText}, ${expectedCleanText})`
      : asyncModifier
      ? `expect(${actualCleanText}).${asyncModifier}.${matcher}(${expectedCleanText})`
      : `expect(${actualCleanText}).${matcher}(${expectedCleanText})`;

    const message = `${fullAssertion} compares an expression against itself: likely a copy-paste error.`;
    const hint = getIdenticalExpressionHint(
      actualCleanNode,
      matcher,
      context.source,
      asyncModifier,
      isChaiAssert,
    );

    findings.push(
      finding(
        context,
        node,
        'identical-expression',
        'P1',
        message,
        hint,
      ),
    );
  });

  return findings;
};

/** A skipped test protects nothing, and gets forgotten. */
export const skippedTest: Rule = (context) => {
  const findings: Finding[] = [];

  walk(context.source, (node) => {
    if (!ts.isCallExpression(node)) return;
    if (!isTestCall(node) && !isSuiteCall(node)) return;

    const name = calleeName(node.expression);
    const chain = modifiers(node.expression);
    const omitted = chain.includes('skip') || chain.includes('todo') || name === 'xit' || name === 'xtest' || name === 'xdescribe';
    if (!omitted) return;

    findings.push(
      finding(
        context,
        node,
        'skipped-test',
        'P3',
        `"${titleOf(node)}" is skipped.`,
        'Re-enable it or delete it. A disabled test gives the illusion of coverage.',
      ),
    );
  });

  return findings;
};

/** `it.only` leaves the rest of the suite out without anyone noticing in CI. */
export const focusedTest: Rule = (context) => {
  const findings: Finding[] = [];

  walk(context.source, (node) => {
    if (!ts.isCallExpression(node)) return;
    if (!isTestCall(node) && !isSuiteCall(node)) return;
    if (!modifiers(node.expression).includes('only')) return;

    findings.push(
      finding(
        context,
        node,
        'focused-test',
        'P1',
        `"${titleOf(node)}" uses .only: the rest of the suite doesn't run.`,
        'Remove .only before merging. In CI this silences the rest of the tests.',
      ),
    );
  });

  return findings;
};



/**
 * An async assertion with no `await` never gets checked.
 *
 * `expect(promise).rejects.toThrow()` returns a promise. Without `await` or
 * `return`, the test ends before it settles and the failure is lost — or
 * worse, it surfaces in a different test, blamed on the wrong case.
 *
 * It's the most common defect in async suites and the hardest to spot by
 * reading: the line looks complete. Jest sometimes warns and sometimes
 * doesn't, depending on the version and on whether another test absorbs
 * the rejection.
 */
export const missingAwait: Rule = (context) => {
  const findings: Finding[] = [];
  const playwright = usesPlaywright(context.source);

  walk(context.source, (node) => {
    if (!ts.isExpressionStatement(node)) return;

    const asyncExpect = findAsyncExpect(node.expression, playwright);
    if (asyncExpect === null) return;

    findings.push(
      finding(
        context,
        node,
        'missing-await',
        'P1',
        `expect(...).${asyncExpect} with no await: the test ends before checking anything.`,
        'Add await, or return the expression.',
      ),
    );
  });

  return findings;
};

const ASYNC_MODIFIERS = new Set(['resolves', 'rejects']);

/**
 * Playwright matchers that wait for the element and return a promise.
 *
 * In Playwright EVERY assertion on a locator is asynchronous: it retries
 * until it passes or times out. Without `await`, the assertion gets
 * discarded and the test passes without having checked anything — the same
 * defect as with `.rejects`, but far more frequent because the line looks
 * complete.
 */
const PLAYWRIGHT_MATCHERS = new Set([
  'toBeVisible',
  'toBeHidden',
  'toBeEnabled',
  'toBeDisabled',
  'toBeChecked',
  'toBeEditable',
  'toBeEmpty',
  'toBeFocused',
  'toBeAttached',
  'toBeInViewport',
  'toContainText',
  'toHaveText',
  'toHaveValue',
  'toHaveValues',
  'toHaveAttribute',
  'toHaveClass',
  'toHaveCount',
  'toHaveCSS',
  'toHaveId',
  'toHaveJSProperty',
  'toHaveScreenshot',
  'toHaveTitle',
  'toHaveURL',
  'toBeOK',
]);

/** Does the file import Playwright? Only then are its matchers asynchronous. */
function usesPlaywright(source: ts.SourceFile): boolean {
  return source.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteralLike(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text.includes('@playwright/'),
  );
}

/**
 * Returns the async modifier (`resolves` / `rejects`) of an expression that
 * starts at `expect(...)`, or null if it isn't that shape.
 *
 * Only the bare expression is inspected: if the node were `await ...` or
 * `return ...`, it wouldn't be an ExpressionStatement with this shape.
 */
function findAsyncExpect(expression: ts.Expression, playwright: boolean): string | null {
  let current: ts.Node = expression;
  let modifier: string | null = null;

  // Walked from the chain back to its root: expect(x).rejects.toThrow()
  while (ts.isCallExpression(current) || ts.isPropertyAccessExpression(current)) {
    if (ts.isPropertyAccessExpression(current)) {
      const name = current.name.text;
      if (ASYNC_MODIFIERS.has(name)) modifier = name;
      else if (playwright && modifier === null && PLAYWRIGHT_MATCHERS.has(name)) {
        modifier = name;
      }
      current = current.expression;
    } else {
      current = current.expression;
    }
  }

  if (modifier === null) return null;
  return ts.isIdentifier(current) && current.text === 'expect' ? modifier : null;
}

/**
 * An assertion inside a `catch` block never runs if the code doesn't throw.
 *
 * If `riskyOperation()` succeeds or fails silently, the `catch` block is
 * skipped entirely, and the test completes green without verifying anything.
 *
 * Safe alternatives:
 * - `await expect(promise).rejects.toThrow()`
 * - Put `expect.unreachable()`, `fail()`, or `throw` inside the `try` block
 * - Declare `expect.assertions(...)` / `expect.hasAssertions()`
 */
export const assertionInCatch: Rule = (context) => {
  const findings: Finding[] = [];

  walk(context.source, (node) => {
    if (!isTestCall(node)) return;
    const body = bodyOf(node);
    if (!body) return;

    if (hasAssertionPlan(body)) return;

    walk(body, (inner) => {
      if (!ts.isTryStatement(inner)) return;
      if (!inner.catchClause) return;

      if (!containsAssertion(inner.catchClause.block)) return;
      if (hasFailureGuard(inner.tryBlock)) return;

      findings.push(
        finding(
          context,
          inner.catchClause,
          'assertion-in-catch',
          'P1',
          'Assertion inside a catch block without guaranteed failure in try block.',
          'If the code under test does not throw, the catch block is skipped and the test passes silently. Use await expect(promise).rejects.toThrow() instead, or add expect.unreachable() in the try block.',
        ),
      );
    });
  });

  return findings;
};

function hasAssertionPlan(testBody: ts.Node): boolean {
  let found = false;
  walk(testBody, (node) => {
    if (found || !ts.isCallExpression(node)) return;
    if (ts.isPropertyAccessExpression(node.expression)) {
      const prop = node.expression.name.text;
      const target = node.expression.expression;
      if (ts.isIdentifier(target) && target.text === 'expect') {
        if (prop === 'assertions' || prop === 'hasAssertions') {
          found = true;
        }
      }
    }
  });
  return found;
}

function hasFailureGuard(tryBlock: ts.Block): boolean {
  let found = false;
  walk(tryBlock, (node) => {
    if (found) return;

    if (ts.isThrowStatement(node)) {
      found = true;
      return;
    }

    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (ts.isIdentifier(expr) && expr.text === 'fail') {
        found = true;
        return;
      }
      if (ts.isPropertyAccessExpression(expr)) {
        const prop = expr.name.text;
        const target = expr.expression;
        if (ts.isIdentifier(target)) {
          if (target.text === 'expect' && (prop === 'unreachable' || prop === 'fail')) {
            found = true;
            return;
          }
          if (target.text === 'assert' && prop === 'fail') {
            found = true;
            return;
          }
        }
      }
    }
  });
  return found;
}

const PLAYWRIGHT_BOOLEAN_METHODS: Record<string, string> = {
  isVisible: 'toBeVisible',
  isHidden: 'toBeHidden',
  isEnabled: 'toBeEnabled',
  isDisabled: 'toBeDisabled',
  isChecked: 'toBeChecked',
  isEditable: 'toBeEditable',
};

interface ParsedBooleanAssertion {
  readonly expectCall: ts.CallExpression;
  readonly actual: ts.Expression;
  readonly matcher: string;
  readonly hasNot: boolean;
  readonly isPositive: boolean;
}

function parseBooleanAssertion(node: ts.CallExpression): ParsedBooleanAssertion | null {
  if (!ts.isPropertyAccessExpression(node.expression)) return null;

  const matcher = node.expression.name.text;
  let hasNot = false;
  let target: ts.Expression = node.expression.expression;

  if (ts.isPropertyAccessExpression(target) && target.name.text === 'not') {
    hasNot = true;
    target = target.expression;
  }

  if (!ts.isCallExpression(target)) return null;
  if (calleeName(target.expression) !== 'expect') return null;

  const expectCall = target;
  let actual = expectCall.arguments[0];
  if (!actual) return null;

  while (ts.isParenthesizedExpression(actual)) {
    actual = actual.expression;
  }

  let isPositive: boolean;
  if (matcher === 'toBe' || matcher === 'toEqual' || matcher === 'toStrictEqual') {
    if (node.arguments.length === 0) return null;
    const arg = node.arguments[0];
    if (!arg) return null;
    if (arg.kind === ts.SyntaxKind.TrueKeyword) {
      isPositive = true;
    } else if (arg.kind === ts.SyntaxKind.FalseKeyword) {
      isPositive = false;
    } else {
      return null;
    }
  } else if (matcher === 'toBeTruthy') {
    isPositive = true;
  } else if (matcher === 'toBeFalsy') {
    isPositive = false;
  } else {
    return null;
  }

  return { expectCall, actual, matcher, hasNot, isPositive };
}

interface AssertionSuggestion {
  readonly suggestedFix?: string;
  readonly customHint?: string;
}

function getBooleanAssertionSuggestion(
  expr: ts.Expression,
  targetBool: boolean,
  source: ts.SourceFile,
): AssertionSuggestion | null {
  let actual = expr;
  while (ts.isParenthesizedExpression(actual)) {
    actual = actual.expression;
  }

  if (ts.isBinaryExpression(actual)) {
    const op = actual.operatorToken.kind;
    let left = actual.left;
    let right = actual.right;

    while (ts.isParenthesizedExpression(left)) left = left.expression;
    while (ts.isParenthesizedExpression(right)) right = right.expression;

    const leftText = left.getText(source).trim();
    const rightText = right.getText(source).trim();

    if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken) {
      if (right.kind === ts.SyntaxKind.TrueKeyword) {
        return targetBool
          ? { suggestedFix: `expect(${leftText}).toBe(true)` }
          : { suggestedFix: `expect(${leftText}).not.toBe(true)` };
      }
      if (right.kind === ts.SyntaxKind.FalseKeyword) {
        return targetBool
          ? { suggestedFix: `expect(${leftText}).toBe(false)` }
          : { suggestedFix: `expect(${leftText}).not.toBe(false)` };
      }
      if (left.kind === ts.SyntaxKind.TrueKeyword) {
        return targetBool
          ? { suggestedFix: `expect(${rightText}).toBe(true)` }
          : { suggestedFix: `expect(${rightText}).not.toBe(true)` };
      }
      if (left.kind === ts.SyntaxKind.FalseKeyword) {
        return targetBool
          ? { suggestedFix: `expect(${rightText}).toBe(false)` }
          : { suggestedFix: `expect(${rightText}).not.toBe(false)` };
      }

      if (op === ts.SyntaxKind.EqualsEqualsEqualsToken) {
        return targetBool
          ? { suggestedFix: `expect(${leftText}).toBe(${rightText})` }
          : { suggestedFix: `expect(${leftText}).not.toBe(${rightText})` };
      } else {
        return targetBool
          ? { suggestedFix: `expect(${leftText}).toEqual(${rightText})` }
          : { suggestedFix: `expect(${leftText}).not.toEqual(${rightText})` };
      }
    }

    if (op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken) {
      if (right.kind === ts.SyntaxKind.TrueKeyword) {
        return targetBool
          ? { suggestedFix: `expect(${leftText}).not.toBe(true)` }
          : { suggestedFix: `expect(${leftText}).toBe(true)` };
      }
      if (right.kind === ts.SyntaxKind.FalseKeyword) {
        return targetBool
          ? { suggestedFix: `expect(${leftText}).not.toBe(false)` }
          : { suggestedFix: `expect(${leftText}).toBe(false)` };
      }

      if (op === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
        return targetBool
          ? { suggestedFix: `expect(${leftText}).not.toBe(${rightText})` }
          : { suggestedFix: `expect(${leftText}).toBe(${rightText})` };
      } else {
        return targetBool
          ? { suggestedFix: `expect(${leftText}).not.toEqual(${rightText})` }
          : { suggestedFix: `expect(${leftText}).toEqual(${rightText})` };
      }
    }

    if (op === ts.SyntaxKind.GreaterThanToken) {
      return targetBool
        ? { suggestedFix: `expect(${leftText}).toBeGreaterThan(${rightText})` }
        : { suggestedFix: `expect(${leftText}).toBeLessThanOrEqual(${rightText})` };
    }

    if (op === ts.SyntaxKind.GreaterThanEqualsToken) {
      return targetBool
        ? { suggestedFix: `expect(${leftText}).toBeGreaterThanOrEqual(${rightText})` }
        : { suggestedFix: `expect(${leftText}).toBeLessThan(${rightText})` };
    }

    if (op === ts.SyntaxKind.LessThanToken) {
      return targetBool
        ? { suggestedFix: `expect(${leftText}).toBeLessThan(${rightText})` }
        : { suggestedFix: `expect(${leftText}).toBeGreaterThanOrEqual(${rightText})` };
    }

    if (op === ts.SyntaxKind.LessThanEqualsToken) {
      return targetBool
        ? { suggestedFix: `expect(${leftText}).toBeLessThanOrEqual(${rightText})` }
        : { suggestedFix: `expect(${leftText}).toBeGreaterThan(${rightText})` };
    }

    if (op === ts.SyntaxKind.InstanceOfKeyword) {
      return targetBool
        ? { suggestedFix: `expect(${leftText}).toBeInstanceOf(${rightText})` }
        : { suggestedFix: `expect(${leftText}).not.toBeInstanceOf(${rightText})` };
    }

    if (op === ts.SyntaxKind.InKeyword) {
      return targetBool
        ? { suggestedFix: `expect(${rightText}).toHaveProperty(${leftText})` }
        : { suggestedFix: `expect(${rightText}).not.toHaveProperty(${leftText})` };
    }

    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      return {
        customHint: `Split into separate assertions: expect(${leftText}).toBeTruthy() and expect(${rightText}).toBeTruthy() for clearer diagnostics.`,
      };
    }

    if (op === ts.SyntaxKind.BarBarToken) {
      return {
        customHint: `Avoid logical OR in assertions; assert on specific expected outcomes instead.`,
      };
    }

    return null;
  }

  if (ts.isCallExpression(actual)) {
    if (
      ts.isPropertyAccessExpression(actual.expression) &&
      actual.expression.name.text === 'includes' &&
      actual.arguments.length >= 1
    ) {
      const objText = actual.expression.expression.getText(source).trim();
      const argText = actual.arguments[0]!.getText(source).trim();
      return targetBool
        ? { suggestedFix: `expect(${objText}).toContain(${argText})` }
        : { suggestedFix: `expect(${objText}).not.toContain(${argText})` };
    }

    if (
      ts.isIdentifier(actual.expression) &&
      actual.expression.text === 'Boolean' &&
      actual.arguments.length === 1
    ) {
      const argText = actual.arguments[0]!.getText(source).trim();
      return targetBool
        ? { suggestedFix: `expect(${argText}).toBeTruthy()` }
        : { suggestedFix: `expect(${argText}).toBeFalsy()` };
    }

    if (ts.isPropertyAccessExpression(actual.expression)) {
      const methodName = actual.expression.name.text;
      const pwMatcher = PLAYWRIGHT_BOOLEAN_METHODS[methodName];
      if (pwMatcher) {
        const locText = actual.expression.expression.getText(source).trim();
        return targetBool
          ? { suggestedFix: `await expect(${locText}).${pwMatcher}()` }
          : { suggestedFix: `await expect(${locText}).not.${pwMatcher}()` };
      }
    }
  }

  if (ts.isAwaitExpression(actual) && ts.isCallExpression(actual.expression)) {
    const call = actual.expression;
    if (ts.isPropertyAccessExpression(call.expression)) {
      const methodName = call.expression.name.text;
      const pwMatcher = PLAYWRIGHT_BOOLEAN_METHODS[methodName];
      if (pwMatcher) {
        const locText = call.expression.expression.getText(source).trim();
        return targetBool
          ? { suggestedFix: `await expect(${locText}).${pwMatcher}()` }
          : { suggestedFix: `await expect(${locText}).not.${pwMatcher}()` };
      }
    }
  }

  if (
    ts.isPrefixUnaryExpression(actual) &&
    actual.operator === ts.SyntaxKind.ExclamationToken
  ) {
    let inner: ts.Expression = actual.operand;
    while (ts.isParenthesizedExpression(inner)) inner = inner.expression;

    const innerSuggestion = getBooleanAssertionSuggestion(inner, !targetBool, source);
    if (innerSuggestion) return innerSuggestion;

    const innerText = inner.getText(source).trim();
    return targetBool
      ? { suggestedFix: `expect(${innerText}).toBe(false)` }
      : { suggestedFix: `expect(${innerText}).toBe(true)` };
  }

  return null;
}

/**
 * Asserting boolean conditions with `.toBe(true)`, `.toBeTruthy()`, etc.,
 * conceals the actual values and prevents useful failure diffs.
 * E.g., `expect(a === b).toBe(true)` instead of `expect(a).toBe(b)`.
 */
export const redundantBooleanAssertion: Rule = (context) => {
  const findings: Finding[] = [];

  walk(context.source, (node) => {
    if (!ts.isCallExpression(node)) return;

    const parsed = parseBooleanAssertion(node);
    if (!parsed) return;

    const { actual, hasNot, isPositive } = parsed;
    const targetBool = hasNot ? !isPositive : isPositive;

    const suggestion = getBooleanAssertionSuggestion(actual, targetBool, context.source);
    if (!suggestion) return;

    const nodeText = node.getText(context.source).replace(/\s+/g, ' ').trim();
    const hint =
      suggestion.customHint ??
      `Use ${suggestion.suggestedFix} instead for clearer failure diffs and semantic assertions.`;

    findings.push(
      finding(
        context,
        node,
        'redundant-boolean-assertion',
        'P2',
        `Redundant boolean assertion: ${nodeText}.`,
        hint,
      ),
    );
  });

  return findings;
};

export const rules: readonly Rule[] = [
  noAssertion,
  expectWithoutMatcher,
  tautology,
  identicalExpression,
  skippedTest,
  focusedTest,
  missingAwait,
  assertionInCatch,
  redundantBooleanAssertion,
];
