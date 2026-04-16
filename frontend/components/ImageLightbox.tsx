'use client'

import { useEffect } from 'react'
import { MdDownload, MdClose } from 'react-icons/md'

/**
 * Tap-to-zoom image lightbox with optional download button.
 * Click backdrop or press Esc to dismiss.
 */
export function ImageLightbox({ src, alt, downloadName, onClose, onDownload }: {
  src: string | null
  alt?: string
  downloadName?: string
  onClose: () => void
  onDownload?: () => void
}) {
  useEffect(() => {
    if (!src) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [src, onClose])

  if (!src) return null

  return (
    <div
      onClick={onClose}
      className="aa-backdrop fixed inset-0 z-[100] bg-black/85 flex flex-col items-center justify-center p-4 cursor-zoom-out"
      role="dialog"
      aria-modal="true"
    >
      {/* Top bar */}
      <div className="absolute top-4 right-4 flex items-center gap-2" onClick={e => e.stopPropagation()}>
        <button
          onClick={async (e) => {
            e.stopPropagation()
            try {
              const url = src.includes('res.cloudinary.com')
                ? src.replace('/upload/', '/upload/fl_attachment/')
                : src
              const res = await fetch(url)
              const blob = await res.blob()
              const a = document.createElement('a')
              a.href = URL.createObjectURL(blob)
              a.download = downloadName || 'imagen.png'
              document.body.appendChild(a)
              a.click()
              document.body.removeChild(a)
              URL.revokeObjectURL(a.href)
            } catch {}
            onDownload?.()
          }}
          className="w-10 h-10 rounded-full bg-white/15 hover:bg-white/25 text-white flex items-center justify-center backdrop-blur transition"
          aria-label="Descargar"
        >
          <MdDownload className="w-5 h-5" />
        </button>
        <button
          onClick={onClose}
          aria-label="Cerrar"
          className="w-10 h-10 rounded-full bg-white/15 hover:bg-white/25 text-white flex items-center justify-center backdrop-blur transition"
        >
          <MdClose className="w-5 h-5" />
        </button>
      </div>
      <img
        src={src}
        alt={alt || ''}
        onClick={e => e.stopPropagation()}
        className="aa-modal max-w-[95vw] max-h-[85vh] rounded-xl shadow-2xl object-contain cursor-default"
      />
    </div>
  )
}
