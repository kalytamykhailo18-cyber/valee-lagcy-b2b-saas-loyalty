'use client'

import { useState } from 'react'
import Link from 'next/link'
import { api } from '@/lib/api'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    setError('')
    setLoading(true)
    try {
      await api.requestPasswordReset(email.trim())
      setSent(true)
    } catch (e: any) {
      setError(e?.error || 'No pudimos procesar la solicitud. Intenta de nuevo.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="min-h-screen bg-slate-50 flex flex-col">
      <header className="py-6 px-4 sm:px-8">
        <Link href="/" className="text-2xl font-extrabold text-indigo-700">Valee</Link>
      </header>
      <div className="flex-1 flex items-center justify-center px-4">
        <div className="w-full max-w-md bg-white rounded-2xl shadow-sm border border-slate-100 p-8">
          <h1 className="text-2xl font-bold text-slate-800">Recuperar contrasena</h1>
          <p className="text-sm text-slate-500 mt-2">
            Ingresa el correo con el que te registraste. Te enviaremos un enlace para elegir una contrasena nueva.
          </p>

          {sent ? (
            <div className="mt-6 space-y-4">
              <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-xl p-4 text-sm">
                Si esa cuenta existe, ya te enviamos un correo con el enlace. Revisa tu bandeja de entrada (y la carpeta de spam).
              </div>
              <Link href="/merchant/login" className="block text-center text-sm text-emerald-700 font-semibold">
                Volver a iniciar sesion
              </Link>
            </div>
          ) : (
            <div className="mt-6 space-y-4">
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="tu@comercio.com"
                className="w-full px-4 py-3 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
              {error && <p className="text-sm text-rose-600">{error}</p>}
              <button
                onClick={submit}
                disabled={loading || !email}
                className="w-full bg-emerald-600 text-white py-3 rounded-xl font-semibold text-sm hover:bg-emerald-700 disabled:opacity-50"
              >
                {loading ? 'Enviando...' : 'Enviar enlace'}
              </button>
              <p className="text-center text-sm text-slate-500 pt-1">
                <Link href="/merchant/login" className="underline underline-offset-2 hover:text-emerald-700">Volver a iniciar sesion</Link>
              </p>
            </div>
          )}
        </div>
      </div>
    </main>
  )
}
