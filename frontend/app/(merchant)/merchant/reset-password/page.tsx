'use client'

import { Suspense, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { api } from '@/lib/api'

function ResetInner() {
  const router = useRouter()
  const sp = useSearchParams()
  const token = sp.get('token') || ''

  const [pw1, setPw1] = useState('')
  const [pw2, setPw2] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  async function submit() {
    setError('')
    if (pw1 !== pw2) { setError('Las contrasenas no coinciden'); return }
    if (pw1.length < 8) { setError('La contrasena debe tener al menos 8 caracteres'); return }
    setLoading(true)
    try {
      await api.confirmPasswordReset(token, pw1)
      setDone(true)
      setTimeout(() => router.push('/merchant/login'), 1500)
    } catch (e: any) {
      setError(e?.error || 'No pudimos restablecer la contrasena.')
    } finally {
      setLoading(false)
    }
  }

  if (!token) {
    return (
      <div className="text-center">
        <p className="text-rose-600">Enlace invalido.</p>
        <Link href="/merchant/forgot-password" className="mt-4 inline-block text-sm text-emerald-700 underline">Solicita uno nuevo</Link>
      </div>
    )
  }

  if (done) {
    return (
      <div className="text-center space-y-3">
        <div className="text-5xl">✓</div>
        <p className="text-lg font-bold text-slate-800">Contrasena actualizada</p>
        <p className="text-sm text-slate-500">Te estamos redirigiendo al login...</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-800">Nueva contrasena</h1>
      <p className="text-sm text-slate-500">Elige una contrasena nueva para tu cuenta.</p>
      <input
        type="password"
        value={pw1}
        onChange={e => setPw1(e.target.value)}
        placeholder="Nueva contrasena"
        className="w-full px-4 py-3 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
      />
      <input
        type="password"
        value={pw2}
        onChange={e => setPw2(e.target.value)}
        placeholder="Repite la contrasena"
        className="w-full px-4 py-3 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
      />
      {error && <p className="text-sm text-rose-600">{error}</p>}
      <button
        onClick={submit}
        disabled={loading || !pw1 || !pw2}
        className="w-full bg-emerald-600 text-white py-3 rounded-xl font-semibold text-sm hover:bg-emerald-700 disabled:opacity-50"
      >
        {loading ? 'Guardando...' : 'Guardar contrasena'}
      </button>
    </div>
  )
}

export default function ResetPasswordPage() {
  return (
    <main className="min-h-screen bg-slate-50 flex flex-col">
      <header className="py-6 px-4 sm:px-8">
        <Link href="/" className="text-2xl font-extrabold text-indigo-700">Valee</Link>
      </header>
      <div className="flex-1 flex items-center justify-center px-4">
        <div className="w-full max-w-md bg-white rounded-2xl shadow-sm border border-slate-100 p-8">
          <Suspense fallback={<div className="text-center text-slate-500">Cargando...</div>}>
            <ResetInner />
          </Suspense>
        </div>
      </div>
    </main>
  )
}
