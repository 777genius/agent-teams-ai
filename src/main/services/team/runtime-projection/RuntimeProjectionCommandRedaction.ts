const REDACTED_VALUE = '[redacted]';
const MAX_OUTPUT_CHARS = 500;
const MAX_SCAN_CHARS = 16_384;
const MAX_NESTING_DEPTH = 32;
const MAX_CASE_DEPTH = 16;

const SECRET_FLAGS = [
  '--authorization',
  '--auth-token',
  '--password',
  '--api-key',
  '--secret',
  '--token',
] as const;

type Quote = 'none' | 'single' | 'double';

interface CaseFrame {
  awaitingIn: boolean;
  inPattern: boolean;
  patternParentheses: number;
  atPatternStart: boolean;
  inBracketExpression: boolean;
  bracketExpressionHasCharacter: boolean;
}

interface RootFrame {
  kind: 'root';
  quote: Quote;
}

interface ParenthesisFrame {
  kind: 'command' | 'arithmetic';
  quote: Quote;
  parentheses: number;
  cases: CaseFrame[];
}

interface ParameterFrame {
  kind: 'parameter';
  quote: Quote;
  braces: number;
}

interface BacktickFrame {
  kind: 'backtick';
  quote: 'none';
}

type ShellFrame = RootFrame | ParenthesisFrame | ParameterFrame | BacktickFrame;

interface ShellWordEnd {
  end: number;
  complete: boolean;
}

function isWhitespace(character: string | undefined): boolean {
  return character !== undefined && /\s/u.test(character);
}

function isAsciiWordCharacter(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z_]/u.test(character);
}

function isShellWordBoundary(character: string | undefined): boolean {
  return (
    character === undefined ||
    isWhitespace(character) ||
    character === ';' ||
    character === '|' ||
    character === '&' ||
    character === '(' ||
    character === ')'
  );
}

function isFlagStartBoundary(character: string | undefined): boolean {
  return (
    character === undefined ||
    isWhitespace(character) ||
    character === ';' ||
    character === '|' ||
    character === '&' ||
    character === '('
  );
}

function isFlagLikeToken(command: string, index: number, end: number): boolean {
  if (command[index] !== '-' || index + 1 >= end) {
    return false;
  }
  const next = command[index + 1];
  if (next === '-') {
    const longFlagStart = command[index + 2];
    return index + 2 >= end || isWhitespace(longFlagStart) || /[A-Za-z]/u.test(longFlagStart ?? '');
  }
  return /[A-Za-z?]/u.test(next ?? '');
}

function pushFrame(frames: ShellFrame[], frame: ShellFrame): boolean {
  if (frames.length >= MAX_NESTING_DEPTH) {
    return false;
  }
  frames.push(frame);
  return true;
}

function newCaseFrame(): CaseFrame {
  return {
    awaitingIn: true,
    inPattern: false,
    patternParentheses: 0,
    atPatternStart: false,
    inBracketExpression: false,
    bracketExpressionHasCharacter: false,
  };
}

function beginCasePattern(frame: CaseFrame): void {
  frame.awaitingIn = false;
  frame.inPattern = true;
  frame.patternParentheses = 0;
  frame.atPatternStart = true;
  frame.inBracketExpression = false;
  frame.bracketExpressionHasCharacter = false;
}

function currentCaseFrame(frame: ShellFrame): CaseFrame | undefined {
  return frame.kind === 'command' || frame.kind === 'arithmetic' ? frame.cases.at(-1) : undefined;
}

function readShellKeyword(
  command: string,
  index: number,
  end: number,
  frame: ParenthesisFrame
): number {
  if (!isAsciiWordCharacter(command[index]) || !isShellWordBoundary(command[index - 1])) {
    return index;
  }

  let wordEnd = index + 1;
  while (wordEnd < end && isAsciiWordCharacter(command[wordEnd])) {
    wordEnd += 1;
  }
  if (!isShellWordBoundary(command[wordEnd])) {
    return index;
  }

  const word = command.slice(index, wordEnd);
  const activeCase = frame.cases.at(-1);
  if (word === 'case') {
    // Within a pattern, `case` is ordinary pattern text (including inside extglobs).
    // A nested case statement can only begin while its parent is in an arm body.
    if (!activeCase || (!activeCase.awaitingIn && !activeCase.inPattern)) {
      if (frame.cases.length >= MAX_CASE_DEPTH) {
        return -1;
      }
      frame.cases.push(newCaseFrame());
    } else if (activeCase.inPattern) {
      activeCase.atPatternStart = false;
    }
  } else if (word === 'in' && activeCase?.awaitingIn) {
    beginCasePattern(activeCase);
  } else if (
    word === 'esac' &&
    activeCase?.inPattern &&
    activeCase.atPatternStart &&
    activeCase.patternParentheses === 0
  ) {
    frame.cases.pop();
  } else if (activeCase?.inPattern) {
    activeCase.atPatternStart = false;
  }
  return wordEnd;
}

