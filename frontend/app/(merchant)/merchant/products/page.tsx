'use client'

import { useState, useEffect } from 'react'
import { MdCardGiftcard } from 'react-icons/md'
import { api } from '@/lib/api'
import { ImageLightbox } from '@/components/ImageLightbox'
import { formatPoints, formatCash } from '@/lib/format'

export default function ProductManagement() {
  const [products, setProducts] = useState<any[]>([])
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', description: '', photoUrl: '', redemptionCost: '', cashPrice: '', stock: '0', assetTypeId: '', minLevel: '1' })
  const [editForm, setEditForm] = useState({ name: '', description: '', photoUrl: '', redemptionCost: '', stock: '', minLevel: '' })
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [editUploading, setEditUploading] = useState(false)

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
    } catch (err) {
      console.error('Image upload failed:', err)
    }
    setUploadState(false)
  }

  useEffect(() => {
    loadProducts()
    // Auto-set assetTypeId from the merchant's product list or settings
    api.getProducts().then(data => {
      const firstProduct = data.products?.[0]
      if (firstProduct?.assetTypeId) {
        setForm(prev => ({ ...prev, assetTypeId: firstProduct.assetTypeId }))
      }
    }).catch(() => {})
    // Fallback: fetch from merchant settings
    api.getMerchantSettings().then((s: any) => {
      if (s.assetTypeId) setForm(prev => prev.assetTypeId ? prev : { ...prev, assetTypeId: s.assetTypeId })
    }).catch(() => {})
  }, [])

  async function loadProducts() {
    try {
      const data = await api.getProducts()
      setProducts(data.products)
    } catch {}
  }

  async function handleCreate() {
    if (!form.name || !form.redemptionCost) return
    setLoading(true)
    try {
      await api.createProduct({
        name: form.name,
        description: form.description,
        photoUrl: form.photoUrl || undefined,
        redemptionCost: form.redemptionCost,
        cashPrice: form.cashPrice || undefined,
        stock: parseInt(form.stock) || 0,
        assetTypeId: form.assetTypeId,
        minLevel: parseInt(form.minLevel) || 1,
      })
      setShowForm(false)
      setForm({ name: '', description: '', photoUrl: '', redemptionCost: '', cashPrice: '', stock: '0', assetTypeId: '', minLevel: '1' })
      loadProducts()
    } catch {}
    setLoading(false)
  }

  async function handleToggle(id: string) {
    try { await api.toggleProduct(id); loadProducts() } catch {}
  }

  function startEdit(p: any) {
    setEditingId(p.id)
    setEditForm({
      name: p.name,
      description: p.description || '',
      photoUrl: p.photoUrl || '',
      redemptionCost: p.redemptionCost?.toString() || '',
      stock: p.stock?.toString() || '0',
      minLevel: p.minLevel?.toString() || '1',
    })
  }

  async function handleSaveEdit(id: string) {
    setLoading(true)
    try {
      await api.updateProduct(id, {
        name: editForm.name,
        description: editForm.description,
        photoUrl: editForm.photoUrl || undefined,
        redemptionCost: editForm.redemptionCost,
        stock: parseInt(editForm.stock),
        minLevel: parseInt(editForm.minLevel) || 1,
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
            <h1 className="text-2xl lg:text-3xl font-bold text-slate-800 tracking-tight">Catalogo de productos</h1>
            <p className="text-sm text-slate-500 mt-1">Crea y gestiona los productos que tus clientes pueden canjear</p>
          </div>
          <button
            onClick={() => setShowForm(!showForm)}
            className="aa-btn aa-btn-emerald bg-emerald-600 text-white px-5 py-2.5 rounded-xl text-sm font-semibold hover:bg-emerald-700"
          >
            <span className="relative z-10">{showForm ? 'Cancelar' : '+ Nuevo producto'}</span>
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="px-4 sm:px-6 lg:px-8 pb-8">
        {/* Create form */}
        {showForm && (
          <div className="bg-white rounded-2xl p-5 lg:p-6 shadow-sm border border-slate-100 mb-6 space-y-4 max-w-3xl">
            <h2 className="text-lg font-semibold text-slate-800">Nuevo producto</h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Nombre</label>
                <input
                  type="text"
                  placeholder="Ej: Cafe gratis"
                  value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  className="aa-field aa-field-emerald w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Descripcion</label>
                <input
                  type="text"
                  placeholder="Breve descripcion"
                  value={form.description}
                  onChange={e => setForm({ ...form, description: e.target.value })}
                  className="aa-field aa-field-emerald w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm"
                />
              </div>
            </div>

            <div>
              <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Foto del producto</label>
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
              <details className="text-xs text-slate-400 mt-2">
                <summary className="cursor-pointer hover:text-slate-600">O ingresar URL manualmente</summary>
                <input
                  type="text"
                  placeholder="URL de foto (Cloudinary)"
                  value={form.photoUrl}
                  onChange={e => setForm({ ...form, photoUrl: e.target.value })}
                  className="w-full mt-2 px-3 py-2 rounded-lg border border-slate-200 text-sm"
                />
              </details>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div>
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Costo (pts)</label>
                <input
                  type="number"
                  value={form.redemptionCost}
                  onChange={e => setForm({ ...form, redemptionCost: e.target.value })}
                  className="aa-field aa-field-emerald w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Parte en $ (opcional)</label>
                <input
                  type="number"
                  step="0.01"
                  placeholder="0"
                  value={form.cashPrice}
                  onChange={e => setForm({ ...form, cashPrice: e.target.value })}
                  className="w-full mt-1 px-3 py-2.5 rounded-lg border border-amber-200 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
                />
              </div>
              <div>
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Stock</label>
                <input
                  type="number"
                  value={form.stock}
                  onChange={e => setForm({ ...form, stock: e.target.value })}
                  className="aa-field aa-field-emerald w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Nivel min.</label>
                <input
                  type="number"
                  value={form.minLevel}
                  onChange={e => setForm({ ...form, minLevel: e.target.value })}
                  className="aa-field aa-field-emerald w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm"
                />
              </div>
            </div>

            <button
              onClick={handleCreate}
              disabled={loading || !form.name || !form.redemptionCost}
              className="w-full bg-emerald-600 text-white py-3 rounded-xl text-sm font-semibold disabled:opacity-50 hover:bg-emerald-700 transition"
            >
              {loading ? 'Creando...' : 'Crear producto'}
            </button>
          </div>
        )}

        {/* Product grid */}
        {products.length === 0 ? (
          <div className="bg-white rounded-2xl p-12 text-center border border-slate-100 aa-rise">
            <p className="text-slate-400">No hay productos creados todavia</p>
            <p className="text-sm text-slate-400 mt-1">Toca el boton Nuevo producto para empezar</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {products.map((p, i) => (
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
                        placeholder="Detalle del producto"
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
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Costo (pts)</label>
                        <input type="number" placeholder="0" value={editForm.redemptionCost} onChange={e => setEditForm({ ...editForm, redemptionCost: e.target.value })} className="w-full mt-1 px-2 py-2 rounded-lg border text-sm" />
                      </div>
                      <div>
                        <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Stock</label>
                        <input type="number" placeholder="0" value={editForm.stock} onChange={e => setEditForm({ ...editForm, stock: e.target.value })} className="w-full mt-1 px-2 py-2 rounded-lg border text-sm" />
                      </div>
                      <div>
                        <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Nivel min</label>
                        <input type="number" placeholder="1" value={editForm.minLevel} onChange={e => setEditForm({ ...editForm, minLevel: e.target.value })} className="w-full mt-1 px-2 py-2 rounded-lg border text-sm" />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => setEditingId(null)} className="aa-btn flex-1 bg-slate-100 py-2 rounded-lg text-sm hover:bg-slate-200"><span className="relative z-10">Cancelar</span></button>
                      <button onClick={() => handleSaveEdit(p.id)} disabled={loading} className="aa-btn aa-btn-emerald flex-1 bg-emerald-600 text-white py-2 rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-emerald-700 flex items-center justify-center">
                        {loading && <span className="aa-spinner" />}<span className="relative z-10">{loading ? '...' : 'Guardar'}</span>
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {/* Product photo area */}
                    <div className="relative bg-slate-100 aspect-square flex items-center justify-center">
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
                        <MdCardGiftcard className="w-12 h-12 text-slate-400" />
                      )}
                      <button
                        onClick={() => handleToggle(p.id)}
                        className={`absolute top-3 right-3 px-3 py-1 rounded-full text-xs font-semibold backdrop-blur-sm shadow-sm ${p.active ? 'bg-green-100/95 text-green-700' : 'bg-red-100/95 text-red-700'}`}
                      >
                        {p.active ? 'Activo' : 'Inactivo'}
                      </button>
                    </div>

                    {/* Product info */}
                    <div className="p-4">
                      <p className="font-semibold text-slate-800 truncate">{p.name}</p>
                      {p.description && (
                        <p className="text-xs text-slate-500 mt-1 line-clamp-2">{p.description}</p>
                      )}
                      <div className="flex items-center justify-between mt-3">
                        <div>
                          <p className="text-lg font-bold text-emerald-700">
                            {formatPoints(p.redemptionCost)} <span className="text-xs font-medium text-slate-500">pts</span>
                          </p>
                          {p.cashPrice && Number(p.cashPrice) > 0 && (
                            <p className="text-sm font-bold text-amber-600">+ ${formatCash(p.cashPrice)}</p>
                          )}
                        </div>
                        <div className="text-right">
                          <span className="text-xs text-slate-500">Stock: {p.stock}</span>
                          {p.cashPrice && Number(p.cashPrice) > 0 && (
                            <span className="block text-[10px] text-amber-600 font-semibold mt-0.5">HIBRIDA</span>
                          )}
                        </div>
                      </div>
                      {p.minLevel > 1 && (
                        <p className="text-xs text-indigo-600 mt-1">Requiere nivel {p.minLevel}+</p>
                      )}
                      {p.stock === 0 && p.active && (
                        <p className="text-xs text-amber-600 mt-2">Sin stock — invisible para consumidores</p>
                      )}
                      <button
                        onClick={() => startEdit(p)}
                        className="aa-btn w-full mt-3 py-2 text-xs text-indigo-600 hover:bg-indigo-50 rounded-lg font-medium"
                      >
                        <span className="relative z-10">Editar</span>
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
