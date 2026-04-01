'use client'

import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import Link from 'next/link'

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
      setMsg('Tenant created successfully')
      loadTenants()
    } catch (e: any) { setMsg(e.error || 'Error') }
    setLoading(false)
  }

  async function handleDeactivate(id: string) {
    try { await api.deactivateTenant(id); loadTenants() } catch {}
  }

  return (
    <div className="min-h-screen bg-slate-100 p-4">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Link href="/admin" className="text-slate-700 text-2xl">&larr;</Link>
          <h1 className="text-xl font-bold">Tenant Management</h1>
        </div>
        <button onClick={() => setShowCreate(!showCreate)} className="bg-slate-800 text-white px-4 py-2 rounded-xl text-sm font-medium">
          {showCreate ? 'Cancel' : '+ New Tenant'}
        </button>
      </div>

      {msg && <p className={`text-sm mb-4 ${msg.includes('Error') ? 'text-red-500' : 'text-green-600'}`}>{msg}</p>}

      {showCreate && (
        <div className="bg-white rounded-2xl p-4 shadow-sm mb-4 space-y-3 animate-fade-in">
          <input type="text" placeholder="Business name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className="w-full px-3 py-2 rounded-lg border text-sm" />
          <input type="text" placeholder="Slug (url-safe)" value={form.slug} onChange={e => setForm({ ...form, slug: e.target.value })} className="w-full px-3 py-2 rounded-lg border text-sm" />
          <input type="email" placeholder="Owner email" value={form.ownerEmail} onChange={e => setForm({ ...form, ownerEmail: e.target.value })} className="w-full px-3 py-2 rounded-lg border text-sm" />
          <input type="text" placeholder="Owner name" value={form.ownerName} onChange={e => setForm({ ...form, ownerName: e.target.value })} className="w-full px-3 py-2 rounded-lg border text-sm" />
          <input type="password" placeholder="Owner password" value={form.ownerPassword} onChange={e => setForm({ ...form, ownerPassword: e.target.value })} className="w-full px-3 py-2 rounded-lg border text-sm" />
          <button onClick={handleCreate} disabled={loading} className="w-full bg-slate-800 text-white py-2 rounded-lg text-sm font-medium disabled:opacity-50">
            {loading ? 'Creating...' : 'Create Tenant'}
          </button>
        </div>
      )}

      <div className="space-y-2">
        {tenants.map(t => (
          <div key={t.id} className="bg-white rounded-xl p-4 shadow-sm flex items-center justify-between">
            <div>
              <p className="font-medium">{t.name}</p>
              <p className="text-xs text-slate-500">{t.slug} | {t.ownerEmail}</p>
              <p className="text-xs text-slate-400">Created: {new Date(t.createdAt).toLocaleDateString()}</p>
            </div>
            <div className="flex items-center gap-2">
              <span className={`text-xs px-2 py-1 rounded-full ${t.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>{t.status}</span>
              {t.status === 'active' && (
                <button onClick={() => handleDeactivate(t.id)} className="text-xs text-red-500 hover:text-red-700">Deactivate</button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
