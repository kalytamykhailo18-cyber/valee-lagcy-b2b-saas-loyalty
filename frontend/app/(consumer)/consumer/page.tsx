'use client'

import { useState, useEffect, useCallback } from 'react'
import { MdCameraAlt, MdCardGiftcard, MdAssignment, MdLock } from 'react-icons/md'
import { api } from '@/lib/api'
import Link from 'next/link'
import { getLocalPendingBalance, getPendingCount, syncPendingActions, purgeExpiredActions, type QueuedAction } from '@/lib/offline-queue'
import { useOnlineStatus } from '@/lib/use-online-status'

type Screen = 'login' | 'otp' | 'main'

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

export default function ConsumerApp() {
  const [screen, setScreen] = useState<Screen>('login')
  const [phoneNumber, setPhoneNumber] = useState('')
  const [tenantSlug, setTenantSlug] = useState('')
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
  const [showWelcome, setShowWelcome] = useState(false)
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

  useEffect(() => {
    const token = localStorage.getItem('accessToken')
    if (token) {
      setScreen('main')
      loadData()
    }
    // Check expired items
    const expired = purgeExpiredActions()
    setPendingCount(getPendingCount())
  }, [])

  async function loadData() {
    try {
      const [balData, histData, accData] = await Promise.all([
        api.getBalance(),
        api.getHistory(),
        api.getAccount(),
      ])
      setBalance(balData.balance)
      setConfirmedBalance(balData.confirmed || balData.balance)
      setProvisionalBalance(balData.provisional || '0')
      setUnitLabel(balData.unitLabel)
      setAssetTypeId(balData.assetTypeId)
      setHistory(histData.entries)
      setAccount(accData)

      if (!localStorage.getItem('welcomeDismissed') && histData.entries.length === 0) {
        setShowWelcome(true)
      }
    } catch {
      localStorage.removeItem('accessToken')
      setScreen('login')
    }
  }

  async function handleRequestOTP() {
    setError('')
    setLoading(true)
    try {
      await api.requestOTP(phoneNumber, tenantSlug)
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
      const data = await api.verifyOTP(phoneNumber, otp, tenantSlug)
      localStorage.setItem('accessToken', data.accessToken)
      localStorage.setItem('refreshToken', data.refreshToken)
      setScreen('main')
      loadData()
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

  // ---- LOGIN SCREEN ----
  if (screen === 'login') {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="w-full max-w-sm space-y-6">
          <div className="text-center">
            <h1 className="text-2xl font-bold text-indigo-600">Loyalty Points</h1>
            <p className="text-slate-500 mt-1">Ingresa tu numero para comenzar</p>
          </div>
          <div className="space-y-4">
            <input
              type="text" placeholder="Codigo del comercio (slug)"
              value={tenantSlug} onChange={e => setTenantSlug(e.target.value)}
              className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <input
              type="tel" placeholder="+58412..."
              value={phoneNumber} onChange={e => setPhoneNumber(e.target.value)}
              className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            {error && <p className="text-red-500 text-sm">{error}</p>}
            <button
              onClick={handleRequestOTP} disabled={loading || !phoneNumber || !tenantSlug}
              className="w-full bg-indigo-600 text-white py-3 rounded-xl font-medium hover:bg-indigo-700 disabled:opacity-50 transition"
            >
              {loading ? 'Enviando...' : 'Enviar codigo OTP'}
            </button>
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
  return (
    <div className="min-h-screen pb-20">
      {/* Welcome Card */}
      {showWelcome && (
        <div className="bg-indigo-600 text-white p-6 animate-fade-in">
          <h2 className="text-xl font-bold">Hola!</h2>
          <p className="mt-2 text-indigo-100">Bienvenido a tu programa de recompensas. Escanea tus facturas para ganar puntos y canjealos por productos.</p>
          <button onClick={dismissWelcome} className="mt-4 bg-white text-indigo-600 px-4 py-2 rounded-lg font-medium text-sm">
            Entendido
          </button>
        </div>
      )}

      {/* Header */}
      <div className="bg-white shadow-sm p-4 flex items-center justify-between">
        <div>
          <p className="text-sm text-slate-500">
            {account?.accountType === 'verified' ? 'Cuenta verificada' : 'Cuenta'}
          </p>
          <p className="font-medium">{account?.phoneNumber}</p>
        </div>
        <button onClick={logout} className="text-sm text-slate-400 hover:text-slate-600">Salir</button>
      </div>

      {/* Offline indicator */}
      {!isOnline && (
        <div className="mx-4 mt-2 bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-800">
          Sin conexion. Algunas acciones se guardaran localmente.
        </div>
      )}
      {pendingCount > 0 && (
        <div className="mx-4 mt-2 bg-indigo-50 border border-indigo-200 rounded-xl p-3 text-sm text-indigo-800 flex items-center justify-between">
          <span>{pendingCount} accion(es) pendiente(s) de sincronizar</span>
          {isOnline && (
            <button onClick={handleSync} className="text-indigo-600 font-medium text-sm underline">Sincronizar</button>
          )}
        </div>
      )}

      {/* Balance Card */}
      <div className="mx-4 mt-4 bg-gradient-to-br from-indigo-600 to-indigo-800 rounded-2xl p-6 text-white shadow-lg">
        <p className="text-indigo-200 text-sm">Tu saldo</p>
        <p className="text-4xl font-bold mt-1">{(parseFloat(balance) - getLocalPendingBalance()).toLocaleString()}</p>
        <p className="text-indigo-200 text-sm mt-1">{unitLabel}</p>
        {parseFloat(provisionalBalance) > 0 && (
          <div className="mt-3 inline-flex items-center gap-1.5 bg-indigo-500/40 backdrop-blur-sm rounded-lg px-2.5 py-1 text-xs">
            <MdLock className="w-4 h-4 inline" />
            <span>{parseFloat(provisionalBalance).toLocaleString()} {unitLabel} en verificacion</span>
          </div>
        )}
        {pendingCount > 0 && (
          <p className="text-indigo-300 text-xs mt-1">
            ({getLocalPendingBalance().toLocaleString()} pts en canjes pendientes)
          </p>
        )}
      </div>

      {/* Action Buttons */}
      <div className="mx-4 mt-4 grid grid-cols-2 gap-3">
        <Link href="/scan" className="bg-white rounded-xl p-4 text-center shadow-sm hover:shadow-md transition">
          <MdCameraAlt className="w-6 h-6 mx-auto text-indigo-600" />
          <p className="text-sm font-medium mt-1">Escanear factura</p>
        </Link>
        <Link href="/catalog" className="bg-white rounded-xl p-4 text-center shadow-sm hover:shadow-md transition">
          <MdCardGiftcard className="w-6 h-6 mx-auto text-indigo-600" />
          <p className="text-sm font-medium mt-1">Catalogo</p>
        </Link>
        <Link href="/dual-scan" className="bg-white rounded-xl p-4 text-center shadow-sm hover:shadow-md transition">
          <MdCameraAlt className="w-6 h-6 mx-auto text-indigo-600" />
          <p className="text-sm font-medium mt-1">Escanear QR</p>
        </Link>
        <Link href="/disputes" className="bg-white rounded-xl p-4 text-center shadow-sm hover:shadow-md transition">
          <MdAssignment className="w-6 h-6 mx-auto text-indigo-600" />
          <p className="text-sm font-medium mt-1">Reclamo</p>
        </Link>
      </div>

      {/* Transaction History */}
      <div className="mx-4 mt-6">
        <h3 className="font-semibold text-slate-700 mb-3">Historial</h3>
        {history.length === 0 ? (
          <p className="text-slate-400 text-sm text-center py-8">No tienes movimientos aun. Escanea tu primera factura!</p>
        ) : (
          <div className="space-y-2">
            {history.map(entry => (
              <div key={entry.id} className="bg-white rounded-xl p-4 shadow-sm flex items-center justify-between">
                <div>
                  <p className="font-medium text-sm">{EVENT_LABELS[entry.eventType] || entry.eventType}</p>
                  <p className="text-xs text-slate-400">{new Date(entry.createdAt).toLocaleString('es-VE')}</p>
                  {entry.merchantName && <p className="text-xs text-slate-400">{entry.merchantName}</p>}
                </div>
                <p className={`font-bold ${entry.entryType === 'CREDIT' ? 'text-green-600' : 'text-red-500'}`}>
                  {entry.entryType === 'CREDIT' ? '+' : '-'}{parseFloat(entry.amount).toLocaleString()}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
