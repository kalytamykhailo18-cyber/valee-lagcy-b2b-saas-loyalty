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
  const [affiliated, setAffiliated] = useState<AffiliatedMerchant[]>([])

  useEffect(() => { load() }, [])

  async function load() {
    const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null
    if (token) {
      try {
        const data = await api.getAllAccounts()
        setAuthenticated(true)
        setMerchants(data.merchants)
        setTotalBalance(data.totalBalance)
        setPhoneNumber(data.phoneNumber)
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
    setAuthenticated(false)
    setMerchants([])
    load()
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
              <h1 className="text-2xl font-bold text-indigo-700">Valee</h1>
              <p className="text-xs text-slate-400">{phoneNumber}</p>
            </div>
            <button
              onClick={logout}
              className="text-sm text-slate-500 hover:text-slate-700 underline"
            >
              Cerrar sesion
            </button>
          </div>
        </header>

        {/* Main content */}
        <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6 lg:py-10">
          {/* Total balance card */}
          <section className="bg-gradient-to-br from-indigo-600 to-indigo-800 rounded-3xl p-6 sm:p-8 lg:p-10 text-white shadow-xl">
            <p className="text-indigo-200 text-sm sm:text-base">Tu saldo total</p>
            <p className="text-5xl sm:text-6xl lg:text-7xl font-bold mt-2 tracking-tight">
              {parseFloat(totalBalance).toLocaleString()}
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
                {merchants.map(m => (
                  <div
                    key={m.accountId}
                    className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden hover:shadow-md transition-shadow"
                  >
                    <div className="p-5 flex items-center justify-between border-b border-slate-100">
                      <div>
                        <p className="font-bold text-slate-800 text-lg">{m.tenantName}</p>
                        <p className="text-sm text-indigo-600 font-semibold mt-0.5">
                          {parseFloat(m.balance).toLocaleString()} {m.unitLabel}
                        </p>
                      </div>
                      <button
                        onClick={() => {
                          localStorage.removeItem('accessToken')
                          localStorage.removeItem('refreshToken')
                          router.push(`/consumer?tenant=${m.tenantSlug}`)
                        }}
                        className="text-sm bg-indigo-50 text-indigo-700 px-4 py-2 rounded-lg font-medium hover:bg-indigo-100 transition-colors"
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
                                className={`bg-slate-50 rounded-xl p-3 text-center ${canAfford ? '' : 'opacity-50 grayscale'}`}
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
                                  {parseFloat(p.redemptionCost).toLocaleString()} pts
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

        <footer className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 text-center text-xs text-slate-400 border-t border-slate-200 mt-12">
          <Link href="/merchant/login" className="hover:text-slate-600">
            Acceso comercio
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
          <div>
            <h1 className="text-5xl sm:text-6xl lg:text-7xl font-bold mb-4 tracking-tight">
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

          {/* Footer links */}
          <footer className="mt-10 pt-6 border-t border-slate-200 text-center text-xs text-slate-400 space-x-6">
            <Link href="/merchant/login" className="hover:text-slate-600">Acceso comercio</Link>
            <Link href="/admin/login" className="hover:text-slate-600">Admin</Link>
          </footer>
        </div>
      </div>
    </div>
  )
}
