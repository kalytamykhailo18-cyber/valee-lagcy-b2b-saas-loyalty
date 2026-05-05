'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { MdCheckCircle } from 'react-icons/md'
import { api } from '@/lib/api'
import { formatCash, formatPoints } from '@/lib/format'

// Same input-sanitization pair used on Productos / Promociones hibridas.
// Eric 2026-04-25/26: Venezuelan merchants type "1.500" expecting 1500 (dot is
// the thousand separator in es-VE), but a raw <input type="number"> reads it
// as 1.5 and the system multiplies the wrong amount. Strip non-digits on
// input, re-format with dot thousand separators on display.
const fmtThousands = (s: string) => {
  const digits = String(s).replace(/\D/g, '')
  if (!digits) return ''
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}
const stripNonDigits = (s: string) => s.replace(/\D/g, '')

function decodeDualScanNonce(token: string): string | null {
  // Post 2026-04-23 short-QR redesign the server returns the bare 16-char hex
  // nonce as the token (so the QR drops from version 14 to 3). Older callers
  // still emit a base64 HMAC payload with payload.nonce inside — keep that
  // path so QRs in flight during a deploy keep working. Without this branch
  // the merchant polling silently no-op'd and the cashier never saw the green
  // confirmation when the customer paid (Eric 2026-04-26).
  if (/^[0-9a-f]{8,32}$/i.test(token)) return token
  try {
    const decoded = JSON.parse(atob(token))
    const nonce = decoded?.payload?.nonce
    return typeof nonce === 'string' ? nonce : null
  } catch {
    return null
  }
}

function maskPhone(p: string | null): string {
  if (!p) return ''
  if (p.length < 4) return p
  return `***${p.slice(-4)}`
}

interface ConfirmedPayment {
  valueAssigned: string
  consumerPhone: string | null
  consumerName: string | null
  confirmedAt: string
}

