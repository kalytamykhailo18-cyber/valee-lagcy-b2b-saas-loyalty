'use client'

import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import { MdSms, MdChat, MdCheckCircle, MdWarning } from 'react-icons/md'

interface AuthChannelState {
  channel: 'whatsapp' | 'sms'
  updatedAt: string | null
  updatedBy: string | null
  smsAvailable: boolean
}

export default function AuthChannelPage() {
  const [state, setState] = useState<AuthChannelState | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  async function load() {
    setLoading(true)
    try {
      const data: any = await api.getAuthChannel()
      setState(data)
    } catch (e: any) {
      setMessage({ tone: 'err', text: e?.error || 'No se pudo cargar la configuracion' })
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  async function handleSwitch(channel: 'whatsapp' | 'sms') {
    if (!state || state.channel === channel) return
    if (channel === 'sms' && !state.smsAvailable) {
      setMessage({ tone: 'err', text: 'Twilio Verify no esta configurado en el servidor (faltan TWILIO_*).' })
      return
    }
    setSaving(true)
    setMessage(null)
    try {
      await api.setAuthChannel(channel)
      setMessage({ tone: 'ok', text: `Canal de codigo OTP actualizado a ${channel === 'sms' ? 'SMS' : 'WhatsApp'}.` })
      await load()
    } catch (e: any) {
      setMessage({ tone: 'err', text: e?.error || 'No se pudo actualizar el canal' })
    }
    setSaving(false)
  }

  if (loading || !state) {
    return (
      <div className="p-8">
        <p className="text-slate-400">Cargando...</p>
      </div>
    )
  }

  const isSms = state.channel === 'sms'

  return (
    <div className="p-6 lg:p-8 max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl lg:text-3xl font-bold text-slate-800 tracking-tight">Canal de OTP</h1>
        <p className="text-sm text-slate-500 mt-1">
          Define por donde se envia el codigo de verificacion al consumer cuando inicia sesion.
          Cambia al canal SMS si WhatsApp / Meta presenta problemas.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <button
          onClick={() => handleSwitch('whatsapp')}
          disabled={saving}
          className={`text-left p-5 rounded-2xl border-2 transition shadow-sm ${
            !isSms
              ? 'border-emerald-500 bg-emerald-50'
              : 'border-slate-200 bg-white hover:border-slate-300'
          }`}
        >
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <MdChat className="w-6 h-6 text-emerald-600" />
              <span className="font-bold text-slate-800">WhatsApp</span>
            </div>
            {!isSms && <MdCheckCircle className="w-5 h-5 text-emerald-600" />}
          </div>
          <p className="text-xs text-slate-500 leading-relaxed">
            Canal principal. Plantilla autenticacion + texto libre cuando hay ventana abierta.
          </p>
        </button>

        <button
          onClick={() => handleSwitch('sms')}
          disabled={saving || !state.smsAvailable}
          className={`text-left p-5 rounded-2xl border-2 transition shadow-sm ${
            isSms
              ? 'border-emerald-500 bg-emerald-50'
              : !state.smsAvailable
              ? 'border-slate-200 bg-slate-50 opacity-60 cursor-not-allowed'
              : 'border-slate-200 bg-white hover:border-slate-300'
          }`}
        >
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <MdSms className="w-6 h-6 text-indigo-600" />
              <span className="font-bold text-slate-800">SMS (Twilio Verify)</span>
            </div>
            {isSms && <MdCheckCircle className="w-5 h-5 text-emerald-600" />}
          </div>
          <p className="text-xs text-slate-500 leading-relaxed">
            Canal de emergencia. Twilio gestiona el codigo, expiracion y reintentos. Funciona internacionalmente.
          </p>
          {!state.smsAvailable && (
            <p className="text-[11px] text-amber-700 mt-2 inline-flex items-center gap-1">
              <MdWarning className="w-3.5 h-3.5" /> Configura TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN y TWILIO_VERIFY_SERVICE_SID en el servidor para activarlo.
            </p>
          )}
        </button>
      </div>

      {message && (
        <div className={`mt-4 p-3 rounded-xl text-sm ${
          message.tone === 'ok' ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-rose-50 text-rose-800 border border-rose-200'
        }`}>
          {message.text}
        </div>
      )}

      <div className="mt-6 p-4 rounded-xl bg-white border border-slate-100 text-xs text-slate-500 space-y-1">
        <p><span className="font-semibold text-slate-700">Canal activo:</span> {state.channel === 'sms' ? 'SMS' : 'WhatsApp'}</p>
        {state.updatedAt && (
          <p><span className="font-semibold text-slate-700">Ultimo cambio:</span> {new Date(state.updatedAt).toLocaleString('es-VE')}</p>
        )}
        <p className="pt-2 text-[11px] text-slate-400 leading-relaxed">
          El cambio se aplica al instante a las nuevas peticiones de codigo. Las sesiones que ya estaban verificando un codigo previo se mantienen — el flujo de verificacion intenta ambos canales hasta encontrar el codigo valido, asi que un cambio mid-flow no deja al usuario afuera.
        </p>
      </div>
    </div>
  )
}
