'use client'

import { useState } from 'react'
import {
  MdInfoOutline, MdPeopleAlt, MdScheduleSend, MdAutoAwesome,
  MdLocalFireDepartment, MdEmojiEvents, MdCardGiftcard, MdRestaurantMenu,
  MdLockOutline, MdClose,
} from 'react-icons/md'

interface Segment {
  id: string
  name: string
  description: string
  count: number
  Icon: any
  color: string
  bgColor: string
  borderColor: string
  sampleNames: string[]
}

interface Template {
  id: string
  title: string
  body: string
}

const SEGMENTS: Segment[] = [
  {
    id: 'inactive-15',
    name: 'Inactivos recientes',
    description: 'Sin enviar factura desde hace mas de 15 dias',
    count: 47,
    Icon: MdScheduleSend,
    color: 'text-amber-700',
    bgColor: 'bg-amber-50',
    borderColor: 'border-amber-200',
    sampleNames: ['Maria Perez', 'Jose Rodriguez', 'Carmen Gonzalez'],
  },
  {
    id: 'inactive-60',
    name: 'Inactivos profundos',
    description: 'Mas de 60 dias sin actividad',
    count: 23,
    Icon: MdAutoAwesome,
    color: 'text-red-700',
    bgColor: 'bg-red-50',
    borderColor: 'border-red-200',
    sampleNames: ['Pedro Martinez', 'Ana Garcia', 'Luis Hernandez'],
  },
  {
    id: 'first-time',
    name: 'Primera vez sin volver',
    description: 'Hicieron solo una compra y no han regresado',
    count: 12,
    Icon: MdPeopleAlt,
    color: 'text-blue-700',
    bgColor: 'bg-blue-50',
    borderColor: 'border-blue-200',
    sampleNames: ['Sofia Lopez', 'Carlos Diaz', 'Andrea Ruiz'],
  },
  {
    id: 'accumulators',
    name: 'Acumuladores',
    description: 'Mas de 1000 puntos sin canjear nunca',
    count: 8,
    Icon: MdEmojiEvents,
    color: 'text-purple-700',
    bgColor: 'bg-purple-50',
    borderColor: 'border-purple-200',
    sampleNames: ['Roberto Silva', 'Patricia Mendez', 'Daniel Torres'],
  },
  {
    id: 'top-spenders',
    name: 'Grandes consumidores',
    description: 'Top 10 por monto facturado en los ultimos 90 dias',
    count: 10,
    Icon: MdLocalFireDepartment,
    color: 'text-orange-700',
    bgColor: 'bg-orange-50',
    borderColor: 'border-orange-200',
    sampleNames: ['Eduardo Castro', 'Valentina Romero', 'Gabriel Ortiz'],
  },
  {
    id: 'high-ticket',
    name: 'Ticket promedio alto',
    description: 'Clientes con factura promedio mayor a $50',
    count: 19,
    Icon: MdRestaurantMenu,
    color: 'text-emerald-700',
    bgColor: 'bg-emerald-50',
    borderColor: 'border-emerald-200',
    sampleNames: ['Isabel Vargas', 'Miguel Salazar', 'Laura Jimenez'],
  },
  {
    id: 'birthday',
    name: 'Cumpleaneros del mes',
    description: 'Clientes que cumplen anos este mes',
    count: 14,
    Icon: MdCardGiftcard,
    color: 'text-pink-700',
    bgColor: 'bg-pink-50',
    borderColor: 'border-pink-200',
    sampleNames: ['Veronica Morales', 'Juan Pena', 'Camila Reyes'],
  },
]

const TEMPLATES: Template[] = [
  {
    id: 'reactivation',
    title: 'Reactivacion de inactivos',
    body: 'Hola {nombre}, te extranamos en {comercio}. Tu saldo actual es {puntos} puntos. Esta semana ven y te damos doble valor en tu proxima factura.',
  },
  {
    id: 'redeem-push',
    title: 'Empuje a canjear',
    body: 'Hola {nombre}, tienes {puntos} puntos acumulados en {comercio}. Mira lo que puedes canjear hoy: {link_catalogo}',
  },
  {
    id: 'second-visit',
    title: 'Bienvenida al segundo canje',
    body: 'Gracias {nombre} por tu primera visita a {comercio}. Vuelve esta semana y tu siguiente factura suma 50 por ciento mas de puntos.',
  },
  {
    id: 'birthday-greet',
    title: 'Saludo de cumpleanos',
    body: 'Feliz cumpleanos {nombre}! Te regalamos {bono} puntos para celebrarlo en {comercio}. Valido por 7 dias.',
  },
]

