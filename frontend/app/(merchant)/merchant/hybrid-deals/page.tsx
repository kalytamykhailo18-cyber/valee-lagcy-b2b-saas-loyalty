'use client'

import { useState, useEffect } from 'react'
import { MdLocalOffer } from 'react-icons/md'
import { api } from '@/lib/api'
import { ImageLightbox } from '@/components/ImageLightbox'
import { formatPoints } from '@/lib/format'

const fmtThousands = (s: string) => {
  const digits = String(s).replace(/\D/g, '')
  if (!digits) return ''
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}
const stripNonDigits = (s: string) => s.replace(/\D/g, '')

interface Product {
  id: string
  name: string
  description: string | null
  photoUrl: string | null
  redemptionCost: string
  cashPrice: string | null
  stock: number
  active: boolean
  minLevel: number
  branchId?: string | null
  branchName?: string | null
}

export default function HybridDealsPage() {
  const [allProducts, setAllProducts] = useState<Product[]>([])
  const [branches, setBranches] = useState<Array<{ id: string; name: string; active: boolean }>>([])
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState({
    name: '',
    description: '',
    photoUrl: '',
    cashPrice: '',
    redemptionCost: '',
    stock: '0',
    assetTypeId: '',
    minLevel: '1',
    branchId: '',
  })
  const [editForm, setEditForm] = useState({
    name: '',
    description: '',
    photoUrl: '',
    cashPrice: '',
    redemptionCost: '',
    stock: '',
    minLevel: '',
    branchId: '',
  })
  const [loading, setLoading] = useState(false)
  const [createMessage, setCreateMessage] = useState('')
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [editUploading, setEditUploading] = useState(false)
  const [assetTypeId, setAssetTypeId] = useState('')

  useEffect(() => {
    loadProducts()
    api.getBranches().then((data: any) => {
      setBranches((data.branches || []).filter((b: any) => b.active))
    }).catch(() => {})
  }, [])

  async function loadProducts() {
    try {
      const data = await api.getProducts()
      setAllProducts(data.products)
      // Pick the first product's assetTypeId for new deals
      if (data.products.length > 0 && !assetTypeId) {
        setAssetTypeId(data.products[0].assetTypeId || '')
      }
    } catch {}
  }

  // Only deals with a cashPrice set are considered hybrid
  const hybridDeals = allProducts.filter(p => p.cashPrice !== null && Number(p.cashPrice) > 0)

  async function handleImageUpload(file: File, target: 'create' | 'edit') {
    const setUploadState = target === 'create' ? setUploading : setEditUploading
    setUploadState(true)
    try {
      const result = await api.uploadProductImage(file)
      if (result.success && result.url) {
        if (target === 'create') {
          setForm(prev => ({ ...prev, photoUrl: result.url }))
        } else {
          setEditForm(prev => ({ ...prev, photoUrl: result.url }))
        }
      }
    } catch {}
    setUploadState(false)
  }

  async function handleCreate() {
    if (!form.name || !form.cashPrice || !form.redemptionCost) return
    setCreateMessage('')
    setLoading(true)
    try {
      await api.createProduct({
        name: form.name,
        description: form.description,
        photoUrl: form.photoUrl || undefined,
        cashPrice: form.cashPrice,
        redemptionCost: form.redemptionCost,
        stock: parseInt(form.stock) || 0,
        assetTypeId: assetTypeId,
        minLevel: parseInt(form.minLevel) || 1,
        branchId: form.branchId || undefined,
      })
      setShowForm(false)
      setForm({ name: '', description: '', photoUrl: '', cashPrice: '', redemptionCost: '', stock: '0', assetTypeId: '', minLevel: '1', branchId: '' })
      setCreateMessage('Promocion creada')
      setTimeout(() => setCreateMessage(''), 2500)
      loadProducts()
    } catch (e: any) {
      // Surface plan-limit 402s and other backend rejections to the user
      // (Genesis QA item 9). Without this the UI looked frozen.
      const msg = e?.error || e?.message || 'No se pudo crear la promocion.'
      setCreateMessage(`Error: ${msg}`)
    }
    setLoading(false)
  }

  async function handleToggle(id: string) {
    try { await api.toggleProduct(id); loadProducts() } catch {}
  }

  function startEdit(p: Product) {
    setEditingId(p.id)
    setEditForm({
      name: p.name,
      description: p.description || '',
      photoUrl: p.photoUrl || '',
      cashPrice: p.cashPrice || '',
      redemptionCost: p.redemptionCost || '',
      stock: p.stock?.toString() || '0',
      minLevel: p.minLevel?.toString() || '1',
      branchId: p.branchId || '',
    })
  }

  async function handleSaveEdit(id: string) {
    setLoading(true)
    try {
      await api.updateProduct(id, {
        name: editForm.name,
        description: editForm.description,
        photoUrl: editForm.photoUrl || undefined,
        cashPrice: editForm.cashPrice || undefined,
        redemptionCost: editForm.redemptionCost,
        stock: parseInt(editForm.stock),
        minLevel: parseInt(editForm.minLevel) || 1,
        // Null (not undefined) so picking "Todas" actually clears an
        // existing scope — same contract as the catalog page.
        branchId: editForm.branchId ? editForm.branchId : null,
      })
      setEditingId(null)
      loadProducts()
    } catch {}
    setLoading(false)
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <ImageLightbox src={lightboxSrc} alt="Producto" onClose={() => setLightboxSrc(null)} />
      {/* Page header */}
      <div className="px-4 sm:px-6 lg:px-8 pt-6 lg:pt-8 pb-4 aa-rise">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl lg:text-3xl font-bold text-slate-800 tracking-tight">Promociones hibridas</h1>
            <p className="text-sm text-slate-500 mt-1">
              Ofertas combinadas de efectivo + puntos. El cliente paga una parte en efectivo y el resto con sus puntos.
            </p>
          </div>
          <button
            onClick={() => setShowForm(!showForm)}
            className="aa-btn aa-btn-emerald bg-emerald-600 text-white px-5 py-2.5 rounded-xl text-sm font-semibold hover:bg-emerald-700"
          >
            <span className="relative z-10">{showForm ? 'Cancelar' : '+ Nueva promocion'}</span>
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="px-4 sm:px-6 lg:px-8 pb-8">
        {/* Info banner */}
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-6 max-w-3xl">
          <p className="text-sm text-amber-800 font-semibold mb-1">Como funciona</p>
          <p className="text-xs text-amber-700 leading-relaxed">
            El cliente paga el precio en efectivo al cajero, despues escanea el QR de canje con su saldo de puntos.
            El cajero recibe primero el efectivo, luego entrega el premio. Las promociones hibridas son perfectas para
            que clientes nuevos canjeen aunque no tengan suficientes puntos todavia.
          </p>
        </div>

        {/* Create form */}
        {showForm && (
          <div className="bg-white rounded-2xl p-5 lg:p-6 shadow-sm border border-slate-100 mb-6 space-y-4 max-w-3xl">
            <h2 className="text-lg font-semibold text-slate-800">Nueva promocion hibrida</h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Nombre</label>
                <input
                  type="text"
                  placeholder="Ej: Pizza familiar 2x1"
                  value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  className="aa-field aa-field-emerald w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Descripcion</label>
                <input
                  type="text"
                  placeholder="Detalle de la oferta"
                  value={form.description}
                  onChange={e => setForm({ ...form, description: e.target.value })}
                  className="aa-field aa-field-emerald w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm"
                />
              </div>
            </div>

            <div>
              <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Foto de la promocion</label>
              <div className="mt-2 flex items-center gap-3 flex-wrap">
                <label className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium cursor-pointer transition ${uploading ? 'bg-slate-100 text-slate-400' : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'}`}>
                  {uploading ? 'Subiendo...' : 'Subir foto'}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif"
                    className="hidden"
                    disabled={uploading}
                    onChange={e => { const f = e.target.files?.[0]; if (f) handleImageUpload(f, 'create'); e.target.value = '' }}
                  />
                </label>
                {form.photoUrl && (
                  <img src={form.photoUrl} alt="Preview" className="w-16 h-16 rounded-lg object-cover border border-slate-200" />
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Parte en efectivo</label>
                <div className="relative mt-1">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">$</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="3.00"
                    value={form.cashPrice}
                    onChange={e => setForm({ ...form, cashPrice: e.target.value })}
                    className="w-full pl-7 pr-3 py-2.5 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
                <p className="text-xs text-slate-400 mt-1">Lo que el cliente paga en efectivo al cajero</p>
              </div>
              <div>
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Parte en puntos</label>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="800"
                  value={fmtThousands(form.redemptionCost)}
                  onChange={e => setForm({ ...form, redemptionCost: stripNonDigits(e.target.value) })}
                  className="aa-field aa-field-emerald w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm"
                />
                <p className="text-xs text-slate-400 mt-1">Lo que descuenta del saldo del cliente</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Stock</label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={fmtThousands(form.stock)}
                  onChange={e => setForm({ ...form, stock: stripNonDigits(e.target.value) })}
                  className="aa-field aa-field-emerald w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Nivel min.</label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={fmtThousands(form.minLevel)}
                  onChange={e => setForm({ ...form, minLevel: stripNonDigits(e.target.value) })}
                  className="aa-field aa-field-emerald w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm"
                />
              </div>
            </div>

            {branches.length > 0 && (
              <div>
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Sucursal</label>
                <select
                  value={form.branchId}
                  onChange={e => setForm({ ...form, branchId: e.target.value })}
                  className="aa-field aa-field-emerald w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm"
                >
                  <option value="">Todas las sucursales</option>
                  {branches.map(b => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
                <p className="text-xs text-slate-400 mt-1">Dejalo en &ldquo;Todas&rdquo; si la promocion aplica en todo el comercio.</p>
              </div>
            )}

            <button
              onClick={handleCreate}
              disabled={loading || !form.name || !form.cashPrice || !form.redemptionCost}
              className="aa-btn aa-btn-emerald w-full bg-emerald-600 text-white py-3 rounded-xl text-sm font-semibold disabled:opacity-50 hover:bg-emerald-700 flex items-center justify-center"
            >
              {loading && <span className="aa-spinner" />}<span className="relative z-10">{loading ? 'Creando...' : 'Crear promocion'}</span>
            </button>
            {createMessage && (
              <p className={`text-sm mt-2 ${createMessage.startsWith('Error') ? 'text-rose-600' : 'text-emerald-600'}`}>
                {createMessage}
              </p>
            )}
          </div>
        )}
        {!showForm && createMessage && (
          <p className={`text-sm mb-4 ${createMessage.startsWith('Error') ? 'text-rose-600' : 'text-emerald-600'}`}>
            {createMessage}
          </p>
        )}

        {/* Hybrid deals grid */}
        {hybridDeals.length === 0 ? (
          <div className="bg-white rounded-2xl p-12 text-center border border-slate-100">
            <MdLocalOffer className="w-12 h-12 text-slate-400 mx-auto" />
            <p className="text-slate-500 mt-4">No hay promociones hibridas todavia</p>
            <p className="text-sm text-slate-400 mt-1">Crea tu primera oferta combinada de efectivo + puntos</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {hybridDeals.map((p, i) => (
              <div key={p.id} className="aa-card aa-row-in bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden" style={{ animationDelay: `${Math.min(i * 40, 360)}ms` }}>
                {editingId === p.id ? (
                  <div className="p-4 space-y-3">
                    <div>
                      <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Nombre</label>
                      <input
                        type="text"
                        value={editForm.name}
                        onChange={e => setEditForm({ ...editForm, name: e.target.value })}
                        className="w-full mt-1 px-3 py-2 rounded-lg border text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Descripcion</label>
                      <input
                        type="text"
                        placeholder="Detalle de la oferta"
                        value={editForm.description}
                        onChange={e => setEditForm({ ...editForm, description: e.target.value })}
                        className="w-full mt-1 px-3 py-2 rounded-lg border text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide block mb-1">Foto</label>
                      <div className="flex items-center gap-2">
                        <label className={`inline-flex items-center gap-1 px-3 py-2 rounded-lg text-xs font-medium cursor-pointer ${editUploading ? 'bg-slate-100 text-slate-400' : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'}`}>
                          {editUploading ? 'Subiendo...' : 'Cambiar foto'}
                          <input
                            type="file"
                            accept="image/jpeg,image/png,image/webp,image/gif"
                            className="hidden"
                            disabled={editUploading}
                            onChange={e => { const f = e.target.files?.[0]; if (f) handleImageUpload(f, 'edit'); e.target.value = '' }}
                          />
                        </label>
                        {editForm.photoUrl && (
                          <img src={editForm.photoUrl} alt="" className="w-10 h-10 rounded-lg object-cover border border-slate-200" />
                        )}
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Precio ($)</label>
                        <input type="number" step="0.01" placeholder="0.00" value={editForm.cashPrice} onChange={e => setEditForm({ ...editForm, cashPrice: e.target.value })} className="w-full mt-1 px-2 py-2 rounded-lg border text-sm" />
                      </div>
                      <div>
                        <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Costo (pts)</label>
                        <input type="text" inputMode="numeric" placeholder="0" value={fmtThousands(editForm.redemptionCost)} onChange={e => setEditForm({ ...editForm, redemptionCost: stripNonDigits(e.target.value) })} className="w-full mt-1 px-2 py-2 rounded-lg border text-sm" />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Stock</label>
                        <input type="text" inputMode="numeric" placeholder="0" value={fmtThousands(editForm.stock)} onChange={e => setEditForm({ ...editForm, stock: stripNonDigits(e.target.value) })} className="w-full mt-1 px-2 py-2 rounded-lg border text-sm" />
                      </div>
                      <div>
                        <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Nivel minimo</label>
                        <input type="text" inputMode="numeric" placeholder="1" value={fmtThousands(editForm.minLevel)} onChange={e => setEditForm({ ...editForm, minLevel: stripNonDigits(e.target.value) })} className="w-full mt-1 px-2 py-2 rounded-lg border text-sm" />
                      </div>
                    </div>
                    {branches.length > 0 && (
                      <div>
                        <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Sucursal</label>
                        <select
                          value={editForm.branchId}
                          onChange={e => setEditForm({ ...editForm, branchId: e.target.value })}
                          className="w-full mt-1 px-2 py-2 rounded-lg border text-sm"
                        >
                          <option value="">Todas las sucursales</option>
                          {branches.map(b => (
                            <option key={b.id} value={b.id}>{b.name}</option>
                          ))}
                        </select>
                      </div>
                    )}
                    <div className="flex gap-2">
                      <button onClick={() => setEditingId(null)} className="flex-1 bg-slate-100 py-2 rounded-lg text-sm hover:bg-slate-200 transition">Cancelar</button>
                      <button onClick={() => handleSaveEdit(p.id)} disabled={loading} className="aa-btn aa-btn-emerald flex-1 bg-emerald-600 text-white py-2 rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-emerald-700">
                        {loading ? '...' : 'Guardar'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {/* Photo */}
                    <div className="relative bg-gradient-to-br from-amber-50 to-emerald-50 aspect-square flex items-center justify-center">
                      {p.photoUrl ? (
                        <button
                          type="button"
                          onClick={() => setLightboxSrc(p.photoUrl)}
                          className="w-full h-full cursor-zoom-in"
                          aria-label={`Ver foto de ${p.name}`}
                        >
                          <img src={p.photoUrl} alt={p.name} className="w-full h-full object-cover hover:opacity-95 transition" />
                        </button>
                      ) : (
                        <MdLocalOffer className="w-16 h-16 text-amber-400" />
                      )}
                      {/* Hybrid badge + optional branch chip */}
                      <div className="absolute top-3 left-3 flex gap-2 items-center">
                        <span className="bg-amber-500 text-white px-2.5 py-1 rounded-full text-xs font-bold shadow-sm">
                          HIBRIDA
                        </span>
                        {branches.length > 0 && (
                          <span className={`text-[10px] font-semibold px-2 py-1 rounded-full backdrop-blur-sm shadow-sm ${p.branchId ? 'bg-indigo-600/90 text-white' : 'bg-slate-800/70 text-white'}`}>
                            {p.branchName || 'Todas'}
                          </span>
                        )}
                      </div>
                      <button
                        onClick={() => handleToggle(p.id)}
                        className={`absolute top-3 right-3 px-3 py-1 rounded-full text-xs font-semibold backdrop-blur-sm shadow-sm ${p.active ? 'bg-green-100/95 text-green-700' : 'bg-red-100/95 text-red-700'}`}
                      >
                        {p.active ? 'Activa' : 'Inactiva'}
                      </button>
                    </div>

                    {/* Info */}
                    <div className="p-4">
                      <p className="font-semibold text-slate-800 truncate">{p.name}</p>
                      {p.description && (
                        <p className="text-xs text-slate-500 mt-1 line-clamp-2">{p.description}</p>
                      )}

                      {/* Hybrid pricing breakdown */}
                      <div className="mt-3 bg-slate-50 rounded-lg p-3">
                        <div className="flex justify-between items-center">
                          <div className="text-center flex-1">
                            <p className="text-xs text-slate-500">Efectivo</p>
                            <p className="text-base font-bold text-amber-600">${parseFloat(p.cashPrice || '0').toFixed(2)}</p>
                          </div>
                          <span className="text-slate-400 text-xs px-1">+</span>
                          <div className="text-center flex-1">
                            <p className="text-xs text-slate-500">Puntos</p>
                            <p className="text-base font-bold text-emerald-700">{formatPoints(p.redemptionCost)}</p>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center justify-between mt-3 text-xs text-slate-500">
                        <span>Stock: {p.stock}</span>
                        {p.minLevel > 1 && <span className="text-indigo-600">Nivel {p.minLevel}+</span>}
                      </div>

                      {p.stock === 0 && p.active && (
                        <p className="text-xs text-amber-600 mt-2">Sin stock — invisible para consumidores</p>
                      )}

                      <button
                        onClick={() => startEdit(p)}
                        className="w-full mt-3 py-2 text-xs text-indigo-600 hover:bg-indigo-50 rounded-lg font-medium transition"
                      >
                        Editar
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
