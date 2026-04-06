'use client'

import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import Link from 'next/link'

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
    <div className="min-h-screen bg-emerald-50 p-4">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Link href="/merchant" className="text-emerald-700 text-2xl">&larr;</Link>
          <h1 className="text-xl font-bold text-emerald-800">Sucursales</h1>
        </div>
        <button onClick={() => setShowForm(!showForm)} className="bg-emerald-600 text-white px-4 py-2 rounded-xl text-sm font-medium">
          {showForm ? 'Cancelar' : '+ Nueva'}
        </button>
      </div>

      {message && (
        <div className="mb-4 bg-white rounded-xl p-3 shadow-sm text-sm text-emerald-700">{message}</div>
      )}

      {/* Create Form */}
      {showForm && (
        <div className="bg-white rounded-2xl p-4 shadow-sm mb-4 space-y-3 animate-fade-in">
          <input type="text" placeholder="Nombre de la sucursal" value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })}
            className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm" />
          <input type="text" placeholder="Direccion" value={form.address}
            onChange={e => setForm({ ...form, address: e.target.value })}
            className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm" />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-slate-500">Latitud</label>
              <input type="number" step="any" placeholder="10.4806" value={form.latitude}
                onChange={e => setForm({ ...form, latitude: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm" />
            </div>
            <div>
              <label className="text-xs text-slate-500">Longitud</label>
              <input type="number" step="any" placeholder="-66.9036" value={form.longitude}
                onChange={e => setForm({ ...form, longitude: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm" />
            </div>
          </div>
          <button onClick={handleCreate} disabled={creating || !form.name.trim()}
            className="w-full bg-emerald-600 text-white py-2 rounded-lg text-sm font-medium disabled:opacity-50">
            {creating ? 'Creando...' : 'Crear sucursal'}
          </button>
        </div>
      )}

      {/* Branch List */}
      {loading ? (
        <p className="text-center text-slate-400 mt-8">Cargando...</p>
      ) : branches.length === 0 ? (
        <div className="bg-white rounded-2xl p-8 shadow-sm text-center">
          <span className="text-4xl">🏪</span>
          <p className="text-slate-500 mt-3">No hay sucursales creadas</p>
        </div>
      ) : (
        <div className="space-y-3">
          {branches.map(b => (
            <div key={b.id} className="bg-white rounded-xl p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <p className="font-medium">{b.name}</p>
                  {b.address && <p className="text-sm text-slate-500">{b.address}</p>}
                  {b.latitude != null && b.longitude != null && (
                    <p className="text-xs text-slate-400">GPS: {b.latitude}, {b.longitude}</p>
                  )}
                </div>
                <button onClick={() => handleToggle(b.id)}
                  className={`px-3 py-1 rounded-full text-xs font-medium ${b.active ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                  {b.active ? 'Activa' : 'Inactiva'}
                </button>
              </div>

              {/* QR Section */}
              <div className="mt-3 pt-3 border-t border-slate-100">
                {b.qrCodeUrl ? (
                  <div className="flex items-center gap-3">
                    <img src={b.qrCodeUrl} alt={`QR ${b.name}`} className="w-16 h-16 rounded-lg border border-slate-200" />
                    <div>
                      <p className="text-xs text-slate-500">Codigo QR generado</p>
                      <button onClick={() => handleGenerateQR(b.id)} disabled={generatingQR === b.id}
                        className="text-xs text-emerald-600 hover:text-emerald-800 mt-1">
                        {generatingQR === b.id ? 'Regenerando...' : 'Regenerar QR'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button onClick={() => handleGenerateQR(b.id)} disabled={generatingQR === b.id}
                    className="w-full bg-emerald-50 text-emerald-700 py-2 rounded-lg text-sm font-medium hover:bg-emerald-100 disabled:opacity-50">
                    {generatingQR === b.id ? 'Generando...' : 'Generar codigo QR'}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
