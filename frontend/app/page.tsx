'use client'

import { useState, useEffect } from 'react'
import { MdCardGiftcard } from 'react-icons/md'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { api } from '@/lib/api'
import { getCurrentSessionIdentity, maskPhone } from '@/lib/session-identity'

interface MerchantAccount {
  accountId: string
  tenantId: string
  tenantName: string
  tenantSlug: string
  balance: string
  unitLabel: string
  topProducts: Array<{ id: string; name: string; photoUrl: string | null; redemptionCost: string; stock: number }>
}

interface AffiliatedMerchant {
  id: string
  name: string
  slug: string
  qrCodeUrl: string | null
}

export default function Home() {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [affiliated, setAffiliated] = useState<AffiliatedMerchant[]>([])
  const [hasSession, setHasSession] = useState(false)
  const [sessionPhone, setSessionPhone] = useState<string | null>(null)

  useEffect(() => {
    // `/` is ALWAYS the public landing page now. It does not auto-switch to
    // an authenticated view — that used to cause valee.app to open straight
    // into someone else's consumer dashboard on a shared computer. The
    // multicommerce hub lives at /consumer. We just record whether the user
    // has a session so we can swap the CTA copy from "Ya tengo cuenta" to
    // "Mi cuenta". When a session exists we also surface the phone number
    // (masked) so the user knows WHICH account they'll enter before clicking.
    if (typeof window !== 'undefined') {
      const token = localStorage.getItem('accessToken')
      setHasSession(!!token)
      if (token) {
        const ident = getCurrentSessionIdentity()
        setSessionPhone(ident?.phoneNumber || null)
      }
    }
    ;(async () => {
      try {
        const aff = await api.getAffiliatedMerchants()
        setAffiliated(aff.merchants)
      } catch {}
      setLoading(false)
    })()
  }, [])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="w-12 h-12 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  // ============================================================
  // PUBLIC — Welcoming landing (always shown; session-aware CTA)
  // ============================================================
  return (
    <div className="min-h-screen bg-gradient-to-b from-indigo-600 via-indigo-500 to-indigo-400">
      {/* Hero */}
      <div className="max-w-6xl mx-auto px-6 sm:px-8 lg:px-12 pt-12 lg:pt-24 pb-8 lg:pb-16 text-white">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-12 items-center">
          <div className="aa-rise">
            <h1 className="text-5xl sm:text-6xl lg:text-7xl font-extrabold mb-4 tracking-tight">
              Valee
            </h1>
            <p className="text-indigo-100 text-lg sm:text-xl lg:text-2xl leading-snug">
              Gana recompensas en tus comercios favoritos.
            </p>
            <p className="text-indigo-200 text-base sm:text-lg mt-2">
              Cada compra cuenta.
            </p>

            <div className="hidden lg:block mt-8">
              <Link
                href="/consumer"
                className="aa-btn inline-block bg-white text-indigo-700 font-semibold text-base py-3 px-8 rounded-xl hover:bg-indigo-50 shadow-lg"
              >
                <span className="relative z-10">
                  {hasSession
                    ? (sessionPhone ? `Entrar como ${maskPhone(sessionPhone)}` : 'Mi cuenta')
                    : 'Ya tengo cuenta'}
                </span>
              </Link>
              {hasSession && (
                <Link href="/consumer?switch=1" className="block text-xs text-indigo-100 hover:text-white mt-3 underline">
                  No soy yo — cambiar de cuenta
                </Link>
              )}
              <p className="text-xs text-indigo-200 mt-4 max-w-sm">
                Si nunca has visitado un comercio Valee, escanea el QR del comercio para empezar.
              </p>
            </div>
          </div>

          {/* Right column on desktop — phone mockup / how it works */}
          <div className="hidden lg:block">
            <div className="bg-white/10 backdrop-blur-sm rounded-3xl p-8 border border-white/20">
              <h2 className="text-white font-bold text-2xl mb-4">Como funciona</h2>
              <ol className="space-y-4 text-indigo-50">
                <li className="flex gap-4">
                  <span className="flex-shrink-0 w-8 h-8 bg-white/20 rounded-full flex items-center justify-center font-bold">1</span>
                  <span className="pt-1">Visita un comercio Valee y escanea su codigo QR</span>
                </li>
                <li className="flex gap-4">
                  <span className="flex-shrink-0 w-8 h-8 bg-white/20 rounded-full flex items-center justify-center font-bold">2</span>
                  <span className="pt-1">Envia foto de tu factura o paga con Pago Movil</span>
                </li>
                <li className="flex gap-4">
                  <span className="flex-shrink-0 w-8 h-8 bg-white/20 rounded-full flex items-center justify-center font-bold">3</span>
                  <span className="pt-1">Acumula puntos automaticamente</span>
                </li>
                <li className="flex gap-4">
                  <span className="flex-shrink-0 w-8 h-8 bg-white/20 rounded-full flex items-center justify-center font-bold">4</span>
                  <span className="pt-1">Canjea por productos directo desde la app</span>
                </li>
              </ol>
            </div>
          </div>
        </div>
      </div>

      {/* White content section */}
      <div className="bg-white rounded-t-3xl lg:rounded-t-[3rem]">
        <div className="max-w-6xl mx-auto px-6 sm:px-8 lg:px-12 pt-10 lg:pt-16 pb-12">
          {/* Mobile how it works — hidden on desktop (shown in hero above) */}
          <div className="lg:hidden mb-10">
            <h2 className="text-slate-800 font-bold text-2xl mb-4">Como funciona</h2>
            <ol className="space-y-3 text-base text-slate-600">
              <li className="flex gap-3">
                <span className="text-indigo-600 font-bold">1.</span>
                <span>Visita un comercio Valee y escanea su codigo QR</span>
              </li>
              <li className="flex gap-3">
                <span className="text-indigo-600 font-bold">2.</span>
                <span>Envia foto de tu factura o paga con Pago Movil</span>
              </li>
              <li className="flex gap-3">
                <span className="text-indigo-600 font-bold">3.</span>
                <span>Acumula puntos automaticamente</span>
              </li>
              <li className="flex gap-3">
                <span className="text-indigo-600 font-bold">4.</span>
                <span>Canjea por productos directo desde la app</span>
              </li>
            </ol>
          </div>

          {/* Affiliated merchants grid */}
          {affiliated.length > 0 && (
            <div className="mb-10">
              <h2 className="text-slate-800 font-bold text-2xl mb-6">
                Comercios afiliados
              </h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
                {affiliated.map(m => (
                  <div
                    key={m.id}
                    className="bg-slate-50 rounded-2xl p-4 text-center border border-slate-100 hover:border-indigo-200 hover:shadow-md transition-all"
                  >
                    <div className="w-14 h-14 bg-indigo-100 text-indigo-700 rounded-full mx-auto mb-3 flex items-center justify-center font-bold text-2xl">
                      {m.name.charAt(0)}
                    </div>
                    <p className="text-sm font-medium text-slate-700 line-clamp-2">
                      {m.name}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Mobile CTA — hidden on desktop */}
          <div className="lg:hidden">
            <Link
              href="/consumer"
              className="block bg-indigo-600 text-white text-center text-base py-4 rounded-2xl font-semibold hover:bg-indigo-700 transition-colors"
            >
              {hasSession
                ? (sessionPhone ? `Entrar como ${maskPhone(sessionPhone)}` : 'Mi cuenta')
                : 'Ya tengo cuenta'}
            </Link>
            {hasSession && (
              <Link href="/consumer?switch=1" className="block text-center text-xs text-slate-500 hover:text-slate-700 mt-2 underline">
                No soy yo — cambiar de cuenta
              </Link>
            )}
            <p className="text-xs text-slate-400 text-center mt-3">
              Si nunca has visitado un comercio Valee, escanea el QR del comercio para empezar.
            </p>
          </div>

          {/* Merchant signup CTA */}
          <div className="mt-8 bg-emerald-50 border border-emerald-200 rounded-2xl p-5 text-center">
            <p className="text-sm font-semibold text-emerald-800">Tienes un comercio?</p>
            <p className="text-xs text-emerald-700 mt-1 mb-3">Registra tu negocio en Valee gratis y empieza a fidelizar clientes.</p>
            <Link
              href="/merchant/signup"
              className="inline-block bg-emerald-600 text-white px-5 py-2.5 rounded-xl text-sm font-semibold hover:bg-emerald-700 transition"
            >
              Registra tu comercio
            </Link>
          </div>

          {/* Footer links */}
          <footer className="mt-10 pt-6 border-t border-slate-200 text-center text-sm font-medium text-slate-500 space-x-6">
            <Link
              href="/privacy"
              className="hover:text-indigo-700 hover:underline underline-offset-4 transition-colors"
            >
              Privacidad
            </Link>
            <Link
              href="/terms"
              className="hover:text-indigo-700 hover:underline underline-offset-4 transition-colors"
            >
              Terminos
            </Link>
          </footer>
        </div>
      </div>
    </div>
  )
}
