'use client'

import { useState, useEffect } from 'react'
import { MdCardGiftcard } from 'react-icons/md'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { api } from '@/lib/api'

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
  const [authenticated, setAuthenticated] = useState(false)
  const [merchants, setMerchants] = useState<MerchantAccount[]>([])
  const [totalBalance, setTotalBalance] = useState('0')
  const [phoneNumber, setPhoneNumber] = useState('')
  const [displayName, setDisplayName] = useState<string | null>(null)
  const [affiliated, setAffiliated] = useState<AffiliatedMerchant[]>([])

  useEffect(() => { load() }, [])

  // Re-check auth when the tab becomes visible or the page is restored from
  // bfcache (back/forward swipe). Without this, swiping back after logout
  // shows the previous authenticated view.
  useEffect(() => {
    const recheck = () => {
      const t = localStorage.getItem('accessToken')
      if (!t && authenticated) window.location.reload()
    }
    const onVis = () => { if (document.visibilityState === 'visible') recheck() }
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) recheck() }
    const onStorage = (e: StorageEvent) => { if (e.key === 'accessToken') recheck() }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('pageshow', onShow)
    window.addEventListener('storage', onStorage)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('pageshow', onShow)
      window.removeEventListener('storage', onStorage)
    }
  }, [authenticated])

  async function load() {
    const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null
    if (token) {
      try {
        const data = await api.getAllAccounts()
        setAuthenticated(true)
        setMerchants(data.merchants)
        setTotalBalance(data.totalBalance)
        setPhoneNumber(data.phoneNumber)
        setDisplayName(data.displayName || null)
        setLoading(false)
        return
      } catch {
        localStorage.removeItem('accessToken')
        localStorage.removeItem('refreshToken')
      }
    }
    try {
      const aff = await api.getAffiliatedMerchants()
      setAffiliated(aff.merchants)
    } catch {}
    setLoading(false)
  }

  function logout() {
    localStorage.removeItem('accessToken')
    localStorage.removeItem('refreshToken')
    // Hard navigation clears the bfcache so swiping back won't resurrect
    // the authenticated page.
    window.location.href = '/'
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="w-12 h-12 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  // ============================================================
  // AUTHENTICATED — Multicommerce dashboard
  // ============================================================
  if (authenticated) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-indigo-50 via-white to-white">
        {/* Header */}
        <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between">
            <div>
              <Link
                href="/"
                className="inline-block text-2xl font-extrabold tracking-tight text-indigo-700 hover:text-indigo-800 transition-colors"
              >
                Valee
              </Link>
              <p className="text-xs text-slate-400 mt-0.5">{phoneNumber}</p>
            </div>
            <button
              onClick={logout}
              className="text-sm font-medium text-slate-500 hover:text-indigo-700 hover:underline underline-offset-4 transition-colors"
            >
              Cerrar sesion
            </button>
          </div>
        </header>

        {/* Main content */}
        <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6 lg:py-10">
          {/* Greeting */}
          <div className="mb-4 lg:mb-6 aa-rise-sm">
            <h1 className="text-2xl sm:text-3xl font-bold text-slate-800 tracking-tight">
              Hola{displayName ? `, ${displayName}` : ''}
            </h1>
          </div>

          {/* Total balance card */}
          <section className="bg-gradient-to-br from-indigo-600 to-indigo-800 rounded-3xl p-6 sm:p-8 lg:p-10 text-white shadow-xl aa-rise">
            <p className="text-indigo-200 text-sm sm:text-base">Tu saldo total</p>
            <p key={totalBalance} className="text-5xl sm:text-6xl lg:text-7xl font-bold mt-2 tracking-tight aa-count tabular-nums">
              {Math.round(parseFloat(totalBalance)).toLocaleString()}
            </p>
            <p className="text-indigo-200 text-sm sm:text-base mt-2">
              puntos en {merchants.length} comercio{merchants.length !== 1 ? 's' : ''}
            </p>
          </section>

          {merchants.length === 0 ? (
            <div className="mt-8 bg-white rounded-2xl p-8 text-center border border-slate-200">
              <p className="text-slate-600 mb-2 font-medium">Aun no estas registrado en ningun comercio.</p>
              <p className="text-sm text-slate-400">
                Visita un comercio Valee y escanea su QR para empezar a ganar puntos.
              </p>
            </div>
          ) : (
            <section className="mt-8 lg:mt-12">
              <h2 className="text-slate-700 font-semibold text-sm uppercase tracking-wider mb-4">
                Tus comercios
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-2 gap-4 lg:gap-6">
                {merchants.map((m, i) => (
                  <div
                    key={m.accountId}
                    className="aa-card aa-row-in bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden"
                    style={{ animationDelay: `${Math.min(i * 60, 360)}ms` }}
                  >
                    <div className="p-5 flex items-center justify-between border-b border-slate-100">
                      <div>
                        <p className="font-bold text-slate-800 text-lg">{m.tenantName}</p>
                        <p className="text-sm text-indigo-600 font-semibold mt-0.5">
                          {Math.round(parseFloat(m.balance)).toLocaleString()} {m.unitLabel}
                        </p>
                      </div>
                      <button
                        onClick={() => {
                          router.push(`/consumer?tenant=${m.tenantSlug}`)
                        }}
                        className="aa-btn text-sm bg-indigo-50 text-indigo-700 px-4 py-2 rounded-lg font-medium hover:bg-indigo-100"
                      >
                        Ver detalle
                      </button>
                    </div>

                    {m.topProducts.length > 0 && (
                      <div className="p-5">
                        <p className="text-xs text-slate-400 uppercase tracking-wider mb-3">
                          Top recompensas
                        </p>
                        <div className="grid grid-cols-3 gap-3">
                          {m.topProducts.map(p => {
                            const canAfford = Number(m.balance) >= Number(p.redemptionCost)
                            return (
                              <div
                                key={p.id}
                                onClick={() => router.push(`/consumer?tenant=${m.tenantSlug}`)}
                                className={`bg-slate-50 rounded-xl p-3 text-center cursor-pointer hover:bg-indigo-50 transition ${canAfford ? '' : 'opacity-50 grayscale'}`}
                              >
                                {p.photoUrl ? (
                                  <img
                                    src={p.photoUrl}
                                    alt={p.name}
                                    className="w-full h-20 object-cover rounded-lg mb-2"
                                  />
                                ) : (
                                  <div className="w-full h-20 bg-slate-200 rounded-lg mb-2 flex items-center justify-center text-3xl">
                                    <MdCardGiftcard className="w-8 h-8 text-slate-400" />
                                  </div>
                                )}
                                <p className="text-xs font-medium text-slate-700 line-clamp-2 mb-1">
                                  {p.name}
                                </p>
                                <p className="text-xs text-indigo-600 font-bold">
                                  {Math.round(parseFloat(p.redemptionCost)).toLocaleString()} pts
                                </p>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
        </main>

        <footer className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 text-center text-sm font-medium text-slate-500 border-t border-slate-200 mt-12 space-x-6">
          <Link
            href="/merchant/login"
            className="hover:text-indigo-700 hover:underline underline-offset-4 transition-colors"
          >
            Acceso comercio
          </Link>
          <Link
            href="/merchant/signup"
            className="hover:text-indigo-700 hover:underline underline-offset-4 transition-colors"
          >
            Registra tu comercio
          </Link>
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
    )
  }

  // ============================================================
  // PUBLIC — Welcoming landing
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
                className="inline-block bg-white text-indigo-700 font-semibold text-base py-3 px-8 rounded-xl hover:bg-indigo-50 transition-colors shadow-lg"
              >
                Ya tengo cuenta
              </Link>
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
              Ya tengo cuenta
            </Link>
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
              href="/merchant/login"
              className="hover:text-indigo-700 hover:underline underline-offset-4 transition-colors"
            >
              Acceso comercio
            </Link>
            <Link
              href="/merchant/signup"
              className="hover:text-indigo-700 hover:underline underline-offset-4 transition-colors"
            >
              Registrar comercio
            </Link>
            <Link
              href="/admin/login"
              className="hover:text-indigo-700 hover:underline underline-offset-4 transition-colors"
            >
              Admin
            </Link>
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
