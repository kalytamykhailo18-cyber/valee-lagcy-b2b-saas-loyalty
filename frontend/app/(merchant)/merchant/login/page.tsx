'use client'

import { useState } from 'react'
import { api } from '@/lib/api'
import { useRouter } from 'next/navigation'

export default function MerchantLogin() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [tenantSlug, setTenantSlug] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  async function handleLogin() {
    setError('')
    setLoading(true)
    try {
      const data = await api.merchantLogin(email, password, tenantSlug)
      localStorage.setItem('accessToken', data.accessToken)
      localStorage.setItem('staffRole', data.staff.role)
      localStorage.setItem('staffName', data.staff.name)
      router.push(data.staff.role === 'cashier' ? '/merchant/scanner' : '/merchant')
    } catch (e: any) {
      setError(e.error || 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-emerald-50">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-emerald-700">Merchant Dashboard</h1>
          <p className="text-slate-500 mt-1">Inicia sesion con tu cuenta de comercio</p>
        </div>
        <div className="bg-white rounded-2xl p-6 shadow-sm space-y-4">
          <input type="text" placeholder="Codigo del comercio" value={tenantSlug} onChange={e => setTenantSlug(e.target.value)}
            className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500" />
          <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)}
            className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500" />
          <input type="password" placeholder="Contrasena" value={password} onChange={e => setPassword(e.target.value)}
            className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500" />
          {error && <p className="text-red-500 text-sm">{error}</p>}
          <button onClick={handleLogin} disabled={loading} className="w-full bg-emerald-600 text-white py-3 rounded-xl font-medium hover:bg-emerald-700 disabled:opacity-50 transition">
            {loading ? 'Ingresando...' : 'Ingresar'}
          </button>
        </div>
      </div>
    </div>
  )
}
