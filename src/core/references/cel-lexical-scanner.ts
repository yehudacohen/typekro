/** Preserve offsets while hiding quoted CEL data from reference scanners. */
export function maskCelStringLiterals(expression: string): string {
  const characters = [...expression];
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (quote === undefined) {
      if (character === '"' || character === "'") {
        quote = character;
        characters[index] = ' ';
      }
      continue;
    }
    characters[index] = ' ';
    if (escaped) {
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === quote) {
      quote = undefined;
    }
  }
  return characters.join('');
}

export interface CelLambdaScope {
  readonly variable: string;
  readonly bodyStart: number;
  readonly bodyEnd: number;
}

/**
 * Locate each lexical CEL collection-macro body without treating a lambda
 * identifier as expression-global.
 */
export function collectCelLambdaScopes(expression: string): CelLambdaScope[] {
  const scopes: CelLambdaScope[] = [];
  const macroPattern = /\.(?:all|exists|exists_one|map|filter)\s*\(/g;
  let match: RegExpExecArray | null = macroPattern.exec(expression);

  while (match !== null) {
    const openParen = expression.indexOf('(', match.index);
    const parsed = parseCelMacroArguments(expression, openParen);
    if (parsed) {
      const variable = expression.slice(parsed.firstArgumentStart, parsed.firstArgumentEnd).trim();
      if (/^[A-Za-z_][A-Za-z0-9_]*$/u.test(variable)) {
        scopes.push({
          variable,
          bodyStart: parsed.bodyStart,
          bodyEnd: parsed.closeParen,
        });
      }
    }
    match = macroPattern.exec(expression);
  }
  return scopes;
}

export function isCelLambdaLocalAt(
  identifier: string,
  offset: number,
  scopes: readonly CelLambdaScope[]
): boolean {
  return scopes.some(
    (scope) => scope.variable === identifier && offset >= scope.bodyStart && offset < scope.bodyEnd
  );
}

function parseCelMacroArguments(
  expression: string,
  openParen: number
):
  | {
      readonly firstArgumentStart: number;
      readonly firstArgumentEnd: number;
      readonly bodyStart: number;
      readonly closeParen: number;
    }
  | undefined {
  if (openParen < 0 || expression[openParen] !== '(') return undefined;

  const stack: string[] = ['('];
  let firstComma: number | undefined;
  for (let index = openParen + 1; index < expression.length; index += 1) {
    const character = expression[index];
    if (character === '(' || character === '[' || character === '{') {
      stack.push(character);
      continue;
    }
    if (character === ')' || character === ']' || character === '}') {
      const expected = character === ')' ? '(' : character === ']' ? '[' : '{';
      if (stack.at(-1) !== expected) return undefined;
      stack.pop();
      if (stack.length === 0) {
        if (firstComma === undefined) return undefined;
        return {
          firstArgumentStart: openParen + 1,
          firstArgumentEnd: firstComma,
          bodyStart: firstComma + 1,
          closeParen: index,
        };
      }
      continue;
    }
    if (character === ',' && stack.length === 1 && firstComma === undefined) {
      firstComma = index;
    }
  }
  return undefined;
}
