'use client'

import { useState } from 'react'
import { api } from '@/lib/api'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

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
      localStorage.setItem('refreshToken', data.refreshToken)
      localStorage.setItem('staffRole', data.staff.role)
      localStorage.setItem('staffName', data.staff.name)
      router.push(data.staff.role === 'cashier' ? '/merchant/scanner' : '/merchant')
    } catch (e: any) {
      setError(e.error || 'Credenciales invalidas')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-emerald-50">
      <header className="py-6 text-center">
        <Link
          href="/"
          className="inline-block text-3xl font-extrabold tracking-tight text-emerald-700 hover:text-emerald-800 transition-colors"
        >
          Valee
        </Link>
      </header>

      <main className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-sm space-y-6">
          <div className="text-center">
            <h1 className="text-2xl font-bold text-slate-800">Panel del comercio</h1>
            <p className="text-slate-500 mt-1 text-sm">Inicia sesion con tu cuenta de comercio</p>
          </div>
          <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-100 space-y-4">
            <div>
              <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Codigo del comercio</label>
              <input
                type="text"
                value={tenantSlug}
                onChange={e => setTenantSlug(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleLogin()}
                className="w-full mt-1 px-4 py-3 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>
            <div>
              <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Email</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleLogin()}
                className="w-full mt-1 px-4 py-3 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>
            <div>
              <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Contrasena</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleLogin()}
                className="w-full mt-1 px-4 py-3 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">{error}</div>
            )}
            <button
              onClick={handleLogin}
              disabled={loading || !email || !password || !tenantSlug}
              className="w-full bg-emerald-600 text-white py-3 rounded-xl font-semibold text-sm hover:bg-emerald-700 disabled:opacity-50 transition"
            >
              {loading ? 'Ingresando...' : 'Ingresar'}
            </button>
          </div>
        </div>
      </main>

      <footer className="py-8 text-center text-sm font-medium text-slate-500 space-x-6">
        <Link
          href="/"
          className="hover:text-emerald-700 hover:underline underline-offset-4 transition-colors"
        >
          Inicio
        </Link>
        <Link
          href="/admin/login"
          className="hover:text-emerald-700 hover:underline underline-offset-4 transition-colors"
        >
          Admin
        </Link>
        <Link
          href="/privacy"
          className="hover:text-emerald-700 hover:underline underline-offset-4 transition-colors"
        >
          Privacidad
        </Link>
        <Link
          href="/terms"
          className="hover:text-emerald-700 hover:underline underline-offset-4 transition-colors"
        >
          Terminos
        </Link>
      </footer>
    </div>
  )
}
