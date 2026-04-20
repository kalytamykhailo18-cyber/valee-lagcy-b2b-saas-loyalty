'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { api } from '@/lib/api'
import Link from 'next/link'
import {
  generateActionId,
  enqueueAction,
  getPendingActions,
  getPendingCount,
  syncPendingActions,
  purgeExpiredActions,
  type QueuedAction,
} from '@/lib/offline-queue'
import { useOnlineStatus } from '@/lib/use-online-status'
import { formatPoints, formatCash } from '@/lib/format'

type ScanState = 'scanning' | 'processing' | 'success' | 'failure' | 'queued'
type InputMode = 'camera' | 'manual'

export default function CashierScanner() {
  // Auth guard — redirect to login if no session
  useEffect(() => {
    if (typeof window === 'undefined') return
    const token = localStorage.getItem('staffAccessToken') || localStorage.getItem('accessToken')
    const role = localStorage.getItem('staffRole')
    if (!token || !role) {
      window.location.replace('/merchant/login')
    }
  }, [])
  const [state, setState] = useState<ScanState>('scanning')
  const [inputMode, setInputMode] = useState<InputMode>('camera')
  const [tokenInput, setTokenInput] = useState('')
  const [result, setResult] = useState<any>(null)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [pendingCount, setPendingCount] = useState(0)
  const [syncing, setSyncing] = useState(false)
  const scannerRef = useRef<any>(null)
  const scannerContainerId = 'qr-reader'
  const isProcessingRef = useRef(false)

  const handleSync = useCallback(async () => {
    const count = getPendingCount()
    if (count === 0) return
    setSyncing(true)
    try {
      await syncPendingActions(async (action: QueuedAction) => {
        if (action.type === 'scan_redemption') {
          return await api.scanRedemption(action.payload.token)
        }
        throw new Error('Unknown action type')
      })
    } catch {}
    setSyncing(false)
    setPendingCount(getPendingCount())
  }, [])

  const isOnline = useOnlineStatus(handleSync)

  useEffect(() => {
    purgeExpiredActions()
    setPendingCount(getPendingCount())
  }, [])

  const stopScanner = useCallback(async () => {
    if (scannerRef.current) {
      try {
        const scannerState = scannerRef.current.getState()
        if (scannerState === 2 || scannerState === 3) {
          await scannerRef.current.stop()
        }
      } catch {}
      try {
        scannerRef.current.clear()
      } catch {}
      scannerRef.current = null
    }
  }, [])

  const processToken = useCallback(async (token: string) => {
    if (isProcessingRef.current) return
    isProcessingRef.current = true

    await stopScanner()
    setState('processing')

    const actionId = generateActionId()

    try {
      const apiPromise = api.scanRedemption(token)
        .catch((e: any) => {
          // Check if it's a network error (no status means no response reached us)
          const isNetworkError = !e?.status && (e?.message === 'Failed to fetch' || e?.name === 'TypeError')

          if (isNetworkError) {
            // Queue for later
            enqueueAction(actionId, 'scan_redemption', { token })
            setPendingCount(getPendingCount())
            return { success: false, queued: true, message: 'Sin conexion. El canje se procesara cuando vuelvas a estar en linea.' }
          }
          return { success: false, message: e?.error || e?.message || 'Error al procesar el canje' }
        })

      const animPromise = new Promise(resolve => setTimeout(resolve, 1500))
      const [apiResult] = await Promise.all([apiPromise, animPromise]) as [any, unknown]

      setResult(apiResult)
      if (apiResult.queued) {
        setState('queued')
      } else {
        setState(apiResult.success ? 'success' : 'failure')
      }
    } catch {
      // Fallback: queue
      enqueueAction(actionId, 'scan_redemption', { token })
      setPendingCount(getPendingCount())
      setResult({ success: false, queued: true, message: 'Sin conexion. Canje guardado localmente.' })
      setState('queued')
    }

    // Auto-reset after 5 seconds
    setTimeout(() => {
      setState('scanning')
      setTokenInput('')
      setResult(null)
      isProcessingRef.current = false
    }, 5000)
  }, [stopScanner])

  const startScanner = useCallback(async () => {
    setCameraError(null)

    const { Html5Qrcode } = await import('html5-qrcode')
    await stopScanner()
    await new Promise(resolve => setTimeout(resolve, 100))

    const container = document.getElementById(scannerContainerId)
    if (!container) return

    const scanner = new Html5Qrcode(scannerContainerId)
    scannerRef.current = scanner

    try {
      await scanner.start(
        { facingMode: 'environment' },
        {
          fps: 10,
          qrbox: { width: 260, height: 260 },
          aspectRatio: 1,
          disableFlip: false,
          // Continuous autofocus + higher target resolution so the camera
          // actually catches small QR codes printed on receipts. Without this
          // many phones lock focus once and never re-focus, so the cashier
          // sees a blurry preview that never decodes.
          videoConstraints: {
            facingMode: 'environment',
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            advanced: [
              { focusMode: 'continuous' },
              { focusDistance: { min: 0, ideal: 0.2, max: 1 } },
            ],
          },
        } as any,
        (decodedText: string) => {
          if (!isProcessingRef.current && decodedText.trim()) {
            processToken(decodedText.trim())
          }
        },
        () => {}
      )
      // Belt-and-suspenders: force continuous autofocus via the raw track API
      // for browsers that ignore advanced constraints in getUserMedia.
      try {
        const videoEl = document.querySelector<HTMLVideoElement>(`#${scannerContainerId} video`)
        const track = (videoEl?.srcObject as MediaStream | null)?.getVideoTracks?.()[0]
        if (track && 'applyConstraints' in track) {
          await track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as any] }).catch(() => {})
        }
      } catch {}
    } catch (err: any) {
      console.error('Camera start error:', err)
      const msg = typeof err === 'string' ? err : err?.message || 'No se pudo acceder a la camara'
      setCameraError(msg)
      setInputMode('manual')
    }
  }, [stopScanner, processToken])

  useEffect(() => {
    if (state === 'scanning' && inputMode === 'camera') {
      startScanner()
    }
    return () => { stopScanner() }
  }, [state, inputMode, startScanner, stopScanner])

  function handleManualScan() {
    if (!tokenInput.trim()) return
    processToken(tokenInput.trim())
  }

  function handleReset() {
    setState('scanning')
    setTokenInput('')
    setResult(null)
    isProcessingRef.current = false
  }

  // SUCCESS screen
  if (state === 'success') {
    const isHybrid = result?.cashAmount && parseFloat(result.cashAmount) > 0;
    return (
      <div className="min-h-screen bg-green-500 flex items-center justify-center">
        <div className="text-center text-white animate-check">
          <span className="text-8xl">*</span>
          <h1 className="text-3xl font-bold mt-6">CANJE EXITOSO</h1>
          {result?.productName && <p className="text-xl mt-2">{result.productName}</p>}
          {result?.amount && <p className="text-2xl font-bold mt-2">{formatPoints(result.amount)} pts</p>}
          {isHybrid && (
            <div className="bg-yellow-400 text-yellow-900 rounded-xl p-4 mt-4 mx-4">
              <p className="text-sm font-bold uppercase">Oferta hibrida</p>
              <p className="text-3xl font-bold mt-1">${formatCash(result.cashAmount)}</p>
              <p className="text-sm font-bold mt-1">Recuerda recibir primero los $, antes de entregar el premio</p>
            </div>
          )}
          <p className="mt-4 text-green-100">El canje ha sido procesado correctamente</p>
        </div>
      </div>
    )
  }

  // QUEUED screen (offline)
  if (state === 'queued') {
    return (
      <div className="min-h-screen bg-amber-500 flex items-center justify-center">
        <div className="text-center text-white animate-fade-in">
          <span className="text-8xl">~</span>
          <h1 className="text-3xl font-bold mt-6">EN COLA</h1>
          <p className="text-xl mt-2">{result?.message || 'Canje guardado para sincronizar'}</p>
          <button onClick={handleReset}
            className="mt-8 bg-white/20 backdrop-blur px-6 py-3 rounded-xl font-medium">
            Continuar escaneando
          </button>
        </div>
      </div>
    )
  }

  // FAILURE screen
  if (state === 'failure') {
    return (
      <div className="min-h-screen bg-red-500 flex items-center justify-center">
        <div className="text-center text-white animate-fade-in">
          <span className="text-8xl">X</span>
          <h1 className="text-3xl font-bold mt-6">RECHAZADO</h1>
          <p className="text-xl mt-2">{result?.message || 'Error desconocido'}</p>
          <button onClick={handleReset}
            className="mt-8 bg-white/20 backdrop-blur px-6 py-3 rounded-xl font-medium">
            Intentar de nuevo
          </button>
        </div>
      </div>
    )
  }

  // PROCESSING screen
  if (state === 'processing') {
    return (
      <div className="min-h-screen bg-emerald-600 flex items-center justify-center">
        <div className="text-center text-white">
          <div className="w-16 h-16 border-4 border-white/30 border-t-white rounded-full animate-spin mx-auto" />
          <p className="text-lg mt-4">Procesando canje...</p>
        </div>
      </div>
    )
  }

  // SCANNING screen
  return (
    <div className="min-h-screen bg-emerald-50 p-4">
      <div className="flex items-center gap-3 mb-4 aa-rise-sm">
        <Link href="/merchant" className="text-emerald-700 text-2xl transition-transform hover:-translate-x-0.5">&larr;</Link>
        <h1 className="text-xl font-bold text-emerald-800 tracking-tight">Escaner de canjes</h1>
      </div>

      {/* Cashier cross-link: scanner ↔ pago en efectivo. Scanner is a bare
          route (no sidebar), so without this button a cashier logged into
          kiosk mode has no way to reach the dual-scan flow. */}
      <Link
        href="/merchant/dual-scan"
        className="aa-rise-sm flex items-center justify-between bg-white border border-emerald-200 rounded-xl px-4 py-3 mb-4 shadow-sm hover:bg-emerald-50 transition"
      >
        <div>
          <p className="text-sm font-semibold text-emerald-800">Pago en efectivo</p>
          <p className="text-xs text-slate-500">Generar QR para clientes que pagan sin factura</p>
        </div>
        <span className="text-emerald-700 text-xl">&rarr;</span>
      </Link>

      {/* Offline / Sync indicators */}
      {!isOnline && (
        <div className="aa-pop bg-amber-50 border border-amber-200 rounded-xl p-3 mb-4 text-sm text-amber-800">
          Sin conexion. Los canjes se guardaran localmente.
        </div>
      )}
      {pendingCount > 0 && (
        <div className="aa-pop bg-indigo-50 border border-indigo-200 rounded-xl p-3 mb-4 flex items-center justify-between">
          <span className="text-sm text-indigo-800">
            {syncing ? 'Sincronizando...' : `${pendingCount} canje(s) pendiente(s)`}
          </span>
          {isOnline && !syncing && (
            <button onClick={handleSync} className="text-sm text-indigo-600 font-medium underline">
              Sincronizar
            </button>
          )}
        </div>
      )}

      {/* Toggle between camera and manual */}
      <div className="flex bg-white rounded-xl p-1 mb-4 shadow-sm">
        <button
          onClick={() => setInputMode('camera')}
          className={`flex-1 py-2 rounded-lg text-sm font-medium transition ${
            inputMode === 'camera'
              ? 'bg-emerald-600 text-white'
              : 'text-slate-500 hover:text-slate-700'
          }`}
        >
          Camara
        </button>
        <button
          onClick={() => setInputMode('manual')}
          className={`flex-1 py-2 rounded-lg text-sm font-medium transition ${
            inputMode === 'manual'
              ? 'bg-emerald-600 text-white'
              : 'text-slate-500 hover:text-slate-700'
          }`}
        >
          Manual
        </button>
      </div>

      <div className="bg-white rounded-2xl p-6 shadow-sm aa-rise" style={{ animationDelay: '120ms' }}>
        {inputMode === 'camera' ? (
          <>
            {cameraError ? (
              <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-4">
                <p className="text-red-700 text-sm font-medium">Error de camara</p>
                <p className="text-red-600 text-xs mt-1">{cameraError}</p>
                <button
                  onClick={() => { setCameraError(null); startScanner(); }}
                  className="mt-2 text-sm text-red-700 underline"
                >
                  Reintentar
                </button>
              </div>
            ) : null}
            <div className="relative rounded-xl overflow-hidden bg-black">
              <div id={scannerContainerId} className="w-full" />
            </div>
            <p className="text-center text-sm text-slate-500 mt-3">
              Apunta la camara al codigo QR del cliente
            </p>
          </>
        ) : (
          <>
            <p className="text-sm text-slate-600 font-medium mb-1">Codigo de canje</p>
            <p className="text-xs text-slate-400 mb-3">Ingresa el codigo de 6 digitos que te diga el cliente</p>
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={tokenInput}
              onChange={e => setTokenInput(e.target.value.replace(/\D/g, '').slice(0, 6))}
              onKeyDown={e => e.key === 'Enter' && tokenInput.length === 6 && handleManualScan()}
              placeholder="000000"
              className="aa-field aa-field-emerald w-full px-4 py-4 rounded-xl border-2 border-slate-200 focus:border-emerald-500 text-center text-3xl tracking-widest font-mono"
              autoFocus
            />
            <button onClick={handleManualScan} disabled={tokenInput.length !== 6}
              className="aa-btn aa-btn-emerald w-full mt-4 bg-emerald-600 text-white py-3 rounded-xl font-medium hover:bg-emerald-700 disabled:opacity-50">
              <span className="relative z-10">{tokenInput.length === 6 ? 'Procesar canje' : `Ingresa ${6 - tokenInput.length} digito${6 - tokenInput.length === 1 ? '' : 's'} mas`}</span>
            </button>
          </>
        )}
      </div>
    </div>
  )
}
