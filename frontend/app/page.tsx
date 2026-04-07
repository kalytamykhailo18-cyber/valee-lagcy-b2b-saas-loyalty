'use client'

import { useState, useEffect } from 'react'
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
        // Invalid token — fall through to public landing
        localStorage.removeItem('accessToken')
        localStorage.removeItem('refreshToken')
      }
    }
    // Public landing
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
  // AUTHENTICATED VIEW: Multicommerce dashboard
  // ============================================================
  if (authenticated) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-indigo-50 to-white">
        <header className="bg-white shadow-sm p-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-indigo-700">Valee</h1>
            <p className="text-xs text-slate-400">{phoneNumber}</p>
          </div>
          <button onClick={logout} className="text-xs text-slate-500 underline">Cerrar sesion</button>
        </header>

        {/* Total balance card */}
        <div className="mx-4 mt-4 bg-gradient-to-br from-indigo-600 to-indigo-800 rounded-2xl p-6 text-white shadow-lg">
          <p className="text-indigo-200 text-sm">Tu saldo total</p>
          <p className="text-5xl font-bold mt-2">{parseFloat(totalBalance).toLocaleString()}</p>
          <p className="text-indigo-200 text-sm mt-1">puntos en {merchants.length} comercio{merchants.length !== 1 ? 's' : ''}</p>
        </div>

        {merchants.length === 0 ? (
          <div className="mx-4 mt-6 bg-white rounded-2xl p-6 text-center">
            <p className="text-slate-500 mb-4">Aun no estas registrado en ningun comercio.</p>
            <p className="text-sm text-slate-400">Visita un comercio Valee y escanea su QR para empezar a ganar puntos.</p>
          </div>
        ) : (
          <div className="px-4 mt-6 space-y-4 pb-8">
            <h2 className="font-semibold text-slate-700 text-sm uppercase tracking-wide">Tus comercios</h2>
            {merchants.map(m => (
              <div key={m.accountId} className="bg-white rounded-2xl shadow-sm overflow-hidden">
                <div className="p-4 flex items-center justify-between border-b border-slate-100">
                  <div>
                    <p className="font-semibold text-slate-800">{m.tenantName}</p>
                    <p className="text-xs text-slate-400">{parseFloat(m.balance).toLocaleString()} {m.unitLabel}</p>
                  </div>
                  <button
                    onClick={() => {
                      // Switch session to this tenant by re-logging
                      localStorage.removeItem('accessToken')
                      localStorage.removeItem('refreshToken')
                      router.push(`/consumer?tenant=${m.tenantSlug}`)
                    }}
                    className="text-xs bg-indigo-50 text-indigo-700 px-3 py-1.5 rounded-lg font-medium"
                  >Ver detalle →</button>
                </div>

                {m.topProducts.length > 0 && (
                  <div className="p-4">
                    <p className="text-xs text-slate-400 uppercase tracking-wide mb-2">Top recompensas</p>
                    <div className="grid grid-cols-3 gap-2">
                      {m.topProducts.map(p => {
                        const canAfford = Number(m.balance) >= Number(p.redemptionCost)
                        return (
                          <div key={p.id} className={`bg-slate-50 rounded-xl p-2 text-center ${canAfford ? '' : 'opacity-50'}`}>
                            {p.photoUrl ? (
                              <img src={p.photoUrl} alt={p.name} className="w-full h-16 object-cover rounded-lg mb-1" />
                            ) : (
                              <div className="w-full h-16 bg-slate-200 rounded-lg mb-1 flex items-center justify-center text-2xl">🎁</div>
                            )}
                            <p className="text-xs font-medium text-slate-700 line-clamp-2">{p.name}</p>
                            <p className="text-xs text-indigo-600 font-bold mt-0.5">{parseFloat(p.redemptionCost).toLocaleString()} pts</p>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <footer className="mt-8 p-4 text-center text-xs text-slate-400">
          <Link href="/merchant/login" className="underline">Acceso comercio</Link>
        </footer>
      </div>
    )
  }

  // ============================================================
  // PUBLIC VIEW: Welcoming landing with affiliated merchants
  // ============================================================
  return (
    <div className="min-h-screen bg-gradient-to-b from-indigo-600 via-indigo-500 to-indigo-400 text-white">
      <div className="px-6 pt-12 pb-8">
        <h1 className="text-5xl font-bold mb-3">Valee</h1>
        <p className="text-indigo-100 text-lg leading-snug">
          Gana recompensas en tus comercios favoritos.<br />
          Cada compra cuenta.
        </p>
      </div>

      <div className="bg-white rounded-t-3xl px-6 pt-8 pb-12 min-h-[60vh]">
        <div className="space-y-6">
          <div>
            <h2 className="text-slate-800 font-bold text-xl mb-2">Como funciona</h2>
            <ol className="space-y-3 text-sm text-slate-600">
              <li className="flex gap-3"><span className="text-indigo-600 font-bold">1.</span><span>Visita un comercio Valee y escanea su codigo QR</span></li>
              <li className="flex gap-3"><span className="text-indigo-600 font-bold">2.</span><span>Envia foto de tu factura o paga con Pago Movil</span></li>
              <li className="flex gap-3"><span className="text-indigo-600 font-bold">3.</span><span>Acumula puntos automaticamente</span></li>
              <li className="flex gap-3"><span className="text-indigo-600 font-bold">4.</span><span>Canjea por productos directo desde la app</span></li>
            </ol>
          </div>

          {affiliated.length > 0 && (
            <div>
              <h2 className="text-slate-800 font-bold text-xl mb-3">Comercios afiliados</h2>
              <div className="grid grid-cols-2 gap-3">
                {affiliated.map(m => (
                  <div key={m.id} className="bg-slate-50 rounded-xl p-4 text-center">
                    <div className="w-12 h-12 bg-indigo-100 text-indigo-700 rounded-full mx-auto mb-2 flex items-center justify-center font-bold text-lg">
                      {m.name.charAt(0)}
                    </div>
                    <p className="text-xs font-medium text-slate-700 line-clamp-2">{m.name}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="pt-4">
            <Link href="/consumer" className="block bg-indigo-600 text-white text-center py-4 rounded-xl font-medium">
              Ya tengo cuenta
            </Link>
            <p className="text-xs text-slate-400 text-center mt-3">
              Si nunca has visitado un comercio Valee, escanea el QR del comercio para empezar.
            </p>
          </div>

          <footer className="pt-8 text-center text-xs text-slate-400 space-x-4">
            <Link href="/merchant/login" className="underline">Acceso comercio</Link>
            <Link href="/admin/login" className="underline">Admin</Link>
          </footer>
        </div>
      </div>
    </div>
  )
}
