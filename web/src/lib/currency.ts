// Adrian, direct: "cost of purchase... show in the currency of
// wherever the user is." GET /billing/currency (currency_service.py)
// resolves a real geo-IP + a real live FX rate for the visitor — this
// is purely the display-side formatting half: `rate` converts an IDR
// amount into that currency, "null" (currency or rate) means "couldn't
// resolve a real one, just show the base Rp price" — never a guessed
// number.
export type LocalizedCurrency = { currency: string | null; rate: number | null };

export function formatConvertedPrice(priceIdr: number, localized: LocalizedCurrency): string | null {
  if (!localized.currency || localized.rate === null || priceIdr <= 0) return null;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: localized.currency }).format(
      priceIdr * localized.rate,
    );
  } catch {
    // An unrecognized/malformed currency code would throw here —
    // never surface that as a crash, just skip the estimate.
    return null;
  }
}
