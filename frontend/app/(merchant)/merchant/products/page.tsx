'use client'

import { useState, useEffect } from 'react'
import { MdCardGiftcard, MdArchive, MdUnarchive, MdHistory, MdClose, MdPerson } from 'react-icons/md'
import { api } from '@/lib/api'
import { ImageLightbox } from '@/components/ImageLightbox'
import { formatPoints, formatCash } from '@/lib/format'

// Eric 2026-04-25: merchants typing "1.500" got 1.5 points because the input
// was raw <input type="number">. Strip everything but digits on input and
// re-format with dot thousand separators on display, so the merchant cannot
// accidentally enter a decimal separator that the system reads as fraction.
const fmtThousands = (s: string) => {
  const digits = String(s).replace(/\D/g, '')
  if (!digits) return ''
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}
const stripNonDigits = (s: string) => s.replace(/\D/g, '')

export default function ProductManagement() {
  const [products, setProducts] = useState<any[]>([])
  const [archivedProducts, setArchivedProducts] = useState<any[]>([])
  const [branches, setBranches] = useState<Array<{ id: string; name: string; active: boolean }>>([])
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const [form, setForm] = useState<{ name: string; description: string; photoUrl: string; redemptionCost: string; cashPrice: string; stock: string; assetTypeId: string; minLevel: string; branchIds: string[] }>(
    { name: '', description: '', photoUrl: '', redemptionCost: '', cashPrice: '', stock: '0', assetTypeId: '', minLevel: '1', branchIds: [] }
  )
  const [editForm, setEditForm] = useState<{ name: string; description: string; photoUrl: string; redemptionCost: string; stock: string; minLevel: string; branchIds: string[] }>(
    { name: '', description: '', photoUrl: '', redemptionCost: '', stock: '', minLevel: '', branchIds: [] }
  )
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [editUploading, setEditUploading] = useState(false)
  const [createMessage, setCreateMessage] = useState('')
  const [toggleError, setToggleError] = useState<{ id: string; msg: string } | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  // Per-product redemption history modal (Eric 2026-05-04 Notion Nota 3).
  const [historyFor, setHistoryFor] = useState<any | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)

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
    // Branches for the per-product scope selector. Empty list means the
    // tenant hasn't created any branch yet, so we hide the selector.
    api.getBranches().then((data: any) => {
      setBranches((data.branches || []).filter((b: any) => b.active))
    }).catch(() => {})
  }, [])

  async function loadProducts() {
    try {
      const [active, archived] = await Promise.all([
        api.getProducts(),
        api.getProducts({ archived: true }).catch(() => ({ products: [] })),
      ])
      setProducts(active.products)
      setArchivedProducts((archived as any).products || [])
    } catch {}
  }

  async function handleCreate() {
    if (!form.name || !form.redemptionCost) return
    setCreateMessage('')
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
        branchIds: form.branchIds,
      })
      // Reset the form but PRESERVE assetTypeId — it's a tenant-level config
      // and is required on every create. Clearing it broke the back-to-back
      // create flow (Genesis QA item 4): second POST went with empty
      // assetTypeId, backend rejected it, and the silent catch hid the
      // error so the page looked frozen.
      setForm(prev => ({
        name: '', description: '', photoUrl: '', redemptionCost: '',
        cashPrice: '', stock: '0', minLevel: '1', branchIds: [],
        assetTypeId: prev.assetTypeId,
      }))
      setShowForm(false)
      setCreateMessage('Producto creado')
      setTimeout(() => setCreateMessage(''), 2500)
      loadProducts()
    } catch (e: any) {
      // Surface server errors so plan-limit rejections and backend 4xx don't
      // fail silently (Genesis QA item 4 + a head-start on item 9).
      const msg = e?.error || e?.message || 'No se pudo crear el producto.'
      setCreateMessage(`Error: ${msg}`)
    }
    setLoading(false)
  }

  async function handleToggle(id: string) {
    setToggleError(null)
    try { await api.toggleProduct(id); await loadProducts() }
    catch (e: any) {
      setToggleError({ id, msg: e?.error || 'No se pudo cambiar el estado.' })
      setTimeout(() => setToggleError(null), 4000)
    }
  }

  async function handleArchive(p: any) {
    if (!confirm(`Archivar "${p.name}"? Dejara de verse en el catalogo. Podes restaurarla luego sin perder la data.`)) return
    try { await api.archiveProduct(p.id); await loadProducts() }
    catch (e: any) { alert(e?.error || 'No se pudo archivar.') }
  }

  async function handleUnarchive(p: any) {
    try { await api.unarchiveProduct(p.id); await loadProducts() }
    catch (e: any) { alert(e?.error || 'No se pudo restaurar.') }
  }

  async function loadHistory(p: any) {
    setHistoryFor({ ...p, loading: true })
    setHistoryLoading(true)
    try {
      const data: any = await api.getProductRedemptionHistory(p.id)
      setHistoryFor(data)
    } catch (e: any) {
      setHistoryFor(null)
      alert(e?.error || 'No se pudo cargar el historial.')
    } finally {
      setHistoryLoading(false)
    }
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
      // Multi-sucursal: read the new branchIds array from the API; fall
      // back to the legacy single branchId for products created before the
      // join migration.
      branchIds: Array.isArray(p.branchIds) && p.branchIds.length > 0
        ? p.branchIds
        : (p.branchId ? [p.branchId] : []),
    })
  }

  async function handleSaveEdit(id: string) {
    setLoading(true)
    setCreateMessage('')
    try {
      await api.updateProduct(id, {
        name: editForm.name,
        description: editForm.description,
        photoUrl: editForm.photoUrl || undefined,
        redemptionCost: editForm.redemptionCost,
        stock: parseInt(editForm.stock),
        minLevel: parseInt(editForm.minLevel) || 1,
        // Send the explicit array (empty === Todas las sucursales). The
        // backend treats `branchIds: []` as "clear all assignments".
        branchIds: editForm.branchIds,
      })
      setEditingId(null)
      loadProducts()
    } catch (e: any) {
      // Edit-cap or stock-guard rejections must bubble to the UI so
      // the owner understands why the save didn't stick (silent catch
      // was masking these during Genesis QA).
      const msg = e?.error || 'No se pudo guardar.'
      setCreateMessage(`Error: ${msg}`)
    }
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
          <div className="flex items-center gap-3">
            {createMessage && (
              <span className={`text-sm ${createMessage.startsWith('Error') ? 'text-rose-600' : 'text-emerald-600'}`}>
                {createMessage}
              </span>
            )}
            <button
              onClick={() => setShowForm(!showForm)}
              className="aa-btn aa-btn-emerald bg-emerald-600 text-white px-5 py-2.5 rounded-xl text-sm font-semibold hover:bg-emerald-700"
            >
              <span className="relative z-10">{showForm ? 'Cancelar' : '+ Nuevo producto'}</span>
            </button>
          </div>
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
                  type="text"
                  inputMode="numeric"
                  value={fmtThousands(form.redemptionCost)}
                  onChange={e => setForm({ ...form, redemptionCost: stripNonDigits(e.target.value) })}
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
                  type="text"
                  inputMode="numeric"
                  value={fmtThousands(form.stock)}
                  onChange={e => setForm({ ...form, stock: stripNonDigits(e.target.value) })}
                  className="aa-field aa-field-emerald w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Nivel min.</label>
                <select
                  value={form.minLevel || '1'}
                  onChange={e => setForm({ ...form, minLevel: e.target.value })}
                  className="aa-field aa-field-emerald w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm bg-white"
                >
                  <option value="1">Nivel 1</option>
                  <option value="2">Nivel 2</option>
                  <option value="3">Nivel 3</option>
                </select>
              </div>
            </div>

            {branches.length > 0 && (
              <div>
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Sucursales</label>
                <div className="mt-1 space-y-2 p-3 rounded-lg border border-slate-200 bg-white">
                  <label className="flex items-center gap-2 cursor-pointer text-sm">
                    <input
                      type="checkbox"
                      checked={form.branchIds.length === 0}
                      onChange={e => { if (e.target.checked) setForm({ ...form, branchIds: [] }) }}
                      className="w-4 h-4 accent-emerald-600"
                    />
                    <span className="font-medium text-slate-700">Todas las sucursales</span>
                  </label>
                  <div className="border-t border-slate-100 pt-2 space-y-1.5">
                    {branches.map(b => {
                      const checked = form.branchIds.includes(b.id)
                      return (
                        <label key={b.id} className="flex items-center gap-2 cursor-pointer text-sm">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={e => {
                              if (e.target.checked) {
                                setForm({ ...form, branchIds: [...form.branchIds, b.id] })
                              } else {
                                setForm({ ...form, branchIds: form.branchIds.filter(x => x !== b.id) })
                              }
                            }}
                            className="w-4 h-4 accent-emerald-600"
                          />
                          <span className="text-slate-700">{b.name}</span>
                        </label>
                      )
                    })}
                  </div>
                </div>
                <p className="text-xs text-slate-400 mt-1">Marca solo las sucursales donde se entrega este producto. Dejalo vacio para activarlo en todas.</p>
              </div>
            )}

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
                        <input type="text" inputMode="numeric" placeholder="0" value={fmtThousands(editForm.redemptionCost)} onChange={e => setEditForm({ ...editForm, redemptionCost: stripNonDigits(e.target.value) })} className="w-full mt-1 px-2 py-2 rounded-lg border text-sm" />
                      </div>
                      <div>
                        <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Stock</label>
                        <input type="text" inputMode="numeric" placeholder="0" value={fmtThousands(editForm.stock)} onChange={e => setEditForm({ ...editForm, stock: stripNonDigits(e.target.value) })} className="w-full mt-1 px-2 py-2 rounded-lg border text-sm" />
                      </div>
                      <div>
                        <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Nivel min</label>
                        <select
                          value={editForm.minLevel || '1'}
                          onChange={e => setEditForm({ ...editForm, minLevel: e.target.value })}
                          className="w-full mt-1 px-2 py-2 rounded-lg border text-sm bg-white"
                        >
                          <option value="1">Nivel 1</option>
                          <option value="2">Nivel 2</option>
                          <option value="3">Nivel 3</option>
                        </select>
                      </div>
                    </div>
                    {branches.length > 0 && (
                      <div>
                        <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Sucursales</label>
                        <div className="mt-1 space-y-1.5 p-2.5 rounded-lg border border-slate-200 bg-white">
                          <label className="flex items-center gap-2 cursor-pointer text-xs">
                            <input
                              type="checkbox"
                              checked={editForm.branchIds.length === 0}
                              onChange={e => { if (e.target.checked) setEditForm({ ...editForm, branchIds: [] }) }}
                              className="w-3.5 h-3.5 accent-emerald-600"
                            />
                            <span className="font-medium text-slate-700">Todas las sucursales</span>
                          </label>
                          <div className="border-t border-slate-100 pt-1.5 space-y-1">
                            {branches.map(b => {
                              const checked = editForm.branchIds.includes(b.id)
                              return (
                                <label key={b.id} className="flex items-center gap-2 cursor-pointer text-xs">
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={e => {
                                      if (e.target.checked) {
                                        setEditForm({ ...editForm, branchIds: [...editForm.branchIds, b.id] })
                                      } else {
                                        setEditForm({ ...editForm, branchIds: editForm.branchIds.filter(x => x !== b.id) })
                                      }
                                    }}
                                    className="w-3.5 h-3.5 accent-emerald-600"
                                  />
                                  <span className="text-slate-700">{b.name}</span>
                                </label>
                              )
                            })}
                          </div>
                        </div>
                      </div>
                    )}
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
                      {branches.length > 0 && (() => {
                        const names: string[] = Array.isArray(p.branchNames) && p.branchNames.length > 0
                          ? p.branchNames
                          : (p.branchName ? [p.branchName] : [])
                        const isWide = names.length === 0
                        const label = isWide ? 'Todas las sucursales' : names.join(' · ')
                        return (
                          <span className={`absolute top-2 left-2 max-w-[calc(100%-1rem)] truncate text-[10px] font-semibold px-2 py-1 rounded-full backdrop-blur-sm ${isWide ? 'bg-slate-800/70 text-white' : 'bg-indigo-600/90 text-white'}`}
                            title={label}
                          >
                            {label}
                          </span>
                        )
                      })()}
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
                      {p.stockAutoDisabled && (
                        <p className="text-xs text-amber-600 mt-1">Apagada por falta de stock. Se reactiva al reponer.</p>
                      )}

                      {/* Explicit toggle button — replaces the old pill. */}
                      <button
                        onClick={() => handleToggle(p.id)}
                        disabled={!p.active && p.stock <= 0}
                        className={`w-full mt-3 py-2.5 rounded-lg text-sm font-semibold transition ${
                          p.active
                            ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200'
                            : p.stock <= 0
                              ? 'bg-slate-100 text-slate-400 cursor-not-allowed border border-slate-200'
                              : 'bg-slate-100 text-slate-700 hover:bg-slate-200 border border-slate-200'
                        }`}
                        title={!p.active && p.stock <= 0 ? 'Agrega stock para activar' : undefined}
                      >
                        {p.active ? 'Activa — Desactivar' : (p.stock <= 0 ? 'Sin stock' : 'Inactiva — Activar')}
                      </button>
                      {toggleError && toggleError.id === p.id && (
                        <p className="text-xs text-rose-600 mt-1.5">{toggleError.msg}</p>
                      )}

                      <div className="flex gap-2 mt-2">
                        <button
                          onClick={() => startEdit(p)}
                          className="flex-1 py-2 text-xs text-indigo-600 hover:bg-indigo-50 rounded-lg font-medium"
                        >
                          Editar
                        </button>
                        <button
                          onClick={() => handleArchive(p)}
                          className="flex-1 py-2 text-xs text-slate-600 hover:bg-slate-100 rounded-lg font-medium inline-flex items-center justify-center gap-1"
                        >
                          <MdArchive className="w-4 h-4" />
                          Archivar
                        </button>
                      </div>
                      <button
                        onClick={() => loadHistory(p)}
                        className="w-full mt-2 py-2 text-xs text-emerald-700 hover:bg-emerald-50 rounded-lg font-medium inline-flex items-center justify-center gap-1"
                      >
                        <MdHistory className="w-4 h-4" />
                        Historial de canjes
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Archived bin */}
        {archivedProducts.length > 0 && (
          <div className="mt-10">
            <button
              onClick={() => setShowArchived(v => !v)}
              className="text-sm text-slate-600 hover:text-slate-800 font-semibold inline-flex items-center gap-2"
            >
              <MdArchive className="w-4 h-4" />
              Archivadas ({archivedProducts.length}) {showArchived ? '▾' : '▸'}
            </button>
            {showArchived && (
              <div className="mt-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {archivedProducts.map(p => (
                  <div key={p.id} className="bg-white rounded-2xl border border-slate-200 overflow-hidden opacity-70">
                    <div className="relative bg-slate-100 aspect-square flex items-center justify-center">
                      {p.photoUrl ? (
                        <img src={p.photoUrl} alt={p.name} className="w-full h-full object-cover grayscale" />
                      ) : (
                        <MdCardGiftcard className="w-12 h-12 text-slate-400" />
                      )}
                      <span className="absolute top-3 right-3 px-2 py-1 rounded-full text-[10px] font-semibold bg-slate-800/80 text-white backdrop-blur-sm">
                        Archivada
                      </span>
                    </div>
                    <div className="p-4">
                      <p className="font-semibold text-slate-700 truncate">{p.name}</p>
                      <button
                        onClick={() => handleUnarchive(p)}
                        className="w-full mt-3 py-2 text-xs bg-emerald-50 text-emerald-700 hover:bg-emerald-100 rounded-lg font-medium inline-flex items-center justify-center gap-1"
                      >
                        <MdUnarchive className="w-4 h-4" />
                        Restaurar
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Per-product redemption history modal — Eric 2026-05-04 Notion Nota 3 */}
      {historyFor && (
        <div
          className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          onClick={() => setHistoryFor(null)}
        >
          <div
            className="bg-white rounded-2xl w-full max-w-lg max-h-[90vh] overflow-hidden flex flex-col shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-5 border-b border-slate-100">
              <div className="min-w-0 flex-1">
                <p className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Historial de canjes</p>
                <p className="text-lg font-bold text-slate-800 truncate">{historyFor.product?.name || historyFor.name}</p>
                {(historyFor.product?.description || historyFor.description) && (
                  <p className="text-xs text-slate-500 truncate">{historyFor.product?.description || historyFor.description}</p>
                )}
              </div>
              <button
                onClick={() => setHistoryFor(null)}
                className="ml-3 w-8 h-8 rounded-lg hover:bg-slate-100 flex items-center justify-center flex-shrink-0"
                aria-label="Cerrar"
              >
                <MdClose className="w-5 h-5 text-slate-500" />
              </button>
            </div>
            {historyLoading ? (
              <div className="p-8 text-center text-slate-400 text-sm">Cargando...</div>
            ) : (
              <>
                {historyFor.summary && (
                  <div className="grid grid-cols-3 gap-3 p-5 border-b border-slate-100">
                    <div>
                      <p className="text-[10px] text-slate-500 uppercase tracking-wide">Canjes totales</p>
                      <p className="text-2xl font-bold text-emerald-700 mt-0.5">{historyFor.summary.totalRedemptions}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-slate-500 uppercase tracking-wide">Clientes unicos</p>
                      <p className="text-2xl font-bold text-emerald-700 mt-0.5">{historyFor.summary.uniqueConsumers}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-slate-500 uppercase tracking-wide">Ultimos 30 dias</p>
                      <p className="text-2xl font-bold text-emerald-700 mt-0.5">{historyFor.summary.last30dRedemptions}</p>
                    </div>
                  </div>
                )}
                <div className="overflow-y-auto p-5 flex-1">
                  {Array.isArray(historyFor.consumers) && historyFor.consumers.length > 0 ? (
                    <div className="space-y-2">
                      {historyFor.consumers.map((c: any) => (
                        <div key={c.accountId} className="flex items-center justify-between p-3 rounded-xl border border-slate-100 bg-slate-50/50">
                          <div className="flex items-center gap-3 min-w-0 flex-1">
                            <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${c.accountType === 'verified' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                              <MdPerson className="w-4 h-4" />
                            </div>
                            <div className="min-w-0 flex-1">
                              {c.displayName ? (
                                <>
                                  <p className="text-sm font-semibold text-slate-800 truncate">{c.displayName}</p>
                                  <p className="text-xs text-slate-500 truncate">{c.phoneNumber}</p>
                                </>
                              ) : (
                                <p className="text-sm font-semibold text-slate-800 truncate">{c.phoneNumber}</p>
                              )}
                              <p className="text-[10px] text-slate-400 mt-0.5">
                                Ultimo canje: {new Date(c.lastAt).toLocaleString('es-VE', { dateStyle: 'short', timeStyle: 'short' })}
                              </p>
                            </div>
                          </div>
                          <div className="text-right flex-shrink-0 ml-2">
                            <p className="text-base font-bold text-emerald-700">{c.count}</p>
                            <p className="text-[10px] text-slate-400">{c.count === 1 ? 'canje' : 'canjes'}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-center text-slate-400 text-sm py-8">Aun no hay canjes confirmados de este producto.</p>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
