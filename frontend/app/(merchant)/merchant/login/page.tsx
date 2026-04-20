'use client'

import { useState } from 'react'
import { api } from '@/lib/api'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

export default function MerchantLogin() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  // Slug is only requested as a fallback when the email is shared across
  // multiple tenants. 99% of users never see this field.
  const [tenantSlug, setTenantSlug] = useState('')
  const [tenantOptions, setTenantOptions] = useState<{ slug: string; name: string }[] | null>(null)
  const [error, setError] = useState('')
  const [suspendedInfo, setSuspendedInfo] = useState<{ tenantName: string; message: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  async function handleLogin() {
    setError('')
    setSuspendedInfo(null)
    setLoading(true)
    try {
      const data = await api.merchantLogin(email, password, tenantSlug || undefined)
      const { setTokens } = await import('@/lib/token-store')
      setTokens('staff', data.accessToken, data.refreshToken)
      localStorage.setItem('staffRole', data.staff.role)
      localStorage.setItem('staffName', data.staff.name)
      // Pre-fetch tenant branding so header shows logo/name immediately
      try {
        const s = await api.getMerchantSettings()
        if (s?.name) localStorage.setItem('tenantName', s.name)
        if (s?.logoUrl) localStorage.setItem('tenantLogoUrl', s.logoUrl)
        else localStorage.removeItem('tenantLogoUrl')
      } catch {}
      router.push(data.staff.role === 'cashier' ? '/merchant/scanner' : '/merchant')
    } catch (e: any) {
      if (e?.requiresTenantSlug && Array.isArray(e.tenantOptions)) {
        setTenantOptions(e.tenantOptions)
        setError('Este email esta vinculado a varios comercios. Elige uno.')
      } else if (e?.tenantSuspended) {
        // Server confirmed correct password + suspended tenant. Show a
        // dedicated panel instead of the generic credentials error so the
        // owner knows it's not a wrong-password problem.
        setSuspendedInfo({ tenantName: e.tenantName || 'tu comercio', message: e.error })
      } else {
        setError(e.error || 'Credenciales invalidas')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-emerald-50">
      <header className="py-6 text-center aa-rise-sm">
        <Link
          href="/"
          className="inline-block text-3xl font-extrabold tracking-tight text-emerald-700 hover:text-emerald-800 transition-colors"
        >
          Valee
        </Link>
      </header>

      <main className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-sm space-y-6">
          <div className="text-center aa-rise" style={{ animationDelay: '80ms' }}>
            <h1 className="text-2xl font-bold text-slate-800 tracking-tight">Panel del comercio</h1>
            <p className="text-slate-500 mt-1 text-sm">Inicia sesion con tu cuenta de comercio</p>
          </div>
          <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-100 space-y-4 aa-rise" style={{ animationDelay: '160ms' }}>
            <div>
              <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Email</label>
              <input
                type="email"
                value={email}
                onChange={e => { setEmail(e.target.value); setTenantOptions(null); setTenantSlug('') }}
                onKeyDown={e => e.key === 'Enter' && handleLogin()}
                autoComplete="email"
                className="aa-field aa-field-emerald w-full mt-1 px-4 py-3 rounded-xl border border-slate-200 text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Contrasena</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleLogin()}
                autoComplete="current-password"
                className="aa-field aa-field-emerald w-full mt-1 px-4 py-3 rounded-xl border border-slate-200 text-sm"
              />
            </div>

            {/* Only shows up if the API replies that this email belongs to
                multiple tenants — the dueño normal nunca lo ve. */}
            {tenantOptions && tenantOptions.length > 0 && (
              <div className="aa-pop">
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Elige tu comercio</label>
                <select
                  value={tenantSlug}
                  onChange={e => setTenantSlug(e.target.value)}
                  className="aa-field aa-field-emerald w-full mt-1 px-4 py-3 rounded-xl border border-slate-200 text-sm bg-white"
                >
                  <option value="">Selecciona...</option>
                  {tenantOptions.map(t => (
                    <option key={t.slug} value={t.slug}>{t.name}</option>
                  ))}
                </select>
              </div>
            )}

            {suspendedInfo && (
              <div className="aa-pop bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-900 space-y-2">
                <p className="font-semibold">Cuenta suspendida</p>
                <p>
                  Tu cuenta del comercio <span className="font-semibold">{suspendedInfo.tenantName}</span> esta suspendida en este momento, por eso no podes entrar.
                </p>
                <p>
                  Para reactivarla, escribinos a{' '}
                  <a href="mailto:soporte@valee.app" className="font-semibold underline hover:text-amber-950">soporte@valee.app</a>
                  {' '}o contactanos por WhatsApp y te ayudamos a regularizar la cuenta.
                </p>
              </div>
            )}

            {error && !suspendedInfo && (
              <div className="aa-pop bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">{error}</div>
            )}
            <button
              onClick={handleLogin}
              disabled={loading || !email || !password || (!!tenantOptions && !tenantSlug)}
              className="aa-btn aa-btn-emerald w-full bg-emerald-600 text-white py-3 rounded-xl font-semibold text-sm hover:bg-emerald-700 disabled:opacity-50 flex items-center justify-center"
            >
              {loading && <span className="aa-spinner" />}<span className="relative z-10">{loading ? 'Ingresando...' : 'Ingresar'}</span>
            </button>
            <p className="text-center text-sm text-slate-500 pt-2">
              No tienes cuenta? <Link href="/merchant/signup" className="text-emerald-600 hover:text-emerald-800 font-semibold">Registra tu comercio</Link>
            </p>
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
