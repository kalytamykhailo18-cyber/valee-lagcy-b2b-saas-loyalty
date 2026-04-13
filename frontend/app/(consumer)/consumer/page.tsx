'use client'

import { useState, useEffect, useCallback, Suspense } from 'react'
import { MdCameraAlt, MdCardGiftcard, MdAssignment, MdLock, MdStarRate, MdChevronRight, MdLocalOffer } from 'react-icons/md'
import { useRouter, useSearchParams } from 'next/navigation'
import { api } from '@/lib/api'
import Link from 'next/link'
import { getLocalPendingBalance, getPendingCount, syncPendingActions, purgeExpiredActions, type QueuedAction } from '@/lib/offline-queue'
import { useOnlineStatus } from '@/lib/use-online-status'

type Screen = 'loading' | 'login' | 'otp' | 'main'

// Default export wraps the inner component in Suspense so useSearchParams works
// inside a statically-rendered route without breaking the build.
export default function ConsumerAppPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="w-12 h-12 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    }>
      <ConsumerApp />
    </Suspense>
  )
}

interface HistoryEntry {
  id: string
  eventType: string
  entryType: string
  amount: string
  status: string
  referenceId: string
  createdAt: string
  merchantName: string | null
}

const EVENT_LABELS: Record<string, string> = {
  INVOICE_CLAIMED: 'Factura validada',
  REDEMPTION_PENDING: 'Canje pendiente',
  REDEMPTION_CONFIRMED: 'Canje procesado',
  REDEMPTION_EXPIRED: 'Canje expirado',
  REVERSAL: 'Reverso',
  ADJUSTMENT_MANUAL: 'Ajuste manual',
  TRANSFER_P2P: 'Transferencia',
}

