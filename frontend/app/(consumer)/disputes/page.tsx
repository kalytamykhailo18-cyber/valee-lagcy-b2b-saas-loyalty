'use client'

import { useState } from 'react'
import { api } from '@/lib/api'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

export default function ConsumerDisputesPage() {
  const [description, setDescription] = useState('')
  const [screenshotUrl, setScreenshotUrl] = useState('')
  const [uploading, setUploading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState('')
  const router = useRouter()

  async function handleScreenshotUpload(file: File) {
    setUploading(true)
    try {
      const result = await api.uploadConsumerImage(file)
      if (result.success && result.url) {
        setScreenshotUrl(result.url)
      }
    } catch {
      setError('Error al subir la imagen')
    }
    setUploading(false)
  }

  async function handleSubmit() {
    if (!description.trim()) return
    setSubmitting(true)
    setError('')
    try {
      await api.submitDispute({
        description: description.trim(),
        screenshotUrl: screenshotUrl || undefined,
      })
      setSubmitted(true)
    } catch (e: any) {
      setError(e.error || 'Error al enviar reclamo')
    }
    setSubmitting(false)
  }

  if (submitted) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="w-full max-w-sm text-center space-y-4">
          <div className="text-5xl">✅</div>
          <h2 className="text-xl font-bold text-slate-700">Reclamo enviado</h2>
          <p className="text-slate-500 text-sm">
            Tu reclamo ha sido recibido. El comercio lo revisara y te notificaremos cuando haya una respuesta.
          </p>
          <button onClick={() => router.push('/consumer')}
            className="w-full bg-indigo-600 text-white py-3 rounded-xl font-medium hover:bg-indigo-700 transition">
            Volver al inicio
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen pb-20">
      {/* Header */}
      <div className="bg-white shadow-sm p-4 flex items-center gap-3">
        <Link href="/consumer" className="text-indigo-600 text-2xl">&larr;</Link>
        <h1 className="text-lg font-bold text-slate-800">Enviar reclamo</h1>
      </div>

      <div className="p-4 space-y-4">
        <div className="bg-indigo-50 rounded-xl p-4">
          <p className="text-sm text-indigo-700">
            Describe tu problema o reclamo. Puedes adjuntar una captura de pantalla como evidencia. El comercio revisara tu caso y te notificara la resolucion.
          </p>
        </div>

        {/* Description */}
        <div>
          <label className="text-sm font-medium text-slate-700">Descripcion del reclamo</label>
          <textarea value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="Explica tu problema en detalle..."
            className="w-full mt-1 px-4 py-3 rounded-xl border border-slate-200 text-sm h-32 resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500" />
        </div>

        {/* Screenshot Upload */}
        <div>
          <label className="text-sm font-medium text-slate-700">Captura de pantalla (opcional)</label>
          <div className="mt-1 flex items-center gap-3">
            <label className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium cursor-pointer ${
              uploading ? 'bg-slate-100 text-slate-400' : 'bg-indigo-100 text-indigo-700 hover:bg-indigo-200'
            }`}>
              {uploading ? 'Subiendo...' : 'Adjuntar imagen'}
              <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden"
                disabled={uploading}
                onChange={e => { const f = e.target.files?.[0]; if (f) handleScreenshotUpload(f); e.target.value = '' }} />
            </label>
            {screenshotUrl && (
              <div className="flex items-center gap-2">
                <img src={screenshotUrl} alt="Captura" className="w-12 h-12 rounded-lg object-cover border border-slate-200" />
                <button onClick={() => setScreenshotUrl('')} className="text-xs text-red-500">Quitar</button>
              </div>
            )}
          </div>
        </div>

        {error && <p className="text-red-500 text-sm">{error}</p>}

        {/* Submit Button */}
        <button onClick={handleSubmit}
          disabled={submitting || !description.trim()}
          className="w-full bg-indigo-600 text-white py-3 rounded-xl font-medium hover:bg-indigo-700 disabled:opacity-50 transition">
          {submitting ? 'Enviando...' : 'Enviar reclamo'}
        </button>
      </div>
    </div>
  )
}
