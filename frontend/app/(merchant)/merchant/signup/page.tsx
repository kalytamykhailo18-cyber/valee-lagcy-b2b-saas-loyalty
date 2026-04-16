'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { api } from '@/lib/api'

export default function MerchantSignup() {
  const router = useRouter()
  const [form, setForm] = useState({
    businessName: '',
    slug: '',
    ownerName: '',
    ownerEmail: '',
    password: '',
    confirmPassword: '',
    rif: '',
    contactPhone: '',
    address: '',
    description: '',
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [topError, setTopError] = useState('')

  // Auto-derive slug from business name
  function setBusinessName(v: string) {
    const newForm: any = { ...form, businessName: v }
    // Only auto-fill slug if user hasn't manually typed one
    if (!form.slug || form.slug === slugify(form.businessName)) {
      newForm.slug = slugify(v)
    }
    setForm(newForm)
  }

  function slugify(s: string): string {
    return s
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 50)
  }

  function validate(): boolean {
    const e: Record<string, string> = {}
    if (!form.businessName.trim() || form.businessName.trim().length < 2) e.businessName = 'Minimo 2 caracteres'
    // Slug is now hidden — server auto-derives it from businessName.
    if (!form.ownerName.trim() || form.ownerName.trim().length < 2) e.ownerName = 'Nombre del propietario obligatorio'
    if (!form.ownerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.ownerEmail)) e.ownerEmail = 'Email invalido'
    if (!form.password || form.password.length < 8) e.password = 'Minimo 8 caracteres'
    if (form.password !== form.confirmPassword) e.confirmPassword = 'Las contrasenas no coinciden'
    if (form.contactPhone.trim()) {
      const digits = form.contactPhone.replace(/\D/g, '')
      if (digits.length < 10 || digits.length > 15) {
        e.contactPhone = 'Debe tener entre 10 y 15 digitos'
      }
    }
    setErrors(e)
    return Object.keys(e).length === 0
  }

  async function handleSubmit(ev: React.FormEvent) {
    ev.preventDefault()
    setTopError('')
    if (!validate()) {
      setTopError('Corrige los campos marcados en rojo')
      return
    }
    setSubmitting(true)
    try {
      const res = await api.merchantSignup({
        businessName: form.businessName.trim(),
        // Optional: backend auto-generates from businessName when omitted.
        slug: form.slug || undefined,
        ownerName: form.ownerName.trim(),
        ownerEmail: form.ownerEmail.trim(),
        password: form.password,
        contactPhone: form.contactPhone.trim() || undefined,
        address: form.address.trim() || undefined,
        description: form.description.trim() || undefined,
      })
      // Auto-login
      localStorage.setItem('accessToken', res.accessToken)
      localStorage.setItem('refreshToken', res.refreshToken)
      localStorage.setItem('staffRole', res.staff.role)
      localStorage.setItem('staffName', res.staff.name)
      localStorage.setItem('tenantName', res.tenant.name)
      router.push('/merchant')
    } catch (e: any) {
      setTopError(e?.error || e?.message || 'Error al crear cuenta')
    } finally {
      setSubmitting(false)
    }
  }

  function field(name: keyof typeof form, label: string, type: string = 'text', placeholder?: string, required?: boolean) {
    return (
      <div>
        <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">
          {label} {required && <span className="text-red-500">*</span>}
        </label>
        <input
          type={type}
          value={form[name]}
          onChange={e => { setForm({ ...form, [name]: e.target.value }); if (errors[name]) setErrors({ ...errors, [name]: '' }) }}
          placeholder={placeholder}
          className={`w-full mt-1 px-3 py-2.5 rounded-lg border text-sm focus:outline-none focus:ring-2 ${errors[name] ? 'border-red-300 focus:ring-red-400' : 'aa-field aa-field-emerald border-slate-200'}`}
        />
        {errors[name] && <p className="text-red-500 text-xs mt-1">{errors[name]}</p>}
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col bg-emerald-50">
      <header className="py-6 text-center aa-rise-sm">
        <Link href="/" className="inline-block text-3xl font-extrabold tracking-tight text-emerald-700 hover:text-emerald-800 transition-colors">
          Valee
        </Link>
        <p className="text-sm text-slate-500 mt-1">Crea tu cuenta de comercio</p>
      </header>

      <main className="flex-1 flex items-start justify-center p-4 pb-16">
        <form onSubmit={handleSubmit} className="w-full max-w-2xl bg-white rounded-2xl p-6 lg:p-8 shadow-sm border border-slate-100 space-y-5 aa-rise" style={{ animationDelay: '80ms' }}>
          <h1 className="text-2xl font-bold text-slate-800 tracking-tight">Registra tu comercio</h1>
          <p className="text-sm text-slate-500">Completa los datos basicos para empezar a usar Valee. Despues podras configurar mas opciones desde tu panel.</p>

          {topError && (
            <div className="aa-pop bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">{topError}</div>
          )}

          <section className="space-y-4">
            <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wide pt-2 border-t border-slate-100">Datos del comercio</h2>
            <div>
              <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Nombre del comercio <span className="text-red-500">*</span></label>
              <input
                type="text"
                value={form.businessName}
                onChange={e => { setBusinessName(e.target.value); if (errors.businessName) setErrors({ ...errors, businessName: '' }) }}
                placeholder="Ej: Farmacia Central"
                className={`w-full mt-1 px-3 py-2.5 rounded-lg border text-sm focus:outline-none focus:ring-2 ${errors.businessName ? 'border-red-300 focus:ring-red-400' : 'aa-field aa-field-emerald border-slate-200'}`}
              />
              {errors.businessName && <p className="text-red-500 text-xs mt-1">{errors.businessName}</p>}
            </div>
            {/* The slug (URL identifier) is auto-derived from businessName by
                the backend. The owner can rename it later from Configuracion if
                needed. We keep it in form state so the auto-derivation logic
                still runs in setBusinessName, but we don't render the input. */}
            {field('contactPhone', 'Telefono de contacto (opcional)', 'tel', '0414-1234567')}
            {field('address', 'Direccion (opcional)', 'text', 'Av. Principal, Valencia')}
            <div>
              <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Descripcion (opcional)</label>
              <textarea
                value={form.description}
                onChange={e => setForm({ ...form, description: e.target.value })}
                maxLength={500}
                placeholder="Breve descripcion de tu comercio"
                className="aa-field aa-field-emerald w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm h-20 resize-none"
              />
            </div>
          </section>

          <section className="space-y-4">
            <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wide pt-2 border-t border-slate-100">Tu cuenta</h2>
            {field('ownerName', 'Tu nombre', 'text', 'Juan Perez', true)}
            {field('ownerEmail', 'Email', 'email', 'tu@email.com', true)}
            {field('password', 'Contrasena', 'password', 'Minimo 8 caracteres', true)}
            {field('confirmPassword', 'Confirmar contrasena', 'password', 'Repite la contrasena', true)}
          </section>

          <button
            type="submit"
            disabled={submitting}
            className="aa-btn aa-btn-emerald w-full bg-emerald-600 text-white py-3 rounded-xl font-semibold disabled:opacity-50 hover:bg-emerald-700 flex items-center justify-center"
          >
            {submitting && <span className="aa-spinner" />}<span className="relative z-10">{submitting ? 'Creando cuenta...' : 'Crear mi comercio'}</span>
          </button>

          <p className="text-center text-sm text-slate-500">
            Ya tienes una cuenta? <Link href="/merchant/login" className="text-emerald-600 hover:text-emerald-800 font-semibold">Inicia sesion</Link>
          </p>
        </form>
      </main>
    </div>
  )
}
