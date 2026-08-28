// Money helpers: amounts are stored as integer paise everywhere except the
// UI boundary, to avoid floating-point drift when summing many line items.

/**
 * Convert a rupee value (number or numeric string, e.g. from a form field
 * that has already been run through calc.js) into integer paise.
 * Uses string-based rounding to avoid binary float artifacts like
 * 19.1 * 100 === 1909.9999999999998.
 * @param {number|string} rupees
 * @returns {number} integer paise
 */
export function rupeesToPaise(rupees) {
  const n = typeof rupees === 'string' ? Number(rupees) : rupees;
  if (!Number.isFinite(n)) throw new Error(`rupeesToPaise: not a finite number: ${rupees}`);
  // Round to the nearest paisa. Math.round on n*100 is fine for any
  // magnitude realistic for personal expenses (well under Number safe range),
  // and avoids the need for decimal-string gymnastics.
  return Math.round(n * 100);
}

/**
 * Convert integer paise to a rupee number (e.g. for feeding back into a
 * <input type="number"> or doing further math).
 * @param {number} paise
 * @returns {number}
 */
export function paiseToRupees(paise) {
  if (!Number.isInteger(paise)) throw new Error(`paiseToRupees: not an integer: ${paise}`);
  return paise / 100;
}

const inrFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const inrFormatterNoDecimals = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/**
 * Format integer paise as an Indian-grouped rupee string, e.g. "₹1,23,456.78".
 * @param {number} paise
 * @param {{ decimals?: boolean, signed?: boolean }} [opts]
 */
export function formatINR(paise, opts = {}) {
  const { decimals = true, signed = false } = opts;
  const rupees = paiseToRupees(paise);
  const formatter = decimals ? inrFormatter : inrFormatterNoDecimals;
  const formatted = formatter.format(Math.abs(rupees));
  if (signed && paise !== 0) return (paise < 0 ? '-' : '+') + formatted;
  return paise < 0 ? '-' + formatted : formatted;
}

/**
 * Format integer paise as a plain rupee number string for editable inputs,
 * e.g. 123456 -> "1234.56". No currency symbol, no grouping.
 * @param {number} paise
 */
export function paiseToInputValue(paise) {
  const rupees = paiseToRupees(paise);
  // Trim trailing ".00" style noise but keep real decimals.
  return String(Math.round(rupees * 100) / 100);
}
