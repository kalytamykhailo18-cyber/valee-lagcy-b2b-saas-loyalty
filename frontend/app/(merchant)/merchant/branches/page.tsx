'use client'

import { useState, useEffect } from 'react'
import dynamic from 'next/dynamic'
import { MdStorefront } from 'react-icons/md'
import { api } from '@/lib/api'

const LocationPicker = dynamic(() => import('@/components/LocationPicker'), { ssr: false })

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

  const [errors, setErrors] = useState<{ name?: string; address?: string; latitude?: string; longitude?: string }>({})

  function validateForm(): boolean {
    const errs: { name?: string; address?: string; latitude?: string; longitude?: string } = {}
    if (!form.name.trim()) errs.name = 'El nombre es obligatorio'
    else if (form.name.trim().length < 2) errs.name = 'Minimo 2 caracteres'
    if (!form.address.trim()) errs.address = 'La direccion es obligatoria'
    if (form.latitude) {
      const lat = parseFloat(form.latitude)
      if (isNaN(lat) || lat < -90 || lat > 90) errs.latitude = 'Latitud invalida (-90 a 90)'
    }
    if (form.longitude) {
      const lng = parseFloat(form.longitude)
      if (isNaN(lng) || lng < -180 || lng > 180) errs.longitude = 'Longitud invalida (-180 a 180)'
    }
    if ((form.latitude && !form.longitude) || (!form.latitude && form.longitude)) {
      if (!form.latitude) errs.latitude = 'Latitud requerida si hay longitud'
      if (!form.longitude) errs.longitude = 'Longitud requerida si hay latitud'
    }
    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  async function handleCreate() {
    setMessage('')
    if (!validateForm()) return
    setCreating(true)
    try {
      await api.createBranch({
        name: form.name.trim(),
        address: form.address.trim() || undefined,
        latitude: form.latitude ? parseFloat(form.latitude) : undefined,
        longitude: form.longitude ? parseFloat(form.longitude) : undefined,
      })
      setForm({ name: '', address: '', latitude: '', longitude: '' })
      setErrors({})
      setShowForm(false)
      setMessage('Sucursal creada exitosamente')
      loadBranches()
    } catch (e: any) {
      setMessage(e?.error || e?.message || 'Error al crear sucursal')
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
    setMessage('')
    try {
      const result = await api.generateBranchQR(id)
      if (result?.qrCodeUrl) {
        setMessage('Codigo QR generado exitosamente')
      } else {
        setMessage('Error: el servidor no devolvio el QR')
      }
      await loadBranches()
    } catch (e: any) {
      setMessage(`Error al generar QR: ${e?.error || e?.message || 'desconocido'}`)
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
          <div className={`mb-4 rounded-xl p-3 text-sm border ${
            message.toLowerCase().includes('error') || message.toLowerCase().includes('invalid')
              ? 'bg-red-50 border-red-200 text-red-700'
              : 'bg-emerald-50 border-emerald-200 text-emerald-700'
          }`}>
            {message}
          </div>
        )}

        {/* Create form */}
        {showForm && (
          <div className="bg-white rounded-2xl p-5 lg:p-6 shadow-sm border border-slate-100 mb-6 space-y-4 max-w-2xl">
            <h2 className="text-lg font-semibold text-slate-800">Nueva sucursal</h2>
            <div>
              <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Nombre <span className="text-red-500">*</span></label>
              <input
                type="text"
                placeholder="Ej: Sucursal Centro"
                value={form.name}
                onChange={e => { setForm({ ...form, name: e.target.value }); if (errors.name) setErrors({ ...errors, name: undefined }) }}
                className={`w-full mt-1 px-3 py-2.5 rounded-lg border text-sm focus:outline-none focus:ring-2 ${errors.name ? 'border-red-300 focus:ring-red-400' : 'border-slate-200 focus:ring-emerald-500'}`}
              />
              {errors.name && <p className="text-red-500 text-xs mt-1">{errors.name}</p>}
            </div>
            <div>
              <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Direccion <span className="text-red-500">*</span></label>
              <input
                type="text"
                placeholder="Av. Principal, Valencia"
                value={form.address}
                onChange={e => { setForm({ ...form, address: e.target.value }); if (errors.address) setErrors({ ...errors, address: undefined }) }}
                className={`w-full mt-1 px-3 py-2.5 rounded-lg border text-sm focus:outline-none focus:ring-2 ${errors.address ? 'border-red-300 focus:ring-red-400' : 'border-slate-200 focus:ring-emerald-500'}`}
              />
              {errors.address && <p className="text-red-500 text-xs mt-1">{errors.address}</p>}
            </div>
            <div>
              <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Ubicacion en el mapa</label>
              <p className="text-xs text-slate-400 mb-2">Busca la direccion, haz click en el mapa o usa tu ubicacion actual</p>
              <LocationPicker
                latitude={form.latitude ? parseFloat(form.latitude) : null}
                longitude={form.longitude ? parseFloat(form.longitude) : null}
                onChange={(lat, lng) => {
                  setForm({ ...form, latitude: lat != null ? String(lat) : '', longitude: lng != null ? String(lng) : '' })
                  if (errors.latitude || errors.longitude) setErrors({ ...errors, latitude: undefined, longitude: undefined })
                }}
                address={form.address}
              />
              {(errors.latitude || errors.longitude) && (
                <p className="text-red-500 text-xs mt-1">{errors.latitude || errors.longitude}</p>
              )}
            </div>
            <button
              onClick={handleCreate}
              disabled={creating}
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
