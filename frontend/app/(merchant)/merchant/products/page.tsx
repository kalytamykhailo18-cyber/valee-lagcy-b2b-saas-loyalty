'use client'

import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import Link from 'next/link'

export default function ProductManagement() {
  const [products, setProducts] = useState<any[]>([])
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', description: '', photoUrl: '', redemptionCost: '', stock: '0', assetTypeId: '', minLevel: '1' })
  const [editForm, setEditForm] = useState({ name: '', description: '', photoUrl: '', redemptionCost: '', stock: '', minLevel: '' })
  const [loading, setLoading] = useState(false)

  useEffect(() => { loadProducts() }, [])

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
        stock: parseInt(form.stock) || 0,
        assetTypeId: form.assetTypeId,
        minLevel: parseInt(form.minLevel) || 1,
      })
      setShowForm(false)
      setForm({ name: '', description: '', photoUrl: '', redemptionCost: '', stock: '0', assetTypeId: '', minLevel: '1' })
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
    <div className="min-h-screen bg-emerald-50 p-4">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Link href="/merchant" className="text-emerald-700 text-2xl">&larr;</Link>
          <h1 className="text-xl font-bold text-emerald-800">Productos</h1>
        </div>
        <button onClick={() => setShowForm(!showForm)} className="bg-emerald-600 text-white px-4 py-2 rounded-xl text-sm font-medium">
          {showForm ? 'Cancelar' : '+ Nuevo'}
        </button>
      </div>

      {showForm && (
        <div className="bg-white rounded-2xl p-4 shadow-sm mb-4 space-y-3 animate-fade-in">
          <input type="text" placeholder="Nombre del producto" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
            className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm" />
          <input type="text" placeholder="Descripcion" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })}
            className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm" />
          <input type="text" placeholder="URL de foto (Cloudinary)" value={form.photoUrl} onChange={e => setForm({ ...form, photoUrl: e.target.value })}
            className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm" />
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-slate-500">Costo (pts)</label>
              <input type="number" value={form.redemptionCost} onChange={e => setForm({ ...form, redemptionCost: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm" />
            </div>
            <div>
              <label className="text-xs text-slate-500">Stock</label>
              <input type="number" value={form.stock} onChange={e => setForm({ ...form, stock: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm" />
            </div>
            <div>
              <label className="text-xs text-slate-500">Nivel min.</label>
              <input type="number" value={form.minLevel} onChange={e => setForm({ ...form, minLevel: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm" />
            </div>
          </div>
          <button onClick={handleCreate} disabled={loading || !form.name || !form.redemptionCost}
            className="w-full bg-emerald-600 text-white py-2 rounded-lg text-sm font-medium disabled:opacity-50">
            {loading ? 'Creando...' : 'Crear producto'}
          </button>
        </div>
      )}

      <div className="space-y-3">
        {products.map(p => (
          <div key={p.id} className="bg-white rounded-xl p-4 shadow-sm">
            {editingId === p.id ? (
              <div className="space-y-2">
                <input type="text" value={editForm.name} onChange={e => setEditForm({ ...editForm, name: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border text-sm" />
                <input type="text" placeholder="Descripcion" value={editForm.description} onChange={e => setEditForm({ ...editForm, description: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border text-sm" />
                <input type="text" placeholder="URL foto" value={editForm.photoUrl} onChange={e => setEditForm({ ...editForm, photoUrl: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border text-sm" />
                <div className="grid grid-cols-3 gap-2">
                  <input type="number" placeholder="Costo" value={editForm.redemptionCost} onChange={e => setEditForm({ ...editForm, redemptionCost: e.target.value })}
                    className="px-3 py-2 rounded-lg border text-sm" />
                  <input type="number" placeholder="Stock" value={editForm.stock} onChange={e => setEditForm({ ...editForm, stock: e.target.value })}
                    className="px-3 py-2 rounded-lg border text-sm" />
                  <input type="number" placeholder="Nivel" value={editForm.minLevel} onChange={e => setEditForm({ ...editForm, minLevel: e.target.value })}
                    className="px-3 py-2 rounded-lg border text-sm" />
                </div>
                <div className="flex gap-2">
                  <button onClick={() => setEditingId(null)} className="flex-1 bg-slate-100 py-2 rounded-lg text-sm">Cancelar</button>
                  <button onClick={() => handleSaveEdit(p.id)} disabled={loading}
                    className="flex-1 bg-emerald-600 text-white py-2 rounded-lg text-sm font-medium disabled:opacity-50">
                    {loading ? 'Guardando...' : 'Guardar'}
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <p className="font-medium">{p.name}</p>
                    <p className="text-sm text-slate-500">
                      {parseFloat(p.redemptionCost).toLocaleString()} pts | Stock: {p.stock}
                      {p.minLevel > 1 ? ` | Nivel ${p.minLevel}+` : ''}
                    </p>
                    {p.description && <p className="text-xs text-slate-400 mt-1">{p.description}</p>}
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => startEdit(p)} className="text-xs text-indigo-600 hover:text-indigo-800">Editar</button>
                    <button onClick={() => handleToggle(p.id)}
                      className={`px-3 py-1 rounded-full text-xs font-medium ${p.active ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                      {p.active ? 'Activo' : 'Inactivo'}
                    </button>
                  </div>
                </div>
                {p.stock === 0 && p.active && (
                  <p className="text-xs text-amber-600 mt-2">Sin stock — invisible para consumidores</p>
                )}
              </div>
            )}
          </div>
        ))}
        {products.length === 0 && <p className="text-center text-slate-400 mt-8">No hay productos creados</p>}
      </div>
    </div>
  )
}
