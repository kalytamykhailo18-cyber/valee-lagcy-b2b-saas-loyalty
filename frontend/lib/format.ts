/**
 * Format a points value for display. Rounds to whole numbers and inserts
 * thousand separators (es-VE → '.' separator, matching how Venezuelan
 * receipts write large amounts). Genesis flagged the consumer PWA
 * showing raw '2207' while the merchant panel already had separators.
 */
export function formatPoints(value: number | string): string {
  const n = typeof value === 'string' ? parseFloat(value) : value
  if (!Number.isFinite(n)) return '0'
  return Math.round(n).toLocaleString('es-VE')
}

export function formatCash(value: number | string): string {
  const n = typeof value === 'string' ? parseFloat(value) : value
  if (!Number.isFinite(n)) return '0'
  return n % 1 === 0
    ? Math.round(n).toLocaleString('es-VE')
    : n.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