export default function SegmentsPage() {
  const [openSegment, setOpenSegment] = useState<Segment | null>(null)
  const [selectedTemplate, setSelectedTemplate] = useState<Template>(TEMPLATES[0])
  const [showLockedModal, setShowLockedModal] = useState(false)

  const totalCustomers = SEGMENTS.reduce((sum, s) => sum + s.count, 0)

  function openSegmentDetail(segment: Segment) {
    setOpenSegment(segment)
    setSelectedTemplate(TEMPLATES[0])
  }

  function closeSegmentDetail() {
    setOpenSegment(null)
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Page header */}
      <div className="px-4 sm:px-6 lg:px-8 pt-6 lg:pt-8 pb-4">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-2xl lg:text-3xl font-bold text-slate-800">Segmentos de clientes</h1>
          <span className="px-3 py-1 rounded-full text-xs font-bold bg-indigo-100 text-indigo-700 uppercase tracking-wide">
            Vista previa - Fase 2
          </span>
        </div>
        <p className="text-sm text-slate-500 mt-1">
          Agrupa a tus clientes en carpetas dinamicas y enviales ofertas especificas con un click
        </p>
      </div>

      {/* Preview banner */}
      <div className="px-4 sm:px-6 lg:px-8 pb-4">
        <div className="bg-gradient-to-r from-indigo-50 to-purple-50 border border-indigo-200 rounded-2xl p-5 flex items-start gap-4">
          <div className="w-10 h-10 rounded-xl bg-indigo-600 text-white flex items-center justify-center flex-shrink-0">
            <MdInfoOutline className="w-6 h-6" />
          </div>
          <div className="flex-1">
            <p className="font-semibold text-slate-800">Esta es una vista previa de la Fase 2</p>
            <p className="text-sm text-slate-600 mt-1">
              Aqui podras agrupar tus clientes en segmentos dinamicos como inactivos, primera vez, acumuladores o cumpleaneros, y mandarles ofertas personalizadas por WhatsApp con un solo click. Los datos que ves abajo son ejemplos para mostrarte como funcionara. Estara disponible en la siguiente fase del producto.
            </p>
          </div>
        </div>
      </div>

      {/* Summary stats */}
      <div className="px-4 sm:px-6 lg:px-8 pb-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-white rounded-2xl p-4 border border-slate-100 shadow-sm">
            <p className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Segmentos</p>
            <p className="text-2xl font-bold text-slate-800 mt-1">{SEGMENTS.length}</p>
          </div>
          <div className="bg-white rounded-2xl p-4 border border-slate-100 shadow-sm">
            <p className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Clientes en total</p>
            <p className="text-2xl font-bold text-slate-800 mt-1">{totalCustomers}</p>
          </div>
          <div className="bg-white rounded-2xl p-4 border border-slate-100 shadow-sm">
            <p className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Plantillas listas</p>
            <p className="text-2xl font-bold text-slate-800 mt-1">{TEMPLATES.length}</p>
          </div>
          <div className="bg-white rounded-2xl p-4 border border-slate-100 shadow-sm">
            <p className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Envios este mes</p>
            <p className="text-2xl font-bold text-slate-800 mt-1">0</p>
          </div>
        </div>
      </div>

      {/* Segment cards grid */}
      <div className="px-4 sm:px-6 lg:px-8 pb-8">
        <h2 className="text-lg font-semibold text-slate-800 mb-4">Carpetas dinamicas</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {SEGMENTS.map(segment => (
            <button
              key={segment.id}
              onClick={() => openSegmentDetail(segment)}
              className={`text-left bg-white rounded-2xl p-5 border ${segment.borderColor} shadow-sm hover:shadow-md transition group`}
            >
              <div className="flex items-start justify-between mb-3">
                <div className={`w-12 h-12 rounded-xl ${segment.bgColor} flex items-center justify-center`}>
                  <segment.Icon className={`w-6 h-6 ${segment.color}`} />
                </div>
                <span className={`text-2xl font-bold ${segment.color}`}>{segment.count}</span>
              </div>
              <p className="font-semibold text-slate-800 mb-1">{segment.name}</p>
              <p className="text-xs text-slate-500 line-clamp-2">{segment.description}</p>
              <div className="mt-3 pt-3 border-t border-slate-100 text-xs text-slate-400 group-hover:text-slate-600 transition">
                Ver carpeta y enviar oferta
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Segment detail modal */}
      {openSegment && (
        <div className="fixed inset-0 bg-slate-900/60 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-white w-full sm:max-w-2xl sm:rounded-2xl rounded-t-2xl shadow-xl max-h-[90vh] overflow-y-auto">
            {/* Modal header */}
            <div className="sticky top-0 bg-white border-b border-slate-100 p-5 flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <div className={`w-12 h-12 rounded-xl ${openSegment.bgColor} flex items-center justify-center flex-shrink-0`}>
                  <openSegment.Icon className={`w-6 h-6 ${openSegment.color}`} />
                </div>
                <div>
                  <p className="font-bold text-slate-800 text-lg">{openSegment.name}</p>
                  <p className="text-xs text-slate-500">{openSegment.count} clientes en esta carpeta</p>
                </div>
              </div>
              <button
                onClick={closeSegmentDetail}
                className="w-8 h-8 rounded-full hover:bg-slate-100 flex items-center justify-center transition flex-shrink-0"
                aria-label="Cerrar"
              >
                <MdClose className="w-5 h-5 text-slate-500" />
              </button>
            </div>

            {/* Modal body */}
            <div className="p-5 space-y-5">
              {/* Sample customers */}
              <div>
                <p className="text-xs text-slate-500 font-semibold uppercase tracking-wide mb-2">Algunos clientes en esta carpeta</p>
                <div className="space-y-2">
                  {openSegment.sampleNames.map((name, i) => (
                    <div key={i} className="flex items-center gap-3 bg-slate-50 rounded-lg p-3">
                      <div className="w-8 h-8 rounded-full bg-slate-200 flex items-center justify-center text-xs font-bold text-slate-600">
                        {name.split(' ').map(p => p[0]).join('')}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-slate-800 truncate">{name}</p>
                        <p className="text-xs text-slate-400">+58 412 ••• ••••</p>
                      </div>
                    </div>
                  ))}
                  <p className="text-xs text-slate-400 text-center pt-1">
                    + {openSegment.count - openSegment.sampleNames.length} mas
                  </p>
                </div>
              </div>

              {/* Template selector */}
              <div>
                <p className="text-xs text-slate-500 font-semibold uppercase tracking-wide mb-2">Elige una plantilla de mensaje</p>
                <div className="space-y-2">
                  {TEMPLATES.map(t => (
                    <button
                      key={t.id}
                      onClick={() => setSelectedTemplate(t)}
                      className={`w-full text-left p-3 rounded-lg border transition ${
                        selectedTemplate.id === t.id
                          ? 'border-indigo-500 bg-indigo-50'
                          : 'border-slate-200 hover:border-slate-300 bg-white'
                      }`}
                    >
                      <p className={`text-sm font-semibold ${selectedTemplate.id === t.id ? 'text-indigo-700' : 'text-slate-700'}`}>
                        {t.title}
                      </p>
                    </button>
                  ))}
                </div>
              </div>

              {/* Preview */}
              <div>
                <p className="text-xs text-slate-500 font-semibold uppercase tracking-wide mb-2">Vista previa del mensaje</p>
                <div className="bg-emerald-50 border border-emerald-100 rounded-xl p-4">
                  <p className="text-sm text-slate-800 whitespace-pre-wrap">{selectedTemplate.body}</p>
                </div>
                <p className="text-xs text-slate-400 mt-2">
                  Las variables {'{nombre}'}, {'{puntos}'}, {'{comercio}'}, {'{bono}'} y {'{link_catalogo}'} se reemplazan automaticamente para cada cliente.
                </p>
              </div>

              {/* Send action */}
              <button
                onClick={() => setShowLockedModal(true)}
                className="w-full bg-slate-300 text-slate-600 py-3 rounded-xl text-sm font-semibold cursor-not-allowed flex items-center justify-center gap-2 hover:bg-slate-400 transition"
              >
                <MdLockOutline className="w-5 h-5" />
                Enviar a {openSegment.count} clientes
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Locked feature modal */}
      {showLockedModal && (
        <div className="fixed inset-0 bg-slate-900/70 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-6 text-center">
            <div className="w-14 h-14 rounded-2xl bg-indigo-100 flex items-center justify-center mx-auto mb-4">
              <MdLockOutline className="w-7 h-7 text-indigo-600" />
            </div>
            <p className="font-bold text-slate-800 text-lg">Disponible en Fase 2</p>
            <p className="text-sm text-slate-500 mt-2">
              El envio masivo de ofertas por segmento estara disponible en la proxima fase de Valee. Mientras tanto, puedes seguir usando Recurrencia para mensajes automaticos a clientes inactivos.
            </p>
            <button
              onClick={() => setShowLockedModal(false)}
              className="mt-5 w-full bg-indigo-600 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-indigo-700 transition"
            >
              Entendido
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
