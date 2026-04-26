'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { MdCameraAlt, MdDescription, MdVerifiedUser, MdStars, MdQrCodeScanner, MdPhotoLibrary } from 'react-icons/md'
import type { ComponentType } from 'react'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import Link from 'next/link'
import { formatPoints } from '@/lib/format'
import { consumerHomeUrl } from '@/lib/consumer-nav'

/**
 * Merchant-entry QR codes encode a wa.me deep link that carries a hidden
 * `[MERCHANT:<slug>]` tag (and optionally `:BRANCH:<id>`). When the consumer
 * PWA scans one, we don't want to push the user out to WhatsApp — we want to
 * keep them in the app and route them to that merchant's storefront.
 * Returns the slug if the decoded text looks like a merchant QR, otherwise null.
 */
function parseMerchantSlug(decoded: string): string | null {
  // Accept both the current "Ref: slug" / "Ref: slug/branchId" format and the
  // legacy "[MERCHANT:slug]" format still printed on older QRs.
  const refMatch = decoded.match(/Ref:\s*([a-z0-9][a-z0-9-]{0,48}[a-z0-9])(?:\/[a-f0-9-]+)?/i)
  if (refMatch) return refMatch[1].toLowerCase()
  const legacyMatch = decoded.match(/\[MERCHANT:([a-z0-9][a-z0-9-]{0,48}[a-z0-9])(?::BRANCH:[^\]]+)?\]/i)
  return legacyMatch ? legacyMatch[1].toLowerCase() : null
}

type Stage = 'idle' | 'processing' | 'result'

const ANIMATION_STEPS: Array<{ label: string; Icon: ComponentType<{ className?: string }>; duration: number }> = [
  { label: 'Leyendo tu factura...', Icon: MdDescription, duration: 500 },
  { label: 'Verificando con el comercio...', Icon: MdVerifiedUser, duration: 500 },
  { label: 'Agregando tus puntos...', Icon: MdStars, duration: 500 },
]

// Dual-scan / QR confirm: same 1.5s cadence but labels that match the
// "scanning a cashier code" UX instead of the invoice photo path.
const QR_ANIMATION_STEPS: Array<{ label: string; Icon: ComponentType<{ className?: string }>; duration: number }> = [
  { label: 'Leyendo el codigo...', Icon: MdDescription, duration: 500 },
  { label: 'Verificando con el comercio...', Icon: MdVerifiedUser, duration: 500 },
  { label: 'Agregando tus puntos...', Icon: MdStars, duration: 500 },
]

const SCANNER_ID = 'scan-unified-camera'