function markCasePatternStarted(frame: ShellFrame): void {
  const activeCase = currentCaseFrame(frame);
  if (activeCase?.inPattern) {
    activeCase.atPatternStart = false;
  }
}

function findShellWordEnd(command: string, start: number, end: number): ShellWordEnd {
  const frames: ShellFrame[] = [{ kind: 'root', quote: 'none' }];
  let index = start;

  while (index < end) {
    const frame = frames.at(-1);
    if (!frame) {
      return { end: index, complete: false };
    }
    const character = command[index];

    if (frame.kind === 'backtick') {
      if (character === '\\') {
        index = Math.min(index + 2, end);
      } else if (character === '`') {
        frames.pop();
        index += 1;
      } else if (
        command[index + 1] === '(' &&
        (character === '$' || character === '<' || character === '>')
      ) {
        const arithmetic = character === '$' && command[index + 2] === '(';
        if (
          !pushFrame(frames, {
            kind: arithmetic ? 'arithmetic' : 'command',
            quote: 'none',
            parentheses: arithmetic ? 2 : 1,
            cases: [],
          })
        ) {
          return { end: index, complete: false };
        }
        index += arithmetic ? 3 : 2;
      } else {
        index += 1;
      }
      continue;
    }

    if (frame.quote === 'single') {
      if (character === "'") {
        frame.quote = 'none';
      }
      index += 1;
      continue;
    }

    if (character === '\\') {
      markCasePatternStarted(frame);
      index = Math.min(index + 2, end);
      continue;
    }
    if (frame.quote === 'double' && character === '"') {
      frame.quote = 'none';
      index += 1;
      continue;
    }
    if (frame.quote === 'none' && character === "'") {
      markCasePatternStarted(frame);
      frame.quote = 'single';
      index += 1;
      continue;
    }
    if (frame.quote === 'none' && character === '"') {
      markCasePatternStarted(frame);
      frame.quote = 'double';
      index += 1;
      continue;
    }

    if (
      command[index + 1] === '(' &&
      (character === '$' || (frame.quote === 'none' && (character === '<' || character === '>')))
    ) {
      markCasePatternStarted(frame);
      const arithmetic = character === '$' && command[index + 2] === '(';
      if (
        !pushFrame(frames, {
          kind: arithmetic ? 'arithmetic' : 'command',
          quote: 'none',
          parentheses: arithmetic ? 2 : 1,
          cases: [],
        })
      ) {
        return { end: index, complete: false };
      }
      index += arithmetic ? 3 : 2;
      continue;
    }
    if (character === '$' && command[index + 1] === '{') {
      markCasePatternStarted(frame);
      if (!pushFrame(frames, { kind: 'parameter', quote: 'none', braces: 1 })) {
        return { end: index, complete: false };
      }
      index += 2;
      continue;
    }
    if (character === '`') {
      markCasePatternStarted(frame);
      if (!pushFrame(frames, { kind: 'backtick', quote: 'none' })) {
        return { end: index, complete: false };
      }
      index += 1;
      continue;
    }

    if (frame.quote === 'double') {
      index += 1;
      continue;
    }

    if (frame.kind === 'root') {
      if (isWhitespace(character)) {
        return { end: index, complete: true };
      }
      index += 1;
      continue;
    }

    if (frame.kind === 'parameter') {
      if (character === '{') {
        if (frame.braces >= MAX_NESTING_DEPTH) {
          return { end: index, complete: false };
        }
        frame.braces += 1;
      } else if (character === '}') {
        frame.braces -= 1;
        if (frame.braces === 0) {
          frames.pop();
        }
      }
      index += 1;
      continue;
    }

    const keywordEnd = readShellKeyword(command, index, end, frame);
    if (keywordEnd === -1) {
      return { end: index, complete: false };
    }
    if (keywordEnd > index) {
      index = keywordEnd;
      continue;
    }

    const activeCase = currentCaseFrame(frame);
    if (activeCase?.inPattern) {
      if (activeCase.inBracketExpression) {
        if (character === ']' && activeCase.bracketExpressionHasCharacter) {
          activeCase.inBracketExpression = false;
        } else {
          activeCase.bracketExpressionHasCharacter = true;
        }
        index += 1;
        continue;
      }
      if (character === '[') {
        activeCase.atPatternStart = false;
        activeCase.inBracketExpression = true;
        activeCase.bracketExpressionHasCharacter = false;
        index += 1;
        continue;
      }
      if (isWhitespace(character)) {
        index += 1;
        continue;
      }
      if (character === '(' && activeCase.atPatternStart) {
        // Bash permits one grammar-level opening parenthesis before a case pattern.
        // Its arm-closing `)` is not a balanced pair, so do not count this opener.
        activeCase.atPatternStart = false;
        index += 1;
        continue;
      }
      activeCase.atPatternStart = false;
      if (character === '(') {
        if (activeCase.patternParentheses >= MAX_NESTING_DEPTH) {
          return { end: index, complete: false };
        }
        activeCase.patternParentheses += 1;
        index += 1;
        continue;
      }
      if (character === ')') {
        if (activeCase.patternParentheses > 0) {
          activeCase.patternParentheses -= 1;
        } else {
          activeCase.inPattern = false;
        }
        index += 1;
        continue;
      }
    }
    if (activeCase && !activeCase.awaitingIn && !activeCase.inPattern && character === ';') {
      if (command[index + 1] === ';' || command[index + 1] === '&') {
        beginCasePattern(activeCase);
        index += command[index + 1] === ';' && command[index + 2] === '&' ? 3 : 2;
        continue;
      }
    }

    if (character === '(') {
      if (frame.parentheses >= MAX_NESTING_DEPTH) {
        return { end: index, complete: false };
      }
      frame.parentheses += 1;
    } else if (character === ')') {
      if (frame.parentheses === 1 && frame.cases.length > 0) {
        return { end: index, complete: false };
      }
      frame.parentheses -= 1;
      if (frame.parentheses === 0) {
        frames.pop();
      }
    }
    index += 1;
  }

  const root = frames.length === 1 ? frames[0] : undefined;
  return {
    end: index,
    complete: root?.kind === 'root' && root.quote === 'none',
  };
}

