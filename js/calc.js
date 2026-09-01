// Safe arithmetic expression evaluator for amount inputs. Supports
// + - * / ( ) and decimals, with standard precedence and unary minus.
// Deliberately hand-rolled (tokenizer + recursive-descent parser) instead
// of eval()/Function() so it can never execute arbitrary JS.

export class CalcError extends Error {}

const TOKEN_RE = /\s*(\d+\.?\d*|\.\d+|[()+\-*/])/y;

function tokenize(expr) {
  const tokens = [];
  TOKEN_RE.lastIndex = 0;
  let pos = 0;
  while (pos < expr.length) {
    TOKEN_RE.lastIndex = pos;
    const m = TOKEN_RE.exec(expr);
    if (!m || m[0].length === 0) {
      throw new CalcError(`Unexpected character at position ${pos}: "${expr.slice(pos, pos + 1)}"`);
    }
    tokens.push(m[1]);
    pos = TOKEN_RE.lastIndex;
  }
  return tokens;
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.i = 0;
  }
  peek() {
    return this.tokens[this.i];
  }
  next() {
    return this.tokens[this.i++];
  }
  parseExpr() {
    let value = this.parseTerm();
    for (;;) {
      const t = this.peek();
      if (t === '+' || t === '-') {
        this.next();
        const rhs = this.parseTerm();
        value = t === '+' ? value + rhs : value - rhs;
      } else {
        break;
      }
    }
    return value;
  }
  parseTerm() {
    let value = this.parseFactor();
    for (;;) {
      const t = this.peek();
      if (t === '*' || t === '/') {
        this.next();
        const rhs = this.parseFactor();
        if (t === '/') {
          if (rhs === 0) throw new CalcError('Division by zero');
          value = value / rhs;
        } else {
          value = value * rhs;
        }
      } else {
        break;
      }
    }
    return value;
  }
  parseFactor() {
    const t = this.peek();
    if (t === '-') {
      this.next();
      return -this.parseFactor();
    }
    if (t === '+') {
      this.next();
      return this.parseFactor();
    }
    if (t === '(') {
      this.next();
      const value = this.parseExpr();
      if (this.peek() !== ')') throw new CalcError('Missing closing parenthesis');
      this.next();
      return value;
    }
    if (t !== undefined && /^\d/.test(t) || (t !== undefined && t.startsWith('.'))) {
      this.next();
      return Number(t);
    }
    throw new CalcError(`Unexpected token: ${t === undefined ? '<end>' : t}`);
  }
}

/**
 * Evaluate an arithmetic expression string, e.g. "120+340+75" -> 535.
 * Throws CalcError on invalid input (bad syntax, division by zero,
 * disallowed characters). Empty/whitespace-only input throws too — callers
 * should check for blank fields before calling this.
 * @param {string} expr
 * @returns {number}
 */
export function evaluate(expr) {
  if (typeof expr !== 'string' || expr.trim() === '') {
    throw new CalcError('Empty expression');
  }
  const tokens = tokenize(expr);
  const parser = new Parser(tokens);
  const value = parser.parseExpr();
  if (parser.i !== tokens.length) {
    throw new CalcError(`Unexpected trailing token: ${parser.peek()}`);
  }
  if (!Number.isFinite(value)) throw new CalcError('Result is not finite');
  return value;
}

/**
 * Best-effort evaluate: returns null instead of throwing on invalid input.
 * Handy for live/blur validation where you want to fall back gracefully.
 * @param {string} expr
 * @returns {number|null}
 */
export function tryEvaluate(expr) {
  try {
    return evaluate(expr);
  } catch {
    return null;
  }
}

/**
 * Wires an amount <input> to evaluate its arithmetic expression (e.g.
 * "120+340+75") on blur/Enter, replacing the input's value with the result.
 * Invalid input just gets a `field-invalid` class, not cleared, so the user
 * can see and fix their typo.
 * @param {HTMLInputElement} input
 */
export function bindAmountField(input) {
  const resolve = () => {
    const raw = input.value.trim();
    if (raw === '') {
      input.classList.remove('field-invalid');
      return;
    }
    const value = tryEvaluate(raw);
    if (value === null) {
      input.classList.add('field-invalid');
      return;
    }
    input.classList.remove('field-invalid');
    input.value = String(Math.round(value * 100) / 100);
  };
  input.addEventListener('blur', resolve);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      resolve();
    }
  });
}
