'use client'

import { useEffect, useRef, useState } from 'react'

interface Props {
  latitude: number | null
  longitude: number | null
  onChange: (lat: number | null, lng: number | null) => void
  address?: string
}

// Venezuela bounds for initial view (Valencia is a good center for Valee)
const DEFAULT_CENTER: [number, number] = [10.1620, -68.0076] // Valencia, Carabobo
const DEFAULT_ZOOM = 12

export default function LocationPicker({ latitude, longitude, onChange, address }: Props) {
  const mapRef = useRef<HTMLDivElement>(null)
  const mapInstanceRef = useRef<any>(null)
  const markerRef = useRef<any>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [mapLoaded, setMapLoaded] = useState(false)

  // Initialize map (client-only)
  useEffect(() => {
    if (typeof window === 'undefined' || !mapRef.current) return
    if (mapInstanceRef.current) return

    ;(async () => {
      const L = (await import('leaflet')).default

      // Fix default marker icon paths (leaflet's default icons break with bundlers)
      delete (L.Icon.Default.prototype as any)._getIconUrl
      L.Icon.Default.mergeOptions({
        iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
        iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
        shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
      })

      const initialCenter: [number, number] = (latitude != null && longitude != null)
        ? [latitude, longitude]
        : DEFAULT_CENTER

      const map = L.map(mapRef.current!, { center: initialCenter, zoom: DEFAULT_ZOOM })
      mapInstanceRef.current = map

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap',
        maxZoom: 19,
      }).addTo(map)

      if (latitude != null && longitude != null) {
        markerRef.current = L.marker([latitude, longitude], { draggable: true }).addTo(map)
        markerRef.current.on('dragend', () => {
          const pos = markerRef.current.getLatLng()
          onChange(pos.lat, pos.lng)
        })
      }

      map.on('click', (e: any) => {
        const { lat, lng } = e.latlng
        if (markerRef.current) {
          markerRef.current.setLatLng([lat, lng])
        } else {
          markerRef.current = L.marker([lat, lng], { draggable: true }).addTo(map)
          markerRef.current.on('dragend', () => {
            const pos = markerRef.current.getLatLng()
            onChange(pos.lat, pos.lng)
          })
        }
        onChange(lat, lng)
      })

      setMapLoaded(true)
    })()

    return () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove()
        mapInstanceRef.current = null
        markerRef.current = null
      }
    }
  }, [])

  // Sync external lat/lng changes to marker
  useEffect(() => {
    if (!mapInstanceRef.current || !mapLoaded) return
    if (latitude == null || longitude == null) {
      if (markerRef.current) {
        markerRef.current.remove()
        markerRef.current = null
      }
      return
    }
    ;(async () => {
      const L = (await import('leaflet')).default
      if (markerRef.current) {
        markerRef.current.setLatLng([latitude, longitude])
      } else {
        markerRef.current = L.marker([latitude, longitude], { draggable: true }).addTo(mapInstanceRef.current)
        markerRef.current.on('dragend', () => {
          const pos = markerRef.current.getLatLng()
          onChange(pos.lat, pos.lng)
        })
      }
      mapInstanceRef.current.setView([latitude, longitude], Math.max(mapInstanceRef.current.getZoom(), 15))
    })()
  }, [latitude, longitude, mapLoaded])

  async function handleSearch() {
    const q = searchQuery.trim() || address?.trim() || ''
    if (!q) return
    setSearching(true)
    try {
      // Nominatim (free, no API key). Add Venezuela bias.
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q + ', Venezuela')}`
      const res = await fetch(url, { headers: { 'User-Agent': 'Valee/1.0' } })
      const data = await res.json()
      if (data.length > 0) {
        const { lat, lon } = data[0]
        onChange(parseFloat(lat), parseFloat(lon))
      } else {
        alert('No se encontro la direccion. Intenta con mas detalles o haz click en el mapa.')
      }
    } catch {
      alert('Error al buscar. Intenta hacer click directamente en el mapa.')
    }
    setSearching(false)
  }

  function useMyLocation() {
    if (!navigator.geolocation) return
    navigator.geolocation.getCurrentPosition(
      (pos) => onChange(pos.coords.latitude, pos.coords.longitude),
      () => alert('No se pudo obtener tu ubicacion. Concede permiso al navegador.')
    )
  }

  function clearLocation() {
    onChange(null, null)
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          type="text"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleSearch() } }}
          placeholder={address ? `Buscar: ${address}` : 'Buscar direccion o lugar...'}
          className="flex-1 px-3 py-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
        />
        <button
          type="button"
          onClick={handleSearch}
          disabled={searching || (!searchQuery.trim() && !address?.trim())}
          className="bg-emerald-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50"
        >
          {searching ? 'Buscando...' : 'Buscar'}
        </button>
      </div>

      <div
        ref={mapRef}
        className="w-full rounded-xl border border-slate-200 overflow-hidden"
        style={{ height: '300px', zIndex: 0 }}
      />
      <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex gap-3">
          <button type="button" onClick={useMyLocation} className="text-emerald-600 hover:text-emerald-800 font-semibold">
            Usar mi ubicacion
          </button>
          {latitude != null && longitude != null && (
            <button type="button" onClick={clearLocation} className="text-red-600 hover:text-red-800 font-semibold">
              Quitar ubicacion
            </button>
          )}
        </div>
        {latitude != null && longitude != null ? (
          <p className="text-slate-500 font-mono">
            {latitude.toFixed(6)}, {longitude.toFixed(6)}
          </p>
        ) : (
          <p className="text-slate-400">Click en el mapa para marcar ubicacion</p>
        )}
      </div>
    </div>
  )
}
