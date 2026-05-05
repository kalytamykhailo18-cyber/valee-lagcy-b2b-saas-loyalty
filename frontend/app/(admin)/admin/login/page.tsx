'use client'

import { useState } from 'react'
import { api } from '@/lib/api'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

export default function AdminLogin() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  async function handleLogin() {
    setError('')
    setLoading(true)
    try {
      const data = await api.adminLogin(email, password)
      const { setTokens } = await import('@/lib/token-store')
      setTokens('admin', data.accessToken, data.refreshToken)
      localStorage.setItem('adminName', data.admin.name)
      router.push('/admin')
    } catch (e: any) {
      setError(e.error || 'Credenciales invalidas')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-slate-800 to-slate-900">
      <header className="py-6 text-center aa-rise-sm">
        <Link
          href="/"
          className="inline-block text-3xl font-extrabold tracking-tight text-white hover:text-indigo-200 transition-colors"
        >
          Valee
        </Link>
      </header>

      <main className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-sm space-y-6">
          <div className="text-center aa-rise" style={{ animationDelay: '80ms' }}>
            <h1 className="text-2xl font-bold text-white tracking-tight">Administracion</h1>
            <p className="text-slate-400 mt-1 text-sm">Acceso restringido al equipo de plataforma</p>
          </div>
          <div className="bg-white rounded-2xl p-6 shadow-xl border border-slate-100 space-y-4 aa-rise" style={{ animationDelay: '160ms' }}>
            <div>
              <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Email</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleLogin()}
                className="aa-field w-full mt-1 px-4 py-3 rounded-xl border border-slate-200 text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleLogin()}
                className="aa-field w-full mt-1 px-4 py-3 rounded-xl border border-slate-200 text-sm"
              />
            </div>
            {error && (
              <div className="aa-pop bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">{error}</div>
            )}
            <button
              onClick={handleLogin}
              disabled={loading || !email || !password}
              className="aa-btn aa-btn-primary w-full bg-indigo-600 text-white py-3 rounded-xl font-semibold text-sm hover:bg-indigo-700 disabled:opacity-50 flex items-center justify-center"
            >
              {loading && <span className="aa-spinner" />}<span className="relative z-10">{loading ? 'Ingresando...' : 'Ingresar'}</span>
            </button>
          </div>
        </div>
      </main>

      <footer className="py-8 text-center text-sm font-medium text-slate-400 space-x-6">
        <Link
          href="/"
          className="hover:text-indigo-300 hover:underline underline-offset-4 transition-colors"
        >
          Inicio
        </Link>
        <Link
          href="/merchant/login"
          className="hover:text-indigo-300 hover:underline underline-offset-4 transition-colors"
        >
          Acceso comercio
        </Link>
        <Link
          href="/privacy"
          className="hover:text-indigo-300 hover:underline underline-offset-4 transition-colors"
        >
          Privacidad
        </Link>
        <Link
          href="/terms"
          className="hover:text-indigo-300 hover:underline underline-offset-4 transition-colors"
        >
          Terminos
        </Link>
      </footer>
    </div>
  )
}
