'use client'

import { useState, useEffect } from 'react'
import { MdArrowBack, MdContentCopy, MdShare, MdPeople, MdCheckCircle } from 'react-icons/md'
import { api } from '@/lib/api'
import { formatPoints } from '@/lib/format'
import { consumerHomeUrl } from '@/lib/consumer-nav'

interface ReferralQr {
  referralSlug: string
  deepLink: string
  qrPngBase64: string
  bonusAmount: number
  tenantName: string
}

interface ReferralStats {
  count: number
  pending: number
  credited: number
  totalEarned: string
}

export default function InvitePage() {
  const [qr, setQr] = useState<ReferralQr | null>(null)
  const [stats, setStats] = useState<ReferralStats | null>(null)
  const [error, setError] = useState<string>('')
  const [copied, setCopied] = useState(false)
  const [unitLabel, setUnitLabel] = useState('pts')

  useEffect(() => {
    (async () => {
      try {
        const [qrRes, statsRes, account] = await Promise.all([
          api.getReferralQr(),
          api.getReferrals(),
          api.getAccount().catch(() => null),
        ])
        setQr(qrRes as any)
        setStats(statsRes as any)
        // Account doesn't directly return unitLabel, fetch balance for it
        try {
          const bal: any = await api.getBalance()
          if (bal?.unitLabel) setUnitLabel(bal.unitLabel)
        } catch {}
      } catch (e: any) {
        if (e?.status === 409 && e?.requiresMerchantSelection) {
          setError('Selecciona un comercio primero para invitar amigos.')
        } else if (e?.status === 403 && e?.referralBonusActive === false) {
          // Eric 2026-05-04: tenant turned off the referral bonus.
          // Friendly message instead of a redirect.
          setError(e?.error || 'El programa de referidos esta pausado por el comercio.')
        } else if (e?.status === 401) {
          window.location.href = '/'
        } else {
          setError('No pudimos cargar tu QR de referidos. Intenta de nuevo.')
        }
      }
    })()
  }, [])

  async function copyLink() {
    if (!qr?.deepLink) return
    try {
      await navigator.clipboard.writeText(qr.deepLink)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = qr.deepLink
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  async function share() {
    if (!qr?.deepLink) return
    const shareData = {
      title: `Te invito a ${qr.tenantName} en Valee`,
      text: `Gana puntos en ${qr.tenantName} cada vez que compras. Unete con mi link:`,
      url: qr.deepLink,
    }
    if (typeof navigator !== 'undefined' && 'share' in navigator) {
      try { await (navigator as any).share(shareData) } catch {}
    } else {
      copyLink()
    }
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center gap-3">
          <a href={consumerHomeUrl()} className="text-slate-600 hover:text-indigo-600 transition-transform hover:-translate-x-0.5">
            <MdArrowBack className="w-6 h-6" />
          </a>
          <h1 className="text-lg font-bold text-slate-800 tracking-tight">Invita amigos</h1>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-6 space-y-5">
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700">
            {error}
          </div>
        )}

        {qr && (
          <>
            <section className="bg-gradient-to-br from-indigo-600 via-indigo-700 to-indigo-900 rounded-3xl p-6 text-white text-center overflow-hidden relative"
              style={{ boxShadow: '0 1px 2px rgba(15,23,42,0.08), 0 20px 40px -16px rgba(79,70,229,0.35)' }}>
              <div className="pointer-events-none absolute -top-16 -right-16 w-56 h-56 bg-white/10 rounded-full blur-3xl" />
              <div className="relative">
                <p className="text-[10px] uppercase tracking-[0.14em] text-indigo-200 font-semibold mb-2">Bonus por referido</p>
                <p className="text-[52px] font-bold leading-none tabular-nums">{formatPoints(qr.bonusAmount)}</p>
                <p className="text-indigo-200 text-sm mt-2">{unitLabel} cuando tu amigo haga su primera factura en {qr.tenantName}</p>
              </div>
            </section>

            <section className="bg-white rounded-3xl border border-slate-200 p-6 flex flex-col items-center">
              <img
                src={`data:image/png;base64,${qr.qrPngBase64}`}
                alt="Tu codigo QR de referidos"
                className="w-64 h-64 rounded-2xl"
              />
              <p className="text-sm text-slate-500 mt-4 text-center">
                Tu amigo escanea este QR y le manda mensaje a nuestro WhatsApp. Cuando haga su primera factura, ganas tu bonus.
              </p>
            </section>

            <section className="grid grid-cols-2 gap-3">
              <button
                onClick={share}
                className="aa-btn aa-btn-primary bg-indigo-600 text-white rounded-2xl py-4 font-semibold flex items-center justify-center gap-2 hover:bg-indigo-700"
              >
                <MdShare className="w-5 h-5 relative z-10" />
                <span className="relative z-10">Compartir</span>
              </button>
              <button
                onClick={copyLink}
                className="aa-btn bg-white border border-slate-200 text-slate-700 rounded-2xl py-4 font-semibold flex items-center justify-center gap-2 hover:bg-slate-50"
              >
                <MdContentCopy className="w-5 h-5" />
                {copied ? 'Copiado!' : 'Copiar link'}
              </button>
            </section>

            {stats && (
              <section className="bg-white rounded-3xl border border-slate-200 p-5">
                <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wider mb-4">Tus referidos</h2>
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="p-3 bg-slate-50 rounded-2xl">
                    <p className="text-2xl font-bold text-slate-900 tabular-nums">{stats.count}</p>
                    <p className="text-[11px] text-slate-500 font-semibold uppercase tracking-wide mt-1">Total</p>
                  </div>
                  <div className="p-3 bg-amber-50 rounded-2xl">
                    <p className="text-2xl font-bold text-amber-700 tabular-nums">{stats.pending}</p>
                    <p className="text-[11px] text-amber-700 font-semibold uppercase tracking-wide mt-1">Pendientes</p>
                  </div>
                  <div className="p-3 bg-emerald-50 rounded-2xl">
                    <p className="text-2xl font-bold text-emerald-700 tabular-nums">{stats.credited}</p>
                    <p className="text-[11px] text-emerald-700 font-semibold uppercase tracking-wide mt-1">Completados</p>
                  </div>
                </div>
                {Number(stats.totalEarned) > 0 && (
                  <div className="mt-4 flex items-center justify-between bg-indigo-50 rounded-2xl px-4 py-3">
                    <div className="flex items-center gap-2">
                      <MdCheckCircle className="w-5 h-5 text-indigo-600" />
                      <span className="text-sm text-slate-700">Has ganado</span>
                    </div>
                    <span className="text-lg font-bold text-indigo-700 tabular-nums">
                      {formatPoints(stats.totalEarned)} {unitLabel}
                    </span>
                  </div>
                )}
              </section>
            )}

            <section className="bg-white rounded-3xl border border-slate-200 p-5">
              <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wider mb-3">Como funciona</h2>
              <ol className="space-y-3 text-sm text-slate-600">
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 bg-indigo-100 text-indigo-700 rounded-full flex items-center justify-center font-bold text-xs">1</span>
                  <span className="pt-0.5">Comparte tu QR o tu link con un amigo.</span>
                </li>
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 bg-indigo-100 text-indigo-700 rounded-full flex items-center justify-center font-bold text-xs">2</span>
                  <span className="pt-0.5">Tu amigo lo usa para entrar a {qr.tenantName} y hacer su primera compra.</span>
                </li>
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 bg-indigo-100 text-indigo-700 rounded-full flex items-center justify-center font-bold text-xs">3</span>
                  <span className="pt-0.5">Automaticamente recibes tu bonus de {formatPoints(qr.bonusAmount)} {unitLabel}.</span>
                </li>
              </ol>
            </section>
          </>
        )}
      </main>
    </div>
  )
}
