'use client'

import { useState, useEffect } from 'react'
import { MdStorefront } from 'react-icons/md'
import { api } from '@/lib/api'

interface Branch {
  id: string
  name: string
  address: string | null
  latitude: number | null
  longitude: number | null
  active: boolean
  qrCodeUrl: string | null
  createdAt: string
}

export default function BranchesPage() {
  const [branches, setBranches] = useState<Branch[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ name: '', address: '', latitude: '', longitude: '' })
  const [creating, setCreating] = useState(false)
  const [generatingQR, setGeneratingQR] = useState<string | null>(null)
  const [message, setMessage] = useState('')

  useEffect(() => { loadBranches() }, [])

  async function loadBranches() {
    try {
      const data = await api.getBranches()
      setBranches(data.branches)
    } catch {} finally { setLoading(false) }
  }

  async function handleCreate() {
    if (!form.name.trim()) return
    setCreating(true)
    setMessage('')
    try {
      await api.createBranch({
        name: form.name.trim(),
        address: form.address.trim() || undefined,
        latitude: form.latitude ? parseFloat(form.latitude) : undefined,
        longitude: form.longitude ? parseFloat(form.longitude) : undefined,
      })
      setForm({ name: '', address: '', latitude: '', longitude: '' })
      setShowForm(false)
      setMessage('Sucursal creada exitosamente')
      loadBranches()
    } catch {
      setMessage('Error al crear sucursal')
    }
    setCreating(false)
  }

  async function handleToggle(id: string) {
    try {
      await api.toggleBranch(id)
      loadBranches()
    } catch {}
  }

  async function handleGenerateQR(id: string) {
    setGeneratingQR(id)
    try {
      await api.generateBranchQR(id)
      setMessage('Codigo QR generado exitosamente')
      loadBranches()
    } catch {
      setMessage('Error al generar codigo QR')
    }
    setGeneratingQR(null)
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Page header */}
      <div className="px-4 sm:px-6 lg:px-8 pt-6 lg:pt-8 pb-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl lg:text-3xl font-bold text-slate-800">Sucursales</h1>
            <p className="text-sm text-slate-500 mt-1">Gestiona las ubicaciones fisicas de tu comercio y sus codigos QR</p>
          </div>
          <button
            onClick={() => setShowForm(!showForm)}
            className="bg-emerald-600 text-white px-5 py-2.5 rounded-xl text-sm font-semibold hover:bg-emerald-700 shadow-sm transition"
          >
            {showForm ? 'Cancelar' : '+ Nueva sucursal'}
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="px-4 sm:px-6 lg:px-8 pb-8">
        {message && (
          <div className="mb-4 bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-sm text-emerald-700">
            {message}
          </div>
        )}

        {/* Create form */}
        {showForm && (
          <div className="bg-white rounded-2xl p-5 lg:p-6 shadow-sm border border-slate-100 mb-6 space-y-4 max-w-2xl">
            <h2 className="text-lg font-semibold text-slate-800">Nueva sucursal</h2>
            <div>
              <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Nombre</label>
              <input
                type="text"
                placeholder="Ej: Sucursal Centro"
                value={form.name}
                onChange={e => setForm({ ...form, name: e.target.value })}
                className="w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>
            <div>
              <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Direccion</label>
              <input
                type="text"
                placeholder="Av. Principal, Valencia"
                value={form.address}
                onChange={e => setForm({ ...form, address: e.target.value })}
                className="w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Latitud</label>
                <input
                  type="number"
                  step="any"
                  placeholder="10.4806"
                  value={form.latitude}
                  onChange={e => setForm({ ...form, latitude: e.target.value })}
                  className="w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Longitud</label>
                <input
                  type="number"
                  step="any"
                  placeholder="-66.9036"
                  value={form.longitude}
                  onChange={e => setForm({ ...form, longitude: e.target.value })}
                  className="w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
            </div>
            <button
              onClick={handleCreate}
              disabled={creating || !form.name.trim()}
              className="w-full bg-emerald-600 text-white py-3 rounded-xl text-sm font-semibold disabled:opacity-50 hover:bg-emerald-700 transition"
            >
              {creating ? 'Creando...' : 'Crear sucursal'}
            </button>
          </div>
        )}

        {/* Branch grid */}
        {loading ? (
          <p className="text-center text-slate-400 mt-8">Cargando...</p>
        ) : branches.length === 0 ? (
          <div className="bg-white rounded-2xl p-12 text-center border border-slate-100">
            <MdStorefront className="w-12 h-12 text-slate-400 mx-auto" />
            <p className="text-slate-500 mt-4">No hay sucursales creadas todavia</p>
            <p className="text-sm text-slate-400 mt-1">Crea tu primera sucursal para empezar</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {branches.map(b => (
              <div key={b.id} className="bg-white rounded-2xl shadow-sm border border-slate-100 hover:shadow-md hover:border-emerald-200 transition overflow-hidden">
                <div className="p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-slate-800 text-lg truncate">{b.name}</p>
                      {b.address && (
                        <p className="text-sm text-slate-500 mt-1 truncate">{b.address}</p>
                      )}
                      {b.latitude != null && b.longitude != null && (
                        <p className="text-xs text-slate-400 mt-1">
                          GPS: {Number(b.latitude).toFixed(4)}, {Number(b.longitude).toFixed(4)}
                        </p>
                      )}
                    </div>
                    <button
                      onClick={() => handleToggle(b.id)}
                      className={`flex-shrink-0 relative w-12 h-7 rounded-full transition-colors ${b.active ? 'bg-emerald-500' : 'bg-slate-300'}`}
                      aria-label={b.active ? 'Desactivar sucursal' : 'Activar sucursal'}
                    >
                      <span className={`absolute top-0.5 left-0.5 w-6 h-6 bg-white rounded-full shadow transition-transform ${b.active ? 'translate-x-5' : 'translate-x-0'}`} />
                    </button>
                  </div>
                </div>

                {/* QR section */}
                <div className="px-5 pb-5 pt-3 border-t border-slate-100">
                  {b.qrCodeUrl ? (
                    <div className="flex items-center gap-3">
                      <img
                        src={b.qrCodeUrl}
                        alt={`QR ${b.name}`}
                        className="w-20 h-20 rounded-lg border border-slate-200 flex-shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-slate-500 mb-1">Codigo QR activo</p>
                        <button
                          onClick={() => handleGenerateQR(b.id)}
                          disabled={generatingQR === b.id}
                          className="text-xs text-emerald-600 hover:text-emerald-800 font-medium"
                        >
                          {generatingQR === b.id ? 'Regenerando...' : 'Regenerar QR'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => handleGenerateQR(b.id)}
                      disabled={generatingQR === b.id}
                      className="w-full bg-emerald-50 text-emerald-700 py-2.5 rounded-lg text-sm font-semibold hover:bg-emerald-100 disabled:opacity-50 transition"
                    >
                      {generatingQR === b.id ? 'Generando...' : 'Generar codigo QR'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
