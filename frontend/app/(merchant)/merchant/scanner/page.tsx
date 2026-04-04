'use client'

import { useState } from 'react'
import { api } from '@/lib/api'
import Link from 'next/link'

type ScanState = 'scanning' | 'processing' | 'success' | 'failure'

export default function CashierScanner() {
  const [state, setState] = useState<ScanState>('scanning')
  const [tokenInput, setTokenInput] = useState('')
  const [result, setResult] = useState<any>(null)

  async function handleScan() {
    if (!tokenInput.trim()) return
    setState('processing')

    const apiPromise = api.scanRedemption(tokenInput.trim())
      .catch(e => ({ success: false, message: e.error || 'Error scanning QR' }))

    const animPromise = new Promise(resolve => setTimeout(resolve, 1500))

    const [apiResult] = await Promise.all([apiPromise, animPromise])

    setResult(apiResult)
    setState(apiResult.success ? 'success' : 'failure')

    // Auto-reset after 5 seconds
    setTimeout(() => {
      setState('scanning')
      setTokenInput('')
      setResult(null)
    }, 5000)
  }

  // SUCCESS screen — full green (with hybrid cash reminder)
  if (state === 'success') {
    const isHybrid = result?.cashAmount && parseFloat(result.cashAmount) > 0;
    return (
      <div className="min-h-screen bg-green-500 flex items-center justify-center">
        <div className="text-center text-white animate-check">
          <span className="text-8xl">✅</span>
          <h1 className="text-3xl font-bold mt-6">CANJE EXITOSO</h1>
          {result?.productName && <p className="text-xl mt-2">{result.productName}</p>}
          {result?.amount && <p className="text-2xl font-bold mt-2">{parseFloat(result.amount).toLocaleString()} pts</p>}
          {isHybrid && (
            <div className="bg-yellow-400 text-yellow-900 rounded-xl p-4 mt-4 mx-4">
              <p className="text-sm font-bold uppercase">Oferta hibrida</p>
              <p className="text-3xl font-bold mt-1">${parseFloat(result.cashAmount).toLocaleString()}</p>
              <p className="text-sm font-bold mt-1">Recuerda recibir primero los $, antes de entregar el premio</p>
            </div>
          )}
          <p className="mt-4 text-green-100">El canje ha sido procesado correctamente</p>
        </div>
      </div>
    )
  }

  // FAILURE screen — full red
  if (state === 'failure') {
    return (
      <div className="min-h-screen bg-red-500 flex items-center justify-center">
        <div className="text-center text-white animate-fade-in">
          <span className="text-8xl">❌</span>
          <h1 className="text-3xl font-bold mt-6">RECHAZADO</h1>
          <p className="text-xl mt-2">{result?.message || 'Error desconocido'}</p>
          <button onClick={() => { setState('scanning'); setTokenInput(''); setResult(null); }}
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
      <div className="flex items-center gap-3 mb-6">
        <Link href="/merchant" className="text-emerald-700 text-2xl">&larr;</Link>
        <h1 className="text-xl font-bold text-emerald-800">Escaner de canjes</h1>
      </div>

      <div className="bg-white rounded-2xl p-6 shadow-sm">
        <div className="bg-slate-100 rounded-xl h-64 flex items-center justify-center mb-4">
          <div className="text-center">
            <span className="text-5xl">📷</span>
            <p className="text-sm text-slate-500 mt-2">Camara QR activa</p>
            <p className="text-xs text-slate-400">En produccion: escaneo automatico</p>
          </div>
        </div>

        <p className="text-sm text-slate-500 mb-2">O ingresa el token manualmente:</p>
        <textarea
          value={tokenInput} onChange={e => setTokenInput(e.target.value)}
          placeholder="Pega el token QR aqui..."
          className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500 text-sm h-24 resize-none"
        />

        <button onClick={handleScan} disabled={!tokenInput.trim()}
          className="w-full mt-4 bg-emerald-600 text-white py-3 rounded-xl font-medium hover:bg-emerald-700 disabled:opacity-50 transition">
          Procesar canje
        </button>
      </div>
    </div>
  )
}
