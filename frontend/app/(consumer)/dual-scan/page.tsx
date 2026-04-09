'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { MdCheckCircle, MdCancel } from 'react-icons/md'
import { api } from '@/lib/api'
import Link from 'next/link'

type State = 'scanning' | 'processing' | 'success' | 'error'

export default function ConsumerDualScanPage() {
  const [state, setState] = useState<State>('scanning')
  const [result, setResult] = useState<{ message: string; valueAssigned?: string; newBalance?: string } | null>(null)
  const [errorMsg, setErrorMsg] = useState('')
  const [inputMode, setInputMode] = useState<'camera' | 'manual'>('camera')
  const [tokenInput, setTokenInput] = useState('')
  const [cameraError, setCameraError] = useState<string | null>(null)
  const scannerRef = useRef<any>(null)
  const isProcessingRef = useRef(false)
  const scannerContainerId = 'consumer-dual-scanner'

  const stopScanner = useCallback(async () => {
    if (scannerRef.current) {
      try { await scannerRef.current.stop() } catch {}
      try { scannerRef.current.clear() } catch {}
      scannerRef.current = null
    }
  }, [])

  const processToken = useCallback(async (token: string) => {
    if (isProcessingRef.current) return
    isProcessingRef.current = true
    setState('processing')
    await stopScanner()

    try {
      const res = await api.confirmDualScan(token)
      setResult(res)
      setState('success')
    } catch (e: any) {
      setErrorMsg(e.error || 'Error procesando QR')
      setState('error')
    }

    setTimeout(() => {
      setState('scanning')
      setTokenInput('')
      setResult(null)
      setErrorMsg('')
      isProcessingRef.current = false
    }, 6000)
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
        { fps: 10, qrbox: { width: 250, height: 250 }, aspectRatio: 1, disableFlip: false },
        (decodedText: string) => {
          if (!isProcessingRef.current && decodedText.trim()) processToken(decodedText.trim())
        },
        () => {}
      )
    } catch (err: any) {
      const msg = typeof err === 'string' ? err : err?.message || 'No se pudo acceder a la camara'
      setCameraError(msg)
      setInputMode('manual')
    }
  }, [stopScanner, processToken])

  useEffect(() => {
    if (state === 'scanning' && inputMode === 'camera') startScanner()
    return () => { stopScanner() }
  }, [state, inputMode, startScanner, stopScanner])

  function handleManualScan() {
    if (!tokenInput.trim()) return
    processToken(tokenInput.trim())
  }

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      <div className="bg-slate-800 p-4 flex items-center gap-3">
        <Link href="/consumer" className="text-white text-2xl">&larr;</Link>
        <h1 className="text-lg font-bold">Escanear QR del comercio</h1>
      </div>

      {state === 'scanning' && (
        <div className="p-4">
          <div className="flex gap-2 mb-4">
            <button
              onClick={() => setInputMode('camera')}
              className={`flex-1 py-2 rounded-lg text-sm font-medium ${inputMode === 'camera' ? 'bg-indigo-600' : 'bg-slate-700'}`}
            >Camara</button>
            <button
              onClick={() => setInputMode('manual')}
              className={`flex-1 py-2 rounded-lg text-sm font-medium ${inputMode === 'manual' ? 'bg-indigo-600' : 'bg-slate-700'}`}
            >Manual</button>
          </div>

          {inputMode === 'camera' ? (
            <div>
              <div id={scannerContainerId} className="w-full aspect-square bg-black rounded-2xl overflow-hidden" />
              {cameraError && (
                <p className="text-red-400 text-sm mt-3 text-center">{cameraError}</p>
              )}
              <p className="text-center text-slate-400 text-sm mt-4">
                Apunta la camara al QR del comercio
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <textarea
                value={tokenInput}
                onChange={e => setTokenInput(e.target.value)}
                placeholder="Pega el codigo del QR aqui"
                className="w-full bg-slate-800 text-white px-4 py-3 rounded-xl text-sm h-32 resize-none border border-slate-700 focus:outline-none focus:border-indigo-500"
              />
              <button
                onClick={handleManualScan}
                disabled={!tokenInput.trim()}
                className="w-full bg-indigo-600 text-white py-3 rounded-xl font-medium disabled:opacity-50"
              >Confirmar</button>
            </div>
          )}
        </div>
      )}

      {state === 'processing' && (
        <div className="flex flex-col items-center justify-center min-h-[60vh] p-4">
          <div className="w-16 h-16 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin mb-4" />
          <p className="text-slate-300">Procesando...</p>
        </div>
      )}

      {state === 'success' && result && (
        <div className="flex flex-col items-center justify-center min-h-[80vh] p-4 bg-emerald-600">
          <MdCheckCircle className="w-20 h-20 mx-auto mb-4 animate-pulse" />
          <p className="text-2xl font-bold mb-2">Bienvenido!</p>
          <p className="text-emerald-100 text-center mb-6">{result.message}</p>
          {result.valueAssigned && (
            <div className="bg-emerald-700 rounded-2xl p-6 w-full max-w-xs text-center">
              <p className="text-emerald-200 text-sm">Ganaste</p>
              <p className="text-4xl font-bold">{parseFloat(result.valueAssigned).toLocaleString()}</p>
              <p className="text-emerald-200 text-sm mt-2">puntos</p>
            </div>
          )}
        </div>
      )}

      {state === 'error' && (
        <div className="flex flex-col items-center justify-center min-h-[80vh] p-4 bg-red-600">
          <MdCancel className="w-20 h-20 mx-auto mb-4" />
          <p className="text-2xl font-bold mb-2">No se pudo procesar</p>
          <p className="text-red-100 text-center max-w-xs">{errorMsg}</p>
        </div>
      )}
    </div>
  )
}
