'use client'

import { useState, useEffect, useCallback, Suspense } from 'react'
import { MdCameraAlt, MdCardGiftcard, MdAssignment, MdLock, MdStarRate, MdChevronRight, MdLocalOffer } from 'react-icons/md'
import { useRouter, useSearchParams } from 'next/navigation'
import { api } from '@/lib/api'
import Link from 'next/link'
import { getLocalPendingBalance, getPendingCount, syncPendingActions, purgeExpiredActions, type QueuedAction } from '@/lib/offline-queue'
import { useOnlineStatus } from '@/lib/use-online-status'
import { formatPoints, formatCash } from '@/lib/format'
import { getAccess, setTokens, clearTokens } from '@/lib/token-store'

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
  productName?: string | null
  productPhotoUrl?: string | null
}

const EVENT_LABELS: Record<string, string> = {
  INVOICE_CLAIMED: 'Factura validada',
  PRESENCE_VALIDATED: 'Pago en efectivo',
  REDEMPTION_PENDING: 'Canje pendiente',
  REDEMPTION_CONFIRMED: 'Producto Canjeado',
  REDEMPTION_EXPIRED: 'Canje expirado',
  REVERSAL: 'Reverso',
  ADJUSTMENT_MANUAL: 'Ajuste manual',
  TRANSFER_P2P: 'Transferencia',
  WELCOME_BONUS: 'Puntos de Bienvenida',
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
  const [reservedBalance, setReservedBalance] = useState('0')
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
  const [activeCodesCount, setActiveCodesCount] = useState(0)

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
    const t = getAccess('consumer')
    try { fetch('/api/consumer/log-event', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: JSON.stringify({ event, detail }) }) } catch {}
  }

  useEffect(() => {
    const token = getAccess('consumer')
    logEvent('page_mount', `hasToken=${!!token} slug=${merchantSlugFromUrl || '(none)'}`)

    // Remember the current tenant context so inner pages (scan, catalog,
    // my-codes, dual-scan, disputes) can send the user BACK to the same
    // merchant view instead of the multicommerce hub. Clear when the user
    // explicitly navigates to the hub (no ?tenant=).
    if (merchantSlugFromUrl) {
      localStorage.setItem('tenantSlug', merchantSlugFromUrl)
    } else {
      localStorage.removeItem('tenantSlug')
    }

    // Landing page sends ?switch=1 when the user clicks "No soy yo — cambiar
    // de cuenta". Nuke the current session (server cookies + localStorage)
    // before rendering so the /consumer page shows the login screen and
    // NOT another user's dashboard for a split second.
    if (searchParams.get('switch') === '1' && token) {
      ;(async () => {
        try { await fetch('/api/consumer/auth/logout', { method: 'POST', credentials: 'include' }) } catch {}
        clearTokens('consumer')
        localStorage.removeItem('tenantSlug')
        // Replace the URL so a refresh doesn't re-trigger the switch.
        window.history.replaceState({}, '', '/consumer')
        setScreen('login')
      })()
      return
    }

    if (token) {
      if (merchantSlugFromUrl) {
        logEvent('selectMerchant_start', merchantSlugFromUrl)
        ;(async () => {
          try {
            const data = await api.selectMerchant(merchantSlugFromUrl)
            setTokens('consumer', data.accessToken, data.refreshToken)
            logEvent('selectMerchant_ok', merchantSlugFromUrl)
            setScreen('main')
            loadData()
          } catch (e: any) {
            logEvent('selectMerchant_fail', e?.message || e?.error || 'unknown')
            // Only clear session on auth failures (401/403). Otherwise keep the
            // user logged in and show main with whatever token they had — don't
            // kick them to login over a transient error.
            if (e?.status === 401 || e?.status === 403) {
              clearTokens('consumer')
              setScreen('login')
            } else {
              setScreen('main')
              loadData()
            }
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
    // Use allSettled so one failing call (e.g. /balance when the token is
    // still tenantless) doesn't throw away the successful ones. Previously a
    // single failure left every piece of state at its initial value — balance
    // would render as "0" even though the merchant does have points.
    const results = await Promise.allSettled([
      api.getBalance(),
      api.getHistory(),
      api.getAccount(),
      api.getCatalog(50, 0),
      api.getActiveRedemptions(),
    ])

    const [balR, histR, accR, catR, activeR] = results
    const firstAuthFail = results.find(r => r.status === 'rejected' && (r.reason?.status === 401 || r.reason?.status === 403))
    if (firstAuthFail) {
      clearTokens('consumer')
      setScreen('login')
      return
    }

    // If /balance is 409, the token has no merchant scope yet. Try to upgrade
    // via select-merchant using the URL slug (or persisted one) before giving
    // up and showing a stale empty balance.
    if (balR.status === 'rejected' && balR.reason?.status === 409 && balR.reason?.requiresMerchantSelection) {
      const slug = merchantSlugFromUrl || localStorage.getItem('tenantSlug')
      if (slug) {
        try {
          const upgraded = await api.selectMerchant(slug)
          setTokens('consumer', upgraded.accessToken, upgraded.refreshToken)
          logEvent('balance_409_upgrade_ok', slug)
          return loadData()
        } catch (e: any) {
          logEvent('balance_409_upgrade_fail', `${slug}: ${e?.message || e?.error || 'unknown'}`)
        }
      }
    }

    if (balR.status === 'fulfilled') {
      const balData = balR.value
      setBalance(balData.balance)
      setConfirmedBalance(balData.confirmed || balData.balance)
      setProvisionalBalance(balData.provisional || '0')
      setReservedBalance(balData.reserved || '0')
      setUnitLabel(balData.unitLabel)
      setAssetTypeId(balData.assetTypeId)
      if (balData.assetTypeId) localStorage.setItem('assetTypeId', balData.assetTypeId)
    } else {
      logEvent('balance_fail', `${balR.reason?.status || '?'}: ${balR.reason?.error || balR.reason?.message || 'unknown'}`)
    }

    if (histR.status === 'fulfilled') {
      setHistory(histR.value.entries)
      if (!localStorage.getItem('welcomeDismissed') && histR.value.entries.length === 0) {
        setShowWelcome(true)
      }
    }
    if (accR.status === 'fulfilled') setAccount(accR.value)
    if (catR.status === 'fulfilled') setProducts(catR.value.products || [])
    if (activeR.status === 'fulfilled') setActiveCodesCount(activeR.value.redemptions?.length || 0)
  }

  async function handleRequestOTP() {
    setError('')
    // Validate Venezuelan phone format: +58 + 10 digits
    const digits = phoneNumber.replace(/\D/g, '')
    if (!digits.startsWith('58') || digits.length !== 12) {
      setError('Ingresa un numero venezolano valido (10 digitos)')
      return
    }
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
      setTokens('consumer', data.accessToken, data.refreshToken)
      logEvent('verify_otp_ok', `scope=${data.scope} slug=${merchantSlugFromUrl || '(none)'}`)

      if (merchantSlugFromUrl) {
        try {
          const upgraded = await api.selectMerchant(merchantSlugFromUrl)
          setTokens('consumer', upgraded.accessToken, upgraded.refreshToken)
          setScreen('main')
          loadData()
          return
        } catch {
          // Fall through to multicommerce hub
        }
      }
      // No tenant in URL → land on the multicommerce hub directly (we're
      // already at /consumer, just flip to main; the hub gate handles the
      // render). Previously this redirected to '/' which dumped the user
      // back on the public landing.
      setScreen('main')
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

  async function logout() {
    // Hit the server logout BEFORE clearing localStorage so the httpOnly
    // cookies get cleared. Without this the cookie stays alive and the
    // server authenticates the next request as the prior user, so the UI
    // looks logged out but API calls still hit the old session.
    try { await fetch('/api/consumer/auth/logout', { method: 'POST', credentials: 'include' }) } catch {}
    clearTokens('consumer')
    window.location.href = '/'
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
      <div className="min-h-screen flex flex-col items-center justify-center p-4">
        <Link href="/" className="absolute top-4 left-4 text-sm text-slate-500 hover:text-indigo-700 hover:-translate-x-0.5 transition-transform inline-flex items-center gap-1">
          <span>&larr;</span> Volver al inicio
        </Link>
        <div className="w-full max-w-sm space-y-6">
          <div className="text-center aa-rise">
            <Link href="/" className="inline-block">
              <h1 className="text-3xl font-extrabold tracking-tight text-indigo-700 hover:text-indigo-800 transition-colors">Valee</h1>
            </Link>
            <p className="text-slate-500 mt-2">Ingresa tu numero para comenzar</p>
          </div>
          <div className="space-y-2">
            {(() => {
              // Accept either "0414..." (11 digits) or "414..." (10 digits)
              // Strip leading zero if present for normalization
              const raw = phoneNumber.startsWith('+58') ? phoneNumber.slice(3) : phoneNumber.replace(/\D/g, '')
              const normalized = raw.startsWith('0') ? raw.slice(1) : raw
              const prefix = normalized.slice(0, 3)
              const validPrefix = ['412', '414', '416', '424', '426'].includes(prefix)
              const validLength = normalized.length === 10
              const isValid = validPrefix && validLength
              const showValidation = normalized.length > 0

              // Display value: user can see what they typed (with or without leading 0)
              const displayValue = raw

              return (
                <>
                  <div className={`rounded-xl border overflow-hidden ${
                    showValidation && !isValid
                      ? 'border-red-300 focus-within:ring-2 focus-within:ring-red-400'
                      : 'border-slate-200 focus-within:ring-2 focus-within:ring-indigo-500 focus-within:border-indigo-500'
                  }`}>
                    <input
                      type="tel"
                      inputMode="numeric"
                      placeholder="0414 1234567"
                      value={displayValue}
                      onChange={e => {
                        const digits = e.target.value.replace(/\D/g, '').slice(0, 11)
                        // Normalize to 10-digit body for storage (strip optional leading 0)
                        const body = digits.startsWith('0') ? digits.slice(1) : digits
                        setPhoneNumber(body ? `+58${body.slice(0, 10)}` : '')
                        if (error) setError('')
                      }}
                      onKeyDown={e => e.key === 'Enter' && isValid && handleRequestOTP()}
                      className="w-full px-4 py-3 focus:outline-none"
                    />
                  </div>
                  {showValidation && normalized.length >= 3 && !validPrefix && (
                    <p className="text-amber-600 text-xs">El numero debe empezar con 0414, 0424, 0412, 0416 o 0426</p>
                  )}
                  {showValidation && validPrefix && !validLength && (
                    <p className="text-slate-500 text-xs">Faltan {10 - normalized.length} digitos</p>
                  )}
                  {error && <p className="text-red-500 text-sm">{error}</p>}
                  <button
                    onClick={handleRequestOTP}
                    disabled={loading || !isValid}
                    className="aa-btn aa-btn-primary w-full bg-indigo-600 text-white py-3 rounded-xl font-semibold hover:bg-indigo-700 disabled:opacity-50 mt-3 flex items-center justify-center"
                  >
                    {loading && <span className="aa-spinner" />}<span className="relative z-10">{loading ? 'Enviando...' : 'Enviar codigo OTP'}</span>
                  </button>
                  <p className="text-xs text-slate-400 text-center pt-2">
                    Recibiras un codigo por WhatsApp para verificar tu numero.
                  </p>
                </>
              )
            })()}
          </div>
        </div>
      </div>
    )
  }

  // ---- OTP SCREEN ----
  if (screen === 'otp') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-4">
        <Link href="/" className="absolute top-4 left-4 text-sm text-slate-500 hover:text-indigo-700 hover:-translate-x-0.5 transition-transform inline-flex items-center gap-1">
          <span>&larr;</span> Volver al inicio
        </Link>
        <div className="w-full max-w-sm space-y-6">
          <div className="text-center aa-rise">
            <h1 className="text-2xl font-bold text-indigo-600 tracking-tight">Verificacion</h1>
            <p className="text-slate-500 mt-1">Ingresa el codigo de 6 digitos enviado a tu WhatsApp</p>
          </div>
          <div className="space-y-4 aa-rise" style={{ animationDelay: '80ms' }}>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder="000000"
              maxLength={6}
              value={otp}
              onChange={e => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
              onKeyDown={e => e.key === 'Enter' && otp.length === 6 && handleVerifyOTP()}
              className="aa-field w-full px-4 py-3 rounded-xl border border-slate-200 text-center text-2xl tracking-widest"
            />
            {error && <p className="text-red-500 text-sm aa-pop">{error}</p>}
            <button
              onClick={handleVerifyOTP} disabled={loading || otp.length !== 6}
              className="aa-btn aa-btn-primary w-full bg-indigo-600 text-white py-3 rounded-xl font-medium hover:bg-indigo-700 disabled:opacity-50 flex items-center justify-center"
            >
              {loading && <span className="aa-spinner" />}<span className="relative z-10">{loading ? 'Verificando...' : 'Verificar'}</span>
            </button>
            <button onClick={() => setScreen('login')} className="w-full text-slate-500 py-2 hover:text-slate-700 transition-colors">
              Volver
            </button>
            {/* Meta WhatsApp API only delivers free-form messages (like our OTP)
                inside a 24h window that opens when the user messages the business.
                First-time users never hit this window, so the OTP arrives silently
                dropped. Giving them a one-tap link to say "Hola" to Valee opens
                the window — then a Reenviar gets the OTP through. */}
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 mt-2 text-center">
              <p className="text-xs text-amber-800 font-medium">No te llego el codigo?</p>
              <p className="text-xs text-amber-700 mt-1">
                Envia <b>Hola</b> a nuestro WhatsApp y vuelve a pedir el codigo.
              </p>
              <a
                href="https://wa.me/584144018263?text=Hola"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block mt-2 bg-emerald-600 text-white px-4 py-1.5 rounded-lg text-xs font-semibold hover:bg-emerald-700"
              >
                Abrir WhatsApp
              </a>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ---- MULTICOMMERCE HUB ----
  // Routing is driven purely by URL: no ?tenant= → hub. Previously we also
  // checked `account.merchantName`, but when the user navigated away from
  // /consumer?tenant=X the stale state kept them on the single-merchant view.
  if (screen === 'main' && !merchantSlugFromUrl) {
    return <MultiMerchantHub />
  }

  // ---- SINGLE-MERCHANT MAIN SCREEN ----
  // Display total = spendable + reserved so a pending canje QR doesn't
  // look like missing points (Genesis M4). Offline pending still subtracts.
  const displayBalance = formatPoints(parseFloat(balance) + parseFloat(reservedBalance) - getLocalPendingBalance())
  // Greet with the name the merchant linked in "Buscar cliente". If no name is
  // on file we deliberately skip the phone fallback — showing the number feels
  // robotic and clutters the hero.
  const greeting = account?.displayName
    ? `Hola ${account.displayName.split(/\s+/)[0]}!`
    : 'Hola!'
  // Surface the full phone number so a user on a shared browser can tell
  // immediately which account is active. Eric hit this when opening
  // valee.app on his computer auto-entered Genesis's session — the
  // greeting was generic enough that he didn't realize until much later.
  const sessionPhoneLabel = account?.phoneNumber || ''
  const regularProducts = products.filter((p: any) => !p.cashPrice || Number(p.cashPrice) === 0)
  const hybridProducts = products.filter((p: any) => p.cashPrice && Number(p.cashPrice) > 0)
  const userBalance = parseFloat(balance) - getLocalPendingBalance()

  return (
    <div className="min-h-screen bg-slate-50 pb-32">
      {/* Welcome Card */}
      {showWelcome && (
        <div className="aa-pop bg-gradient-to-r from-indigo-600 to-indigo-800 text-white p-6">
          <h2 className="text-xl font-bold tracking-tight">Bienvenido a Valee!</h2>
          <p className="mt-2 text-indigo-100 text-sm">Tu programa de recompensas. Escanea facturas, acumula puntos y canjealos por productos.</p>
          <button onClick={dismissWelcome} className="aa-btn mt-4 bg-white text-indigo-600 px-4 py-2 rounded-lg font-medium text-sm">
            <span className="relative z-10">Entendido</span>
          </button>
        </div>
      )}

      {/* Header: back to hub + merchant label + logout
          "Mis comercios" goes back to the multi-merchant hub at /consumer
          without dropping the session (that's what "Salir" is for). */}
      <div className="bg-white border-b border-slate-100 px-4 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            href="/consumer"
            className="flex items-center gap-1.5 text-xs font-semibold text-indigo-600 hover:text-indigo-800 transition-colors whitespace-nowrap"
          >
            <MdChevronRight className="w-4 h-4 rotate-180" />
            Mis comercios
          </Link>
          {account?.merchantName && (
            <>
              <span className="text-slate-300">|</span>
              <span className="text-sm font-semibold text-slate-600 truncate">{account.merchantName}</span>
            </>
          )}
        </div>
        <button onClick={logout} className="text-xs font-medium text-slate-400 hover:text-slate-600 transition whitespace-nowrap">Salir</button>
      </div>

      {/* Active-session banner — always visible so the user can't miss
          which account they're looking at. Clicking "cambiar" drops the
          session and lands them on the login screen. */}
      {sessionPhoneLabel && (
        <div className="bg-indigo-50 border-b border-indigo-100 px-4 py-2 text-xs flex items-center justify-between gap-2">
          <span className="text-indigo-800 truncate">
            Sesion activa: <span className="font-semibold font-mono">{sessionPhoneLabel}</span>
          </span>
          <button
            onClick={logout}
            className="text-indigo-700 underline hover:text-indigo-900 font-semibold whitespace-nowrap"
          >
            No soy yo
          </button>
        </div>
      )}

      {/* Greeting + logo pair (Valee + merchant logo) */}
      <div className="px-4 pt-5 aa-rise-sm flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight truncate">{greeting}</h1>
        <div className="flex items-center gap-2 flex-shrink-0">
          {/* Valee badge — small lightning bolt on an indigo chip */}
          <div className="w-9 h-9 rounded-full bg-indigo-600 flex items-center justify-center text-white font-bold text-sm shadow-sm" aria-label="Valee" title="Valee">
            <span className="-mt-0.5">⚡</span>
          </div>
          {/* Merchant logo — shown if the merchant configured one */}
          {account?.merchantLogo && (
            <img
              src={account.merchantLogo}
              alt={account?.merchantName || 'Comercio'}
              title={account?.merchantName || 'Comercio'}
              className="w-9 h-9 rounded-full object-cover border border-slate-200 bg-white"
            />
          )}
        </div>
      </div>

      {/* Offline indicators */}
      {!isOnline && (
        <div className="mx-4 mt-2 bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-800">
          Sin conexion. Algunas acciones se guardaran localmente.
        </div>
      )}

      {/* Balance hero — tap to expand history */}
      <section
        className="aa-rise mx-4 mt-5 bg-gradient-to-br from-indigo-600 via-indigo-700 to-indigo-900 rounded-3xl p-6 sm:p-7 text-white overflow-hidden relative"
        style={{ animationDelay: '60ms', boxShadow: '0 1px 2px rgba(15,23,42,0.08), 0 20px 40px -16px rgba(79,70,229,0.35)' }}
      >
        {/* Subtle decorative glow */}
        <div className="pointer-events-none absolute -top-16 -right-16 w-56 h-56 bg-white/10 rounded-full blur-3xl" />
        <div className="relative">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[10px] uppercase tracking-[0.14em] text-indigo-200 font-semibold mb-1.5">Tu saldo</p>
              <p key={displayBalance} className="text-[56px] sm:text-6xl font-bold tracking-tight tabular-nums leading-none break-all aa-count">
                {displayBalance}
              </p>
              <p className="text-indigo-200 text-sm mt-2.5">{unitLabel}</p>
            </div>
            {account?.levelName && (
              <div className="flex items-center gap-1.5 bg-white/15 backdrop-blur rounded-full px-3 py-1.5 border border-white/20 flex-shrink-0">
                <MdStarRate className="w-4 h-4 text-amber-300" />
                <span className="text-xs font-bold tracking-tight">{account.levelName}</span>
              </div>
            )}
          </div>

          {parseFloat(provisionalBalance) > 0 && (
            <div className="mt-4 inline-flex items-center gap-1.5 bg-white/15 backdrop-blur rounded-full px-3 py-1.5 text-xs border border-white/15">
              <MdLock className="w-3.5 h-3.5" />
              <span>{formatPoints(provisionalBalance)} en verificacion</span>
            </div>
          )}

          {parseFloat(reservedBalance) > 0 && (
            <div className="mt-2 inline-flex items-center gap-1.5 bg-white/15 backdrop-blur rounded-full px-3 py-1.5 text-xs border border-white/15">
              <MdLock className="w-3.5 h-3.5" />
              <span>{formatPoints(reservedBalance)} reservados para canje pendiente</span>
            </div>
          )}

          <button
            onClick={() => setShowHistory(!showHistory)}
            className="mt-5 text-xs font-semibold text-indigo-100 hover:text-white inline-flex items-center gap-1 transition-colors"
          >
            {showHistory ? 'Ocultar historial' : 'Ver historial'}
            <MdChevronRight className={`w-4 h-4 transition-transform ${showHistory ? 'rotate-90' : ''}`} />
          </button>
        </div>
      </section>

      {/* Level progress — slim bar BELOW the balance card (not inside it) */}
      {account?.nextLevelName && account?.pointsToNextLevel > 0 ? (
        <div className="mx-4 mt-3 bg-white rounded-xl border border-slate-100 px-4 py-3 shadow-sm">
          <div className="flex items-center justify-between text-[11px] mb-1.5">
            <span className="font-semibold text-slate-700">{account.levelName}</span>
            <span className="tabular-nums text-slate-500">{formatPoints(account.pointsToNextLevel)} para {account.nextLevelName}</span>
          </div>
          <div className="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
            <div
              className="bg-gradient-to-r from-indigo-500 to-indigo-700 h-1.5 rounded-full transition-all"
              style={{
                width: `${Math.min(100, Math.max(5, ((account.nextLevelMin - account.pointsToNextLevel) / account.nextLevelMin) * 100))}%`
              }}
            />
          </div>
        </div>
      ) : account?.levelName ? (
        <div className="mx-4 mt-3 bg-white rounded-xl border border-slate-100 px-4 py-2.5 shadow-sm flex items-center justify-between">
          <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Nivel</span>
          <span className="inline-flex items-center gap-1 text-xs font-bold text-amber-700">
            <MdStarRate className="w-4 h-4 text-amber-500" />
            {account.levelName} · Maximo
          </span>
        </div>
      ) : null}

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
                <div key={entry.id} className="px-4 py-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    {entry.productPhotoUrl ? (
                      <img src={entry.productPhotoUrl} alt={entry.productName || ''} className="w-10 h-10 rounded-lg object-cover flex-shrink-0 border border-slate-100" />
                    ) : entry.productName ? (
                      <div className="w-10 h-10 rounded-lg bg-indigo-50 flex items-center justify-center flex-shrink-0">
                        <MdCardGiftcard className="w-5 h-5 text-indigo-400" />
                      </div>
                    ) : null}
                    <div className="min-w-0">
                      <p className="font-medium text-sm text-slate-700 truncate">{EVENT_LABELS[entry.eventType] || entry.eventType}</p>
                      {entry.productName && (
                        <p className="text-xs text-slate-500 truncate">{entry.productName}</p>
                      )}
                      <p className="text-xs text-slate-400">{new Date(entry.createdAt).toLocaleDateString('es-VE')}</p>
                    </div>
                  </div>
                  <p className={`font-bold text-sm flex-shrink-0 tabular-nums ${entry.entryType === 'CREDIT' ? 'text-emerald-600' : 'text-red-500'}`}>
                    {entry.entryType === 'CREDIT' ? '+' : '-'}{formatPoints(entry.amount)}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Product Catalog — Carousel */}
      {regularProducts.length > 0 && (
        <div className="mt-8 aa-rise" style={{ animationDelay: '180ms' }}>
          <div className="px-4 flex items-end justify-between mb-4">
            <h2 className="font-bold text-slate-900 text-xl tracking-tight">Canjea tus puntos</h2>
            <Link href="/catalog" className="text-indigo-600 text-sm font-semibold hover:text-indigo-800">Ver todo</Link>
          </div>
          <div className="flex gap-4 overflow-x-auto px-4 pb-3 snap-x snap-mandatory scrollbar-hide">
            {regularProducts.map((p: any) => {
              const canAfford = userBalance >= parseFloat(p.redemptionCost)
              return (
                <Link
                  key={p.id}
                  href="/catalog"
                  className={`flex-shrink-0 w-40 sm:w-44 snap-start active:scale-95 transition-transform ${canAfford ? '' : 'opacity-50 grayscale'}`}
                >
                  <div className="w-full aspect-square bg-slate-100 rounded-2xl overflow-hidden" style={{ boxShadow: '0 1px 2px rgba(15,23,42,0.04), 0 8px 20px -10px rgba(15,23,42,0.12)' }}>
                    {p.photoUrl ? (
                      <img src={p.photoUrl} alt={p.name} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <MdCardGiftcard className="w-12 h-12 text-slate-300" />
                      </div>
                    )}
                  </div>
                  <div className="mt-3">
                    <p className="text-sm font-semibold text-slate-900 line-clamp-1 tracking-tight">{p.name}</p>
                    <p className="text-sm text-indigo-600 font-bold mt-0.5 tabular-nums">{formatPoints(p.redemptionCost)} pts</p>
                  </div>
                </Link>
              )
            })}
          </div>
        </div>
      )}

      {/* Hybrid Deals Catalog — Carousel */}
      {hybridProducts.length > 0 && (
        <div className="mt-8 aa-rise" style={{ animationDelay: '240ms' }}>
          <div className="px-4 flex items-end justify-between mb-4">
            <h2 className="font-bold text-slate-900 text-xl tracking-tight flex items-center gap-2">
              <MdLocalOffer className="w-5 h-5 text-amber-500" />
              Puntos + Efectivo
            </h2>
          </div>
          <div className="flex gap-4 overflow-x-auto px-4 pb-3 snap-x snap-mandatory scrollbar-hide">
            {hybridProducts.map((p: any) => (
              <Link
                key={p.id}
                href="/catalog"
                className="flex-shrink-0 w-40 sm:w-44 snap-start active:scale-95 transition-transform"
              >
                <div className="w-full aspect-square bg-gradient-to-b from-amber-50 to-white rounded-2xl overflow-hidden border border-amber-100" style={{ boxShadow: '0 1px 2px rgba(245,158,11,0.08), 0 8px 20px -10px rgba(245,158,11,0.20)' }}>
                  {p.photoUrl ? (
                    <img src={p.photoUrl} alt={p.name} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <MdLocalOffer className="w-12 h-12 text-amber-300" />
                    </div>
                  )}
                </div>
                <div className="mt-3">
                  <p className="text-sm font-semibold text-slate-900 line-clamp-1 tracking-tight">{p.name}</p>
                  <p className="text-sm text-indigo-600 font-bold mt-0.5 tabular-nums">{formatPoints(p.redemptionCost)} pts</p>
                  <p className="text-xs text-amber-600 font-bold mt-0.5">+ ${formatCash(p.cashPrice)}</p>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Active codes banner — shows if user has pending QR codes */}
      {activeCodesCount > 0 && (
        <Link
          href="/my-codes"
          className="block mx-4 mt-4 bg-amber-50 border border-amber-300 rounded-xl p-4 hover:bg-amber-100 transition"
        >
          <div className="flex items-center justify-between">
            <div>
              <p className="text-amber-900 font-bold text-sm">Tienes {activeCodesCount} codigo{activeCodesCount > 1 ? 's' : ''} activo{activeCodesCount > 1 ? 's' : ''}</p>
              <p className="text-amber-700 text-xs mt-0.5">Toca para ver tus QR de canje</p>
            </div>
            <MdChevronRight className="w-6 h-6 text-amber-700" />
          </div>
        </Link>
      )}

      {/* Invite friends — viral growth entry point */}
      <Link
        href="/invite"
        className="block mx-4 mt-3 mb-24 bg-gradient-to-br from-indigo-600 to-indigo-800 text-white rounded-2xl p-4 hover:from-indigo-700 hover:to-indigo-900 transition shadow-sm"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex-1">
            <p className="font-bold text-sm">Invita amigos, gana puntos</p>
            <p className="text-indigo-200 text-xs mt-0.5">Comparte tu QR personal y ganas cuando hagan su primera compra.</p>
          </div>
          <MdChevronRight className="w-6 h-6 text-indigo-200 flex-shrink-0" />
        </div>
      </Link>

      {/* Bottom Fixed Actions */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 p-4 flex gap-3 shadow-lg z-10 aa-rise-sm">
        <Link
          href="/scan"
          className="aa-btn aa-btn-primary flex-1 bg-indigo-600 text-white py-3.5 rounded-xl font-semibold text-sm text-center flex items-center justify-center gap-2 hover:bg-indigo-700"
        >
          <MdCameraAlt className="w-5 h-5 relative z-10" />
          <span className="relative z-10">Escanear factura</span>
        </Link>
        <Link
          href="/catalog"
          className="aa-btn aa-btn-emerald flex-1 bg-emerald-600 text-white py-3.5 rounded-xl font-semibold text-sm text-center flex items-center justify-center gap-2 hover:bg-emerald-700"
        >
          <MdCardGiftcard className="w-5 h-5 relative z-10" />
          <span className="relative z-10">Canjear premios</span>
        </Link>
      </div>
    </div>
  )
}


// ============================================================
// MULTICOMMERCE HUB — list all merchants this consumer has points in
// Used when a logged-in consumer visits /consumer without a specific tenant.
// Previously this view lived at `/` but Eric wanted the root to be a public
// landing page — this component keeps the same behavior at /consumer.
// ============================================================
interface MerchantAccount {
  accountId: string | null
  tenantId: string
  tenantName: string
  tenantSlug: string
  tenantLogoUrl?: string | null
  balance: string
  reserved?: string
  unitLabel: string
  hasAccount?: boolean
  topProducts: Array<{ id: string; name: string; photoUrl: string | null; redemptionCost: string; stock: number }>
}

function MultiMerchantHub() {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [merchants, setMerchants] = useState<MerchantAccount[]>([])
  const [totalBalance, setTotalBalance] = useState('0')
  const [totalReserved, setTotalReserved] = useState('0')
  const [phoneNumber, setPhoneNumber] = useState('')
  const [displayName, setDisplayName] = useState<string | null>(null)

  useEffect(() => {
    (async () => {
      try {
        const data: any = await api.getAllAccounts()
        setMerchants(data.merchants || [])
        setTotalBalance(data.totalBalance || '0')
        setTotalReserved(data.totalReserved || '0')
        setPhoneNumber(data.phoneNumber || '')
        setDisplayName(data.displayName || null)
      } catch {
        // /all-accounts failed — kick to public landing, let them log in again
        clearTokens('consumer')
        window.location.href = '/'
      }
      setLoading(false)
    })()
  }, [])

  async function logout() {
    try { await fetch('/api/consumer/auth/logout', { method: 'POST', credentials: 'include' }) } catch {}
    clearTokens('consumer')
    window.location.href = '/'
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="w-12 h-12 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-indigo-50 via-white to-white">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-3 sm:px-6 lg:px-8 py-3 sm:py-4 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <Link href="/" className="inline-block text-xl sm:text-2xl font-extrabold tracking-tight text-indigo-700 hover:text-indigo-800 transition-colors">Valee</Link>
            {phoneNumber && (
              <div className="mt-1 flex items-center gap-2 flex-wrap">
                <span className="inline-flex items-center gap-1.5 bg-indigo-50 border border-indigo-200 text-indigo-800 text-[11px] sm:text-xs font-mono font-semibold px-2 py-0.5 rounded-full">
                  {phoneNumber}
                </span>
                <button onClick={logout} className="text-[11px] sm:text-xs text-slate-500 hover:text-indigo-700 underline underline-offset-2">
                  No soy yo
                </button>
              </div>
            )}
          </div>
          <button onClick={logout} className="text-xs sm:text-sm font-medium text-slate-500 hover:text-indigo-700 hover:underline underline-offset-4 transition-colors whitespace-nowrap flex-shrink-0">Cerrar sesion</button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-3 sm:px-6 lg:px-8 py-4 sm:py-6 lg:py-10">
        <div className="mb-3 sm:mb-4 lg:mb-6 aa-rise-sm">
          <h1 className="text-xl sm:text-3xl font-bold text-slate-800 tracking-tight">{displayName ? `Hola ${displayName.split(/\s+/)[0]}!` : 'Hola!'}</h1>
        </div>

        <section className="bg-gradient-to-br from-indigo-600 to-indigo-800 rounded-2xl sm:rounded-3xl p-4 sm:p-8 lg:p-10 text-white shadow-xl aa-rise overflow-hidden">
          <p className="text-indigo-200 text-xs sm:text-base">Tu saldo total</p>
          {/* Size the balance text based on digit count so 9-digit
              totals don't wrap to 3 lines on mobile (Genesis M9).
              Display total = spendable + reserved so a pending canje QR
              doesn't look like missing points (Genesis M4). */}
          {(() => {
            const displayTotal = (Number(totalBalance) + Number(totalReserved)).toFixed(8)
            const formatted = formatPoints(displayTotal)
            const digits = String(displayTotal).replace(/\D/g, '').length
            const sizeClass =
              digits >= 9 ? 'text-2xl sm:text-4xl lg:text-5xl' :
              digits >= 7 ? 'text-3xl sm:text-5xl lg:text-6xl' :
              'text-4xl sm:text-5xl lg:text-6xl xl:text-7xl'
            return (
              <p key={displayTotal} className={`${sizeClass} font-bold mt-2 tracking-tight aa-count tabular-nums leading-none`}>
                {formatted}
              </p>
            )
          })()}
          {(() => {
            const withBalance = merchants.filter(m => Number(m.balance) > 0).length
            return (
              <p className="text-indigo-200 text-sm sm:text-base mt-2">
                puntos en {withBalance} comercio{withBalance !== 1 ? 's' : ''}
              </p>
            )
          })()}
          {Number(totalReserved) > 0 && (
            <div className="mt-3 inline-flex items-center gap-1.5 bg-white/15 backdrop-blur rounded-full px-3 py-1.5 text-xs border border-white/15">
              <MdLock className="w-3.5 h-3.5" />
              <span>{formatPoints(totalReserved)} reservados para canje pendiente</span>
            </div>
          )}
        </section>

        {(() => {
          const mine = merchants.filter(m => Number(m.balance) > 0)
          const others = merchants.filter(m => Number(m.balance) === 0)

          if (merchants.length === 0) {
            return (
              <div className="mt-8 bg-white rounded-2xl p-8 text-center border border-slate-200">
                <p className="text-slate-600 mb-2 font-medium">Aun no hay comercios Valee con productos disponibles.</p>
                <p className="text-sm text-slate-400">Vuelve en unos dias — estamos sumando comercios constantemente.</p>
              </div>
            )
          }

          return (
            <>
              {mine.length > 0 && (
                <section className="mt-8 sm:mt-10 lg:mt-14">
                  <h2 className="text-slate-900 font-bold text-lg sm:text-xl tracking-tight mb-4 sm:mb-5 px-1">Tus comercios</h2>
                  <div className="space-y-4 sm:space-y-5 md:grid md:grid-cols-2 md:gap-5 md:space-y-0 lg:gap-6">
                    {mine.map((m, i) => (
                      <div
                        key={m.tenantId}
                        onClick={() => router.push(`/consumer?tenant=${m.tenantSlug}`)}
                        className="aa-card aa-row-in group bg-white rounded-3xl border border-slate-200/70 overflow-hidden cursor-pointer transition-all active:scale-[0.98] hover:shadow-xl hover:border-indigo-200"
                        style={{ animationDelay: `${Math.min(i * 60, 360)}ms`, boxShadow: '0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -12px rgba(15,23,42,0.08)' }}
                      >
                        <div className="px-6 pt-6 pb-5 sm:px-7 sm:pt-7 sm:pb-6">
                          <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 mb-2">
                                {m.tenantLogoUrl ? (
                                  <img src={m.tenantLogoUrl} alt={m.tenantName} className="w-8 h-8 rounded-full object-cover border border-slate-200 bg-white flex-shrink-0" />
                                ) : (
                                  <div className="w-8 h-8 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center font-bold text-sm flex-shrink-0">
                                    {m.tenantName.charAt(0)}
                                  </div>
                                )}
                                <p className="text-sm font-semibold text-slate-900 truncate">{m.tenantName}</p>
                              </div>
                              <p className="text-[11px] uppercase tracking-[0.12em] text-slate-400 font-semibold mb-1">Saldo</p>
                              {(() => {
                                // Responsive sizing: prevent 7+ digit saldos
                                // from wrapping to 3 lines inside the card.
                                // Display total = spendable + reserved so a
                                // pending canje QR doesn't look like missing
                                // points (Genesis M4).
                                const displayBal = Number(m.balance) + Number(m.reserved || 0)
                                const digits = String(displayBal).replace(/\D/g, '').length
                                const cls = digits >= 9 ? 'text-2xl sm:text-3xl'
                                  : digits >= 7 ? 'text-3xl sm:text-4xl'
                                  : 'text-[42px] sm:text-5xl'
                                return (
                                  <p className={`${cls} font-bold text-slate-900 tracking-tight tabular-nums leading-none`}>
                                    {formatPoints(displayBal)}
                                  </p>
                                )
                              })()}
                              <p className="text-sm text-slate-500 mt-1.5">{m.unitLabel}</p>
                              {Number(m.reserved || 0) > 0 && (
                                <p className="text-[11px] text-amber-600 mt-1 font-medium">
                                  {formatPoints(m.reserved || '0')} reservados
                                </p>
                              )}
                            </div>
                            <MdChevronRight className="w-6 h-6 text-slate-300 group-hover:text-indigo-500 group-hover:translate-x-0.5 transition-all flex-shrink-0 mt-1" />
                          </div>
                        </div>
                        {m.topProducts.length > 0 && (
                          <div className="px-6 pb-6 sm:px-7 sm:pb-7">
                            <div className="flex gap-3 overflow-x-auto scrollbar-hide -mx-1 px-1">
                              {m.topProducts.map(p => {
                                const canAfford = Number(m.balance) >= Number(p.redemptionCost)
                                return (
                                  <div
                                    key={p.id}
                                    className={`flex-shrink-0 w-32 sm:w-36 transition ${canAfford ? '' : 'opacity-40 grayscale'}`}
                                  >
                                    {p.photoUrl ? (
                                      <img src={p.photoUrl} alt={p.name} className="w-full aspect-square object-cover rounded-2xl" />
                                    ) : (
                                      <div className="w-full aspect-square bg-slate-100 rounded-2xl flex items-center justify-center">
                                        <MdCardGiftcard className="w-9 h-9 text-slate-300" />
                                      </div>
                                    )}
                                    <p className="text-sm font-semibold text-slate-800 mt-2 line-clamp-1">{p.name}</p>
                                    <p className="text-xs text-indigo-600 font-bold tabular-nums">{formatPoints(p.redemptionCost)} pts</p>
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

              {others.length > 0 && (
                <section className="mt-10 sm:mt-12 lg:mt-16">
                  <h2 className="text-slate-900 font-bold text-lg sm:text-xl tracking-tight mb-1 px-1">Descubre</h2>
                  <p className="text-sm text-slate-500 mb-4 sm:mb-5 px-1">Otros comercios Valee donde puedes empezar a ganar</p>
                  <div className="space-y-4 sm:space-y-5 md:grid md:grid-cols-2 md:gap-5 md:space-y-0 lg:gap-6">
                    {others.map((m, i) => (
                      <div
                        key={m.tenantId}
                        onClick={() => router.push(`/consumer?tenant=${m.tenantSlug}`)}
                        className="aa-card aa-row-in group bg-white rounded-3xl border border-slate-200/70 overflow-hidden cursor-pointer transition-all active:scale-[0.98] hover:shadow-xl hover:border-indigo-200"
                        style={{ animationDelay: `${Math.min(i * 60, 360)}ms`, boxShadow: '0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -12px rgba(15,23,42,0.08)' }}
                      >
                        <div className="px-6 pt-6 pb-5 sm:px-7 sm:pt-7 sm:pb-6">
                          <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0 flex-1 flex items-center gap-3">
                              {m.tenantLogoUrl ? (
                                <img src={m.tenantLogoUrl} alt={m.tenantName} className="w-12 h-12 rounded-full object-cover border border-slate-200 bg-white flex-shrink-0" />
                              ) : (
                                <div className="w-12 h-12 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center font-bold text-lg flex-shrink-0">
                                  {m.tenantName.charAt(0)}
                                </div>
                              )}
                              <div className="min-w-0">
                                <p className="text-xl sm:text-2xl font-bold text-slate-900 tracking-tight truncate">{m.tenantName}</p>
                                <p className="text-sm text-slate-500 mt-0.5">Gana tus primeros puntos aqui</p>
                              </div>
                            </div>
                            <MdChevronRight className="w-6 h-6 text-slate-300 group-hover:text-indigo-500 group-hover:translate-x-0.5 transition-all flex-shrink-0 mt-1" />
                          </div>
                        </div>
                        {m.topProducts.length > 0 && (
                          <div className="px-6 pb-6 sm:px-7 sm:pb-7">
                            <div className="flex gap-3 overflow-x-auto scrollbar-hide -mx-1 px-1">
                              {m.topProducts.map(p => (
                                <div key={p.id} className="flex-shrink-0 w-32 sm:w-36">
                                  {p.photoUrl ? (
                                    <img src={p.photoUrl} alt={p.name} className="w-full aspect-square object-cover rounded-2xl" />
                                  ) : (
                                    <div className="w-full aspect-square bg-slate-100 rounded-2xl flex items-center justify-center">
                                      <MdCardGiftcard className="w-9 h-9 text-slate-300" />
                                    </div>
                                  )}
                                  <p className="text-sm font-semibold text-slate-800 mt-2 line-clamp-1">{p.name}</p>
                                  <p className="text-xs text-indigo-600 font-bold tabular-nums">{formatPoints(p.redemptionCost)} pts</p>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </>
          )
        })()}
      </main>

      <footer className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 text-center text-sm font-medium text-slate-500 border-t border-slate-200 mt-12 space-x-6">
        <Link href="/privacy" className="hover:text-indigo-700 hover:underline underline-offset-4 transition-colors">Privacidad</Link>
        <Link href="/terms" className="hover:text-indigo-700 hover:underline underline-offset-4 transition-colors">Terminos</Link>
      </footer>
    </div>
  )
}