function matchSecretFlag(command: string, index: number, end: number): string | undefined {
  if (command[index] !== '-' || command[index + 1] !== '-') {
    return undefined;
  }
  if (!isFlagStartBoundary(command[index - 1])) {
    return undefined;
  }

  for (const flag of SECRET_FLAGS) {
    if (index + flag.length > end) {
      continue;
    }
    if (command.slice(index, index + flag.length).toLowerCase() !== flag) {
      continue;
    }
    const next = command[index + flag.length];
    if (next === '=' || isWhitespace(next) || index + flag.length === end) {
      return flag;
    }
  }
  return undefined;
}

function appendBounded(output: string, value: string): string {
  if (output.length >= MAX_OUTPUT_CHARS) {
    return output;
  }
  return output + value.slice(0, MAX_OUTPUT_CHARS - output.length);
}

/**
 * Redacts secret-bearing runtime flags without executing or fully parsing shell syntax.
 * Scan, output, nesting, and case depths are capped; incomplete secret values fail closed.
 */
export function sanitizeRuntimeProjectionProcessCommand(
  command: string | undefined
): string | undefined {
  if (command === undefined) {
    return undefined;
  }

  const scanEnd = Math.min(command.length, MAX_SCAN_CHARS);
  let start = 0;
  while (start < scanEnd && isWhitespace(command[start])) {
    start += 1;
  }
  if (start === scanEnd) {
    return command.length > scanEnd ? REDACTED_VALUE : undefined;
  }

  let end = scanEnd;
  if (command.length <= MAX_SCAN_CHARS) {
    while (end > start && isWhitespace(command[end - 1])) {
      end -= 1;
    }
  }

  let output = '';
  let unconsumedStart = start;
  let index = start;
  while (index < end && output.length < MAX_OUTPUT_CHARS) {
    const flag = matchSecretFlag(command, index, end);
    if (!flag) {
      index += 1;
      continue;
    }

    const flagEnd = index + flag.length;
    let valueStart = flagEnd;
    if (command[valueStart] === '=') {
      valueStart += 1;
      output = appendBounded(output, command.slice(unconsumedStart, valueStart));
      output = appendBounded(output, REDACTED_VALUE);
      if (valueStart === end) {
        return output;
      }
    } else {
      while (valueStart < end && isWhitespace(command[valueStart])) {
        valueStart += 1;
      }
      if (valueStart === end) {
        output = appendBounded(output, command.slice(unconsumedStart, flagEnd));
        output = appendBounded(output, ` ${REDACTED_VALUE}`);
        return output;
      }
      output = appendBounded(output, command.slice(unconsumedStart, valueStart));
      output = appendBounded(output, REDACTED_VALUE);
      if (isFlagLikeToken(command, valueStart, end)) {
        output = appendBounded(output, ' ');
        unconsumedStart = valueStart;
        index = valueStart;
        continue;
      }
    }

    const valueEnd = findShellWordEnd(command, valueStart, end);
    if (!valueEnd.complete) {
      return output;
    }
    unconsumedStart = valueEnd.end;
    index = valueEnd.end;
  }

  output = appendBounded(output, command.slice(unconsumedStart, end));
  return output || undefined;
}
