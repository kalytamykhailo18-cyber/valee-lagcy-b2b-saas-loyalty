'use client'

import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { formatPoints } from '@/lib/format'

export default function AdminDashboard() {
  const [metrics, setMetrics] = useState<any>(null)
  const [tenants, setTenants] = useState<any[]>([])
  const [adminName, setAdminName] = useState('')
  const router = useRouter()

  useEffect(() => {
    const name = localStorage.getItem('adminName') || 'Admin'
    const token = localStorage.getItem('adminToken') || localStorage.getItem('accessToken')
    if (!token) { router.push('/admin/login'); return }
    setAdminName(name)
    loadData()
  }, [router])

  async function loadData() {
    try {
      const [m, t] = await Promise.all([api.getMetrics(), api.getTenants()])
      setMetrics(m)
      setTenants(t.tenants)
    } catch {
      router.push('/admin/login')
    }
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Page header */}
      <div className="px-4 sm:px-6 lg:px-8 pt-6 lg:pt-8 pb-4 aa-rise">
        <h1 className="text-2xl lg:text-3xl font-bold text-slate-800 tracking-tight">Panel de administracion</h1>
        <p className="text-sm text-slate-500 mt-1">Bienvenido {adminName}</p>
      </div>

      {/* Content */}
      <div className="px-4 sm:px-6 lg:px-8 pb-8 space-y-6">
        {/* Metrics */}
        {metrics ? (
          <div className="aa-stagger grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4">
            <div className="aa-card bg-white rounded-xl p-5 shadow-sm border border-slate-100">
              <p className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Comercios activos</p>
              <p key={metrics.activeTenants} className="text-3xl font-bold text-indigo-700 mt-2 aa-count tabular-nums">{metrics.activeTenants}</p>
            </div>
            <div className="aa-card bg-white rounded-xl p-5 shadow-sm border border-slate-100">
              <p className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Consumidores</p>
              <p key={metrics.totalConsumers} className="text-3xl font-bold text-indigo-700 mt-2 aa-count tabular-nums">{metrics.totalConsumers}</p>
            </div>
            <div className="aa-card bg-white rounded-xl p-5 shadow-sm border border-slate-100">
              <p className="text-xs text-slate-500 font-semibold uppercase tracking-wide">En circulacion</p>
              <p key={metrics.totalValueInCirculation} className="text-3xl font-bold text-emerald-700 mt-2 truncate aa-count tabular-nums">
                {formatPoints(metrics.totalValueInCirculation)}
              </p>
            </div>
            <div className="aa-card bg-white rounded-xl p-5 shadow-sm border border-slate-100">
              <p className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Validaciones 30d</p>
              <p key={metrics.validationsLast30Days} className="text-3xl font-bold text-slate-800 mt-2 aa-count tabular-nums">{metrics.validationsLast30Days}</p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4">
            {[0,1,2,3].map(i => (
              <div key={i} className="bg-white rounded-xl p-5 shadow-sm border border-slate-100 space-y-3">
                <div className="aa-skel h-2 w-2/3" />
                <div className="aa-skel h-7 w-1/2" />
              </div>
            ))}
          </div>
        )}

        {/* Navigation cards */}
        <section className="aa-rise" style={{ animationDelay: '280ms' }}>
          <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide mb-3">Acciones rapidas</h2>
          <div className="aa-stagger grid grid-cols-1 md:grid-cols-3 gap-4">
            <Link
              href="/admin/tenants"
              className="aa-card block bg-white rounded-2xl p-5 shadow-sm border border-slate-100"
            >
              <p className="font-semibold text-slate-800">Gestion de comercios</p>
              <p className="text-xs text-slate-500 mt-1">Crear, ver y desactivar merchants</p>
            </Link>
            <Link
              href="/admin/ledger"
              className="aa-card block bg-white rounded-2xl p-5 shadow-sm border border-slate-100"
            >
              <p className="font-semibold text-slate-800">Ledger global</p>
              <p className="text-xs text-slate-500 mt-1">Auditoria de transacciones cross-tenant</p>
            </Link>
            <Link
              href="/admin/adjustments"
              className="aa-card block bg-white rounded-2xl p-5 shadow-sm border border-slate-100"
            >
              <p className="font-semibold text-slate-800">Ajustes manuales</p>
              <p className="text-xs text-slate-500 mt-1">Correcciones directas al ledger</p>
            </Link>
          </div>
        </section>

        {/* Tenants list */}
        <section className="aa-rise" style={{ animationDelay: '380ms' }}>
          <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide mb-3">
            Comercios (<span key={tenants.length} className="aa-count tabular-nums inline-block">{tenants.length}</span>)
          </h2>
          {tenants.length === 0 ? (
            <div className="bg-white rounded-2xl p-8 text-center border border-slate-100">
              <p className="text-slate-400">No hay comercios registrados todavia</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {tenants.map((t, i) => (
                <div
                  key={t.id}
                  className="aa-card aa-row-in bg-white rounded-2xl p-5 shadow-sm border border-slate-100"
                  style={{ animationDelay: `${Math.min(i * 40, 360)}ms` }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-slate-800 truncate">{t.name}</p>
                      <p className="text-xs text-slate-500 mt-0.5 truncate">{t.slug}</p>
                      <p className="text-xs text-slate-500 mt-1 truncate">{t.ownerEmail}</p>
                    </div>
                    <span className={`flex-shrink-0 text-xs px-3 py-1 rounded-full font-semibold ${
                      t.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                    }`}>
                      {t.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
