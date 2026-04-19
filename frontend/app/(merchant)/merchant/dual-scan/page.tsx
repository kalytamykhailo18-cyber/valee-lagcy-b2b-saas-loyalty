'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { api } from '@/lib/api'
import { formatCash } from '@/lib/format'

function QRImage({ value }: { value: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    import('qrcode').then(QRCode => {
      QRCode.toDataURL(value, { width: 320, margin: 2, errorCorrectionLevel: 'M' })
        .then(url => { if (!cancelled) setDataUrl(url) })
        .catch(() => { if (!cancelled) setDataUrl(null) })
    })
    return () => { cancelled = true }
  }, [value])

  if (!dataUrl) {
    return (
      <div className="w-64 h-64 lg:w-80 lg:h-80 flex items-center justify-center bg-slate-100 rounded-lg">
        <div className="w-10 h-10 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }
  return <img src={dataUrl} alt="QR" className="w-64 h-64 lg:w-80 lg:h-80" />
}

interface MultiplierInfo {
  currentRate: string
  defaultRate: string
  assetTypeId: string | null
  preferredExchangeSource?: string | null
  referenceCurrency?: string | null
  exchangeRateBs?: number | null
}

export default function DualScanPage() {
  const [amount, setAmount] = useState('')
  const [generating, setGenerating] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  const [expiresAt, setExpiresAt] = useState<number | null>(null)
  const [secondsLeft, setSecondsLeft] = useState(0)
  const [error, setError] = useState('')
  const [multiplier, setMultiplier] = useState<MultiplierInfo | null>(null)

  // Load multiplier + exchange rate so the merchant can preview how many
  // points a given Bs amount will generate, BEFORE committing the QR.
  useEffect(() => {
    (async () => {
      try {
        const m = await api.getMultiplier()
        setMultiplier(m)
      } catch {}
    })()
  }, [])

  // Preview: compute expected points for the current input.
  // The dual-scan amount is always in the tenant's reference currency
  // (USD/EUR) — typed directly by the cashier for cash/mobile payments.
  // Formula: amount × multiplier, floored at 1.
  const currencySymbol = multiplier?.referenceCurrency === 'eur' ? '€' : '$'
  const previewPoints = (() => {
    const n = parseFloat(amount)
    if (!Number.isFinite(n) || n <= 0 || !multiplier) return null
    const rate = Number(multiplier.currentRate) || 1
    return Math.max(1, Math.round(n * rate))
  })()

  // Countdown — compute initial value synchronously so user never sees 0 on mount
  useEffect(() => {
    if (!expiresAt) {
      setSecondsLeft(0)
      return
    }
    // Set immediately on this render cycle
    const initial = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))
    setSecondsLeft(initial)

    const interval = setInterval(() => {
      const left = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))
      setSecondsLeft(left)
      if (left <= 0) {
        clearInterval(interval)
        setToken(null)
        setExpiresAt(null)
      }
    }, 1000)
    return () => clearInterval(interval)
  }, [expiresAt])

  async function generate() {
    setError('')
    if (!amount || parseFloat(amount) <= 0) {
      setError('Ingresa un monto valido')
      return
    }
    setGenerating(true)
    try {
      const res = await api.initiateDualScan(amount)
      const exp = Number(res.expiresAt)
      // Sanity check: server-supplied expiresAt must be in the future. If client
      // clock is wildly off, treat the value as "now + 60s" so the timer at
      // least shows something meaningful instead of vanishing instantly.
      const safeExpiresAt = exp > Date.now() ? exp : Date.now() + 60_000
      setToken(res.token)
      setExpiresAt(safeExpiresAt)
    } catch (e: any) {
      setError(e.error || 'Error al generar QR')
    } finally {
      setGenerating(false)
    }
  }

  function reset() {
    setToken(null)
    setExpiresAt(null)
    setAmount('')
    setError('')
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Page header */}
      <div className="px-4 sm:px-6 lg:px-8 pt-6 lg:pt-8 pb-4 aa-rise">
        <h1 className="text-2xl lg:text-3xl font-bold text-slate-800 tracking-tight">Pago en efectivo</h1>
        <p className="text-sm text-slate-500 mt-1">Genera un codigo QR temporal para clientes que pagan sin recibo (efectivo, Pago Movil, Zelle)</p>
        {/* Cross-link back to scanner — cashier kiosk flow toggles between
            the two without needing the sidebar. */}
        <Link
          href="/merchant/scanner"
          className="inline-flex items-center gap-2 mt-3 text-sm text-emerald-700 hover:text-emerald-800 font-medium"
        >
          &larr; Ir al escaner de canjes
        </Link>
      </div>

      {/* Content */}
      <div className="px-4 sm:px-6 lg:px-8 pb-8">
        <div className="max-w-xl mx-auto">
          {!token ? (
            <div className="bg-white rounded-2xl p-6 lg:p-8 shadow-sm border border-slate-100 space-y-5 aa-rise" style={{ animationDelay: '80ms' }}>
              <div>
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Monto de la transaccion ({currencySymbol})</label>
                <div className="relative mt-2">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 font-bold pointer-events-none text-xl">{currencySymbol}</span>
                  <input
                    type="number"
                    value={amount}
                    onChange={e => setAmount(e.target.value)}
                    placeholder="30.00"
                    className="aa-field aa-field-emerald w-full pl-10 pr-4 py-4 rounded-xl border border-slate-200 text-2xl font-bold text-slate-800 tabular-nums"
                    autoFocus
                    min="0"
                    step="0.01"
                  />
                </div>
                {previewPoints !== null && (
                  <div className="mt-3 bg-emerald-50 border border-emerald-200 rounded-xl p-3 flex items-center justify-between">
                    <span className="text-sm text-emerald-700">El cliente ganara</span>
                    <span className="text-lg font-bold text-emerald-700 tabular-nums">{previewPoints} pts</span>
                  </div>
                )}
                <p className="text-xs text-slate-400 mt-2">
                  El cliente escaneara el QR para acumular sus puntos. Sin necesidad de factura fiscal.
                </p>
              </div>

              {error && (
                <div className="aa-pop bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">
                  {error}
                </div>
              )}

              <button
                onClick={generate}
                disabled={generating || !amount}
                className="aa-btn aa-btn-emerald w-full bg-emerald-600 text-white py-4 rounded-xl font-semibold text-base disabled:opacity-50 hover:bg-emerald-700 flex items-center justify-center"
              >
                {generating && <span className="aa-spinner" />}<span className="relative z-10">{generating ? 'Generando...' : 'Generar QR'}</span>
              </button>
            </div>
          ) : (
            <div className="bg-white rounded-2xl p-6 lg:p-8 shadow-sm border border-slate-100 text-center space-y-5 aa-pop">
              <div>
                <p className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Monto</p>
                <p className="text-4xl lg:text-5xl font-bold text-emerald-700 mt-2 tabular-nums">
                  {currencySymbol}{formatCash(amount)}
                </p>
              </div>

              <p className="text-sm text-slate-500">Muestra este codigo al cliente</p>

              <div className="inline-block bg-white border-4 border-emerald-200 rounded-2xl p-4 animate-qr-build">
                {/* Encode a deep link, not the raw token. Native phone cameras
                    decode a wa.me-style URL and open it in the browser, where
                    /scan?dual=<token> auto-triggers confirmDualScan. Before
                    this, the QR was just a base64 string and the consumer saw
                    raw text with a "Copy" option — "el token no hacia nada". */}
                <QRImage value={`${typeof window !== 'undefined' ? window.location.origin : 'https://valee.app'}/scan?dual=${encodeURIComponent(token)}`} />
              </div>

              <div className="bg-slate-50 rounded-xl p-4">
                <p key={secondsLeft} className="text-4xl font-bold text-emerald-700 aa-count tabular-nums">{secondsLeft}s</p>
                <p className="text-xs text-slate-500 mt-1 uppercase tracking-wide">Tiempo restante</p>
              </div>

              <button
                onClick={reset}
                className="text-sm text-slate-500 underline hover:text-slate-700 transition"
              >
                Cancelar y crear otro
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
