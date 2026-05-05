'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { api } from '@/lib/api'
import { MdArrowBack, MdChevronRight } from 'react-icons/md'
import { formatPoints } from '@/lib/format'
import { consumerHomeUrl } from '@/lib/consumer-nav'
import { clearTokens } from '@/lib/token-store'

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
  const [account, setAccount] = useState<any>(null)
  const phoneNumber = account?.phoneNumber || ''

  useEffect(() => {
    load()
    const interval = setInterval(load, 30000) // refresh every 30s to update time remaining
    return () => clearInterval(interval)
  }, [])

  async function load() {
    try {
      const [redemptionsData, accountData] = await Promise.allSettled([
        api.getActiveRedemptions(),
        api.getAccount(),
      ])
      if (redemptionsData.status === 'fulfilled') {
        setRedemptions(redemptionsData.value.redemptions || [])
      }
      if (accountData.status === 'fulfilled') {
        setAccount(accountData.value)
      }
    } catch {} finally {
      setLoading(false)
    }
  }

  async function logout() {
    try { await fetch('/api/consumer/auth/logout', { method: 'POST', credentials: 'include' }) } catch {}
    clearTokens('consumer')
    window.location.href = '/'
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
      {/*Header*/}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10 ">
                <div className="max-w-[90%] mx-auto px-3 sm:px-6 lg:px-8 py-3 sm:py-4 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                        <Link href="/" className="inline-block text-xl sm:text-2xl font-extrabold tracking-tight text-indigo-700 hover:text-indigo-800 transition-colors">Valee</Link>
                        {phoneNumber && (
                            <div className="mt-1 flex items-center gap-2 flex-wrap">
                                <span className="inline-flex items-center gap-1.5 bg-indigo-50 border border-indigo-200 text-indigo-800 text-[11px] sm:text-xs font-mono font-semibold px-2 py-0.5 rounded-full">
                                    {phoneNumber}
                                </span>
                                {/*<button onClick={logout} className="text-[11px] sm:text-xs text-slate-500 hover:text-indigo-700 underline underline-offset-2">
                                    No soy yo
                                </button>*/}
                            </div>
                        )}
                    </div>
                    <button onClick={logout} className="text-xs sm:text-sm font-medium text-slate-500 hover:text-indigo-700 hover:underline underline-offset-4 transition-colors whitespace-nowrap flex-shrink-0">Cerrar sesion</button>
                </div>
                {/* Header: back to hub + merchant label + logout
                "Mis comercios" goes back to the multi-merchant hub at /consumer
                without dropping the session (that's what "Salir" is for). */}
                <div className="bg-white border-t border-slate-100 px-4 py-3 gap-3">
                    <div className="max-w-[90%] mx-auto flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <Link
                                href="/consumer"
                                className="flex items-center gap-1.5 text-xs font-semibold text-indigo-600 hover:text-indigo-800 transition-colors whitespace-nowrap"
                            >
                                <MdChevronRight className="w-4 h-4 rotate-180" />
                                Mis comercios
                            </Link>
                            {account?.merchantName && (
                                <>
                                    <span className="text-slate-300">|</span>
                                    <MdChevronRight className="w-4 h-4 rotate-180 text-indigo-600" />
                                    {/* <span className="text-sm font-semibold text-slate-600 truncate">{account.merchantName}</span> */}
                                    <a href={consumerHomeUrl()} className="text-xs font-semibold text-indigo-600 text-2xl transition-transform hover:-translate-x-0.5">{account.merchantName}</a>
                                </>
                            )}
                        </div>
                        <button onClick={logout} className="lg:hidden text-xs font-medium text-slate-400 hover:text-slate-600 transition whitespace-nowrap">Salir</button>
                    </div>
                </div>
            </header>

      <div className="max-w-2xl mx-auto py-10 space-y-3">

                <h1 className="font-extrabold px-5">Estos son tu codigos activos en <span className="text-indigo-600">{account.merchantName}</span></h1>
                <p className="text-sm text-slate-500 px-5">
                    Todos los codigos tienen un tiempo de expiracion.
                </p>

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
  const [askCancel, setAskCancel] = useState(false)
  const [cancelling, setCancelling] = useState(false)

  async function doCancel() {
    setCancelling(true)
    try {
      await api.cancelRedemption(redemption.id)
      onBack()
    } catch (e: any) {
      alert(e?.error || 'No se pudo cancelar el canje')
    } finally {
      setCancelling(false)
      setAskCancel(false)
    }
  }

  useEffect(() => {
    // Encode only the tokenId (36-char uuid) instead of the full signed
    // payload. That drops the QR from version ~15 to ~3, producing modules
    // 3-4x larger — dramatically easier for the cashier camera to lock
    // onto on the first frame. The backend already accepts a bare uuid.
    const qrValue = redemption.id || redemption.token
    import('qrcode').then(QRCode => {
      QRCode.toDataURL(qrValue, { width: 320, margin: 2, errorCorrectionLevel: 'Q' })
        .then(url => setQrUrl(url))
        .catch(() => {})
    })
  }, [redemption.id, redemption.token])

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
            <p className="text-xs text-indigo-500 mt-1">Si el escáner no funciona, dicta estos números al cajero.</p>
          </div>
        )}
        <p className="text-center text-sm text-slate-500 mt-4">Presenta este código al personal del comercio.</p>
        <p key={secondsLeft} className="text-center text-lg font-bold text-indigo-600 mt-2 aa-count tabular-nums">
          Expira en {formatTime(secondsLeft)}
        </p>
        <button
          onClick={() => setAskCancel(true)}
          className="w-full mt-6 py-3 rounded-xl border border-rose-200 text-rose-600 text-sm font-semibold hover:bg-rose-50 transition"
        >
          Cancelar canje y recuperar puntos
        </button>
      </div>
      {askCancel && (
        <div className="fixed inset-0 bg-slate-900/60 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl p-6 max-w-sm w-full space-y-4">
            <h3 className="text-lg font-bold text-slate-800">Cancelar canje</h3>
            <p className="text-sm text-slate-600">
              Tus <span className="font-semibold">{formatPoints(redemption.amount)} pts</span> vuelven a tu saldo al instante. Esta accion no se puede deshacer.
            </p>
            <div className="flex gap-2">
              <button
                disabled={cancelling}
                onClick={() => setAskCancel(false)}
                className="flex-1 py-3 rounded-xl bg-slate-100 text-slate-700 font-semibold disabled:opacity-50"
              >
                No, volver
              </button>
              <button
                disabled={cancelling}
                onClick={doCancel}
                className="flex-1 py-3 rounded-xl bg-rose-600 text-white font-semibold disabled:opacity-50"
              >
                {cancelling ? 'Cancelando...' : 'Si, cancelar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
