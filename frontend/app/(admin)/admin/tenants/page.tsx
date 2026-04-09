'use client'

import { useState, useEffect } from 'react'
import { api } from '@/lib/api'

export default function TenantManagement() {
  const [tenants, setTenants] = useState<any[]>([])
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState({ name: '', slug: '', ownerEmail: '', ownerName: '', ownerPassword: '' })
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => { loadTenants() }, [])

  async function loadTenants() {
    try { setTenants((await api.getTenants()).tenants) } catch {}
  }

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
    try { await api.deactivateTenant(id); loadTenants() } catch {}
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Page header */}
      <div className="px-4 sm:px-6 lg:px-8 pt-6 lg:pt-8 pb-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl lg:text-3xl font-bold text-slate-800">Gestion de comercios</h1>
            <p className="text-sm text-slate-500 mt-1">Crea y administra los comercios de la plataforma</p>
          </div>
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="bg-indigo-600 text-white px-5 py-2.5 rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm transition"
          >
            {showCreate ? 'Cancelar' : '+ Nuevo comercio'}
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="px-4 sm:px-6 lg:px-8 pb-8">
        {msg && (
          <div className={`mb-4 p-3 rounded-xl text-sm border ${
            msg.includes('Error')
              ? 'bg-red-50 text-red-700 border-red-200'
              : 'bg-emerald-50 text-emerald-700 border-emerald-200'
          }`}>
            {msg}
          </div>
        )}

        {/* Create form */}
        {showCreate && (
          <div className="bg-white rounded-2xl p-5 lg:p-6 shadow-sm border border-slate-100 mb-6 space-y-4 max-w-2xl">
            <h2 className="text-lg font-semibold text-slate-800">Nuevo comercio</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Nombre del negocio</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  className="w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
              <div>
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Slug (URL)</label>
                <input
                  type="text"
                  placeholder="mi-comercio"
                  value={form.slug}
                  onChange={e => setForm({ ...form, slug: e.target.value })}
                  className="w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
            </div>
            <div>
              <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Email del dueño</label>
              <input
                type="email"
                value={form.ownerEmail}
                onChange={e => setForm({ ...form, ownerEmail: e.target.value })}
                className="w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Nombre del dueño</label>
                <input
                  type="text"
                  value={form.ownerName}
                  onChange={e => setForm({ ...form, ownerName: e.target.value })}
                  className="w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
              <div>
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Password temporal</label>
                <input
                  type="password"
                  value={form.ownerPassword}
                  onChange={e => setForm({ ...form, ownerPassword: e.target.value })}
                  className="w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
            </div>
            <button
              onClick={handleCreate}
              disabled={loading}
              className="w-full bg-indigo-600 text-white py-3 rounded-xl text-sm font-semibold disabled:opacity-50 hover:bg-indigo-700 transition"
            >
              {loading ? 'Creando...' : 'Crear comercio'}
            </button>
          </div>
        )}

        {/* Tenants grid */}
        {tenants.length === 0 ? (
          <div className="bg-white rounded-2xl p-12 text-center border border-slate-100">
            <p className="text-slate-400">No hay comercios registrados todavia</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {tenants.map(t => (
              <div
                key={t.id}
                className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100 hover:shadow-md hover:border-indigo-200 transition"
              >
                <div className="flex items-start justify-between gap-3 mb-3">
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
                <p className="text-xs text-slate-400 mt-1">Creado: {new Date(t.createdAt).toLocaleDateString('es-VE')}</p>
                {t.status === 'active' && (
                  <button
                    onClick={() => handleDeactivate(t.id)}
                    className="w-full mt-4 py-2 text-xs text-red-600 hover:bg-red-50 rounded-lg font-medium transition"
                  >
                    Desactivar
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