function QRImage({ value }: { value: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    import('qrcode').then(QRCode => {
      QRCode.toDataURL(value, { width: 320, margin: 2, errorCorrectionLevel: 'M' })
        .then(url => { if (!cancelled) setDataUrl(url) })
        .catch(() => { if (!cancelled) setDataUrl(null) })
    })
    return () => { cancelled = true }
  }, [value])

  if (!dataUrl) {
    return (
      <div className="w-64 h-64 lg:w-80 lg:h-80 flex items-center justify-center bg-slate-100 rounded-lg">
        <div className="w-10 h-10 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }
  return <img src={dataUrl} alt="QR" className="w-64 h-64 lg:w-80 lg:h-80" />
}

interface MultiplierInfo {
  currentRate: string
  defaultRate: string
  assetTypeId: string | null
  preferredExchangeSource?: string | null
  referenceCurrency?: string | null
  exchangeRateBs?: number | null
}

export default function DualScanPage() {
  const [amount, setAmount] = useState('')
  const [generating, setGenerating] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  const [expiresAt, setExpiresAt] = useState<number | null>(null)
  const [secondsLeft, setSecondsLeft] = useState(0)
  const [error, setError] = useState('')
  const [multiplier, setMultiplier] = useState<MultiplierInfo | null>(null)
  const [confirmed, setConfirmed] = useState<ConfirmedPayment | null>(null)
  const confirmedRef = useRef(false)
  // Eric 2026-05-04 (Notion "Escaner de pagos en efectivo"): when the
  // tenant has 2+ branches, force the cashier to pick the sucursal
  // before generating a cash-payment QR. Same gate already applied to
  // the redemption scanner — keeps trazabilidad por sucursal honest.
  const [branches, setBranches] = useState<Array<{ id: string; name: string; active: boolean }>>([])
  const [branchId, setBranchId] = useState('')

  // Load multiplier + exchange rate so the merchant can preview how many
  // points a given Bs amount will generate, BEFORE committing the QR.
  useEffect(() => {
    (async () => {
      try {
        const m = await api.getMultiplier()
        setMultiplier(m)
      } catch {}
      try {
        const data: any = await api.getBranches()
        const active = (data.branches || []).filter((b: any) => b.active)
        setBranches(active)
        // 0 or 1 active branch → free, no selector needed. Auto-pick
        // the only one so the request still carries branchId.
        if (active.length === 1) setBranchId(active[0].id)
      } catch {}
    })()
  }, [])

  // Preview: compute expected points for the current input.
  // The dual-scan amount is always in the tenant's reference currency
  // (USD/EUR) — typed directly by the cashier for cash/mobile payments.
  // Formula: amount × multiplier, floored at 1.
  const currencySymbol = multiplier?.referenceCurrency === 'eur' ? '€' : '$'
  const previewPoints = (() => {
    const n = parseFloat(amount)
    if (!Number.isFinite(n) || n <= 0 || !multiplier) return null
    const rate = Number(multiplier.currentRate) || 1
    return Math.max(1, Math.round(n * rate))
  })()

  // Poll the backend so we can swap to a success animation the instant the
  // consumer confirms — Eric flagged on 2026-04-23 that the cashier had no
  // feedback other than the TTL ticking down. We check every 1.5s while a
  // token is displayed, and stop the moment consumed=true comes back.
  useEffect(() => {
    if (!token || confirmed) return
    const nonce = decodeDualScanNonce(token)
    if (!nonce) return
    confirmedRef.current = false
    let cancelled = false
    const tick = async () => {
      if (cancelled || confirmedRef.current) return
      try {
        const res = await api.getDualScanStatus(nonce)
        if (cancelled) return
        if (res?.consumed) {
          confirmedRef.current = true
          setConfirmed({
            valueAssigned: String(res.valueAssigned || '0'),
            consumerPhone: res.consumerPhone || null,
            consumerName: res.consumerName || null,
            confirmedAt: res.confirmedAt || new Date().toISOString(),
          })
        }
      } catch {}
    }
    const interval = setInterval(tick, 1500)
    // Fire one immediately so a lucky race (consumer confirms right before
    // we mount the poller) still lights up the success view.
    tick()
    return () => { cancelled = true; clearInterval(interval) }
  }, [token, confirmed])

  // Countdown — compute initial value synchronously so user never sees 0 on mount
  useEffect(() => {
    if (!expiresAt) {
      setSecondsLeft(0)
      return
    }
    // Set immediately on this render cycle
    const initial = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))
    setSecondsLeft(initial)

    const interval = setInterval(() => {
      const left = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))
      setSecondsLeft(left)
      if (left <= 0) {
        clearInterval(interval)
        // Only clear the token if the consumer never confirmed. When a
        // success landed we keep the view mounted so the cashier sees the
        // green confirmation instead of getting bounced back to the form.
        if (!confirmedRef.current) {
          setToken(null)
          setExpiresAt(null)
        }
      }
    }, 1000)
    return () => clearInterval(interval)
  }, [expiresAt])

  async function generate() {
    setError('')
    if (!amount || parseFloat(amount) <= 0) {
      setError('Ingresa un monto valido')
      return
    }
    if (branches.length >= 2 && !branchId) {
      setError('Elegi la sucursal antes de generar el QR')
      return
    }
    setGenerating(true)
    try {
      const res = await api.initiateDualScan(amount, branchId || undefined)
      const exp = Number(res.expiresAt)
      // Sanity check: server-supplied expiresAt must be in the future. If client
      // clock is wildly off, treat the value as "now + 60s" so the timer at
      // least shows something meaningful instead of vanishing instantly.
      const safeExpiresAt = exp > Date.now() ? exp : Date.now() + 60_000
      setToken(res.token)
      setExpiresAt(safeExpiresAt)
    } catch (e: any) {
      setError(e.error || 'Error al generar QR')
    } finally {
      setGenerating(false)
    }
  }

  function reset() {
    setToken(null)
    setExpiresAt(null)
    setAmount('')
    setError('')
    setConfirmed(null)
    confirmedRef.current = false
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Page header */}
      <div className="px-4 sm:px-6 lg:px-8 pt-6 lg:pt-8 pb-4 aa-rise">
        <h1 className="text-2xl lg:text-3xl font-bold text-slate-800 tracking-tight">Pago en efectivo</h1>
        <p className="text-sm text-slate-500 mt-1">Genera un codigo QR temporal para clientes que pagan sin recibo (efectivo)</p>
        {/* Cross-link back to scanner — cashier kiosk flow toggles between
            the two without needing the sidebar. */}
        <Link
          href="/merchant/scanner"
          className="inline-flex items-center gap-2 mt-3 text-sm text-emerald-700 hover:text-emerald-800 font-medium"
        >
          &larr; Ir al escaner de canjes
        </Link>
      </div>

      {/* Content */}
      <div className="px-4 sm:px-6 lg:px-8 pb-8">
        <div className="max-w-xl mx-auto">
          {confirmed ? (
            <div className="bg-gradient-to-br from-emerald-500 to-emerald-600 text-white rounded-2xl p-8 text-center space-y-5 aa-pop shadow-xl">
              <div className="flex justify-center">
                <div className="w-24 h-24 rounded-full bg-white/20 flex items-center justify-center animate-qr-build">
                  <MdCheckCircle className="w-20 h-20 text-white" />
                </div>
              </div>
              <h2 className="text-3xl font-extrabold tracking-tight">Pago registrado</h2>
              <div className="bg-white/10 rounded-xl p-4 space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-emerald-100">Monto</span>
                  <span className="font-bold text-lg">{currencySymbol}{formatCash(amount)}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-emerald-100">Cliente</span>
                  <span className="font-semibold">
                    {confirmed.consumerName || maskPhone(confirmed.consumerPhone)}
                  </span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-emerald-100">Puntos entregados</span>
                  <span className="font-bold text-lg tabular-nums">
                    +{formatPoints(confirmed.valueAssigned)} pts
                  </span>
                </div>
              </div>
              <button
                onClick={reset}
                className="aa-btn w-full bg-white text-emerald-700 py-3 rounded-xl font-bold text-sm hover:bg-emerald-50 transition"
              >
                <span className="relative z-10">Nuevo pago</span>
              </button>
            </div>
          ) : !token ? (
            <>
              {/* Sucursal selector — mirrors the redemption scanner's PASO 1
                  gate. Only renders when the tenant has 2+ active branches;
                  with 0 or 1 branch the selector is unnecessary and the
                  cash-payment QR can be generated freely. Eric 2026-05-04. */}
              {branches.length >= 2 && (
                <div className={`rounded-xl p-3 mb-4 shadow-sm aa-rise-sm border-2 ${!branchId ? 'bg-amber-50 border-amber-400' : 'bg-white border-transparent'}`}>
                  <label className={`text-xs font-semibold uppercase tracking-wide ${!branchId ? 'text-amber-800' : 'text-slate-500'}`}>
                    {!branchId ? 'Paso 1: Elige la sucursal' : 'Sucursal del pago'}
                  </label>
                  <select
                    value={branchId}
                    onChange={e => setBranchId(e.target.value)}
                    className={`aa-field aa-field-emerald w-full mt-1 px-3 py-2.5 rounded-lg border text-sm bg-white ${!branchId ? 'border-amber-400 ring-2 ring-amber-200' : 'border-slate-200'}`}
                  >
                    <option value="">Seleccionar sucursal...</option>
                    {branches.map(b => (
                      <option key={b.id} value={b.id}>{b.name}</option>
                    ))}
                  </select>
                  {!branchId && (
                    <p className="text-xs text-amber-800 mt-2 font-medium">
                      Tenes que elegir la sucursal antes de generar el QR. Asi cada punto emitido queda atribuido a la sucursal correcta.
                    </p>
                  )}
                </div>
              )}
              <div className={`bg-white rounded-2xl p-6 lg:p-8 shadow-sm border border-slate-100 space-y-5 aa-rise ${branches.length >= 2 && !branchId ? 'opacity-60 pointer-events-none' : ''}`} style={{ animationDelay: '80ms' }}>
              <div>
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Monto de la transaccion ({currencySymbol})</label>
                <div className="relative mt-2">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 font-bold pointer-events-none text-xl">{currencySymbol}</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={fmtThousands(amount)}
                    onChange={e => setAmount(stripNonDigits(e.target.value))}
                    placeholder="30"
                    className="aa-field aa-field-emerald w-full pl-10 pr-4 py-4 rounded-xl border border-slate-200 text-2xl font-bold text-slate-800 tabular-nums"
                    autoFocus
                  />
                </div>
                {previewPoints !== null && (
                  <div className="mt-3 bg-emerald-50 border border-emerald-200 rounded-xl p-3 flex items-center justify-between">
                    <span className="text-sm text-emerald-700">El cliente ganara</span>
                    <span className="text-lg font-bold text-emerald-700 tabular-nums">{formatPoints(previewPoints)} pts</span>
                  </div>
                )}
                <p className="text-xs text-slate-400 mt-2">
                  El cliente escaneara el QR para acumular sus puntos. Sin necesidad de factura fiscal.
                </p>
              </div>

              {error && (
                <div className="aa-pop bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">
                  {error}
                </div>
              )}

              <button
                onClick={generate}
                disabled={generating || !amount || (branches.length >= 2 && !branchId)}
                className="aa-btn aa-btn-emerald w-full bg-emerald-600 text-white py-4 rounded-xl font-semibold text-base disabled:opacity-50 hover:bg-emerald-700 flex items-center justify-center"
              >
                {generating && <span className="aa-spinner" />}<span className="relative z-10">{generating ? 'Generando...' : 'Generar QR'}</span>
              </button>
            </div>
            </>
          ) : (
            <div className="bg-white rounded-2xl p-6 lg:p-8 shadow-sm border border-slate-100 text-center space-y-5 aa-pop">
              <div>
                <p className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Monto</p>
                <p className="text-4xl lg:text-5xl font-bold text-emerald-700 mt-2 tabular-nums">
                  {currencySymbol}{formatCash(amount)}
                </p>
              </div>

              <p className="text-sm text-slate-500">Muestra este codigo al cliente</p>

              <div className="inline-block bg-white border-4 border-emerald-200 rounded-2xl p-4 animate-qr-build">
                {/* Encode a deep link, not the raw token. Native phone cameras
                    decode a wa.me-style URL and open it in the browser, where
                    /scan?dual=<token> auto-triggers confirmDualScan. Before
                    this, the QR was just a base64 string and the consumer saw
                    raw text with a "Copy" option — "el token no hacia nada". */}
                <QRImage value={`${typeof window !== 'undefined' ? window.location.origin : 'https://valee.app'}/scan?dual=${encodeURIComponent(token)}`} />
              </div>

              <div className="bg-slate-50 rounded-xl p-4">
                <p key={secondsLeft} className="text-4xl font-bold text-emerald-700 aa-count tabular-nums">{secondsLeft}s</p>
                <p className="text-xs text-slate-500 mt-1 uppercase tracking-wide">Tiempo restante</p>
              </div>

              <button
                onClick={reset}
                className="text-sm text-slate-500 underline hover:text-slate-700 transition"
              >
                Cancelar y crear otro
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
