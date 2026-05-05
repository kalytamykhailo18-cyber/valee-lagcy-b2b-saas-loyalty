'use client'

import { useState } from 'react'
import { MdKey, MdCheckCircle } from 'react-icons/md'
import { api } from '@/lib/api'
import { setTokens } from '@/lib/token-store'

export default function AccountPage() {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  function validate(): string {
    if (!currentPassword) return 'Ingresa tu contrasena actual'
    if (newPassword.length < 6) return 'La nueva contrasena debe tener al menos 6 caracteres'
    if (newPassword === currentPassword) return 'La nueva contrasena debe ser diferente a la actual'
    if (newPassword !== confirmPassword) return 'La confirmacion no coincide con la nueva contrasena'
    return ''
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setSuccess(false)
    const v = validate()
    if (v) { setError(v); return }
    setSubmitting(true)
    try {
      const res: any = await api.changeStaffPassword(currentPassword, newPassword)
      if (res?.accessToken) {
        setTokens('staff', res.accessToken, res.refreshToken)
      }
      setSuccess(true)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (e: any) {
      setError(e?.message || 'No se pudo cambiar la contrasena')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="p-4 lg:p-6 max-w-xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl font-extrabold tracking-tight text-slate-900">Mi cuenta</h1>
        <p className="text-sm text-slate-500 mt-1">
          Cambia tu contrasena. Se cerrara la sesion en los otros dispositivos donde este abierta.
        </p>
      </header>

      <form onSubmit={onSubmit} className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div>
          <label className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Contrasena actual</label>
          <input
            type="password"
            value={currentPassword}
            onChange={e => setCurrentPassword(e.target.value)}
            className="w-full mt-1 px-3 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500"
            autoComplete="current-password"
          />
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Nueva contrasena</label>
          <input
            type="password"
            value={newPassword}
            onChange={e => setNewPassword(e.target.value)}
            className="w-full mt-1 px-3 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500"
            placeholder="min. 6 caracteres"
            autoComplete="new-password"
          />
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Confirmar nueva contrasena</label>
          <input
            type="password"
            value={confirmPassword}
            onChange={e => setConfirmPassword(e.target.value)}
            className="w-full mt-1 px-3 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500"
            autoComplete="new-password"
          />
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2 text-sm">
            {error}
          </div>
        )}
        {success && (
          <div className="bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-lg px-3 py-2 text-sm flex items-center gap-2">
            <MdCheckCircle className="w-5 h-5 flex-shrink-0" />
            <span>Listo, tu contrasena fue actualizada.</span>
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full bg-emerald-600 text-white py-3 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 hover:bg-emerald-700 transition disabled:opacity-60"
        >
          <MdKey className="w-5 h-5" />
          {submitting ? 'Guardando...' : 'Cambiar contrasena'}
        </button>
      </form>
    </div>
  )
}
