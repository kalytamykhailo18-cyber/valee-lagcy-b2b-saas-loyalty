'use client'

import { useState, useEffect } from 'react'
import { api } from '@/lib/api'

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
    <div className="min-h-screen bg-slate-50">
      {/* Page header */}
      <div className="px-4 sm:px-6 lg:px-8 pt-6 lg:pt-8 pb-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl lg:text-3xl font-bold text-slate-800">Recurrencia</h1>
            <p className="text-sm text-slate-500 mt-1">Automatiza mensajes de reactivacion para clientes que no regresan</p>
          </div>
          <button
            onClick={() => setShowForm(!showForm)}
            className="bg-emerald-600 text-white px-5 py-2.5 rounded-xl text-sm font-semibold hover:bg-emerald-700 shadow-sm transition"
          >
            {showForm ? 'Cancelar' : '+ Nueva regla'}
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="px-4 sm:px-6 lg:px-8 pb-8 space-y-8">
        {/* Create form */}
        {showForm && (
          <div className="bg-white rounded-2xl p-5 lg:p-6 shadow-sm border border-slate-100 max-w-2xl space-y-4">
            <h2 className="text-lg font-semibold text-slate-800">Nueva regla</h2>
            <div>
              <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Nombre</label>
              <input
                type="text"
                placeholder="Ej: Recuperar clientes bisemanales"
                value={form.name}
                onChange={e => setForm({ ...form, name: e.target.value })}
                className="w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Intervalo (dias)</label>
                <input
                  type="number"
                  value={form.intervalDays}
                  onChange={e => setForm({ ...form, intervalDays: e.target.value })}
                  className="w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Gracia (dias)</label>
                <input
                  type="number"
                  value={form.graceDays}
                  onChange={e => setForm({ ...form, graceDays: e.target.value })}
                  className="w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
            </div>
            <div>
              <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Mensaje WhatsApp</label>
              <textarea
                value={form.messageTemplate}
                onChange={e => setForm({ ...form, messageTemplate: e.target.value })}
                placeholder="Hola {name}! Hace {days} dias que no te vemos. Te regalamos {bonus} puntos!"
                className="w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm h-24 resize-none focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
              <p className="text-xs text-slate-400 mt-1">
                Variables disponibles: {'{name}'}, {'{days}'}, {'{bonus}'}
              </p>
            </div>
            <div>
              <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Puntos de bono (opcional)</label>
              <input
                type="number"
                placeholder="50"
                value={form.bonusAmount}
                onChange={e => setForm({ ...form, bonusAmount: e.target.value })}
                className="w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>
            <button
              onClick={handleCreate}
              disabled={loading || !form.name || !form.messageTemplate}
              className="w-full bg-emerald-600 text-white py-3 rounded-xl text-sm font-semibold disabled:opacity-50 hover:bg-emerald-700 transition"
            >
              {loading ? 'Creando...' : 'Crear regla'}
            </button>
          </div>
        )}

        {/* Rules grid */}
        <section>
          <h2 className="text-lg font-semibold text-slate-800 mb-4">Reglas activas</h2>
          {rules.length === 0 ? (
            <div className="bg-white rounded-2xl p-8 text-center border border-slate-100">
              <p className="text-slate-400">No hay reglas de recurrencia todavia</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {rules.map(r => (
                <div key={r.id} className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100 hover:shadow-md hover:border-emerald-200 transition">
                  <div className="flex items-start justify-between gap-2 mb-3">
                    <p className="font-semibold text-slate-800 truncate">{r.name}</p>
                    <button
                      onClick={() => handleToggle(r.id)}
                      className={`flex-shrink-0 px-3 py-1 rounded-full text-xs font-semibold ${r.active ? 'bg-green-100 text-green-700 hover:bg-green-200' : 'bg-red-100 text-red-700 hover:bg-red-200'} transition`}
                    >
                      {r.active ? 'Activa' : 'Inactiva'}
                    </button>
                  </div>
                  <div className="text-xs text-slate-500 space-y-1">
                    <p>Cada {r.intervalDays} dias + {r.graceDays} de gracia</p>
                    <p>Bono: {r.bonusAmount ? `${Number(r.bonusAmount)} pts` : 'Sin bono'}</p>
                  </div>
                  <p className="text-xs text-slate-400 mt-3 bg-slate-50 p-2 rounded line-clamp-3">
                    {r.messageTemplate}
                  </p>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Notifications history */}
        <section>
          <h2 className="text-lg font-semibold text-slate-800 mb-4">Notificaciones enviadas</h2>
          {notifications.length === 0 ? (
            <div className="bg-white rounded-2xl p-8 text-center border border-slate-100">
              <p className="text-slate-400">Sin notificaciones enviadas todavia</p>
            </div>
          ) : (
            <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
              <div className="divide-y divide-slate-100">
                {notifications.map((n: any) => (
                  <div key={n.id} className="p-4 flex items-center justify-between hover:bg-slate-50 transition">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-800 truncate">{n.consumerAccount?.phoneNumber}</p>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {n.daysSinceVisit} dias sin visitar - {n.bonusGranted ? 'Bono otorgado' : 'Solo mensaje'}
                      </p>
                      <p className="text-xs text-slate-400">{n.rule?.name}</p>
                    </div>
                    <span className="text-xs text-slate-400 flex-shrink-0 ml-4">
                      {new Date(n.sentAt).toLocaleDateString('es-VE')}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
