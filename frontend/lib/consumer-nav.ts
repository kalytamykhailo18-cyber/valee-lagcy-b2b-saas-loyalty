/**
 * Returns the URL to go back to the consumer home, preserving the tenant slug
 * if one was remembered. Inner pages (scan, catalog, my-codes, dual-scan,
 * disputes) call this so the user lands back in the same merchant view instead
 * of getting dumped on the multicommerce hub.
 *
 * The slug is written to localStorage by the consumer page on mount whenever
 * `?tenant=X` is present, and cleared when the user explicitly navigates to
 * the hub (no `?tenant=`).
 */
export function consumerHomeUrl(): string {
  if (typeof window === 'undefined') return '/consumer'
  const slug = window.localStorage.getItem('tenantSlug')
  return slug ? `/consumer?tenant=${encodeURIComponent(slug)}` : '/consumer'
}
