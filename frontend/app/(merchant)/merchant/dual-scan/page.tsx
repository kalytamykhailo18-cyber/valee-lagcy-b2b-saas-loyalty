'use client'

import { useState, useEffect } from 'react'
import { api } from '@/lib/api'

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

export default function DualScanPage() {
  const [amount, setAmount] = useState('')
  const [generating, setGenerating] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  const [expiresAt, setExpiresAt] = useState<number | null>(null)
  const [secondsLeft, setSecondsLeft] = useState(0)
  const [error, setError] = useState('')

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
      <div className="px-4 sm:px-6 lg:px-8 pt-6 lg:pt-8 pb-4">
        <h1 className="text-2xl lg:text-3xl font-bold text-slate-800">Transaccion sin factura</h1>
        <p className="text-sm text-slate-500 mt-1">Genera un codigo QR temporal para clientes que pagan sin recibo (efectivo, Pago Movil, Zelle)</p>
      </div>

      {/* Content */}
      <div className="px-4 sm:px-6 lg:px-8 pb-8">
        <div className="max-w-xl mx-auto">
          {!token ? (
            <div className="bg-white rounded-2xl p-6 lg:p-8 shadow-sm border border-slate-100 space-y-5">
              <div>
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Monto de la transaccion</label>
                <input
                  type="number"
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  placeholder="Ej: 500.00"
                  className="w-full mt-2 px-4 py-4 rounded-xl border border-slate-200 text-2xl font-bold text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  autoFocus
                  min="0"
                  step="0.01"
                />
                <p className="text-xs text-slate-400 mt-2">
                  El cliente escaneara el QR para acumular sus puntos. Sin necesidad de factura fiscal.
                </p>
              </div>

              {error && (
                <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">
                  {error}
                </div>
              )}

              <button
                onClick={generate}
                disabled={generating || !amount}
                className="w-full bg-emerald-600 text-white py-4 rounded-xl font-semibold text-base disabled:opacity-50 hover:bg-emerald-700 transition"
              >
                {generating ? 'Generando...' : 'Generar QR'}
              </button>
            </div>
          ) : (
            <div className="bg-white rounded-2xl p-6 lg:p-8 shadow-sm border border-slate-100 text-center space-y-5">
              <div>
                <p className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Monto</p>
                <p className="text-4xl lg:text-5xl font-bold text-emerald-700 mt-2">
                  Bs {parseFloat(amount).toLocaleString()}
                </p>
              </div>

              <p className="text-sm text-slate-500">Muestra este codigo al cliente</p>

              <div className="inline-block bg-white border-4 border-emerald-200 rounded-2xl p-4">
                <QRImage value={token} />
              </div>

              <div className="bg-slate-50 rounded-xl p-4">
                <p className="text-4xl font-bold text-emerald-700">{secondsLeft}s</p>
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
