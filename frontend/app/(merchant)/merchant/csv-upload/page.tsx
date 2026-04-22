'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import { formatCash } from '@/lib/format'

interface UploadResult {
  batchId?: string
  status?: string
  rowsLoaded: number
  rowsSkipped: number
  rowsErrored: number
  rowsAutoCredited?: number
  // Backend returns objects { row, reason } — previously typed as
  // `string[]` which crashed React ('Objects are not valid as a React
  // child') when rendering. Keep the union so old responses still render.
  errorDetails?: Array<string | { row: number; reason: string }>
}

interface Invoice {
  id: string
  invoiceNumber: string
  amount: string
  transactionDate: string | null
  customerPhone: string | null
  status: string
  uploadBatchId: string | null
  createdAt: string
}

const STATUS_LABEL: Record<string, string> = {
  // 'Disponible' was confusing the merchant — read as 'product in stock'.
  // 'No reclamada' is explicit: the sale is registered but no customer has
  // submitted the photo to claim the points yet.
  available: 'No reclamada',
  claimed: 'Canjeada',
  pending_validation: 'En validacion',
  rejected: 'Rechazada',
}

const STATUS_STYLE: Record<string, string> = {
  available: 'bg-emerald-100 text-emerald-700',
  claimed: 'bg-indigo-100 text-indigo-700',
  pending_validation: 'bg-amber-100 text-amber-700',
  rejected: 'bg-red-100 text-red-700',
}

