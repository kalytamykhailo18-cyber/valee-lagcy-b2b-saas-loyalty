'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { MdArrowBack, MdRefresh, MdWarning, MdPendingActions, MdLocalOffer } from 'react-icons/md'
import { api } from '@/lib/api'

interface HealthResponse {
  windowHours: number
  since: string
  activeTenants: number
  platform: {
    total: number
    claimed: number
    rejected: number
    pending: number
    manualReview: number
    rejectionRate: number
  }
  backlog: {
    pendingValidation: number
    manualReview: number
  }
  redemption: {
    confirmed: number
    expired: number
    pending: number
  }
  topRejectionReasons: Array<{ reason: string; count: number }>
  tenants: Array<{
    tenantId: string
    tenantName: string
    total: number
    claimed: number
    rejected: number
    pending: number
    manualReview: number
    rejectionRate: number
  }>
  atRiskTenants: Array<{
    tenantId: string
    tenantName: string
    rejectionRate: number
    rejected: number
    total: number
  }>
}

const WINDOW_OPTIONS = [
  { label: 'Ultima 1h',   value: 1 },
  { label: 'Ultimas 24h', value: 24 },
  { label: 'Ultimos 7d',  value: 168 },
  { label: 'Ultimos 30d', value: 720 },
]

export default function PlatformHealthPage() {
  const router = useRouter()
  const [data, setData] = useState<HealthResponse | null>(null)
  const [windowHours, setWindowHours] = useState(24)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async (hours: number) => {
    setLoading(true)
    setError('')
    try {
      const d = await api.getPlatformHealth(hours) as HealthResponse
      setData(d)
    } catch (e: any) {
      if (e?.status === 401 || e?.status === 403) { router.push('/admin/login'); return }
      setError(e?.error || 'No se pudo cargar la informacion')
    } finally {
      setLoading(false)
    }
  }, [router])

  useEffect(() => {
    const token = localStorage.getItem('adminAccessToken') || localStorage.getItem('adminToken') || localStorage.getItem('accessToken')
    if (!token) { router.push('/admin/login'); return }
    load(windowHours)
  }, [load, windowHours, router])

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="px-4 sm:px-6 lg:px-8 pt-6 lg:pt-8 pb-4">
        <div className="flex items-center gap-3 mb-2">
          <Link href="/admin" className="text-slate-500 hover:text-slate-700">
            <MdArrowBack className="w-5 h-5" />
          </Link>
          <h1 className="text-2xl lg:text-3xl font-bold text-slate-800 tracking-tight">Salud de la plataforma</h1>
        </div>
        <p className="text-sm text-slate-500">Estado de las facturas y canjes en tiempo real, por comercio.</p>
      </div>

      <div className="px-4 sm:px-6 lg:px-8 pb-16 space-y-6">
        {/* Window + refresh */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex bg-white rounded-xl p-1 shadow-sm border border-slate-200">
            {WINDOW_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => setWindowHours(opt.value)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                  windowHours === opt.value
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <button
            onClick={() => load(windowHours)}
            className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:text-indigo-700"
            disabled={loading}
          >
            <MdRefresh className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Actualizar
          </button>
        </div>

        {error && (
          <div className="aa-pop bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">{error}</div>
        )}

        {loading && !data && (
          <div className="flex items-center justify-center py-16">
            <div className="w-10 h-10 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {data && (
          <>
            {/* Platform KPIs */}
            <section>
              <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wide mb-3 px-1">Plataforma</h2>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <KPI label="Facturas en ventana" value={data.platform.total.toLocaleString()} tone="slate" />
                <KPI label="Acreditadas" value={data.platform.claimed.toLocaleString()} tone="emerald" />
                <KPI label="Rechazadas" value={data.platform.rejected.toLocaleString()} tone="red" />
                <KPI
                  label="Tasa de rechazo"
                  value={`${(data.platform.rejectionRate * 100).toFixed(1)}%`}
                  tone={data.platform.rejectionRate >= 0.2 ? 'red' : data.platform.rejectionRate >= 0.05 ? 'amber' : 'emerald'}
                />
              </div>
            </section>

            {/* Backlog + redemption */}
            <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100">
                <div className="flex items-center gap-2 mb-3">
                  <MdPendingActions className="w-5 h-5 text-amber-600" />
                  <h3 className="font-semibold text-slate-800">Backlog actual</h3>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <KPI label="En verificacion" value={data.backlog.pendingValidation.toLocaleString()} tone="amber" compact />
                  <KPI label="Revision manual" value={data.backlog.manualReview.toLocaleString()} tone="indigo" compact />
                </div>
              </div>
              <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100">
                <div className="flex items-center gap-2 mb-3">
                  <MdLocalOffer className="w-5 h-5 text-emerald-600" />
                  <h3 className="font-semibold text-slate-800">Canjes en ventana</h3>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <KPI label="Confirmados" value={data.redemption.confirmed.toLocaleString()} tone="emerald" compact />
                  <KPI label="Pendientes" value={data.redemption.pending.toLocaleString()} tone="amber" compact />
                  <KPI label="Expirados" value={data.redemption.expired.toLocaleString()} tone="red" compact />
                </div>
              </div>
            </section>

            {/* At-risk tenants */}
            {data.atRiskTenants.length > 0 && (
              <section>
                <div className="flex items-center gap-2 mb-3 px-1">
                  <MdWarning className="w-5 h-5 text-red-600" />
                  <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wide">Comercios en riesgo</h2>
                </div>
                <div className="bg-white rounded-2xl shadow-sm border border-red-200 overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-red-50 text-red-900">
                      <tr>
                        <th className="text-left px-4 py-2 font-semibold">Comercio</th>
                        <th className="text-right px-4 py-2 font-semibold">Rechazadas</th>
                        <th className="text-right px-4 py-2 font-semibold">Total</th>
                        <th className="text-right px-4 py-2 font-semibold">Tasa</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.atRiskTenants.map(t => (
                        <tr key={t.tenantId} className="border-t border-slate-100">
                          <td className="px-4 py-2 font-medium text-slate-800">{t.tenantName}</td>
                          <td className="px-4 py-2 text-right tabular-nums">{t.rejected.toLocaleString()}</td>
                          <td className="px-4 py-2 text-right tabular-nums">{t.total.toLocaleString()}</td>
                          <td className="px-4 py-2 text-right tabular-nums font-bold text-red-700">
                            {(t.rejectionRate * 100).toFixed(1)}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {/* Top rejection reasons */}
            {data.topRejectionReasons.length > 0 && (
              <section>
                <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wide mb-3 px-1">Razones de rechazo</h2>
                <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-slate-700">
                      <tr>
                        <th className="text-left px-4 py-2 font-semibold">Motivo</th>
                        <th className="text-right px-4 py-2 font-semibold">Cantidad</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.topRejectionReasons.map((r, i) => (
                        <tr key={i} className="border-t border-slate-100">
                          <td className="px-4 py-2 text-slate-700">{r.reason}</td>
                          <td className="px-4 py-2 text-right tabular-nums font-semibold">{r.count.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {/* Per-tenant breakdown */}
            <section>
              <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wide mb-3 px-1">
                Desglose por comercio ({data.activeTenants})
              </h2>
              <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-slate-700">
                    <tr>
                      <th className="text-left px-4 py-2 font-semibold">Comercio</th>
                      <th className="text-right px-4 py-2 font-semibold">Total</th>
                      <th className="text-right px-4 py-2 font-semibold">OK</th>
                      <th className="text-right px-4 py-2 font-semibold">Rech.</th>
                      <th className="text-right px-4 py-2 font-semibold">Pend.</th>
                      <th className="text-right px-4 py-2 font-semibold">Rev.</th>
                      <th className="text-right px-4 py-2 font-semibold">Tasa rechazo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.tenants.map(t => {
                      const rateColor = t.rejectionRate >= 0.2 ? 'text-red-700' :
                                        t.rejectionRate >= 0.05 ? 'text-amber-700' : 'text-slate-600'
                      return (
                        <tr key={t.tenantId} className="border-t border-slate-100 hover:bg-slate-50">
                          <td className="px-4 py-2 font-medium text-slate-800">{t.tenantName}</td>
                          <td className="px-4 py-2 text-right tabular-nums">{t.total.toLocaleString()}</td>
                          <td className="px-4 py-2 text-right tabular-nums text-emerald-700">{t.claimed.toLocaleString()}</td>
                          <td className="px-4 py-2 text-right tabular-nums text-red-700">{t.rejected.toLocaleString()}</td>
                          <td className="px-4 py-2 text-right tabular-nums text-amber-700">{t.pending.toLocaleString()}</td>
                          <td className="px-4 py-2 text-right tabular-nums text-indigo-700">{t.manualReview.toLocaleString()}</td>
                          <td className={`px-4 py-2 text-right tabular-nums font-semibold ${rateColor}`}>
                            {(t.rejectionRate * 100).toFixed(1)}%
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  )
}

function KPI({ label, value, tone, compact }: {
  label: string; value: string; tone: 'slate' | 'emerald' | 'red' | 'amber' | 'indigo'; compact?: boolean
}) {
  const color = {
    slate: 'text-slate-800',
    emerald: 'text-emerald-700',
    red: 'text-red-700',
    amber: 'text-amber-700',
    indigo: 'text-indigo-700',
  }[tone]
  return (
    <div className="bg-white rounded-xl p-3 lg:p-4 shadow-sm border border-slate-100">
      <p className="text-[10px] text-slate-500 font-semibold uppercase tracking-wide">{label}</p>
      <p className={`${compact ? 'text-xl' : 'text-2xl lg:text-3xl'} font-bold mt-1 tabular-nums truncate ${color}`}>{value}</p>
    </div>
  )
}