export default function ScanPage() {
  const router = useRouter()
  const [stage, setStage] = useState<Stage>('idle')
  const [animStep, setAnimStep] = useState(0)
  const [animMode, setAnimMode] = useState<'invoice' | 'qr'>('invoice')
  const activeSteps = animMode === 'qr' ? QR_ANIMATION_STEPS : ANIMATION_STEPS
  const [result, setResult] = useState<any>(null)
  const [error, setError] = useState('')
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [branches, setBranches] = useState<Array<{ id: string; name: string; latitude: number | null; longitude: number | null }>>([])
  const [selectedBranchId, setSelectedBranchId] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const scannerRef = useRef<any>(null)
  const isProcessingRef = useRef(false)

  // Load branches for this tenant. If there's only 1 branch we don't ask.
  // If the user recently scanned a QR (recentBranchId), pre-select it.
  // Otherwise try geolocation and pick the nearest.
  useEffect(() => {
    (async () => {
      try {
        const data: any = await api.getConsumerBranches()
        const bs = data?.branches || []
        setBranches(bs)
        if (bs.length <= 1) return
        if (data?.recentBranchId) {
          setSelectedBranchId(data.recentBranchId)
          return
        }
        // Geolocation fallback — if user grants permission, pick nearest branch
        if (typeof navigator !== 'undefined' && navigator.geolocation) {
          navigator.geolocation.getCurrentPosition(
            pos => {
              const { latitude: lat, longitude: lon } = pos.coords
              let nearest: { id: string; d: number } | null = null
              for (const b of bs) {
                if (b.latitude == null || b.longitude == null) continue
                const d = haversine(lat, lon, b.latitude, b.longitude)
                if (!nearest || d < nearest.d) nearest = { id: b.id, d }
              }
              // Only auto-pick if within 300m of a branch
              if (nearest && nearest.d < 0.3) setSelectedBranchId(nearest.id)
            },
            () => {},
            { enableHighAccuracy: false, timeout: 4000, maximumAge: 60000 },
          )
        }
      } catch {}
    })()
  }, [])

  function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371
    const toRad = (x: number) => (x * Math.PI) / 180
    const dLat = toRad(lat2 - lat1)
    const dLon = toRad(lon2 - lon1)
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  }

  // ----------------------------------------------------------------
  // QR scanner — runs continuously while idle. If a QR is detected
  // we route it as a dual-scan token. If the user instead taps the
  // shutter, we treat the captured frame as an invoice photo.
  // ----------------------------------------------------------------

  const stopScanner = useCallback(async () => {
    if (scannerRef.current) {
      try { await scannerRef.current.stop() } catch {}
      try { scannerRef.current.clear() } catch {}
      scannerRef.current = null
    }
  }, [])

  const processInvoiceImage = useCallback(async (file: File) => {
    setAnimMode('invoice')
    setStage('processing')
    setAnimStep(0)
    setError('')

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

    const assetTypeId = localStorage.getItem('assetTypeId') || ''
    const apiPromise = api.uploadInvoiceImage(file, assetTypeId, { branchId: selectedBranchId || undefined })
      .catch(err => ({ success: false, message: err.error || 'Error procesando la factura' }))

    const [, apiResult] = await Promise.all([animPromise, apiPromise])
    setResult({ kind: 'invoice', ...apiResult })
    setStage('result')
  }, [])

  const processQrToken = useCallback(async (rawToken: string) => {
    if (isProcessingRef.current) return
    isProcessingRef.current = true

    // 0) If the decoded text is a full URL pointing at /scan?dual=<token>
    //    (dual-scan QR generated by the merchant), pull out the token param.
    //    Without this, scanning a dual-scan QR with the native phone camera
    //    opens the browser with the URL visible — but when scanning from INSIDE
    //    the PWA we want to treat it as a dual-scan token directly.
    let token = rawToken
    try {
      if (/^https?:\/\//i.test(rawToken)) {
        const u = new URL(rawToken)
        const dual = u.searchParams.get('dual')
        if (dual) token = dual
      }
    } catch {}

    // 1) Merchant entry QR (wa.me link with [MERCHANT:slug] tag).
    //    Route the user to that merchant's consumer view instead of bouncing
    //    them out to WhatsApp.
    const slug = parseMerchantSlug(token)
    if (slug) {
      await stopScanner()
      router.push(`/consumer?tenant=${encodeURIComponent(slug)}`)
      return
    }

    setAnimMode('qr')
    setStage('processing')
    setAnimStep(0)
    await stopScanner()

    // Play the 3-step / 1.5s animation in parallel with the API call so
    // it's always visible even when the backend responds instantly
    // (Genesis 2026-04-24: "ya veo el QR nuevo pero ahora no sale la
    // animacion"). Previously we jumped animStep to the last index and
    // immediately awaited the API, skipping the progression entirely.
    const animPromise = new Promise<void>(resolve => {
      let step = 0
      const interval = setInterval(() => {
        step++
        setAnimStep(step)
        if (step >= QR_ANIMATION_STEPS.length) {
          clearInterval(interval)
          resolve()
        }
      }, 500)
    })

    const apiPromise = api.confirmDualScan(token)
      .then((res: any) => ({ kind: 'qr' as const, success: true, ...res }))
      .catch((e: any) => ({ kind: 'qr' as const, success: false, message: e.error || 'No se pudo procesar el QR' }))

    const [, apiResult] = await Promise.all([animPromise, apiPromise])
    setResult(apiResult)
    setStage('result')
  }, [stopScanner, router])

  // If the page was opened via /scan?dual=<token> (from the native camera on
  // the consumer's phone), auto-process it without waiting for a scan.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const dual = new URLSearchParams(window.location.search).get('dual')
    if (dual && !isProcessingRef.current) {
      processQrToken(dual)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const startScanner = useCallback(async () => {
    setCameraError(null)
    try {
      const { Html5Qrcode } = await import('html5-qrcode')
      await stopScanner()
      await new Promise(resolve => setTimeout(resolve, 100))

      const container = document.getElementById(SCANNER_ID)
      if (!container) return

      const scanner = new Html5Qrcode(SCANNER_ID)
      scannerRef.current = scanner

      await scanner.start(
        { facingMode: 'environment' },
        {
          fps: 10,
          // Scan the entire visible frame instead of a cropped square.
          // Genesis 2026-04-23: "favor de agrandar mas el recuadro del
          // escaneo, toda la pantalla si es posible". Using the full
          // viewfinder dimensions as qrbox means the detector sees
          // everything the user sees — no hidden dead zone.
          qrbox: (vw: number, vh: number) => ({ width: vw, height: vh }),
          disableFlip: false,
          // Request continuous autofocus so the camera keeps receipts sharp
          // as the user moves the phone. Most browsers silently ignore unknown
          // advanced constraints so this is safe.
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
            processQrToken(decodedText.trim())
          }
        },
        () => {}
      )

      // Belt-and-suspenders: force continuous autofocus via the raw track API
      // for browsers that accept applyConstraints but not the nested advanced
      // field in getUserMedia.
      try {
        const videoEl = document.querySelector<HTMLVideoElement>(`#${SCANNER_ID} video`)
        const track = (videoEl?.srcObject as MediaStream | null)?.getVideoTracks?.()[0]
        if (track && 'applyConstraints' in track) {
          await track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as any] }).catch(() => {})
        }
      } catch {}
    } catch (err: any) {
      const msg = typeof err === 'string' ? err : err?.message || 'No se pudo acceder a la camara'
      setCameraError(msg)
    }
  }, [stopScanner, processQrToken])

  useEffect(() => {
    if (stage === 'idle') {
      startScanner()
    }
    return () => { stopScanner() }
  }, [stage, startScanner, stopScanner])

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    stopScanner()
    processInvoiceImage(file)
  }

  function reset() {
    isProcessingRef.current = false
    setResult(null)
    setError('')
    setAnimStep(0)
    setStage('idle')
  }

  // ----------------------------------------------------------------
  // RENDER
  // ----------------------------------------------------------------

  if (stage === 'processing') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-indigo-600">
        <div className="text-center text-white space-y-4">
          {activeSteps.map((step, i) => (
            <div key={i} className={`transition-opacity duration-300 ${i <= animStep ? 'opacity-100' : 'opacity-20'}`}>
              <step.Icon className="w-8 h-8 mx-auto" />
              <p className="text-lg mt-1">{step.label}</p>
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (stage === 'result' && result) {
    const isSuccess = result.success
    return (
      <div className={`min-h-screen flex items-center justify-center p-6 ${isSuccess ? 'bg-emerald-600' : 'bg-red-600'} text-white`}>
        <div className="text-center space-y-4 max-w-sm">
          {result.kind === 'qr' ? (
            <MdQrCodeScanner className="w-20 h-20 mx-auto" />
          ) : (
            <MdDescription className="w-20 h-20 mx-auto" />
          )}
          <h2 className="text-3xl font-bold">
            {isSuccess
              ? (result.kind === 'qr' ? 'Canje procesado!' : 'Factura validada!')
              : 'No se pudo procesar'}
          </h2>
          {result.message && <p className="text-white/90">{result.message}</p>}
          {result.valueAssigned && (
            <p className="text-4xl font-extrabold tracking-tight">
              +{formatPoints(result.valueAssigned)} pts
            </p>
          )}
          {result.newBalance && (
            <p className="text-white/80">Nuevo saldo: {formatPoints(result.newBalance)} pts</p>
          )}
          <div className="flex flex-col gap-3 pt-4">
            <button
              onClick={reset}
              className="aa-btn bg-white/20 backdrop-blur px-6 py-3 rounded-xl font-semibold hover:bg-white/30"
            >
              <span className="relative z-10">Escanear otra</span>
            </button>
            <a
              href={consumerHomeUrl()}
              className="aa-btn bg-white text-slate-900 px-6 py-3 rounded-xl font-semibold hover:bg-slate-100"
            >
              <span className="relative z-10">Volver al inicio</span>
            </a>
          </div>
        </div>
      </div>
    )
  }

  // IDLE: live camera with QR detection + invoice photo capture
  // fixed + inset-0 + dvh units keep the action bar visible above iOS Safari's
  // dynamic bottom chrome (previously h-screen hid the capture buttons below
  // the fold on phones).
  return (
    <div className="fixed inset-0 bg-slate-900 text-white flex flex-col" style={{ height: '100dvh' }}>
      <header className="px-4 py-3 flex items-center gap-3 flex-shrink-0 absolute top-0 left-0 right-0 z-20 bg-gradient-to-b from-black/70 via-black/30 to-transparent">
        <a href={consumerHomeUrl()} className="text-2xl hover:-translate-x-0.5 transition-transform">&larr;</a>
        <h1 className="text-lg font-bold tracking-tight">Escanear</h1>
      </header>

      <div className="flex-1 relative bg-black overflow-hidden">
        <div id={SCANNER_ID} className="w-full h-full" />

        {/* Corner brackets hug the edges of the video container so the
            capture area == the whole frame (Genesis 2026-04-23: "toda la
            pantalla si es posible"). Small inset keeps the strokes from
            bleeding into the absolute edges of the screen. */}
        <div className="absolute inset-3 sm:inset-5 pointer-events-none">
          <div className="absolute top-0 left-0 w-14 h-14 border-t-4 border-l-4 border-white/85 rounded-tl-xl" />
          <div className="absolute top-0 right-0 w-14 h-14 border-t-4 border-r-4 border-white/85 rounded-tr-xl" />
          <div className="absolute bottom-0 left-0 w-14 h-14 border-b-4 border-l-4 border-white/85 rounded-bl-xl" />
          <div className="absolute bottom-0 right-0 w-14 h-14 border-b-4 border-r-4 border-white/85 rounded-br-xl" />
        </div>

        {cameraError && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-800/95 p-6">
            <p className="text-red-300 text-sm text-center">{cameraError}</p>
          </div>
        )}
      </div>

      <div
        className="flex-shrink-0 bg-gradient-to-t from-slate-900 via-slate-900 to-slate-900/95 px-4 pt-2 space-y-2"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 16px)' }}
      >
        {branches.length > 1 && (
          <div className="space-y-1">
            <label className="text-[11px] uppercase tracking-wide text-slate-400 font-semibold">En que sucursal estas?</label>
            <select
              value={selectedBranchId || ''}
              onChange={e => setSelectedBranchId(e.target.value || null)}
              className="w-full bg-slate-800 text-white border border-slate-700 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="">Seleccionar sucursal…</option>
              {branches.map(b => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>
        )}

        <p className="text-center text-xs text-slate-400">Apunta al QR del cajero o toma foto de tu factura</p>

        <input
          type="file"
          ref={fileRef}
          accept="image/*"
          capture="environment"
          onChange={handleFileSelect}
          className="hidden"
        />

        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => {
              if (fileRef.current) {
                fileRef.current.setAttribute('capture', 'environment')
                fileRef.current.click()
              }
            }}
            className="aa-btn aa-btn-primary bg-indigo-600 hover:bg-indigo-700 text-white py-3 rounded-2xl font-semibold flex items-center justify-center gap-2 text-sm"
          >
            <MdCameraAlt className="w-5 h-5 relative z-10" />
            <span className="relative z-10">Tomar foto</span>
          </button>
          <button
            onClick={() => {
              if (fileRef.current) {
                fileRef.current.removeAttribute('capture')
                fileRef.current.click()
              }
            }}
            className="aa-btn aa-btn-dark bg-slate-700 hover:bg-slate-600 text-white py-3 rounded-2xl font-semibold flex items-center justify-center gap-2 text-sm"
          >
            <MdPhotoLibrary className="w-5 h-5 relative z-10" />
            <span className="relative z-10">Galeria</span>
          </button>
        </div>

        {error && <p className="text-red-400 text-sm text-center">{error}</p>}
      </div>
    </div>
  )
}
