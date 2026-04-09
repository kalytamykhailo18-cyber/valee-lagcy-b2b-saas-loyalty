'use client'

import { useState } from 'react'
import { api } from '@/lib/api'

interface UploadResult {
  rowsLoaded: number
  rowsSkipped: number
  rowsErrored: number
  errorDetails?: string[]
}

export default function CsvUploadPage() {
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [result, setResult] = useState<UploadResult | null>(null)
  const [error, setError] = useState('')
  const [csvText, setCsvText] = useState('')

  async function handleUpload() {
    setError('')
    setResult(null)

    let content = csvText
    if (file) {
      content = await file.text()
    }

    if (!content.trim()) {
      setError('Selecciona un archivo CSV o pega el contenido')
      return
    }

    setUploading(true)
    try {
      const res = await api.uploadCSV(content)
      setResult(res)
      setFile(null)
      setCsvText('')
    } catch (e: any) {
      setError(e.error || 'Error al cargar el CSV')
    } finally {
      setUploading(false)
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (f) {
      setFile(f)
      setCsvText('')
    }
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Page header */}
      <div className="px-4 sm:px-6 lg:px-8 pt-6 lg:pt-8 pb-4">
        <h1 className="text-2xl lg:text-3xl font-bold text-slate-800">Cargar CSV de facturas</h1>
        <p className="text-sm text-slate-500 mt-1">Sube el archivo diario de transacciones exportado desde tu POS</p>
      </div>

      {/* Content */}
      <div className="px-4 sm:px-6 lg:px-8 pb-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Upload form — 2 cols on desktop */}
          <div className="lg:col-span-2 bg-white rounded-2xl p-5 lg:p-6 shadow-sm border border-slate-100 space-y-5">
            <div className="bg-emerald-50 border border-emerald-100 rounded-xl p-4 text-sm text-emerald-800">
              <p className="font-semibold mb-1">Formato esperado</p>
              <code className="text-xs block mt-2 bg-white/60 px-3 py-2 rounded-lg font-mono">
                invoice_number,total,date
              </code>
              <p className="text-xs mt-3 leading-relaxed">
                Cada fila representa una factura. Las facturas duplicadas (mismo numero) se omiten silenciosamente.
                Las filas con error se reportan al final del proceso.
              </p>
            </div>

            <div>
              <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Subir archivo CSV</label>
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={handleFileChange}
                className="block w-full text-sm text-slate-600 mt-2 file:mr-3 file:py-2.5 file:px-5 file:rounded-lg file:border-0 file:bg-emerald-50 file:text-emerald-700 file:font-semibold file:cursor-pointer hover:file:bg-emerald-100 cursor-pointer"
              />
              {file && (
                <p className="text-xs text-slate-500 mt-2">
                  Archivo: {file.name} ({(file.size / 1024).toFixed(1)} KB)
                </p>
              )}
            </div>

            <div>
              <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">O pegar contenido directamente</label>
              <textarea
                value={csvText}
                onChange={(e) => { setCsvText(e.target.value); setFile(null) }}
                placeholder="invoice_number,total,date&#10;INV-001,50.00,2026-04-08&#10;INV-002,100.00,2026-04-08"
                className="w-full h-40 lg:h-48 mt-2 px-4 py-3 rounded-lg border border-slate-200 text-xs font-mono resize-none focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">
                {error}
              </div>
            )}

            <button
              onClick={handleUpload}
              disabled={uploading || (!file && !csvText.trim())}
              className="w-full bg-emerald-600 text-white py-3 rounded-xl font-semibold text-sm disabled:opacity-50 hover:bg-emerald-700 transition"
            >
              {uploading ? 'Procesando...' : 'Cargar facturas'}
            </button>
          </div>

          {/* Result panel — 1 col on desktop */}
          <div className="space-y-4">
            {result ? (
              <div className="bg-white rounded-2xl p-5 lg:p-6 shadow-sm border border-slate-100">
                <h2 className="font-semibold text-slate-800 mb-4">Resultado</h2>
                <div className="space-y-3">
                  <div className="flex items-center justify-between p-3 bg-emerald-50 rounded-xl">
                    <span className="text-sm text-emerald-800 font-medium">Cargadas</span>
                    <span className="text-2xl font-bold text-emerald-700">{result.rowsLoaded}</span>
                  </div>
                  <div className="flex items-center justify-between p-3 bg-amber-50 rounded-xl">
                    <span className="text-sm text-amber-800 font-medium">Duplicadas</span>
                    <span className="text-2xl font-bold text-amber-700">{result.rowsSkipped}</span>
                  </div>
                  <div className="flex items-center justify-between p-3 bg-red-50 rounded-xl">
                    <span className="text-sm text-red-800 font-medium">Con error</span>
                    <span className="text-2xl font-bold text-red-700">{result.rowsErrored}</span>
                  </div>
                </div>

                {result.errorDetails && result.errorDetails.length > 0 && (
                  <div className="mt-4 pt-4 border-t border-slate-100">
                    <p className="text-xs font-semibold text-red-700 mb-2">Errores:</p>
                    <ul className="text-xs text-red-600 space-y-1 max-h-40 overflow-auto">
                      {result.errorDetails.map((e, i) => <li key={i}>- {e}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            ) : (
              <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-100 text-center">
                <p className="text-sm text-slate-400">El resultado de la carga aparecera aqui</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
