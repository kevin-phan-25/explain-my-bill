/**
 * Security Utilities
 * Updated: May 30, 2026
 */

/**
 * Constant-time string comparison to prevent timing attacks
 */
export function timingSafeEqual(a, b) {
  const x = String(a || "");
  const y = String(b || "");

  if (!x || !y || x.length !== y.length) return false;

  let out = 0;
  for (let i = 0; i < x.length; i++) {
    out |= x.charCodeAt(i) ^ y.charCodeAt(i);
  }

  return out === 0;
}
