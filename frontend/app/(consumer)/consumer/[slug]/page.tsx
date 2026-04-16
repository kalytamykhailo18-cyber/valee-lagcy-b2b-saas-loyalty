'use client'

import { useParams } from 'next/navigation'
import { useEffect, useState } from 'react'

export default function MerchantConsumerPage() {
  const params = useParams()
  const slug = params.slug as string

  useEffect(() => {
    // Store the merchant slug so the app uses it for auth
    if (slug) {
      localStorage.setItem('tenantSlug', slug)
    }
  }, [slug])

  // Redirect to the main consumer page with the slug pre-set
  useEffect(() => {
    if (slug) {
      window.location.href = `/consumer?merchant=${slug}`
    }
  }, [slug])

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center aa-rise">
        <div className="w-12 h-12 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto" />
        <p className="text-slate-500 mt-4">Cargando...</p>
      </div>
    </div>
  )
}