export default function CsvUploadPage() {
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [result, setResult] = useState<UploadResult | null>(null)
  const [error, setError] = useState('')
  const [csvText, setCsvText] = useState('')

  // Invoice list
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [total, setTotal] = useState(0)
  const [counts, setCounts] = useState<Record<string, number>>({ available: 0, claimed: 0, pending_validation: 0, rejected: 0 })
  const [statusFilter, setStatusFilter] = useState('')
  const [search, setSearch] = useState('')
  const [listLoading, setListLoading] = useState(true)

  const loadInvoices = useCallback(async (opts?: { batchId?: string }) => {
    setListLoading(true)
    try {
      const data = await api.getInvoices({
        status: statusFilter || undefined,
        search: search.trim() || undefined,
        batchId: opts?.batchId,
        limit: 50,
      })
      setInvoices(data.invoices)
      setTotal(data.total)
      setCounts(data.counts)
    } catch {}
    setListLoading(false)
  }, [statusFilter, search])

  useEffect(() => { loadInvoices() }, [loadInvoices])

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
      // Refresh the list — put the new batch on top
      loadInvoices()
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
      <div className="px-4 sm:px-6 lg:px-8 pt-6 lg:pt-8 pb-4 aa-rise">
        <h1 className="text-2xl lg:text-3xl font-bold text-slate-800 tracking-tight">Cargar CSV de facturas</h1>
        <p className="text-sm text-slate-500 mt-1">Sube el archivo diario de transacciones y revisa aqui mismo todas las facturas de tu comercio</p>
      </div>

      {/* Content */}
      <div className="px-4 sm:px-6 lg:px-8 pb-8 space-y-6">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Upload form — 2 cols on desktop */}
          <div className="lg:col-span-2 bg-white rounded-2xl p-5 lg:p-6 shadow-sm border border-slate-100 space-y-5 aa-rise" style={{ animationDelay: '80ms' }}>
            <div className="bg-emerald-50 border border-emerald-100 rounded-xl p-4 text-sm text-emerald-800">
              <p className="font-semibold mb-1">Formato esperado</p>
              <code className="text-xs block mt-2 bg-white/60 px-3 py-2 rounded-lg font-mono">
                invoice_number,total,date,phone
              </code>
              <p className="text-xs mt-3 leading-relaxed">
                Cada fila es una factura. Las duplicadas (mismo numero) se omiten silenciosamente. Las filas con error se reportan al final.
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
                className="aa-field aa-field-emerald w-full h-40 lg:h-48 mt-2 px-4 py-3 rounded-lg border border-slate-200 text-xs font-mono resize-none"
              />
            </div>

            {error && (
              <div className="aa-pop bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">
                {error}
              </div>
            )}

            <button
              onClick={handleUpload}
              disabled={uploading || (!file && !csvText.trim())}
              className="aa-btn aa-btn-emerald w-full bg-emerald-600 text-white py-3 rounded-xl font-semibold text-sm disabled:opacity-50 hover:bg-emerald-700 flex items-center justify-center"
            >
              {uploading && <span className="aa-spinner" />}<span className="relative z-10">{uploading ? 'Procesando...' : 'Cargar facturas'}</span>
            </button>
          </div>

          {/* Result panel — 1 col on desktop */}
          <div className="space-y-4 aa-rise" style={{ animationDelay: '160ms' }}>
            {result ? (
              <div className="aa-pop bg-white rounded-2xl p-5 lg:p-6 shadow-sm border border-slate-100">
                <h2 className="font-semibold text-slate-800 mb-4">Ultima carga</h2>
                <div className="space-y-3">
                  <div className="flex items-center justify-between p-3 bg-emerald-50 rounded-xl">
                    <span className="text-sm text-emerald-800 font-medium">Cargadas</span>
                    <span key={result.rowsLoaded} className="text-2xl font-bold text-emerald-700 aa-count tabular-nums">{result.rowsLoaded}</span>
                  </div>
                  <div className="flex items-center justify-between p-3 bg-amber-50 rounded-xl">
                    <span className="text-sm text-amber-800 font-medium">Duplicadas</span>
                    <span key={result.rowsSkipped} className="text-2xl font-bold text-amber-700 aa-count tabular-nums">{result.rowsSkipped}</span>
                  </div>
                  <div className="flex items-center justify-between p-3 bg-red-50 rounded-xl">
                    <span className="text-sm text-red-800 font-medium">Con error</span>
                    <span key={result.rowsErrored} className="text-2xl font-bold text-red-700 aa-count tabular-nums">{result.rowsErrored}</span>
                  </div>
                  {result.rowsAutoCredited != null && result.rowsAutoCredited > 0 && (
                    <div className="flex items-center justify-between p-3 bg-indigo-50 rounded-xl">
                      <span className="text-sm text-indigo-800 font-medium">Acreditadas al cliente</span>
                      <span key={result.rowsAutoCredited} className="text-2xl font-bold text-indigo-700 aa-count tabular-nums">{result.rowsAutoCredited}</span>
                    </div>
                  )}
                </div>

                {result.rowsAutoCredited != null && result.rowsAutoCredited > 0 && (
                  <p className="text-xs text-indigo-600 mt-3 leading-relaxed">
                    Las facturas con telefono se acreditaron automaticamente al cliente (no necesita mandar la foto).
                  </p>
                )}
                {result.batchId && (
                  <button
                    onClick={() => loadInvoices({ batchId: result.batchId })}
                    className="aa-btn mt-4 w-full bg-emerald-50 text-emerald-700 py-2 rounded-lg text-sm font-medium hover:bg-emerald-100"
                  >
                    <span className="relative z-10">Ver solo las de esta carga</span>
                  </button>
                )}

                {result.errorDetails && result.errorDetails.length > 0 && (
                  <div className="mt-4 pt-4 border-t border-slate-100">
                    <p className="text-xs font-semibold text-red-700 mb-2">Errores:</p>
                    <ul className="text-xs text-red-600 space-y-1 max-h-40 overflow-auto">
                      {result.errorDetails.map((e, i) => (
                        <li key={i}>
                          {typeof e === 'string'
                            ? `— ${e}`
                            : `— Fila ${e.row}: ${e.reason}`}
                        </li>
                      ))}
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

        {/* Invoice list — so merchants can verify their CSV actually loaded */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 aa-rise" style={{ animationDelay: '220ms' }}>
          <div className="p-5 border-b border-slate-100">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <h2 className="font-semibold text-slate-800 text-lg">
                Facturas registradas <span className="text-slate-400 text-sm font-normal tabular-nums">({total})</span>
              </h2>
              <input
                type="text"
                placeholder="Buscar numero de factura..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="aa-field aa-field-emerald px-3 py-2 rounded-lg border border-slate-200 text-sm w-full sm:w-64"
              />
            </div>

            {/* Status chips */}
            <div className="flex gap-2 mt-3 flex-wrap">
              <button
                onClick={() => setStatusFilter('')}
                className={`px-3 py-1.5 rounded-full text-xs font-semibold transition ${statusFilter === '' ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
              >
                Todas
              </button>
              {(['available', 'claimed', 'pending_validation', 'rejected'] as const).map(s => (
                <button
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  className={`px-3 py-1.5 rounded-full text-xs font-semibold transition ${statusFilter === s ? 'bg-emerald-600 text-white' : `${STATUS_STYLE[s]} hover:opacity-80`}`}
                >
                  {STATUS_LABEL[s]} <span className="opacity-70">({counts[s] ?? 0})</span>
                </button>
              ))}
            </div>
          </div>

          <div className="divide-y divide-slate-100">
            {listLoading ? (
              [0, 1, 2, 3].map(i => (
                <div key={i} className="p-4 flex items-center justify-between gap-3">
                  <div className="space-y-2 flex-1">
                    <div className="aa-skel h-3 w-1/3" />
                    <div className="aa-skel h-2 w-1/5" />
                  </div>
                  <div className="aa-skel h-5 w-20" />
                </div>
              ))
            ) : invoices.length === 0 ? (
              <div className="p-10 text-center">
                <p className="text-slate-400 text-sm">No hay facturas con estos filtros.</p>
                <p className="text-slate-400 text-xs mt-1">Sube un CSV arriba para registrar facturas.</p>
              </div>
            ) : (
              invoices.map((inv, i) => (
                <div
                  key={inv.id}
                  className="aa-row aa-row-in p-4 flex items-center justify-between gap-3 flex-wrap"
                  style={{ animationDelay: `${Math.min(i * 18, 300)}ms` }}
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-slate-800 font-mono text-sm truncate">{inv.invoiceNumber}</p>
                    <div className="text-xs text-slate-500 mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
                      {inv.transactionDate && <span>{new Date(inv.transactionDate).toLocaleDateString('es-VE', { timeZone: 'UTC' })}</span>}
                      {inv.customerPhone && <span>{inv.customerPhone}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <span className="font-bold text-slate-800 tabular-nums">
                      Bs {formatCash(inv.amount)}
                    </span>
                    <span className={`text-[11px] font-semibold px-2 py-1 rounded-full ${STATUS_STYLE[inv.status] || 'bg-slate-100 text-slate-600'}`}>
                      {STATUS_LABEL[inv.status] || inv.status}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
