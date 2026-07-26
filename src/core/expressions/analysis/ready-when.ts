import { escapeRegExp } from '../../../utils/helpers.js';

const READY_WHEN_CALLBACK_METHODS = new Set(['exists', 'all', 'filter', 'map', 'some', 'every']);

function findMatchingParen(source: string, openIndex: number): number {
  let depth = 0;
  let quote: '"' | "'" | '`' | undefined;
  let escaped = false;
  for (let i = openIndex; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') depth++;
    else if (char === ')' && --depth === 0) return i;
  }
  return -1;
}

function normalizeArrowBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed.startsWith('{')) return trimmed;
  return trimmed
    .replace(/^\{\s*(?:return\s+)?/, '')
    .replace(/;?\s*\}\s*$/, '')
    .trim();
}

function convertReadyWhenCallbackMethods(expression: string): string {
  let result = '';
  let index = 0;
  while (index < expression.length) {
    const dotIndex = expression.indexOf('.', index);
    if (dotIndex === -1) {
      result += expression.slice(index);
      break;
    }
    result += expression.slice(index, dotIndex);
    let cursor = dotIndex + 1;
    while (/\s/.test(expression[cursor] ?? '')) cursor++;
    const methodMatch = /^[a-zA-Z_$][a-zA-Z0-9_$]*/.exec(expression.slice(cursor));
    if (!methodMatch || !READY_WHEN_CALLBACK_METHODS.has(methodMatch[0])) {
      result += expression[dotIndex];
      index = dotIndex + 1;
      continue;
    }
    const method = methodMatch[0];
    cursor += method.length;
    while (/\s/.test(expression[cursor] ?? '')) cursor++;
    if (expression[cursor] !== '(') {
      result += expression[dotIndex];
      index = dotIndex + 1;
      continue;
    }
    const closeIndex = findMatchingParen(expression, cursor);
    if (closeIndex === -1) {
      result += expression[dotIndex];
      index = dotIndex + 1;
      continue;
    }
    const callbackSource = expression.slice(cursor + 1, closeIndex).trim();
    const arrowIndex = callbackSource.indexOf('=>');
    if (arrowIndex === -1) {
      result += expression.slice(dotIndex, closeIndex + 1);
      index = closeIndex + 1;
      continue;
    }
    let param = callbackSource.slice(0, arrowIndex).trim();
    param = param
      .replace(/^\(\s*/, '')
      .replace(/\s*\)$/, '')
      .trim();
    const colonIndex = param.indexOf(':');
    if (colonIndex !== -1) param = param.slice(0, colonIndex).trim();
    if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(param)) {
      result += expression.slice(dotIndex, closeIndex + 1);
      index = closeIndex + 1;
      continue;
    }
    let body = normalizeArrowBody(callbackSource.slice(arrowIndex + 2));
    body = body.replace(/===/g, '==').replace(/!==/g, '!=');
    body = convertReadyWhenCallbackMethods(body);
    const celMethod = method === 'some' ? 'exists' : method === 'every' ? 'all' : method;
    result += `.${celMethod}(${param}, ${body})`;
    index = closeIndex + 1;
  }
  return result;
}

/** Lower the supported readyWhen callback subset into a CEL expression. */
export function convertReadyWhenCallbackToCel(
  fn: (...args: unknown[]) => unknown,
  resourceId: string
): string {
  const fnStr = fn.toString();
  const arrowMatch = fnStr.match(
    /^\s*\(?([a-zA-Z_$][a-zA-Z0-9_$]*)\)?\s*=>\s*(?:\{\s*(?:return\s+)?)?([\s\S]+?)(?:\s*;?\s*\})?$/
  );
  let paramName: string;
  let bodyStr: string;
  if (arrowMatch?.[1] && arrowMatch[2]) {
    paramName = arrowMatch[1];
    bodyStr = arrowMatch[2]
      .trim()
      .replace(/;\s*$/, '')
      .replace(/\}\s*$/, '')
      .trim();
  } else {
    const funcMatch = fnStr.match(
      /function\s*\w*\s*\(\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\)\s*\{\s*(?:return\s+)?([\s\S]+?);\s*\}/
    );
    if (!funcMatch?.[1] || !funcMatch[2]) return fnStr;
    paramName = funcMatch[1];
    bodyStr = funcMatch[2].trim();
  }
  let celExpr = bodyStr.replace(new RegExp(`\\b${escapeRegExp(paramName)}\\b`, 'g'), resourceId);
  celExpr = celExpr.replace(/===/g, '==').replace(/!==/g, '!=');
  celExpr = convertReadyWhenCallbackMethods(celExpr);
  return celExpr.replace(/'([^']+)'/g, '"$1"');
}
