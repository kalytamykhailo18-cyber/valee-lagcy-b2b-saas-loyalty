'use client'

import { useState, useEffect, useMemo } from 'react'
import { MdSearch } from 'react-icons/md'
import { api } from '@/lib/api'

export default function TenantManagement() {
  const [tenants, setTenants] = useState<any[]>([])
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState({ name: '', slug: '', ownerEmail: '', ownerName: '', ownerPassword: '' })
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState('')
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'active' | 'inactive' | 'all'>('active')

  useEffect(() => { loadTenants() }, [])

  async function loadTenants() {
    try { setTenants((await api.getTenants()).tenants) } catch {}
  }

  // Filter client-side: at ~50 tenants this is instant and avoids a server
  // round-trip on every keystroke. If the tenant count ever gets large we'll
  // move the filter server-side.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return tenants.filter(t => {
      if (statusFilter !== 'all' && t.status !== statusFilter) return false
      if (!q) return true
      return (
        (t.name || '').toLowerCase().includes(q) ||
        (t.slug || '').toLowerCase().includes(q) ||
        (t.ownerEmail || '').toLowerCase().includes(q) ||
        (t.rif || '').toLowerCase().includes(q)
      )
    })
  }, [tenants, query, statusFilter])

  async function handleCreate() {
    setLoading(true); setMsg('')
    try {
      await api.createTenant(form)
      setShowCreate(false)
      setForm({ name: '', slug: '', ownerEmail: '', ownerName: '', ownerPassword: '' })
      setMsg('Comercio creado exitosamente')
      loadTenants()
    } catch (e: any) { setMsg(e.error || 'Error') }
    setLoading(false)
  }

  async function handleDeactivate(id: string) {
    // Suspension now requires a mandatory reason (min 5 chars) for the audit
    // trail and the force-logout of all staff that happens server-side.
    const reason = window.prompt('Motivo para desactivar el comercio (minimo 5 caracteres):', '')
    if (!reason || reason.trim().length < 5) {
      if (reason !== null) alert('El motivo debe tener al menos 5 caracteres.')
      return
    }
    try {
      await api.deactivateTenant(id, reason.trim())
      loadTenants()
    } catch (e: any) {
      alert(e?.error || 'No se pudo desactivar el comercio')
    }
  }

  async function handleReactivate(id: string) {
    const reason = window.prompt('Motivo para reactivar el comercio (minimo 5 caracteres):', '')
    if (!reason || reason.trim().length < 5) {
      if (reason !== null) alert('El motivo debe tener al menos 5 caracteres.')
      return
    }
    try {
      await api.reactivateTenant(id, reason.trim())
      loadTenants()
    } catch (e: any) {
      alert(e?.error || 'No se pudo reactivar el comercio')
    }
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Page header */}
      <div className="px-4 sm:px-6 lg:px-8 pt-6 lg:pt-8 pb-4 aa-rise">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl lg:text-3xl font-bold text-slate-800 tracking-tight">Gestion de comercios</h1>
            <p className="text-sm text-slate-500 mt-1">Crea y administra los comercios de la plataforma</p>
          </div>
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="aa-btn aa-btn-primary bg-indigo-600 text-white px-5 py-2.5 rounded-xl text-sm font-semibold hover:bg-indigo-700"
          >
            <span className="relative z-10">{showCreate ? 'Cancelar' : '+ Nuevo comercio'}</span>
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="px-4 sm:px-6 lg:px-8 pb-8">
        {msg && (
          <div className={`aa-pop mb-4 p-3 rounded-xl text-sm border ${
            msg.includes('Error')
              ? 'bg-red-50 text-red-700 border-red-200'
              : 'bg-emerald-50 text-emerald-700 border-emerald-200'
          }`}>
            {msg}
          </div>
        )}

        {/* Create form */}
        {showCreate && (
          <div className="aa-rise bg-white rounded-2xl p-5 lg:p-6 shadow-sm border border-slate-100 mb-6 space-y-4 max-w-2xl">
            <h2 className="text-lg font-semibold text-slate-800">Nuevo comercio</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Nombre del negocio</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  className="aa-field w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Slug (URL)</label>
                <input
                  type="text"
                  placeholder="mi-comercio"
                  value={form.slug}
                  onChange={e => setForm({ ...form, slug: e.target.value })}
                  className="aa-field w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm"
                />
              </div>
            </div>
            <div>
              <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Email del dueño</label>
              <input
                type="email"
                value={form.ownerEmail}
                onChange={e => setForm({ ...form, ownerEmail: e.target.value })}
                className="aa-field w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm"
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Nombre del dueño</label>
                <input
                  type="text"
                  value={form.ownerName}
                  onChange={e => setForm({ ...form, ownerName: e.target.value })}
                  className="aa-field w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Password temporal</label>
                <input
                  type="password"
                  value={form.ownerPassword}
                  onChange={e => setForm({ ...form, ownerPassword: e.target.value })}
                  className="aa-field w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm"
                />
              </div>
            </div>
            <button
              onClick={handleCreate}
              disabled={loading}
              className="aa-btn aa-btn-primary w-full bg-indigo-600 text-white py-3 rounded-xl text-sm font-semibold disabled:opacity-50 hover:bg-indigo-700 flex items-center justify-center"
            >
              {loading && <span className="aa-spinner" />}<span className="relative z-10">{loading ? 'Creando...' : 'Crear comercio'}</span>
            </button>
          </div>
        )}

        {/* Search bar — filters the grid by name, slug, email, or RIF. At
            this tenant count (hundreds max) client-side filter is instant
            and avoids a server round-trip per keystroke. */}
        {tenants.length > 0 && (
          <div className="mb-4 flex items-center gap-3 flex-wrap">
            <div className="relative flex-1 max-w-md">
              <MdSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5" />
              <input
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Buscar por nombre, slug, email o RIF..."
                className="aa-field aa-field-indigo w-full pl-10 pr-4 py-2.5 rounded-xl border border-slate-200 text-sm"
              />
            </div>
            {/* Status filter — defaults to 'active' so the list is clean by
                default and test/inactive tenants only appear when explicitly
                requested. */}
            <div className="flex bg-white rounded-xl p-1 shadow-sm border border-slate-200">
              {(['active', 'inactive', 'all'] as const).map(opt => (
                <button
                  key={opt}
                  onClick={() => setStatusFilter(opt)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                    statusFilter === opt ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  {opt === 'active' ? 'Activos' : opt === 'inactive' ? 'Inactivos' : 'Todos'}
                </button>
              ))}
            </div>
            <span className="text-xs text-slate-500">
              {filtered.length === tenants.length
                ? `${tenants.length} comercios`
                : `${filtered.length} de ${tenants.length}`}
            </span>
          </div>
        )}

        {/* Tenants grid */}
        {tenants.length === 0 ? (
          <div className="bg-white rounded-2xl p-12 text-center border border-slate-100 aa-rise">
            <p className="text-slate-400">No hay comercios registrados todavia</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="bg-white rounded-2xl p-12 text-center border border-slate-100 aa-rise">
            <p className="text-slate-400">Sin resultados para {query}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map((t, i) => (
              <div
                key={t.id}
                className="aa-card aa-row-in bg-white rounded-2xl p-5 shadow-sm border border-slate-100"
                style={{ animationDelay: `${Math.min(i * 40, 360)}ms` }}
              >
                <div className="flex items-start gap-3 mb-3">
                  {/* Logo — falls back to first-letter tile when the tenant
                      hasn't uploaded one yet, so the grid reads consistently. */}
                  {t.logoUrl ? (
                    <img
                      src={t.logoUrl}
                      alt={t.name}
                      className="w-12 h-12 rounded-xl object-cover border border-slate-200 flex-shrink-0"
                    />
                  ) : (
                    <div className="w-12 h-12 rounded-xl bg-indigo-100 text-indigo-700 flex items-center justify-center font-bold text-lg flex-shrink-0">
                      {(t.name || '?').charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-slate-800 text-lg truncate">{t.name}</p>
                    <p className="text-xs text-slate-500 mt-0.5 truncate">{t.slug}</p>
                  </div>
                  <span className={`flex-shrink-0 text-xs px-3 py-1 rounded-full font-semibold ${
                    t.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                  }`}>
                    {t.status}
                  </span>
                </div>
                <p className="text-sm text-slate-600 truncate">{t.ownerEmail}</p>
                {t.rif && <p className="text-xs text-slate-500 mt-1 font-mono">RIF: {t.rif}</p>}
                <p className="text-xs text-slate-400 mt-1">Creado: {new Date(t.createdAt).toLocaleDateString('es-VE')}</p>
                {t.status === 'active' ? (
                  <button
                    onClick={() => handleDeactivate(t.id)}
                    className="aa-btn w-full mt-4 py-2 text-xs text-red-600 hover:bg-red-50 rounded-lg font-medium"
                  >
                    <span className="relative z-10">Desactivar</span>
                  </button>
                ) : (
                  <button
                    onClick={() => handleReactivate(t.id)}
                    className="aa-btn w-full mt-4 py-2 text-xs text-emerald-700 hover:bg-emerald-50 rounded-lg font-medium border border-emerald-200"
                  >
                    <span className="relative z-10">Reactivar</span>
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
