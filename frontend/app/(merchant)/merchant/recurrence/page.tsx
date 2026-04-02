'use client'

import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import Link from 'next/link'

export default function RecurrencePage() {
  const [rules, setRules] = useState<any[]>([])
  const [notifications, setNotifications] = useState<any[]>([])
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ name: '', intervalDays: '14', graceDays: '1', messageTemplate: '', bonusAmount: '' })
  const [loading, setLoading] = useState(false)

  useEffect(() => { loadData() }, [])

  async function loadData() {
    try {
      const [r, n] = await Promise.all([api.getRecurrenceRules(), api.getRecurrenceNotifications()])
      setRules(r.rules)
      setNotifications(n.notifications)
    } catch {}
  }

  async function handleCreate() {
    if (!form.name || !form.messageTemplate) return
    setLoading(true)
    try {
      await api.createRecurrenceRule({
        name: form.name,
        intervalDays: form.intervalDays,
        graceDays: form.graceDays,
        messageTemplate: form.messageTemplate,
        bonusAmount: form.bonusAmount || undefined,
      })
      setShowForm(false)
      setForm({ name: '', intervalDays: '14', graceDays: '1', messageTemplate: '', bonusAmount: '' })
      loadData()
    } catch {}
    setLoading(false)
  }

  async function handleToggle(id: string) {
    try { await api.toggleRecurrenceRule(id); loadData() } catch {}
  }

  return (
    <div className="min-h-screen bg-emerald-50 p-4">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Link href="/merchant" className="text-emerald-700 text-2xl">&larr;</Link>
          <h1 className="text-xl font-bold text-emerald-800">Recurrencia</h1>
        </div>
        <button onClick={() => setShowForm(!showForm)} className="bg-emerald-600 text-white px-4 py-2 rounded-xl text-sm font-medium">
          {showForm ? 'Cancelar' : '+ Nueva regla'}
        </button>
      </div>

      {showForm && (
        <div className="bg-white rounded-2xl p-4 shadow-sm mb-4 space-y-3 animate-fade-in">
          <input type="text" placeholder="Nombre de la regla" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
            className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm" />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-slate-500">Intervalo (dias)</label>
              <input type="number" value={form.intervalDays} onChange={e => setForm({ ...form, intervalDays: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm" />
            </div>
            <div>
              <label className="text-xs text-slate-500">Gracia (dias)</label>
              <input type="number" value={form.graceDays} onChange={e => setForm({ ...form, graceDays: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm" />
            </div>
          </div>
          <div>
            <label className="text-xs text-slate-500">Mensaje WhatsApp (usa {'{name}'}, {'{days}'}, {'{bonus}'})</label>
            <textarea value={form.messageTemplate} onChange={e => setForm({ ...form, messageTemplate: e.target.value })}
              placeholder="Hola {name}! Hace {days} dias que no te vemos. Te regalamos {bonus} puntos!"
              className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm h-20 resize-none" />
          </div>
          <div>
            <label className="text-xs text-slate-500">Puntos de bono (opcional)</label>
            <input type="number" placeholder="50" value={form.bonusAmount} onChange={e => setForm({ ...form, bonusAmount: e.target.value })}
              className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm" />
          </div>
          <button onClick={handleCreate} disabled={loading || !form.name || !form.messageTemplate}
            className="w-full bg-emerald-600 text-white py-2 rounded-lg text-sm font-medium disabled:opacity-50">
            {loading ? 'Creando...' : 'Crear regla'}
          </button>
        </div>
      )}

      <div className="space-y-3 mb-6">
        {rules.map(r => (
          <div key={r.id} className="bg-white rounded-xl p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">{r.name}</p>
                <p className="text-xs text-slate-500">Cada {r.intervalDays} dias + {r.graceDays} de gracia | Bono: {r.bonusAmount ? `${Number(r.bonusAmount)} pts` : 'Sin bono'}</p>
              </div>
              <button onClick={() => handleToggle(r.id)}
                className={`px-3 py-1 rounded-full text-xs font-medium ${r.active ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                {r.active ? 'Activa' : 'Inactiva'}
              </button>
            </div>
            <p className="text-xs text-slate-400 mt-2 truncate">{r.messageTemplate}</p>
          </div>
        ))}
        {rules.length === 0 && <p className="text-center text-slate-400 mt-4">No hay reglas de recurrencia creadas</p>}
      </div>

      <h2 className="font-semibold text-slate-700 mb-3">Notificaciones enviadas</h2>
      <div className="space-y-2">
        {notifications.map((n: any) => (
          <div key={n.id} className="bg-white rounded-lg p-3 shadow-sm text-sm">
            <div className="flex justify-between">
              <span className="text-slate-600">{n.consumerAccount?.phoneNumber}</span>
              <span className="text-xs text-slate-400">{new Date(n.sentAt).toLocaleDateString('es-VE')}</span>
            </div>
            <p className="text-xs text-slate-500 mt-1">{n.daysSinceVisit} dias sin visitar | {n.bonusGranted ? 'Bono otorgado' : 'Solo mensaje'}</p>
            <p className="text-xs text-slate-400 mt-1">{n.rule?.name}</p>
          </div>
        ))}
        {notifications.length === 0 && <p className="text-center text-slate-400 text-sm mt-4">Sin notificaciones aun</p>}
      </div>
    </div>
  )
}
