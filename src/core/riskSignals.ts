const HIGH_CONSEQUENCE_RE = /(?:^|[./_-])(webhook|webhooks|checkout|checkouts|payment|payments|order|orders|subscription|subscriptions|billing|auth|session|cart|carts)(?:[./_-]|$)/i;

export function isHighConsequencePath(path: string): boolean {
  return HIGH_CONSEQUENCE_RE.test(path);
}
