'use client'

import { useState, useRef } from 'react'
import { api } from '@/lib/api'
import Link from 'next/link'

type Stage = 'idle' | 'processing' | 'result'

const ANIMATION_STEPS = [
  { label: 'Leyendo tu factura...', icon: '📄', duration: 500 },
  { label: 'Verificando con el comercio...', icon: '🔍', duration: 500 },
  { label: 'Agregando tus puntos...', icon: '💰', duration: 500 },
]

export default function ScanInvoice() {
  const [stage, setStage] = useState<Stage>('idle')
  const [animStep, setAnimStep] = useState(0)
  const [result, setResult] = useState<any>(null)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    setStage('processing')
    setAnimStep(0)
    setError('')

    // Start animation (1.5s minimum)
    const animPromise = new Promise<void>(resolve => {
      let step = 0
      const interval = setInterval(() => {
        step++
        setAnimStep(step)
        if (step >= ANIMATION_STEPS.length) {
          clearInterval(interval)
          resolve()
        }
      }, 500)
    })

    // Call API (simulated with extractedData for now)
    const apiPromise = api.validateInvoice({
      extractedData: {
        invoice_number: 'SCAN-' + Date.now(),
        total_amount: 100,
        transaction_date: new Date().toISOString(),
        customer_phone: null,
        merchant_name: null,
        confidence_score: 0.95,
      },
      assetTypeId: localStorage.getItem('assetTypeId') || '',
    }).catch(err => ({ success: false, message: err.error || 'Error processing invoice' }))

    // Wait for both animation and API
    const [, apiResult] = await Promise.all([animPromise, apiPromise])

    setResult(apiResult)
    setStage('result')
  }

  if (stage === 'processing') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-indigo-600">
        <div className="text-center text-white">
          {ANIMATION_STEPS.map((step, i) => (
            <div key={i} className={`transition-opacity duration-300 mb-4 ${i <= animStep ? 'opacity-100' : 'opacity-20'}`}>
              <span className="text-3xl">{step.icon}</span>
              <p className="text-lg mt-1">{step.label}</p>
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (stage === 'result' && result) {
    return (
      <div className={`min-h-screen flex items-center justify-center ${result.success ? 'bg-green-500' : 'bg-red-500'}`}>
        <div className="text-center text-white animate-fade-in">
          <span className="text-6xl">{result.success ? '✅' : '❌'}</span>
          <h2 className="text-2xl font-bold mt-4">{result.success ? 'Factura validada!' : 'No se pudo validar'}</h2>
          <p className="mt-2 text-white/80">{result.message}</p>
          {result.valueAssigned && (
            <p className="text-3xl font-bold mt-4">+{parseFloat(result.valueAssigned).toLocaleString()} pts</p>
          )}
          {result.newBalance && (
            <p className="mt-2 text-white/80">Nuevo saldo: {parseFloat(result.newBalance).toLocaleString()} pts</p>
          )}
          <Link href="/consumer" className="inline-block mt-8 bg-white/20 backdrop-blur px-6 py-3 rounded-xl font-medium">
            Volver al inicio
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen p-4">
      <div className="flex items-center gap-3 mb-6">
        <Link href="/consumer" className="text-indigo-600 text-2xl">&larr;</Link>
        <h1 className="text-xl font-bold">Escanear factura</h1>
      </div>

      <div className="bg-white rounded-2xl p-8 shadow-sm text-center">
        <span className="text-5xl">📸</span>
        <h2 className="text-lg font-semibold mt-4">Toma una foto de tu factura</h2>
        <p className="text-slate-500 text-sm mt-2">Puedes usar la camara o seleccionar una imagen de tu galeria</p>

        <input type="file" ref={fileRef} accept="image/*" capture="environment" onChange={handleFileSelect} className="hidden" />

        <div className="mt-6 space-y-3">
          <button onClick={() => fileRef.current?.click()} className="w-full bg-indigo-600 text-white py-3 rounded-xl font-medium hover:bg-indigo-700 transition">
            Tomar foto
          </button>
          <button onClick={() => { if (fileRef.current) { fileRef.current.removeAttribute('capture'); fileRef.current.click(); }}} className="w-full bg-slate-100 text-slate-700 py-3 rounded-xl font-medium hover:bg-slate-200 transition">
            Seleccionar de galeria
          </button>
        </div>

        {error && <p className="text-red-500 text-sm mt-4">{error}</p>}
      </div>
    </div>
  )
}
