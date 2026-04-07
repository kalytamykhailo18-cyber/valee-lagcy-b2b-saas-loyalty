'use client'

import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import Link from 'next/link'

export default function DualScanPage() {
  const [amount, setAmount] = useState('')
  const [generating, setGenerating] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  const [expiresAt, setExpiresAt] = useState<number | null>(null)
  const [secondsLeft, setSecondsLeft] = useState(0)
  const [error, setError] = useState('')

  // Countdown
  useEffect(() => {
    if (!expiresAt) return
    const tick = () => {
      const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000))
      setSecondsLeft(left)
      if (left <= 0) {
        setToken(null)
        setExpiresAt(null)
      }
    }
    tick()
    const interval = setInterval(tick, 500)
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
      setToken(res.token)
      setExpiresAt(res.expiresAt)
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
    <div className="min-h-screen bg-emerald-50 p-4">
      <div className="flex items-center gap-3 mb-6">
        <Link href="/merchant" className="text-emerald-700 text-2xl">←</Link>
        <h1 className="text-xl font-bold text-emerald-800">Transaccion sin factura</h1>
      </div>

      {!token ? (
        <div className="bg-white rounded-2xl p-6 shadow-sm space-y-4">
          <div>
            <label className="text-sm text-slate-600">Monto de la transaccion</label>
            <input
              type="number"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              placeholder="Ej: 500.00"
              className="w-full mt-1 px-4 py-3 rounded-xl border border-slate-200 text-lg font-semibold"
              autoFocus
              min="0"
              step="0.01"
            />
            <p className="text-xs text-slate-400 mt-1">
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
            className="w-full bg-emerald-600 text-white py-3 rounded-xl font-medium disabled:opacity-50"
          >
            {generating ? 'Generando...' : 'Generar QR'}
          </button>
        </div>
      ) : (
        <div className="bg-white rounded-2xl p-6 shadow-sm text-center space-y-4">
          <p className="text-sm text-slate-500">Muestra este codigo al cliente</p>
          <p className="text-3xl font-bold text-emerald-700">Bs {parseFloat(amount).toLocaleString()}</p>
          <div className="bg-white border-4 border-emerald-200 rounded-2xl p-4 inline-block">
            {/* Render the token as a QR */}
            <img
              src={`https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(token)}`}
              alt="QR"
              className="w-60 h-60"
            />
          </div>
          <div>
            <p className="text-2xl font-bold text-emerald-700">{secondsLeft}s</p>
            <p className="text-xs text-slate-400">Tiempo restante</p>
          </div>
          <button onClick={reset} className="text-sm text-slate-500 underline">Cancelar y crear otro</button>
        </div>
      )}
    </div>
  )
}
