'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import Link from 'next/link'
import {
  generateActionId,
  enqueueAction,
  getPendingActions,
  getLocalPendingBalance,
  getPendingCount,
  syncPendingActions,
  purgeExpiredActions,
  type QueuedAction,
} from '@/lib/offline-queue'
import { formatPoints, formatCash } from '@/lib/format'
import { useOnlineStatus } from '@/lib/use-online-status'
import { consumerHomeUrl } from '@/lib/consumer-nav'

interface Product {
  id: string
  name: string
  description: string | null
  photoUrl: string | null
  redemptionCost: string
  stock: number
  canAfford: boolean
  minLevel?: number
  levelLocked?: boolean
  branchId?: string | null
  branchName?: string | null
  branchScope?: 'branch' | 'tenant'
  branchNames?: string[]
}

export default function Catalog() {
  const [products, setProducts] = useState<Product[]>([])
  const [balance, setBalance] = useState('0')
  const [spendable, setSpendable] = useState('0')
  const [cashProvisional, setCashProvisional] = useState('0')
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [total, setTotal] = useState(0)
  const [message, setMessage] = useState('')
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null)
  const [redeeming, setRedeeming] = useState(false)
  const [redeemResult, setRedeemResult] = useState<any>(null)
  const [pendingCount, setPendingCount] = useState(0)
  const [syncing, setSyncing] = useState(false)

  const handleSync = useCallback(async () => {
    const pending = getPendingActions()
    if (pending.length === 0) return

    setSyncing(true)
    try {
      await syncPendingActions(async (action: QueuedAction) => {
        if (action.type === 'redeem_product') {
          return await api.redeemProduct(action.payload.productId, action.payload.assetTypeId, action.payload.branchId || null)
        }
        throw new Error('Unknown action type')
      })
      // Refresh data after sync
      loadCatalog()
    } catch {}
    setSyncing(false)
    setPendingCount(getPendingCount())
  }, [])

  const isOnline = useOnlineStatus(handleSync)

  useEffect(() => { loadCatalog() }, [])

  // Check for expired items periodically
  useEffect(() => {
    const interval = setInterval(() => {
      const expired = purgeExpiredActions()
      if (expired.length > 0) {
        setMessage(`${expired.length} accion(es) pendiente(s) expiraron. Intenta de nuevo manualmente.`)
      }
      setPendingCount(getPendingCount())
    }, 60000) // Check every minute
    return () => clearInterval(interval)
  }, [])

  // Update pending count on mount
  useEffect(() => {
    setPendingCount(getPendingCount())
  }, [])

  // Infinite scroll: load more when user scrolls near bottom
  useEffect(() => {
    function handleScroll() {
      if (loadingMore || !hasMore) return
      if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 200) {
        loadMore()
      }
    }
    window.addEventListener('scroll', handleScroll)
    return () => window.removeEventListener('scroll', handleScroll)
  }, [products, loadingMore, hasMore])

  async function loadMore() {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    try {
      const data = await api.getCatalog(20, products.length)
      // Dedup by id — defensive in case the scroll handler fires twice and we
      // refetch offsets that overlap with what we already have. Previously this
      // caused products to appear two or three times in the grid.
      setProducts(prev => {
        const seen = new Set(prev.map((p: Product) => p.id))
        const fresh = (data.products as Product[]).filter(p => !seen.has(p.id))
        return [...prev, ...fresh]
      })
      const totalKnown = data.total ?? products.length + data.products.length
      setHasMore(products.length + data.products.length < totalKnown)
    } catch {} finally { setLoadingMore(false) }
  }

  async function loadCatalog() {
    try {
      const data = await api.getCatalog(20, 0)
      // Dedup on initial load too for the (rare) case where the endpoint
      // returns duplicates under load.
      const seen = new Set<string>()
      const unique = (data.products as Product[]).filter(p => {
        if (seen.has(p.id)) return false
        seen.add(p.id)
        return true
      })
      setProducts(unique)
      setBalance(data.balance)
      setSpendable((data as any).spendable ?? data.balance)
      setCashProvisional((data as any).cashProvisional ?? '0')
      const totalKnown = data.total ?? unique.length
      setTotal(totalKnown)
      setHasMore(unique.length < totalKnown)
    } catch {
      setMessage('Error loading catalog')
    } finally {
      setLoading(false)
    }
  }

  /** Effective spendable = server spendable - locally pending debits.
   *  Spendable excludes cash-provisional credits (PRESENCE_VALIDATED still
   *  awaiting reconciliation), per Eric 2026-05-04. Falls back to total when
   *  the API hasn't returned the spendable field yet. */
  function getEffectiveBalance(): number {
    const serverBal = parseFloat(spendable || balance) || 0
    const pendingDebits = getLocalPendingBalance()
    return serverBal - pendingDebits
  }

  function handleProductClick(product: Product) {
    const effectiveBal = getEffectiveBalance()
    const cost = parseFloat(product.redemptionCost)
    if (cost > effectiveBal) {
      const needed = (cost - effectiveBal).toFixed(0)
      setMessage(`Necesitas ${needed} puntos mas. Escanea una factura para ganar mas puntos!`)
      return
    }
    setSelectedProduct(product)
  }

  async function confirmRedeem() {
    if (!selectedProduct) return
    setRedeeming(true)

    const actionId = generateActionId()
    const assetTypeId = localStorage.getItem('assetTypeId') || ''

    try {
      const result = await api.redeemProduct(selectedProduct.id, assetTypeId, selectedProduct.branchId || null)
      setRedeemResult(result)
    } catch (e: any) {
      // Check if it's a network error (not a server validation error)
      const isNetworkError = !e.status || e.status === 0 || e.message === 'Failed to fetch'
          || (typeof e === 'object' && !('error' in e) && !('message' in e))

      if (isNetworkError) {
        // Queue locally for later sync
        enqueueAction(
          actionId,
          'redeem_product',
          { productId: selectedProduct.id, assetTypeId, branchId: selectedProduct.branchId || null },
          parseFloat(selectedProduct.redemptionCost)
        )
        setPendingCount(getPendingCount())
        setRedeemResult({
          success: false,
          queued: true,
          message: 'Sin conexion. Tu canje se procesara automaticamente cuando vuelvas a estar en linea.',
        })
      } else {
        setRedeemResult({ success: false, message: e.error || 'Error processing redemption' })
      }
    } finally {
      setRedeeming(false)
    }
  }

  const effectiveBalance = getEffectiveBalance()

  // QR Result Screen with animation
  if (redeemResult?.success && redeemResult.token) {
    return (
      <QrRedemptionView
        redeemResult={redeemResult}
        onClear={() => {
          setRedeemResult(null)
          setSelectedProduct(null)
          loadCatalog()
        }}
      />
    )
  }

  // Queued result screen
  if (redeemResult?.queued) {
    return (
      <div className="aa-backdrop min-h-screen flex items-center justify-center p-4">
        <div className="aa-modal bg-white rounded-2xl p-6 shadow-lg w-full max-w-sm text-center">
          <div className="w-16 h-16 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-4 animate-check">
            <span className="text-3xl">~</span>
          </div>
          <h2 className="text-lg font-bold text-amber-700 tracking-tight">Canje en cola</h2>
          <p className="text-sm text-slate-500 mt-2">{redeemResult.message}</p>
          <button
            onClick={() => { setRedeemResult(null); setSelectedProduct(null) }}
            className="aa-btn aa-btn-primary mt-6 bg-indigo-600 text-white px-6 py-3 rounded-xl font-medium w-full"
          >
            <span className="relative z-10">Entendido</span>
          </button>
        </div>
      </div>
    )
  }

  // Confirmation dialog
  if (selectedProduct) {
    const balanceAfter = (effectiveBalance - parseFloat(selectedProduct.redemptionCost)).toFixed(0)
    return (
      <div className="aa-backdrop min-h-screen flex items-center justify-center p-4">
        <div className="aa-modal bg-white rounded-2xl p-6 shadow-lg w-full max-w-sm">
          <h2 className="text-lg font-bold tracking-tight">Confirmar canje</h2>
          <div className="mt-4 space-y-2">
            <p className="text-slate-600"><span className="font-medium">Producto:</span> {selectedProduct.name}</p>
            <p className="text-slate-600"><span className="font-medium">Costo:</span> {formatPoints(selectedProduct.redemptionCost)} pts</p>
            <p className="text-slate-600"><span className="font-medium">Saldo despues:</span> {formatPoints(balanceAfter)} pts</p>
          </div>
          {redeemResult && !redeemResult.success && !redeemResult.queued && (
            <p className="text-red-500 text-sm mt-3">{redeemResult.message}</p>
          )}
          <div className="mt-6 flex gap-3">
            <button onClick={() => { setSelectedProduct(null); setRedeemResult(null) }} className="aa-btn flex-1 bg-slate-100 py-3 rounded-xl font-medium">
              <span className="relative z-10">Cancelar</span>
            </button>
            <button onClick={confirmRedeem} disabled={redeeming} className="aa-btn aa-btn-primary flex-1 bg-indigo-600 text-white py-3 rounded-xl font-medium hover:bg-indigo-700 disabled:opacity-50 flex items-center justify-center">
              {redeeming && <span className="aa-spinner" />}<span className="relative z-10">{redeeming ? 'Procesando...' : 'Confirmar'}</span>
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (loading) return <div className="min-h-screen flex items-center justify-center"><p className="text-slate-400">Cargando...</p></div>

  return (
    <div className="min-h-screen p-4">
      <div className="flex items-center gap-3 mb-4 aa-rise-sm">
        <a href={consumerHomeUrl()} className="text-indigo-600 text-2xl transition-transform hover:-translate-x-0.5">&larr;</a>
        <h1 className="text-xl font-bold tracking-tight">Catalogo</h1>
      </div>

      {/* Offline / Sync indicator */}
      {!isOnline && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-4 text-sm text-amber-800">
          Sin conexion. Los canjes se guardaran localmente.
        </div>
      )}
      {pendingCount > 0 && (
        <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-3 mb-4 flex items-center justify-between">
          <span className="text-sm text-indigo-800">
            {syncing ? 'Sincronizando...' : `${pendingCount} canje(s) pendiente(s)`}
          </span>
          {isOnline && !syncing && (
            <button onClick={handleSync} className="text-sm text-indigo-600 font-medium underline">
              Sincronizar ahora
            </button>
          )}
        </div>
      )}

      <p className="text-sm text-slate-500 mb-4">
        Tu saldo: <span className="font-bold text-indigo-600">{formatPoints(effectiveBalance)} pts</span>
        {pendingCount > 0 && (
          <span className="text-xs text-amber-600 ml-2">
            ({formatPoints(getLocalPendingBalance())} pts pendientes)
          </span>
        )}
      </p>
      {parseFloat(cashProvisional) > 0 && (
        <p className="text-xs text-slate-500 -mt-2 mb-4 leading-relaxed">
          {formatPoints(cashProvisional)} pts de pagos en efectivo estan en verificacion y no se pueden canjear hasta que el comercio los confirme.
        </p>
      )}

      {message && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-4 text-sm text-amber-800">
          {message}
          <button onClick={() => setMessage('')} className="ml-2 font-bold">x</button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        {products.map((product, i) => {
          const canAfford = parseFloat(product.redemptionCost) <= effectiveBalance
          const levelLocked = !!product.levelLocked
          const dimmed = levelLocked || !canAfford
          return (
            <div
              key={product.id}
              onClick={() => !levelLocked && handleProductClick(product)}
              className={`aa-card aa-row-in bg-white rounded-xl shadow-sm overflow-hidden ${levelLocked ? '' : 'cursor-pointer'} ${dimmed ? 'grayscale opacity-70' : ''}`}
              style={{ animationDelay: `${Math.min(i * 30, 300)}ms` }}
            >
              <div className="h-32 bg-slate-100 flex items-center justify-center">
                {product.photoUrl ? (
                  <img src={product.photoUrl} alt={product.name} className="h-full w-full object-cover" />
                ) : (
                  <span className="text-4xl">*</span>
                )}
              </div>
              <div className="p-3">
                <p className="font-medium text-sm truncate">{product.name}</p>
                <p className="text-indigo-600 font-bold text-sm">{formatPoints(product.redemptionCost)} pts</p>
                <p className="text-xs text-slate-400">{product.stock} disponibles</p>
                {(() => {
                  const names = product.branchNames || []
                  if (product.branchScope === 'branch' && product.branchName) {
                    return (
                      <p className="text-[11px] text-emerald-700 mt-1 truncate" title={product.branchName}>
                        Solo en {product.branchName}
                      </p>
                    )
                  }
                  if (product.branchScope === 'tenant' && names.length > 0) {
                    return (
                      <p className="text-[11px] text-slate-500 mt-1 truncate" title={names.join(', ')}>
                        Todas las sucursales{names.length <= 3 ? `: ${names.join(', ')}` : ` (${names.length})`}
                      </p>
                    )
                  }
                  return null
                })()}
                {levelLocked ? (
                  <button className="w-full mt-2 bg-slate-100 text-slate-600 text-[11px] py-2 rounded-lg font-semibold cursor-not-allowed" disabled>
                    Solo valido para Socios Valee nivel {product.minLevel}
                  </button>
                ) : canAfford ? (
                  <button className="aa-btn aa-btn-primary w-full mt-2 bg-indigo-600 text-white text-xs py-2 rounded-lg font-medium">
                    <span className="relative z-10">Canjear</span>
                  </button>
                ) : (
                  <button className="w-full mt-2 bg-slate-200 text-slate-500 text-xs py-2 rounded-lg font-medium cursor-not-allowed" disabled>
                    Ya casi es tuyo!
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {loadingMore && (
        <p className="text-center text-slate-400 mt-4 py-4">Cargando mas productos...</p>
      )}

      {!hasMore && products.length > 0 && (
        <p className="text-center text-slate-300 text-sm mt-4 py-4">No hay mas productos</p>
      )}

      {products.length === 0 && !loading && (
        <p className="text-center text-slate-400 mt-12">No hay productos disponibles en este momento</p>
      )}
    </div>
  )
}

// Simple QR display using canvas
/**
 * QR result view with a 3-second poll against /redemption-status. The moment
 * the cashier scans the code (token.status becomes 'used'), we replace the QR
 * with a green confirmation screen — Eric's request: "quitarlo con un mensaje
 * diciendo el canjeo fue verificado con exito".
 */
function QrRedemptionView({ redeemResult, onClear }: { redeemResult: any; onClear: () => void }) {
  const [confirmed, setConfirmed] = useState(false)

  useEffect(() => {
    if (!redeemResult?.tokenId) return
    let cancelled = false
    const check = async () => {
      try {
        const s = await api.getRedemptionStatus(redeemResult.tokenId)
        if (!cancelled && s.status === 'used') setConfirmed(true)
      } catch {}
    }
    check()
    const interval = setInterval(check, 3000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [redeemResult?.tokenId])

  if (confirmed) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-emerald-600 text-white p-6">
        <div className="text-center space-y-4 max-w-sm animate-check">
          <div className="text-7xl">✓</div>
          <h2 className="text-3xl font-bold tracking-tight">Canje verificado con exito</h2>
          <p className="text-emerald-100">Tu codigo fue escaneado por el comercio. Disfruta tu premio!</p>
          <a
            href={consumerHomeUrl()}
            className="aa-btn aa-btn-primary inline-block mt-4 bg-white text-emerald-700 px-8 py-3 rounded-xl font-semibold"
          >
            <span className="relative z-10">Volver al inicio</span>
          </a>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-white p-4">
      <div className="text-center animate-qr-build">
        <h2 className="text-xl font-bold text-indigo-600 mb-4">Tu codigo QR de canje</h2>
        <div className="bg-slate-100 rounded-2xl p-8 inline-block">
          <QRDisplay value={redeemResult.tokenId || redeemResult.token} />
        </div>
        {redeemResult.shortCode && (
          <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-4 mt-4">
            <p className="text-xs text-indigo-600 uppercase tracking-wider font-semibold">Codigo manual</p>
            <p className="text-3xl font-bold text-indigo-700 tracking-widest font-mono mt-1">{redeemResult.shortCode}</p>
            <p className="text-xs text-indigo-500 mt-1">Dile este codigo al cajero si no puede escanear</p>
          </div>
        )}
        {redeemResult.cashAmount && parseFloat(redeemResult.cashAmount) > 0 ? (
          <div className="bg-amber-50 border border-amber-300 rounded-xl p-4 mt-4 text-left space-y-2">
            <p className="text-amber-900 font-bold text-center mb-3">Canje hibrido</p>
            <p className="text-amber-800"><span className="font-bold">1.</span> Paga <span className="font-bold">${formatCash(redeemResult.cashAmount)}</span> en caja</p>
            <p className="text-amber-800"><span className="font-bold">2.</span> Muestra tu QR al cajero para ser escaneado</p>
            <p className="text-amber-800"><span className="font-bold">3.</span> Espera tu premio!</p>
          </div>
        ) : (
          <p className="text-sm text-slate-500 mt-4">Muestra este codigo al cajero</p>
        )}
        {redeemResult.expiresAt && (
          <CountdownTimer expiresAt={redeemResult.expiresAt} onExpired={onClear} />
        )}
        <a href={consumerHomeUrl()} className="block mt-6 text-indigo-600 font-medium">Volver al inicio</a>
      </div>
    </div>
  )
}

function QRDisplay({ value }: { value: string }) {
  const [qrUrl, setQrUrl] = useState<string | null>(null)

  useEffect(() => {
    import('qrcode').then(QRCode => {
      QRCode.toDataURL(value, { width: 280, margin: 2, errorCorrectionLevel: 'Q' })
        .then(url => setQrUrl(url))
        .catch(() => {})
    })
  }, [value])

  return (
    <div className="flex flex-col items-center">
      {qrUrl ? (
        <img src={qrUrl} alt="QR de canje" className="w-56 h-56 rounded-lg border-2 border-slate-200" />
      ) : (
        <div className="w-56 h-56 bg-slate-100 rounded-lg flex items-center justify-center">
          <div className="w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
        </div>
      )}
      {/* Removed the 'Copiar codigo manual' button and the long JWT
          preview — Genesis flagged them as confusing. The 6-digit manual
          code rendered separately below the QR is the proper fallback
          when the cashier's camera can't read the code. */}
    </div>
  )
}

function CountdownTimer({ expiresAt, onExpired }: { expiresAt: string; onExpired: () => void }) {
  const [remaining, setRemaining] = useState('')

  useEffect(() => {
    const interval = setInterval(() => {
      const diff = new Date(expiresAt).getTime() - Date.now()
      if (diff <= 0) {
        clearInterval(interval)
        setRemaining('Expirado')
        onExpired()
        return
      }
      const min = Math.floor(diff / 60000)
      const sec = Math.floor((diff % 60000) / 1000)
      setRemaining(`${min}:${sec.toString().padStart(2, '0')}`)
    }, 1000)

    return () => clearInterval(interval)
  }, [expiresAt, onExpired])

  return (
    <p className={`text-lg font-mono mt-3 ${remaining === 'Expirado' ? 'text-red-500' : 'text-slate-600'}`}>
      {remaining || 'Calculando...'}
    </p>
  )
}
