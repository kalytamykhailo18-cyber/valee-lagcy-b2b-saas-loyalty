'use client'

import { useParams, useSearchParams } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { MdChat, MdRocketLaunch } from 'react-icons/md'

// Splice the QR-encoded markers (branchId, cashier slug, referral slug) into
// the wa.me link's `text` param so the webhook parsers see them on the
// inbound message. Without this, the merchant-entry API returns a link with
// only "Ref: <slug>" and the cashier/branch/referral attribution is lost on
// the WhatsApp path.
function enrichWhatsAppLink(rawLink: string | null, params: { branch?: string | null; cjr?: string | null; ref2u?: string | null }): string | null {
  if (!rawLink) return null
  try {
    const u = new URL(rawLink)
    let text = u.searchParams.get('text') || ''
    if (params.branch) {
      text = text.replace(/(Ref:\s*[a-z0-9][a-z0-9-]*)/i, `$1/${params.branch}`)
    }
    if (params.cjr)   text += ` Cjr:${params.cjr}`
    if (params.ref2u) text += ` Ref2U:${params.ref2u}`
    u.searchParams.set('text', text)
    return u.toString()
  } catch {
    return rawLink
  }
}

interface MerchantEntry {
  name: string
  slug: string
  qrCodeUrl: string | null
  whatsappLink: string | null
}

export default function MerchantConsumerPage() {
  const params = useParams()
  const search = useSearchParams()
  const slug = params.slug as string
  const [entry, setEntry] = useState<MerchantEntry | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!slug) return
    // Persist tenant slug + any QR-encoded context (branch / cashier / referral)
    // before the consumer picks an entry path. The /consumer page (and the rest
    // of the PWA) reads these on mount to scope balance, catalog, attribution.
    localStorage.setItem('tenantSlug', slug)
    const branch = search?.get('branch')
    const cjr = search?.get('cjr')
    const ref2u = search?.get('ref2u')
    if (branch) localStorage.setItem('pendingBranchId', branch)
    else        localStorage.removeItem('pendingBranchId')
    if (cjr)    localStorage.setItem('pendingStaffQrSlug', cjr)
    else        localStorage.removeItem('pendingStaffQrSlug')
    if (ref2u)  localStorage.setItem('pendingReferralSlug', ref2u)
    else        localStorage.removeItem('pendingReferralSlug')

    // Fetch the merchant entry payload (name + wa.me link). No auth required.
    ;(async () => {
      try {
        const apiBase = process.env.NEXT_PUBLIC_API_BASE || ''
        const res = await fetch(`${apiBase}/api/consumer/merchant-entry/${encodeURIComponent(slug)}`)
        if (!res.ok) {
          setError('Comercio no encontrado')
          return
        }
        const data = await res.json()
        setEntry(data)
      } catch {
        setError('No se pudo cargar el comercio')
      }
    })()
  }, [slug, search])

  function continueInApp() {
    const qs = new URLSearchParams({ merchant: slug })
    const branch = search?.get('branch')
    const cjr = search?.get('cjr')
    const ref2u = search?.get('ref2u')
    if (branch) qs.set('branch', branch)
    if (cjr)    qs.set('cjr', cjr)
    if (ref2u)  qs.set('ref2u', ref2u)
    window.location.href = `/consumer?${qs.toString()}`
  }

  const enrichedWhatsAppLink = useMemo(() => enrichWhatsAppLink(entry?.whatsappLink ?? null, {
    branch: search?.get('branch'),
    cjr:    search?.get('cjr'),
    ref2u:  search?.get('ref2u'),
  }), [entry?.whatsappLink, search])

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="text-center max-w-md">
          <p className="text-rose-600 font-semibold">El comercio no se encuentra en nuestros registros</p>
        </div>
      </div>
    )
  }

  if (!entry) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-12 h-12 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-emerald-50 flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-sm border border-slate-100 p-6 space-y-5 aa-rise">
        <div className="text-center space-y-2">
          <p className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Bienvenido a</p>
          <h1 className="text-2xl font-bold text-emerald-700">{entry.name}</h1>
          <p className="text-sm text-slate-500">Elegi como queres entrar para sumar tus puntos.</p>
        </div>

        <button
          onClick={continueInApp}
          className="aa-btn aa-btn-emerald w-full bg-emerald-600 text-white py-3.5 rounded-xl font-semibold hover:bg-emerald-700 flex items-center justify-center gap-2"
        >
          <MdRocketLaunch className="w-5 h-5" />
          <span className="relative z-10">Continuar aqui</span>
        </button>

        {enrichedWhatsAppLink && (
          <a
            href={enrichedWhatsAppLink}
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full bg-white border-2 border-emerald-200 text-emerald-700 py-3 rounded-xl font-semibold hover:bg-emerald-50 transition text-center"
          >
            <span className="inline-flex items-center gap-2">
              <MdChat className="w-5 h-5" />
              Abrir en WhatsApp
            </span>
          </a>
        )}

        <p className="text-[11px] text-slate-400 text-center">
          Cualquiera de las dos opciones acumula tus puntos en el mismo comercio.
        </p>
      </div>
    </div>
  )
}
