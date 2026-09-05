// Adrian, direct: "cost of purchase... show in the currency of
// wherever the user is," then: "I want the main number displayed to
// be USD." GET /billing/currency (currency_service.py) resolves two
// independent real things, neither ever a guess: `usd_rate`
// (location-independent — the PRIMARY price every visitor sees) and
// `currency`/`rate` (THIS visitor's own real local currency — the
// secondary "≈" estimate, which can be IDR, or even USD itself if
// they're actually in the US). Either half null means "fall back to
// the real Rp price for that half."
export type LocalizedCurrency = { currency: string | null; rate: number | null; usd_rate: number | null };

/** Converts+formats a plain IDR amount into a single {currency, rate}
 * pair — generic so the same helper renders both the USD primary
 * (`{currency: "USD", rate: localized.usd_rate}`) and the visitor's
 * own local "≈" estimate (`{currency: localized.currency, rate:
 * localized.rate}`). Null (either field, or a malformed currency code)
 * means "couldn't resolve a real one, don't show an estimate." */
export function formatConvertedPrice(priceIdr: number, target: { currency: string | null; rate: number | null }): string | null {
  if (!target.currency || target.rate === null || priceIdr <= 0) return null;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: target.currency }).format(
      priceIdr * target.rate,
    );
  } catch {
    // An unrecognized/malformed currency code would throw here —
    // never surface that as a crash, just skip the estimate.
    return null;
  }
}

/** The primary displayed price — USD, falling back to the real Rp
 * price if a live USD rate couldn't be resolved (never a guessed
 * number). `priceIdr === 0` (the Free plan) always short-circuits to
 * "Free", the one case with nothing to convert. */
export function primaryPriceLabel(priceIdr: number, localized: LocalizedCurrency): string {
  if (priceIdr === 0) return "Free";
  const usd = formatConvertedPrice(priceIdr, { currency: "USD", rate: localized.usd_rate });
  return usd ?? `Rp ${priceIdr.toLocaleString("id-ID")}`;
}

/** The secondary "≈ ..." estimate in the visitor's own real local
 * currency — omitted entirely when it would just repeat the primary
 * (their local currency IS USD) or when it didn't resolve. */
export function localEstimateLabel(priceIdr: number, localized: LocalizedCurrency): string | null {
  if (priceIdr === 0 || !localized.currency || localized.currency === "USD") return null;
  return formatConvertedPrice(priceIdr, { currency: localized.currency, rate: localized.rate });
}
