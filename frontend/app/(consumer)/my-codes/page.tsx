'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { api } from '@/lib/api'
import { MdArrowBack } from 'react-icons/md'
import { formatPoints } from '@/lib/format'

interface ActiveRedemption {
  id: string
  token: string
  shortCode: string | null
  productName: string
  productPhoto: string | null
  amount: string
  cashAmount: string | null
  expiresAt: string
  secondsRemaining: number
  createdAt: string
}

export default function MyCodesPage() {
  const [redemptions, setRedemptions] = useState<ActiveRedemption[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<ActiveRedemption | null>(null)

  useEffect(() => {
    load()
    const interval = setInterval(load, 30000) // refresh every 30s to update time remaining
    return () => clearInterval(interval)
  }, [])

  async function load() {
    try {
      const data = await api.getActiveRedemptions()
      setRedemptions(data.redemptions || [])
    } catch {} finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="w-12 h-12 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (selected) {
    return <QRView redemption={selected} onBack={() => { setSelected(null); load() }} />
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10 aa-rise-sm">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/consumer" className="text-slate-600 hover:text-indigo-600 transition-transform hover:-translate-x-0.5">
            <MdArrowBack className="w-6 h-6" />
          </Link>
          <h1 className="text-lg font-bold text-slate-800 tracking-tight">Mis codigos activos</h1>
        </div>
      </header>

      <div className="max-w-2xl mx-auto p-4 space-y-3">
        {redemptions.length === 0 ? (
          <div className="text-center py-16 aa-rise">
            <p className="text-slate-500">No tienes codigos activos</p>
            <Link href="/catalog" className="aa-btn aa-btn-primary inline-block mt-4 bg-indigo-600 text-white px-6 py-3 rounded-xl font-semibold">
              <span className="relative z-10">Ver catalogo</span>
            </Link>
          </div>
        ) : (
          redemptions.map((r, i) => (
            <button
              key={r.id}
              onClick={() => setSelected(r)}
              className="aa-card aa-row-in w-full bg-white rounded-2xl p-4 shadow-sm border border-slate-100 flex items-center gap-3"
              style={{ animationDelay: `${Math.min(i * 40, 360)}ms` }}
            >
              {r.productPhoto ? (
                <img src={r.productPhoto} alt={r.productName} className="w-16 h-16 rounded-lg object-cover" />
              ) : (
                <div className="w-16 h-16 rounded-lg bg-indigo-100" />
              )}
              <div className="flex-1 text-left">
                <p className="font-semibold text-slate-800">{r.productName}</p>
                <p className="text-sm text-indigo-600">{formatPoints(r.amount)} pts</p>
                <p className="text-xs text-slate-400 mt-1">
                  Expira en {formatTime(r.secondsRemaining)}
                </p>
              </div>
              <div className="text-indigo-600 font-medium text-sm">Ver QR</div>
            </button>
          ))
        )}
      </div>
    </div>
  )
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function QRView({ redemption, onBack }: { redemption: ActiveRedemption; onBack: () => void }) {
  const [qrUrl, setQrUrl] = useState<string | null>(null)
  const [secondsLeft, setSecondsLeft] = useState(redemption.secondsRemaining)
  const [confirmed, setConfirmed] = useState(false)

  useEffect(() => {
    import('qrcode').then(QRCode => {
      QRCode.toDataURL(redemption.token, { width: 320, margin: 2, errorCorrectionLevel: 'M' })
        .then(url => setQrUrl(url))
        .catch(() => {})
    })
  }, [redemption.token])

  useEffect(() => {
    const interval = setInterval(() => {
      const remaining = Math.max(0, Math.floor((new Date(redemption.expiresAt).getTime() - Date.now()) / 1000))
      setSecondsLeft(remaining)
      if (remaining === 0) {
        clearInterval(interval)
        onBack()
      }
    }, 1000)
    return () => clearInterval(interval)
  }, [redemption.expiresAt, onBack])

  // Poll for cashier confirmation so the QR disappears once it's been scanned.
  useEffect(() => {
    let cancelled = false
    const check = async () => {
      try {
        const s = await api.getRedemptionStatus(redemption.id)
        if (!cancelled && s.status === 'used') setConfirmed(true)
      } catch {}
    }
    check()
    const poll = setInterval(check, 3000)
    return () => { cancelled = true; clearInterval(poll) }
  }, [redemption.id])

  if (confirmed) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-emerald-600 text-white p-6">
        <div className="text-center space-y-4 max-w-sm animate-check">
          <div className="text-7xl">✓</div>
          <h2 className="text-3xl font-bold tracking-tight">Canje verificado con exito</h2>
          <p className="text-emerald-100">{redemption.productName} fue entregado por el comercio.</p>
          <button
            onClick={onBack}
            className="aa-btn aa-btn-primary inline-block mt-4 bg-white text-emerald-700 px-8 py-3 rounded-xl font-semibold"
          >
            <span className="relative z-10">Volver</span>
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-white flex flex-col items-center p-4">
      <div className="w-full max-w-sm aa-rise">
        <button onClick={onBack} className="flex items-center gap-2 text-slate-600 hover:text-indigo-600 mb-6 transition-transform hover:-translate-x-0.5">
          <MdArrowBack className="w-5 h-5" /> Volver
        </button>
        <h2 className="text-xl font-bold text-indigo-600 mb-2 text-center tracking-tight">{redemption.productName}</h2>
        <p className="text-sm text-slate-500 text-center mb-6">
          {formatPoints(redemption.amount)} pts
          {redemption.cashAmount && parseFloat(redemption.cashAmount) > 0 && ` + $${redemption.cashAmount}`}
        </p>
        <div className="bg-slate-100 rounded-2xl p-8 flex justify-center animate-qr-build">
          {qrUrl ? (
            <img src={qrUrl} alt="QR de canje" className="w-64 h-64 rounded-lg" />
          ) : (
            <div className="w-64 h-64 flex items-center justify-center">
              <div className="w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
            </div>
          )}
        </div>
        {redemption.shortCode && (
          <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-4 mt-4 text-center">
            <p className="text-xs text-indigo-600 uppercase tracking-wider font-semibold">Codigo manual</p>
            <p className="text-3xl font-bold text-indigo-700 tracking-widest font-mono mt-1">{redemption.shortCode}</p>
            <p className="text-xs text-indigo-500 mt-1">Dile este codigo al cajero si no puede escanear</p>
          </div>
        )}
        <p className="text-center text-sm text-slate-500 mt-4">Muestra este codigo al cajero</p>
        <p key={secondsLeft} className="text-center text-lg font-bold text-indigo-600 mt-2 aa-count tabular-nums">
          Expira en {formatTime(secondsLeft)}
        </p>
      </div>
    </div>
  )
}
