// Display-only currency localization for plan prices — what's
// actually charged is always the fixed price_idr amount via Dodo
// (billing_service.py creates every Product priced in IDR; see its
// own docstring for why), this only changes how that SAME amount is
// shown to a visitor, converted at a rough hand-set rate for their
// likely currency. Never used anywhere real money is computed.
//
// Deliberately browser-locale-based (navigator.language), not real
// IP geolocation — no third-party network call from every landing-page
// visitor's browser, no rate-limit/reliability risk on a public page,
// no IP sent to an external service. Less precise than true geo-IP
// (reflects the visitor's OS/browser language setting, not their
// physical location), a real tradeoff worth knowing about — swap in a
// geo-IP lookup later if that precision turns out to matter more than
// the simplicity/privacy this buys.

const REGION_CURRENCY: Record<string, string> = {
  US: "USD",
  GB: "GBP",
  ID: "IDR",
  JP: "JPY",
  SG: "SGD",
  MY: "MYR",
  AU: "AUD",
  CA: "CAD",
  IN: "INR",
  PH: "PHP",
  DE: "EUR",
  FR: "EUR",
  IT: "EUR",
  ES: "EUR",
  NL: "EUR",
  BE: "EUR",
  IE: "EUR",
  PT: "EUR",
  AT: "EUR",
  FI: "EUR",
  GR: "EUR",
};

// IDR per 1 unit of the target currency — a rough snapshot for display
// purposes, not a live rate; revisit periodically. Same discipline as
// the ~Rp 16,000/USD assumption already documented in the
// rename/reprice migration for the Dodo Payments margin math.
const IDR_PER_UNIT: Record<string, number> = {
  USD: 16000,
  EUR: 17300,
  GBP: 20200,
  JPY: 107,
  SGD: 11900,
  MYR: 3400,
  AUD: 10500,
  CAD: 11700,
  INR: 192,
  PHP: 285,
  IDR: 1,
};

/** Client-only (reads navigator) — call from a useEffect, never during
 * render, so server and first client render both start from nothing
 * and stay hydration-safe. */
export function detectCurrency(): string {
  if (typeof navigator === "undefined") return "IDR";
  try {
    const region = new Intl.Locale(navigator.language).maximize().region;
    return (region && REGION_CURRENCY[region]) || "USD";
  } catch {
    return "USD";
  }
}

/** Null when there's nothing useful to show — already IDR, a free
 * (0-price) plan, or a currency this table has no rate for. */
export function formatLocalizedPrice(priceIdr: number, currency: string): string | null {
  if (currency === "IDR" || priceIdr <= 0) return null;
  const rate = IDR_PER_UNIT[currency];
  if (!rate) return null;
  const amount = priceIdr / rate;
  try {
    return new Intl.NumberFormat(navigator.language, { style: "currency", currency }).format(amount);
  } catch {
    return null;
  }
}
