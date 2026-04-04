'use client'

import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import Link from 'next/link'

interface Product {
  id: string
  name: string
  description: string | null
  photoUrl: string | null
  redemptionCost: string
  stock: number
  canAfford: boolean
}

export default function Catalog() {
  const [products, setProducts] = useState<Product[]>([])
  const [balance, setBalance] = useState('0')
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [total, setTotal] = useState(0)
  const [message, setMessage] = useState('')
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null)
  const [redeeming, setRedeeming] = useState(false)
  const [redeemResult, setRedeemResult] = useState<any>(null)

  useEffect(() => { loadCatalog() }, [])

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
      setProducts(prev => [...prev, ...data.products])
      setHasMore(products.length + data.products.length < data.total)
    } catch {} finally { setLoadingMore(false) }
  }

  async function loadCatalog() {
    try {
      const data = await api.getCatalog(20, 0)
      setProducts(data.products)
      setBalance(data.balance)
      setTotal(data.total || data.products.length)
      setHasMore(data.products.length < (data.total || data.products.length))
    } catch {
      setMessage('Error loading catalog')
    } finally {
      setLoading(false)
    }
  }

  function handleProductClick(product: Product) {
    if (!product.canAfford) {
      const needed = (parseFloat(product.redemptionCost) - parseFloat(balance)).toFixed(0)
      setMessage(`Necesitas ${needed} puntos mas. Escanea una factura para ganar mas puntos!`)
      return
    }
    setSelectedProduct(product)
  }

  async function confirmRedeem() {
    if (!selectedProduct) return
    setRedeeming(true)
    try {
      const result = await api.redeemProduct(selectedProduct.id, localStorage.getItem('assetTypeId') || '')
      setRedeemResult(result)
    } catch (e: any) {
      setRedeemResult({ success: false, message: e.error || 'Error processing redemption' })
    } finally {
      setRedeeming(false)
    }
  }

  // QR Result Screen with animation
  if (redeemResult?.success && redeemResult.token) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white p-4">
        <div className="text-center animate-qr-build">
          <h2 className="text-xl font-bold text-indigo-600 mb-4">Tu codigo QR de canje</h2>
          <div className="bg-slate-100 rounded-2xl p-8 inline-block">
            <QRDisplay value={redeemResult.token} />
          </div>
          {redeemResult.cashAmount && parseFloat(redeemResult.cashAmount) > 0 ? (
            <div className="bg-amber-50 border border-amber-300 rounded-xl p-4 mt-4 text-left space-y-2">
              <p className="text-amber-900 font-bold text-center mb-3">Canje hibrido</p>
              <p className="text-amber-800"><span className="font-bold">1.</span> Paga <span className="font-bold">${parseFloat(redeemResult.cashAmount).toLocaleString()}</span> en caja</p>
              <p className="text-amber-800"><span className="font-bold">2.</span> Muestra tu QR al cajero para ser escaneado</p>
              <p className="text-amber-800"><span className="font-bold">3.</span> Espera tu premio!</p>
            </div>
          ) : (
            <p className="text-sm text-slate-500 mt-4">Muestra este codigo al cajero</p>
          )}
          {redeemResult.expiresAt && (
            <CountdownTimer expiresAt={redeemResult.expiresAt} onExpired={() => {
              setRedeemResult(null)
              setSelectedProduct(null)
              loadCatalog()
            }} />
          )}
          <Link href="/consumer" className="block mt-6 text-indigo-600 font-medium">Volver al inicio</Link>
        </div>
      </div>
    )
  }

  // Confirmation dialog
  if (selectedProduct) {
    const balanceAfter = (parseFloat(balance) - parseFloat(selectedProduct.redemptionCost)).toFixed(0)
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl p-6 shadow-lg w-full max-w-sm animate-fade-in">
          <h2 className="text-lg font-bold">Confirmar canje</h2>
          <div className="mt-4 space-y-2">
            <p className="text-slate-600"><span className="font-medium">Producto:</span> {selectedProduct.name}</p>
            <p className="text-slate-600"><span className="font-medium">Costo:</span> {parseFloat(selectedProduct.redemptionCost).toLocaleString()} pts</p>
            <p className="text-slate-600"><span className="font-medium">Saldo despues:</span> {parseFloat(balanceAfter).toLocaleString()} pts</p>
          </div>
          {redeemResult && !redeemResult.success && (
            <p className="text-red-500 text-sm mt-3">{redeemResult.message}</p>
          )}
          <div className="mt-6 flex gap-3">
            <button onClick={() => { setSelectedProduct(null); setRedeemResult(null) }} className="flex-1 bg-slate-100 py-3 rounded-xl font-medium">
              Cancelar
            </button>
            <button onClick={confirmRedeem} disabled={redeeming} className="flex-1 bg-indigo-600 text-white py-3 rounded-xl font-medium hover:bg-indigo-700 disabled:opacity-50 transition">
              {redeeming ? 'Procesando...' : 'Confirmar'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (loading) return <div className="min-h-screen flex items-center justify-center"><p className="text-slate-400">Cargando...</p></div>

  return (
    <div className="min-h-screen p-4">
      <div className="flex items-center gap-3 mb-4">
        <Link href="/consumer" className="text-indigo-600 text-2xl">&larr;</Link>
        <h1 className="text-xl font-bold">Catalogo</h1>
      </div>

      <p className="text-sm text-slate-500 mb-4">Tu saldo: <span className="font-bold text-indigo-600">{parseFloat(balance).toLocaleString()} pts</span></p>

      {message && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-4 text-sm text-amber-800">
          {message}
          <button onClick={() => setMessage('')} className="ml-2 font-bold">×</button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        {products.map(product => (
          <div
            key={product.id}
            onClick={() => handleProductClick(product)}
            className={`bg-white rounded-xl shadow-sm overflow-hidden cursor-pointer transition hover:shadow-md ${!product.canAfford ? 'grayscale opacity-70' : ''}`}
          >
            <div className="h-32 bg-slate-100 flex items-center justify-center">
              {product.photoUrl ? (
                <img src={product.photoUrl} alt={product.name} className="h-full w-full object-cover" />
              ) : (
                <span className="text-4xl">🎁</span>
              )}
            </div>
            <div className="p-3">
              <p className="font-medium text-sm truncate">{product.name}</p>
              <p className="text-indigo-600 font-bold text-sm">{parseFloat(product.redemptionCost).toLocaleString()} pts</p>
              <p className="text-xs text-slate-400">{product.stock} disponibles</p>
              {product.canAfford ? (
                <button className="w-full mt-2 bg-indigo-600 text-white text-xs py-2 rounded-lg font-medium">
                  Canjear
                </button>
              ) : (
                <button className="w-full mt-2 bg-slate-200 text-slate-500 text-xs py-2 rounded-lg font-medium cursor-not-allowed" disabled>
                  🔒 Bloqueado
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {loadingMore && (
        <p className="text-center text-slate-400 mt-4 py-4">Cargando más productos...</p>
      )}

      {!hasMore && products.length > 0 && (
        <p className="text-center text-slate-300 text-sm mt-4 py-4">No hay más productos</p>
      )}

      {products.length === 0 && !loading && (
        <p className="text-center text-slate-400 mt-12">No hay productos disponibles en este momento</p>
      )}
    </div>
  )
}

// Simple QR display using canvas
function QRDisplay({ value }: { value: string }) {
  return (
    <div className="w-48 h-48 bg-white flex items-center justify-center border-2 border-slate-200 rounded-lg">
      <div className="text-center">
        <p className="text-xs text-slate-400 break-all px-2">{value.slice(0, 30)}...</p>
        <p className="text-xs text-slate-500 mt-2">QR Code</p>
      </div>
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
