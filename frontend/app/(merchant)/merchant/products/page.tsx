'use client'

import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import Link from 'next/link'

export default function ProductManagement() {
  const [products, setProducts] = useState<any[]>([])
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ name: '', description: '', photoUrl: '', redemptionCost: '', stock: '0', assetTypeId: '' })
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
      })
      setShowForm(false)
      setForm({ name: '', description: '', photoUrl: '', redemptionCost: '', stock: '0', assetTypeId: '' })
      loadProducts()
    } catch {}
    setLoading(false)
  }

  async function handleToggle(id: string) {
    try {
      await api.toggleProduct(id)
      loadProducts()
    } catch {}
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
          <input type="text" placeholder="Nombre" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
            className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm" />
          <input type="text" placeholder="Descripcion" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })}
            className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm" />
          <input type="text" placeholder="URL de foto (Cloudinary)" value={form.photoUrl} onChange={e => setForm({ ...form, photoUrl: e.target.value })}
            className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm" />
          <div className="grid grid-cols-2 gap-3">
            <input type="number" placeholder="Costo (pts)" value={form.redemptionCost} onChange={e => setForm({ ...form, redemptionCost: e.target.value })}
              className="px-3 py-2 rounded-lg border border-slate-200 text-sm" />
            <input type="number" placeholder="Stock" value={form.stock} onChange={e => setForm({ ...form, stock: e.target.value })}
              className="px-3 py-2 rounded-lg border border-slate-200 text-sm" />
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
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">{p.name}</p>
                <p className="text-sm text-slate-500">{parseFloat(p.redemptionCost).toLocaleString()} pts | Stock: {p.stock}</p>
              </div>
              <button onClick={() => handleToggle(p.id)}
                className={`px-3 py-1 rounded-full text-xs font-medium ${p.active ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                {p.active ? 'Activo' : 'Inactivo'}
              </button>
            </div>
          </div>
        ))}
        {products.length === 0 && <p className="text-center text-slate-400 mt-8">No hay productos creados</p>}
      </div>
    </div>
  )
}
