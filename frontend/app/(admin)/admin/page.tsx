'use client'

import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { formatPoints } from '@/lib/format'
import { MdTrendingUp, MdTrendingDown, MdWarning } from 'react-icons/md'

interface ExecDashboard {
  activeTenants: number
  totalConsumers: number
  verifiedConsumers: number
  valueIssued: string
  valueRedeemed: string
  valueInCirculation: string
  validationsLast30Days: number
  weeklyTx: Array<{ week: string; count: number; value: string }>
  topMerchants: Array<{
    tenantId: string; tenantName: string; tenantSlug: string;
    transactions: number; valueIssued: string; uniqueConsumers: number;
  }>
  topConsumers: Array<{
    phoneNumber: string; displayName: string | null;
    tenantsCount: number; lifetimeEarned: string;
  }>
  churn: Array<{
    tenantId: string; tenantName: string; tenantSlug: string;
    lastTxAt: string | null; daysIdle: number;
  }>
  idleThresholdDays: number
}

export default function AdminDashboard() {
  const [data, setData] = useState<ExecDashboard | null>(null)
  const [adminName, setAdminName] = useState('')
  const router = useRouter()

  useEffect(() => {
    const name = localStorage.getItem('adminName') || 'Admin'
    const token = localStorage.getItem('adminToken') || localStorage.getItem('accessToken')
    if (!token) { router.push('/admin/login'); return }
    setAdminName(name)
    ;(async () => {
      try {
        const d = await api.getExecDashboard(14, 8) as any
        setData(d)
      } catch (e: any) {
        if (e?.status === 401 || e?.status === 403) router.push('/admin/login')
      }
    })()
  }, [router])

  // Max count in weekly series for simple bar scaling.
  const maxWeekly = data ? Math.max(1, ...data.weeklyTx.map(w => w.count)) : 1

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="px-4 sm:px-6 lg:px-8 pt-6 lg:pt-8 pb-4">
        <h1 className="text-2xl lg:text-3xl font-bold text-slate-800 tracking-tight">Panel ejecutivo</h1>
        <p className="text-sm text-slate-500 mt-1">Bienvenido {adminName}</p>
        {/* Top-level quick links — always rendered (outside the data-loaded
            guard) so operators can navigate even while the dashboard is
            still loading. */}
        <nav className="mt-4 flex flex-wrap gap-2 text-xs font-semibold">
          <Link href="/admin/tenants"     className="px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-700 hover:bg-slate-50">Comercios</Link>
          <Link href="/admin/ledger"      className="px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-700 hover:bg-slate-50">Ledger global</Link>
          <Link href="/admin/adjustments" className="px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-700 hover:bg-slate-50">Ajustes</Link>
          <Link href="/admin/health"      className="px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-700 hover:bg-slate-50">Salud de plataforma</Link>
          <Link href="/admin/sessions"    className="px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-700 hover:bg-slate-50">Sesiones</Link>
        </nav>
      </div>

      <div className="px-4 sm:px-6 lg:px-8 pb-12 space-y-6">
        {!data ? (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4">
            {[0,1,2,3].map(i => (
              <div key={i} className="bg-white rounded-xl p-5 shadow-sm border border-slate-100 space-y-3">
                <div className="aa-skel h-2 w-2/3" />
                <div className="aa-skel h-7 w-1/2" />
              </div>
            ))}
          </div>
        ) : (
          <>
            {/* Top KPIs */}
            <div className="grid grid-cols-2 lg:grid-cols-6 gap-3 lg:gap-4">
              <KPI label="Comercios activos" value={String(data.activeTenants)} color="indigo" />
              <KPI label="Consumidores" value={String(data.totalConsumers)} subtitle={`${data.verifiedConsumers} verificados`} color="indigo" />
              <KPI label="Emitido total" value={formatPoints(data.valueIssued)} color="emerald" />
              <KPI label="Canjeado total" value={formatPoints(data.valueRedeemed)} color="amber" />
              <KPI label="En circulacion" value={formatPoints(data.valueInCirculation)} color="slate" />
              <KPI label="Validaciones 30d" value={String(data.validationsLast30Days)} color="slate" />
            </div>

            {/* Weekly transaction trend */}
            <section className="bg-white rounded-2xl border border-slate-100 shadow-sm">
              <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
                <h2 className="text-sm font-bold text-slate-800 uppercase tracking-wide flex items-center gap-2">
                  <MdTrendingUp className="w-5 h-5 text-indigo-600" />
                  Transacciones por semana
                </h2>
                <p className="text-xs text-slate-500">Ultimas 8 semanas</p>
              </div>
              {data.weeklyTx.length === 0 ? (
                <p className="text-center text-sm text-slate-400 py-8">Sin datos todavia</p>
              ) : (
                <div className="px-5 py-5">
                  <div className="flex items-end gap-2 h-40">
                    {data.weeklyTx.map((w, i) => {
                      const pct = Math.max(4, (w.count / maxWeekly) * 100)
                      return (
                        <div key={i} className="flex-1 flex flex-col items-center gap-1 group">
                          <span className="text-[10px] text-slate-500 tabular-nums group-hover:text-indigo-700">{w.count}</span>
                          <div className="w-full bg-slate-100 rounded-t-lg relative" style={{ height: `${pct}%` }}>
                            <div className="w-full h-full bg-gradient-to-t from-indigo-600 to-indigo-400 rounded-t-lg" />
                          </div>
                          <span className="text-[10px] text-slate-400">{new Date(w.week).toLocaleDateString('es-VE', { month: 'short', day: 'numeric' })}</span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </section>

            {/* Top merchants + top consumers side by side on desktop */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <section className="bg-white rounded-2xl border border-slate-100 shadow-sm">
                <div className="px-5 py-4 border-b border-slate-100">
                  <h2 className="text-sm font-bold text-slate-800 uppercase tracking-wide">Top comercios (30d)</h2>
                </div>
                <div className="divide-y divide-slate-50">
                  {data.topMerchants.length === 0 ? (
                    <p className="text-sm text-slate-400 text-center py-6">Sin datos</p>
                  ) : data.topMerchants.map((m, i) => (
                    <div key={m.tenantId} className="px-5 py-3 flex items-center gap-3">
                      <span className={`w-7 h-7 rounded-full flex items-center justify-center font-bold text-xs flex-shrink-0 ${
                        i === 0 ? 'bg-amber-100 text-amber-700' :
                        i === 1 ? 'bg-slate-100 text-slate-700' :
                        i === 2 ? 'bg-orange-100 text-orange-700' :
                        'bg-slate-50 text-slate-500'
                      }`}>{i + 1}</span>
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-slate-800 text-sm truncate">{m.tenantName}</p>
                        <p className="text-xs text-slate-500">{m.uniqueConsumers} clientes unicos</p>
                      </div>
                      <div className="text-right">
                        <p className="font-bold text-indigo-700 tabular-nums">{m.transactions}</p>
                        <p className="text-[10px] text-slate-500 uppercase">trx</p>
                      </div>
                      <div className="text-right">
                        <p className="font-bold text-emerald-700 tabular-nums">{formatPoints(m.valueIssued)}</p>
                        <p className="text-[10px] text-slate-500 uppercase">pts</p>
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="bg-white rounded-2xl border border-slate-100 shadow-sm">
                <div className="px-5 py-4 border-b border-slate-100">
                  <h2 className="text-sm font-bold text-slate-800 uppercase tracking-wide">Top consumidores (LTV)</h2>
                </div>
                <div className="divide-y divide-slate-50">
                  {data.topConsumers.length === 0 ? (
                    <p className="text-sm text-slate-400 text-center py-6">Sin datos</p>
                  ) : data.topConsumers.map((c, i) => (
                    <div key={c.phoneNumber} className="px-5 py-3 flex items-center gap-3">
                      <span className={`w-7 h-7 rounded-full flex items-center justify-center font-bold text-xs flex-shrink-0 ${
                        i === 0 ? 'bg-amber-100 text-amber-700' :
                        i === 1 ? 'bg-slate-100 text-slate-700' :
                        i === 2 ? 'bg-orange-100 text-orange-700' :
                        'bg-slate-50 text-slate-500'
                      }`}>{i + 1}</span>
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-slate-800 text-sm truncate">{c.displayName || c.phoneNumber}</p>
                        <p className="text-xs text-slate-500">{c.tenantsCount} comercio{c.tenantsCount !== 1 ? 's' : ''}</p>
                      </div>
                      <div className="text-right">
                        <p className="font-bold text-indigo-700 tabular-nums">{formatPoints(c.lifetimeEarned)}</p>
                        <p className="text-[10px] text-slate-500 uppercase">pts LTV</p>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            </div>

            {/* Churn watch */}
            {data.churn.length > 0 && (
              <section className="bg-white rounded-2xl border border-red-100 shadow-sm">
                <div className="px-5 py-4 border-b border-red-100 flex items-center justify-between">
                  <h2 className="text-sm font-bold text-red-800 uppercase tracking-wide flex items-center gap-2">
                    <MdWarning className="w-5 h-5 text-red-600" />
                    Comercios sin actividad (≥ {data.idleThresholdDays}d)
                  </h2>
                  <span className="text-xs font-semibold bg-red-100 text-red-700 px-2 py-1 rounded-full">
                    {data.churn.length}
                  </span>
                </div>
                <div className="divide-y divide-red-50">
                  {data.churn.map(t => (
                    <div key={t.tenantId} className="px-5 py-3 flex items-center justify-between">
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-slate-800 text-sm truncate">{t.tenantName}</p>
                        <p className="text-xs text-slate-500">
                          {t.lastTxAt
                            ? `Ultima transaccion: ${new Date(t.lastTxAt).toLocaleDateString('es-VE')}`
                            : 'Nunca ha tenido transacciones'}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 text-red-700 flex-shrink-0">
                        <MdTrendingDown className="w-4 h-4" />
                        <span className="text-sm font-bold tabular-nums">{t.daysIdle >= 9999 ? '∞' : `${t.daysIdle}d`}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Quick actions */}
            <section>
              <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wide mb-3 px-1">Acciones</h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <Link href="/admin/tenants" className="block bg-white rounded-2xl p-5 shadow-sm border border-slate-100 hover:shadow-md transition">
                  <p className="font-semibold text-slate-800">Gestion de comercios</p>
                  <p className="text-xs text-slate-500 mt-1">Crear, ver y desactivar merchants</p>
                </Link>
                <Link href="/admin/ledger" className="block bg-white rounded-2xl p-5 shadow-sm border border-slate-100 hover:shadow-md transition">
                  <p className="font-semibold text-slate-800">Ledger global</p>
                  <p className="text-xs text-slate-500 mt-1">Auditoria cross-tenant</p>
                </Link>
                <Link href="/admin/adjustments" className="block bg-white rounded-2xl p-5 shadow-sm border border-slate-100 hover:shadow-md transition">
                  <p className="font-semibold text-slate-800">Ajustes manuales</p>
                  <p className="text-xs text-slate-500 mt-1">Correcciones directas al ledger</p>
                </Link>
                <Link href="/admin/health" className="block bg-white rounded-2xl p-5 shadow-sm border border-slate-100 hover:shadow-md transition">
                  <p className="font-semibold text-slate-800">Salud de la plataforma</p>
                  <p className="text-xs text-slate-500 mt-1">Ranking de comercios en riesgo y razones de rechazo</p>
                </Link>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  )
}

function KPI({ label, value, subtitle, color }: { label: string; value: string; subtitle?: string; color: 'indigo' | 'emerald' | 'amber' | 'slate' }) {
  const colorClass = {
    indigo: 'text-indigo-700',
    emerald: 'text-emerald-700',
    amber: 'text-amber-700',
    slate: 'text-slate-800',
  }[color]
  return (
    <div className="bg-white rounded-xl p-4 lg:p-5 shadow-sm border border-slate-100">
      <p className="text-[10px] text-slate-500 font-semibold uppercase tracking-wide">{label}</p>
      <p className={`text-2xl lg:text-3xl font-bold mt-1.5 tabular-nums truncate ${colorClass}`}>{value}</p>
      {subtitle && <p className="text-[11px] text-slate-400 mt-0.5">{subtitle}</p>}
    </div>
  )
}