function ConsumerApp() {
  const router = useRouter()
  const searchParams = useSearchParams()
  // Accept both ?merchant= and ?tenant= for backwards compat with the home page
  // and external links/QRs that use either name.
  const merchantSlugFromUrl = searchParams.get('merchant') || searchParams.get('tenant') || ''

  // Always start with 'loading' to avoid login page flash during SSR hydration.
  // The useEffect below checks localStorage and sets the real screen.
  const [screen, setScreen] = useState<Screen>('loading')
  const [phoneNumber, setPhoneNumber] = useState('')
  const [otp, setOtp] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const [balance, setBalance] = useState('0')
  const [confirmedBalance, setConfirmedBalance] = useState('0')
  const [provisionalBalance, setProvisionalBalance] = useState('0')
  const [unitLabel, setUnitLabel] = useState('points')
  const [assetTypeId, setAssetTypeId] = useState('')
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [account, setAccount] = useState<any>(null)
  const [products, setProducts] = useState<any[]>([])
  const [showWelcome, setShowWelcome] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)

  const handleSync = useCallback(async () => {
    const count = getPendingCount()
    if (count === 0) return
    try {
      await syncPendingActions(async (action: QueuedAction) => {
        if (action.type === 'redeem_product') {
          return await api.redeemProduct(action.payload.productId, action.payload.assetTypeId)
        }
        throw new Error('Unknown action type')
      })
      loadData()
    } catch {}
    setPendingCount(getPendingCount())
  }, [])

  const isOnline = useOnlineStatus(handleSync)

  function logEvent(event: string, detail?: string) {
    try { fetch('/api/consumer/log-event', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(localStorage.getItem('accessToken') ? { Authorization: `Bearer ${localStorage.getItem('accessToken')}` } : {}) }, body: JSON.stringify({ event, detail }) }) } catch {}
  }

  useEffect(() => {
    const token = localStorage.getItem('accessToken')
    logEvent('page_mount', `hasToken=${!!token} slug=${merchantSlugFromUrl || '(none)'}`)

    if (token) {
      if (merchantSlugFromUrl) {
        logEvent('selectMerchant_start', merchantSlugFromUrl)
        ;(async () => {
          try {
            const data = await api.selectMerchant(merchantSlugFromUrl)
            localStorage.setItem('accessToken', data.accessToken)
            localStorage.setItem('refreshToken', data.refreshToken)
            logEvent('selectMerchant_ok', merchantSlugFromUrl)
            setScreen('main')
            loadData()
          } catch (e: any) {
            logEvent('selectMerchant_fail', e?.message || e?.error || 'unknown')
            localStorage.removeItem('accessToken')
            localStorage.removeItem('refreshToken')
            setScreen('login')
          }
        })()
      } else {
        logEvent('loadData_direct', 'no slug, trying existing token')
        setScreen('main')
        loadData()
      }
    } else {
      setScreen('login')
    }
    purgeExpiredActions()
    setPendingCount(getPendingCount())
  }, [merchantSlugFromUrl])

  async function loadData() {
    try {
      const [balData, histData, accData, catData] = await Promise.all([
        api.getBalance(),
        api.getHistory(),
        api.getAccount(),
        api.getCatalog(50, 0),
      ])
      setBalance(balData.balance)
      setConfirmedBalance(balData.confirmed || balData.balance)
      setProvisionalBalance(balData.provisional || '0')
      setUnitLabel(balData.unitLabel)
      setAssetTypeId(balData.assetTypeId)
      if (balData.assetTypeId) localStorage.setItem('assetTypeId', balData.assetTypeId)
      setHistory(histData.entries)
      setAccount(accData)
      setProducts(catData.products || [])

      if (!localStorage.getItem('welcomeDismissed') && histData.entries.length === 0) {
        setShowWelcome(true)
      }
    } catch (err: any) {
      logEvent('loadData_fail', `err=${err?.message || err?.error || 'unknown'}`)
      // Token is invalid or expired and refresh failed — clear and show login
      localStorage.removeItem('accessToken')
      localStorage.removeItem('refreshToken')
      setScreen('login')
    }
  }

  async function handleRequestOTP() {
    setError('')
    setLoading(true)
    try {
      await api.requestOTP(phoneNumber)
      setScreen('otp')
    } catch (e: any) {
      setError(e.error || 'Error sending OTP')
    } finally {
      setLoading(false)
    }
  }

  async function handleVerifyOTP() {
    setError('')
    setLoading(true)
    try {
      // Tenantless verify → global token. If we landed here from a merchant URL
      // we still want to show the per-merchant view, so call selectMerchant
      // immediately to upgrade the token.
      const data = await api.verifyOTP(phoneNumber, otp)
      localStorage.setItem('accessToken', data.accessToken)
      localStorage.setItem('refreshToken', data.refreshToken)
      logEvent('verify_otp_ok', `scope=${data.scope} slug=${merchantSlugFromUrl || '(none)'}`)

      if (merchantSlugFromUrl) {
        try {
          const upgraded = await api.selectMerchant(merchantSlugFromUrl)
          localStorage.setItem('accessToken', upgraded.accessToken)
          localStorage.setItem('refreshToken', upgraded.refreshToken)
          setScreen('main')
          loadData()
          return
        } catch {
          // Fall through to multicommerce landing
        }
      }
      window.location.href = '/'
    } catch (e: any) {
      setError(e.error || 'Invalid OTP')
    } finally {
      setLoading(false)
    }
  }

  function dismissWelcome() {
    setShowWelcome(false)
    localStorage.setItem('welcomeDismissed', 'true')
  }

  function logout() {
    localStorage.removeItem('accessToken')
    localStorage.removeItem('refreshToken')
    setScreen('login')
    setBalance('0')
    setHistory([])
  }

  // ---- LOADING SCREEN (checking token) ----
  if (screen === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="w-12 h-12 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  // ---- LOGIN SCREEN ----
  if (screen === 'login') {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="w-full max-w-sm space-y-6">
          <div className="text-center">
            <h1 className="text-3xl font-extrabold tracking-tight text-indigo-700">Valee</h1>
            <p className="text-slate-500 mt-2">Ingresa tu numero para comenzar</p>
          </div>
          <div className="space-y-4">
            <input
              type="tel" placeholder="+58 412 1234567"
              value={phoneNumber} onChange={e => setPhoneNumber(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && phoneNumber && handleRequestOTP()}
              className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            {error && <p className="text-red-500 text-sm">{error}</p>}
            <button
              onClick={handleRequestOTP} disabled={loading || !phoneNumber}
              className="w-full bg-indigo-600 text-white py-3 rounded-xl font-semibold hover:bg-indigo-700 disabled:opacity-50 transition"
            >
              {loading ? 'Enviando...' : 'Enviar codigo OTP'}
            </button>
            <p className="text-xs text-slate-400 text-center pt-2">
              Recibiras un codigo por WhatsApp para verificar tu numero.
            </p>
          </div>
        </div>
      </div>
    )
  }

  // ---- OTP SCREEN ----
  if (screen === 'otp') {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="w-full max-w-sm space-y-6">
          <div className="text-center">
            <h1 className="text-2xl font-bold text-indigo-600">Verificacion</h1>
            <p className="text-slate-500 mt-1">Ingresa el codigo de 6 digitos enviado a tu WhatsApp</p>
          </div>
          <div className="space-y-4">
            <input
              type="text" placeholder="000000" maxLength={6}
              value={otp} onChange={e => setOtp(e.target.value)}
              className="w-full px-4 py-3 rounded-xl border border-slate-200 text-center text-2xl tracking-widest focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            {error && <p className="text-red-500 text-sm">{error}</p>}
            <button
              onClick={handleVerifyOTP} disabled={loading || otp.length !== 6}
              className="w-full bg-indigo-600 text-white py-3 rounded-xl font-medium hover:bg-indigo-700 disabled:opacity-50 transition"
            >
              {loading ? 'Verificando...' : 'Verificar'}
            </button>
            <button onClick={() => setScreen('login')} className="w-full text-slate-500 py-2">
              Volver
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ---- MAIN SCREEN ----
  const displayBalance = Math.round(parseFloat(balance) - getLocalPendingBalance()).toLocaleString()
  const userName = account?.displayName || account?.phoneNumber || ''
  const greeting = userName ? `Hola ${userName}` : 'Hola!'
  const regularProducts = products.filter((p: any) => !p.cashPrice || Number(p.cashPrice) === 0)
  const hybridProducts = products.filter((p: any) => p.cashPrice && Number(p.cashPrice) > 0)
  const userBalance = parseFloat(balance) - getLocalPendingBalance()

  return (
    <div className="min-h-screen bg-slate-50 pb-32">
      {/* Welcome Card */}
      {showWelcome && (
        <div className="bg-gradient-to-r from-indigo-600 to-indigo-800 text-white p-6">
          <h2 className="text-xl font-bold">Bienvenido a Valee!</h2>
          <p className="mt-2 text-indigo-100 text-sm">Tu programa de recompensas. Escanea facturas, acumula puntos y canjealos por productos.</p>
          <button onClick={dismissWelcome} className="mt-4 bg-white text-indigo-600 px-4 py-2 rounded-lg font-medium text-sm">
            Entendido
          </button>
        </div>
      )}

      {/* Header: Valee + merchant + logout */}
      <div className="bg-white border-b border-slate-100 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-xl font-extrabold tracking-tight text-indigo-700">Valee</span>
          {account?.merchantName && (
            <>
              <span className="text-slate-300">|</span>
              <span className="text-sm font-semibold text-slate-600 truncate max-w-[160px]">{account.merchantName}</span>
            </>
          )}
        </div>
        <button onClick={logout} className="text-xs font-medium text-slate-400 hover:text-slate-600 transition">Salir</button>
      </div>

      {/* Greeting */}
      <div className="px-4 pt-5">
        <h1 className="text-2xl font-bold text-slate-800">{greeting}</h1>
      </div>

      {/* Offline indicators */}
      {!isOnline && (
        <div className="mx-4 mt-2 bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-800">
          Sin conexion. Algunas acciones se guardaran localmente.
        </div>
      )}

      {/* Balance Bar (clickable → toggle history) */}
      <button
        onClick={() => setShowHistory(!showHistory)}
        className="mx-4 mt-4 w-[calc(100%-2rem)] bg-gradient-to-br from-indigo-600 to-indigo-800 rounded-2xl p-5 text-white shadow-lg text-left active:scale-[0.98] transition-transform"
      >
        <div className="flex items-center justify-between">
          <div>
            <p className="text-indigo-200 text-xs uppercase tracking-wide">Tu saldo</p>
            <p className="text-3xl font-extrabold tracking-tight mt-1">{displayBalance}</p>
            <p className="text-indigo-200 text-xs mt-0.5">{unitLabel}</p>
          </div>
          <div className="flex flex-col items-center gap-1">
            {account?.levelName && (
              <div className="flex items-center gap-1 bg-white/20 backdrop-blur-sm rounded-full px-3 py-1">
                <MdStarRate className="w-4 h-4 text-amber-300" />
                <span className="text-xs font-bold">{account.levelName}</span>
              </div>
            )}
            <MdChevronRight className={`w-5 h-5 text-indigo-200 transition-transform ${showHistory ? 'rotate-90' : ''}`} />
          </div>
        </div>
        {parseFloat(provisionalBalance) > 0 && (
          <div className="mt-2 inline-flex items-center gap-1.5 bg-indigo-500/40 backdrop-blur-sm rounded-lg px-2.5 py-1 text-xs">
            <MdLock className="w-3.5 h-3.5" />
            <span>{Math.round(parseFloat(provisionalBalance)).toLocaleString()} en verificacion</span>
          </div>
        )}
      </button>

      {/* Level Progress Bar */}
      {account?.nextLevelName && account?.pointsToNextLevel > 0 && (
        <div className="mx-4 mt-2 bg-white rounded-xl p-3 border border-slate-100 shadow-sm">
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className="text-slate-500">Nivel {account.levelName}</span>
            <span className="text-indigo-600 font-semibold">
              {Math.round(account.pointsToNextLevel).toLocaleString()} pts para {account.nextLevelName}
            </span>
          </div>
          <div className="w-full bg-slate-100 rounded-full h-2">
            <div
              className="bg-gradient-to-r from-indigo-500 to-indigo-600 h-2 rounded-full transition-all"
              style={{
                width: `${Math.min(100, Math.max(5, ((account.nextLevelMin - account.pointsToNextLevel) / account.nextLevelMin) * 100))}%`
              }}
            />
          </div>
        </div>
      )}

      {/* Transaction History (expandable) */}
      {showHistory && (
        <div className="mx-4 mt-3 bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
          <div className="p-4 border-b border-slate-50">
            <h3 className="font-semibold text-slate-700 text-sm">Historial de movimientos</h3>
          </div>
          {history.length === 0 ? (
            <p className="text-slate-400 text-sm text-center py-6">No tienes movimientos aun</p>
          ) : (
            <div className="divide-y divide-slate-50 max-h-64 overflow-y-auto">
              {history.map(entry => (
                <div key={entry.id} className="px-4 py-3 flex items-center justify-between">
                  <div>
                    <p className="font-medium text-sm text-slate-700">{EVENT_LABELS[entry.eventType] || entry.eventType}</p>
                    <p className="text-xs text-slate-400">{new Date(entry.createdAt).toLocaleDateString('es-VE')}</p>
                  </div>
                  <p className={`font-bold text-sm ${entry.entryType === 'CREDIT' ? 'text-emerald-600' : 'text-red-500'}`}>
                    {entry.entryType === 'CREDIT' ? '+' : '-'}{Math.round(parseFloat(entry.amount)).toLocaleString()}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Product Catalog — Carousel */}
      {regularProducts.length > 0 && (
        <div className="mt-6">
          <div className="px-4 flex items-center justify-between mb-3">
            <h2 className="font-bold text-slate-800">Canjea tus puntos</h2>
            <Link href="/catalog" className="text-indigo-600 text-xs font-semibold">Ver todo</Link>
          </div>
          <div className="flex gap-3 overflow-x-auto px-4 pb-2 snap-x snap-mandatory scrollbar-hide">
            {regularProducts.map((p: any) => {
              const canAfford = userBalance >= parseFloat(p.redemptionCost)
              return (
                <Link
                  key={p.id}
                  href="/catalog"
                  className={`flex-shrink-0 w-36 snap-start rounded-2xl border overflow-hidden transition active:scale-95 ${
                    canAfford ? 'border-slate-200 bg-white shadow-sm' : 'border-slate-100 bg-slate-50 opacity-60'
                  }`}
                >
                  <div className="w-36 h-36 bg-slate-100 flex items-center justify-center overflow-hidden">
                    {p.photoUrl ? (
                      <img src={p.photoUrl} alt={p.name} className="w-full h-full object-cover" />
                    ) : (
                      <MdCardGiftcard className="w-10 h-10 text-slate-300" />
                    )}
                  </div>
                  <div className="p-2.5">
                    <p className="text-xs font-semibold text-slate-800 truncate">{p.name}</p>
                    <p className="text-xs text-indigo-600 font-bold mt-0.5">{Math.round(parseFloat(p.redemptionCost)).toLocaleString()} pts</p>
                    <p className="text-[10px] text-slate-400 mt-0.5">{p.stock} disponibles</p>
                  </div>
                </Link>
              )
            })}
          </div>
        </div>
      )}

      {/* Hybrid Deals Catalog — Carousel */}
      {hybridProducts.length > 0 && (
        <div className="mt-6">
          <div className="px-4 flex items-center justify-between mb-3">
            <h2 className="font-bold text-slate-800 flex items-center gap-2">
              <MdLocalOffer className="w-5 h-5 text-amber-500" />
              Puntos + Efectivo
            </h2>
          </div>
          <div className="flex gap-3 overflow-x-auto px-4 pb-2 snap-x snap-mandatory scrollbar-hide">
            {hybridProducts.map((p: any) => (
              <Link
                key={p.id}
                href="/catalog"
                className="flex-shrink-0 w-36 snap-start rounded-2xl border border-amber-200 bg-gradient-to-b from-amber-50 to-white shadow-sm overflow-hidden active:scale-95 transition"
              >
                <div className="w-36 h-36 bg-amber-50 flex items-center justify-center overflow-hidden">
                  {p.photoUrl ? (
                    <img src={p.photoUrl} alt={p.name} className="w-full h-full object-cover" />
                  ) : (
                    <MdLocalOffer className="w-10 h-10 text-amber-300" />
                  )}
                </div>
                <div className="p-2.5">
                  <p className="text-xs font-semibold text-slate-800 truncate">{p.name}</p>
                  <p className="text-xs text-indigo-600 font-bold mt-0.5">{Math.round(parseFloat(p.redemptionCost)).toLocaleString()} pts</p>
                  <p className="text-xs text-amber-600 font-bold">+ ${Number(p.cashPrice).toLocaleString()}</p>
                  <p className="text-[10px] text-slate-400 mt-0.5">{p.stock} disponibles</p>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Bottom Fixed Actions */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 p-4 flex gap-3 shadow-lg z-10">
        <Link
          href="/scan"
          className="flex-1 bg-indigo-600 text-white py-3.5 rounded-xl font-semibold text-sm text-center flex items-center justify-center gap-2 hover:bg-indigo-700 active:scale-[0.97] transition"
        >
          <MdCameraAlt className="w-5 h-5" />
          Escanear factura
        </Link>
        <Link
          href="/catalog"
          className="flex-1 bg-emerald-600 text-white py-3.5 rounded-xl font-semibold text-sm text-center flex items-center justify-center gap-2 hover:bg-emerald-700 active:scale-[0.97] transition"
        >
          <MdCardGiftcard className="w-5 h-5" />
          Canjear premios
        </Link>
      </div>
    </div>
  )
}
