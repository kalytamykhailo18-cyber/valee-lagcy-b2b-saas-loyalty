'use client'

import { useState, useEffect } from 'react'
import { api } from '@/lib/api'

export default function RecurrencePage() {
  const [rules, setRules] = useState<any[]>([])
  const [notifications, setNotifications] = useState<any[]>([])
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', intervalDays: '14', graceDays: '1', messageTemplate: '', bonusAmount: '', targetPhones: '' as string })
  const [loading, setLoading] = useState(false)
  const [expandedRule, setExpandedRule] = useState<string | null>(null)
  const [eligibleByRule, setEligibleByRule] = useState<Record<string, any>>({})
  const [loadingEligible, setLoadingEligible] = useState<string | null>(null)

  useEffect(() => { loadData() }, [])

  async function loadData() {
    try {
      const [r, n] = await Promise.all([api.getRecurrenceRules(), api.getRecurrenceNotifications()])
      setRules(r.rules)
      setNotifications(n.notifications)
    } catch {}
  }

  async function loadEligible(ruleId: string) {
    if (eligibleByRule[ruleId]) return
    setLoadingEligible(ruleId)
    try {
      const data = await api.getRecurrenceEligible(ruleId)
      setEligibleByRule(prev => ({ ...prev, [ruleId]: data }))
    } catch {}
    setLoadingEligible(null)
  }

  function toggleRuleExpansion(ruleId: string) {
    if (expandedRule === ruleId) {
      setExpandedRule(null)
    } else {
      setExpandedRule(ruleId)
      loadEligible(ruleId)
    }
  }

  const [errors, setErrors] = useState<{ [k: string]: string }>({})
  const [createMsg, setCreateMsg] = useState('')

  function validateForm(): boolean {
    const errs: { [k: string]: string } = {}
    const name = form.name.trim()
    const msg = form.messageTemplate.trim()
    const intervalNum = parseInt(form.intervalDays)
    const graceNum = parseInt(form.graceDays)
    const bonusNum = form.bonusAmount ? parseInt(form.bonusAmount) : null

    if (!name) errs.name = 'El nombre es obligatorio'
    else if (name.length < 4) errs.name = 'Minimo 4 caracteres'
    else if (name.length > 80) errs.name = 'Maximo 80 caracteres'

    if (!form.intervalDays) errs.intervalDays = 'El intervalo es obligatorio'
    else if (isNaN(intervalNum) || intervalNum < 1) errs.intervalDays = 'Minimo 1 dia'
    else if (intervalNum > 365) errs.intervalDays = 'Maximo 365 dias'

    if (!form.graceDays) errs.graceDays = 'La gracia es obligatoria'
    else if (isNaN(graceNum) || graceNum < 0) errs.graceDays = 'Minimo 0 dias'
    else if (graceNum > 90) errs.graceDays = 'Maximo 90 dias'

    if (!msg) errs.messageTemplate = 'El mensaje es obligatorio'
    else if (msg.length < 20) errs.messageTemplate = `Minimo 20 caracteres (llevas ${msg.length})`
    else if (msg.length > 500) errs.messageTemplate = `Maximo 500 caracteres (llevas ${msg.length})`

    if (form.bonusAmount && (isNaN(bonusNum!) || bonusNum! < 1)) {
      errs.bonusAmount = 'Debe ser un numero positivo'
    }

    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  async function handleCreate() {
    setCreateMsg('')
    if (!validateForm()) {
      setCreateMsg('Error: corrige los campos marcados en rojo')
      return
    }
    setLoading(true)
    try {
      const targetPhonesArr = form.targetPhones
        .split(/[\n,;]+/)
        .map(s => s.trim())
        .filter(Boolean)
      const payload = {
        name: form.name.trim(),
        intervalDays: form.intervalDays,
        graceDays: form.graceDays,
        messageTemplate: form.messageTemplate.trim(),
        bonusAmount: form.bonusAmount || undefined,
        targetPhones: targetPhonesArr,
      }
      if (editingId) {
        await api.updateRecurrenceRule(editingId, payload)
        setCreateMsg('Regla actualizada')
      } else {
        await api.createRecurrenceRule(payload)
        setCreateMsg('Regla creada exitosamente')
      }
      setShowForm(false)
      setEditingId(null)
      setForm({ name: '', intervalDays: '14', graceDays: '1', messageTemplate: '', bonusAmount: '', targetPhones: '' })
      setErrors({})
      loadData()
    } catch (e: any) {
      setCreateMsg(e?.error || e?.message || 'Error al guardar regla')
    }
    setLoading(false)
  }

  function startEdit(rule: any) {
    setEditingId(rule.id)
    setForm({
      name: rule.name || '',
      intervalDays: String(rule.intervalDays),
      graceDays: String(rule.graceDays),
      messageTemplate: rule.messageTemplate || '',
      bonusAmount: rule.bonusAmount ? String(rule.bonusAmount) : '',
      targetPhones: Array.isArray(rule.targetPhones) ? rule.targetPhones.join('\n') : '',
    })
    setErrors({})
    setCreateMsg('')
    setShowForm(true)
    // scroll to top of form
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function cancelEdit() {
    setEditingId(null)
    setShowForm(false)
    setForm({ name: '', intervalDays: '14', graceDays: '1', messageTemplate: '', bonusAmount: '', targetPhones: '' })
    setErrors({})
    setCreateMsg('')
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Eliminar la regla "${name}"? Esto la desactivara permanentemente.`)) return
    try {
      await api.deleteRecurrenceRule(id)
      setCreateMsg('Regla eliminada')
      loadData()
    } catch (e: any) {
      setCreateMsg(e?.error || e?.message || 'Error al eliminar regla')
    }
  }

  async function handleToggle(id: string) {
    try { await api.toggleRecurrenceRule(id); loadData() } catch {}
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Page header */}
      <div className="px-4 sm:px-6 lg:px-8 pt-6 lg:pt-8 pb-4 aa-rise">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl lg:text-3xl font-bold text-slate-800 tracking-tight">Recurrencia</h1>
            <p className="text-sm text-slate-500 mt-1">Automatiza mensajes de reactivacion para clientes que no regresan</p>
          </div>
          <button
            onClick={() => { if (showForm) cancelEdit(); else setShowForm(true) }}
            className="aa-btn aa-btn-emerald bg-emerald-600 text-white px-5 py-2.5 rounded-xl text-sm font-semibold hover:bg-emerald-700"
          >
            <span className="relative z-10">{showForm ? 'Cancelar' : '+ Nueva regla'}</span>
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="px-4 sm:px-6 lg:px-8 pb-8 space-y-8">
        {/* Create form */}
        {showForm && (
          <div className="bg-white rounded-2xl p-5 lg:p-6 shadow-sm border border-slate-100 max-w-2xl space-y-4">
            <h2 className="text-lg font-semibold text-slate-800">{editingId ? 'Editar regla' : 'Nueva regla'}</h2>

            {Object.keys(errors).length > 0 && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-3">
                <p className="text-sm font-semibold text-red-700 mb-1">Hay {Object.keys(errors).length} error{Object.keys(errors).length > 1 ? 'es' : ''} en el formulario:</p>
                <ul className="text-sm text-red-600 list-disc list-inside space-y-0.5">
                  {Object.values(errors).filter(Boolean).map((err, i) => (<li key={i}>{err}</li>))}
                </ul>
              </div>
            )}

            <div>
              <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Nombre <span className="text-red-500">*</span></label>
              <input
                type="text"
                placeholder="Ej: Recuperar clientes bisemanales"
                value={form.name}
                maxLength={80}
                onChange={e => { setForm({ ...form, name: e.target.value }); if (errors.name) setErrors({ ...errors, name: '' }) }}
                className={`w-full mt-1 px-3 py-2.5 rounded-lg border text-sm focus:outline-none focus:ring-2 ${errors.name ? 'border-red-300 focus:ring-red-400' : 'aa-field aa-field-emerald border-slate-200'}`}
              />
              {errors.name && <p className="text-red-500 text-xs mt-1">{errors.name}</p>}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Intervalo (dias) <span className="text-red-500">*</span></label>
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={form.intervalDays}
                  onChange={e => { setForm({ ...form, intervalDays: e.target.value }); if (errors.intervalDays) setErrors({ ...errors, intervalDays: '' }) }}
                  className={`w-full mt-1 px-3 py-2.5 rounded-lg border text-sm focus:outline-none focus:ring-2 ${errors.intervalDays ? 'border-red-300 focus:ring-red-400' : 'aa-field aa-field-emerald border-slate-200'}`}
                />
                <p className="text-[11px] text-slate-400 mt-1">Cada cuantos dias esperas que el cliente regrese.</p>
                {errors.intervalDays && <p className="text-red-500 text-xs mt-1">{errors.intervalDays}</p>}
              </div>
              <div>
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Gracia (dias) <span className="text-red-500">*</span></label>
                <input
                  type="number"
                  min={0}
                  max={90}
                  value={form.graceDays}
                  onChange={e => { setForm({ ...form, graceDays: e.target.value }); if (errors.graceDays) setErrors({ ...errors, graceDays: '' }) }}
                  className={`w-full mt-1 px-3 py-2.5 rounded-lg border text-sm focus:outline-none focus:ring-2 ${errors.graceDays ? 'border-red-300 focus:ring-red-400' : 'aa-field aa-field-emerald border-slate-200'}`}
                />
                <p className="text-[11px] text-slate-400 mt-1">Dias extra antes de mandar el recordatorio. Se suma al intervalo.</p>
                {errors.graceDays && <p className="text-red-500 text-xs mt-1">{errors.graceDays}</p>}
              </div>
            </div>
            {(() => {
              const i = parseInt(form.intervalDays)
              const g = parseInt(form.graceDays)
              if (!Number.isFinite(i) || !Number.isFinite(g) || i < 1 || g < 0) return null
              return (
                <p className="text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-md px-2 py-1.5">
                  Se envia el mensaje cuando el cliente lleve {i + g} dias sin volver ({i} del intervalo + {g} de gracia).
                </p>
              )
            })()}
            <div>
              <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Mensaje WhatsApp <span className="text-red-500">*</span></label>
              <textarea
                value={form.messageTemplate}
                maxLength={500}
                onChange={e => { setForm({ ...form, messageTemplate: e.target.value }); if (errors.messageTemplate) setErrors({ ...errors, messageTemplate: '' }) }}
                placeholder="Hola {name}! Hace {days} dias que no te vemos. Te regalamos {bonus} puntos!"
                className={`w-full mt-1 px-3 py-2.5 rounded-lg border text-sm h-24 resize-none focus:outline-none focus:ring-2 ${errors.messageTemplate ? 'border-red-300 focus:ring-red-400' : 'aa-field aa-field-emerald border-slate-200'}`}
              />
              <div className="flex justify-between items-center mt-1">
                <p className="text-xs text-slate-400">Variables: {'{name}'}, {'{days}'}, {'{bonus}'} (minimo 20, maximo 500)</p>
                <p className={`text-xs font-medium ${form.messageTemplate.trim().length < 20 ? 'text-amber-600' : form.messageTemplate.length > 500 ? 'text-red-500' : 'text-slate-400'}`}>{form.messageTemplate.length}/500</p>
              </div>
              {errors.messageTemplate && <p className="text-red-500 text-xs mt-1">{errors.messageTemplate}</p>}
            </div>
            <div>
              <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Puntos de bono (opcional)</label>
              <input
                type="number"
                min={1}
                placeholder="50"
                value={form.bonusAmount}
                onChange={e => { setForm({ ...form, bonusAmount: e.target.value }); if (errors.bonusAmount) setErrors({ ...errors, bonusAmount: '' }) }}
                className={`w-full mt-1 px-3 py-2.5 rounded-lg border text-sm focus:outline-none focus:ring-2 ${errors.bonusAmount ? 'border-red-300 focus:ring-red-400' : 'aa-field aa-field-emerald border-slate-200'}`}
              />
              {errors.bonusAmount && <p className="text-red-500 text-xs mt-1">{errors.bonusAmount}</p>}
            </div>
            <div>
              <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Grupo de telefonos (opcional)</label>
              <textarea
                value={form.targetPhones}
                onChange={e => setForm({ ...form, targetPhones: e.target.value })}
                placeholder="Deja vacio para enviar a TODOS los clientes inactivos.&#10;O ingresa numeros (uno por linea o separados por coma):&#10;0414 1234567&#10;04241234567"
                className="w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm h-28 resize-none font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
              <p className="text-xs text-slate-400 mt-1">
                Si dejas vacio el mensaje se envia a TODOS los clientes que no han visitado en el periodo. Si agregas numeros, solo a esos.
              </p>
              {form.targetPhones.trim() && (
                <p className="text-xs text-emerald-600 mt-1 font-semibold">
                  Grupo: {form.targetPhones.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean).length} numero(s)
                </p>
              )}
            </div>

            {createMsg && (
              <p className={`text-sm ${createMsg.toLowerCase().includes('error') ? 'text-red-500' : 'text-emerald-600'}`}>{createMsg}</p>
            )}
            <div className="flex gap-2">
              {editingId && (
                <button
                  onClick={cancelEdit}
                  className="flex-1 bg-slate-100 text-slate-700 py-3 rounded-xl text-sm font-semibold hover:bg-slate-200 transition"
                >
                  Cancelar
                </button>
              )}
              <button
                onClick={handleCreate}
                disabled={loading}
                className="aa-btn aa-btn-emerald flex-1 bg-emerald-600 text-white py-3 rounded-xl text-sm font-semibold disabled:opacity-50 hover:bg-emerald-700 flex items-center justify-center"
              >
                {loading && <span className="aa-spinner" />}<span className="relative z-10">{loading ? 'Guardando...' : editingId ? 'Guardar cambios' : 'Crear regla'}</span>
              </button>
            </div>
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
            <div className="space-y-4">
              {rules.map((r, idx) => {
                const eligible = eligibleByRule[r.id]
                const isExpanded = expandedRule === r.id
                return (
                  <div key={r.id} className="aa-card aa-row-in bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden" style={{ animationDelay: `${Math.min(idx * 40, 360)}ms` }}>
                    <div className="p-5">
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
                        <p>
                          Grupo: {Array.isArray(r.targetPhones) && r.targetPhones.length > 0
                            ? `${r.targetPhones.length} numero(s) especifico(s)`
                            : 'Todos los clientes inactivos'}
                        </p>
                      </div>
                      <p className="text-xs text-slate-400 mt-3 bg-slate-50 p-2 rounded line-clamp-3">
                        {r.messageTemplate}
                      </p>
                      <div className="flex flex-wrap gap-3 mt-3">
                        <button
                          onClick={() => toggleRuleExpansion(r.id)}
                          className="text-sm text-emerald-600 hover:text-emerald-800 font-semibold"
                        >
                          {isExpanded ? 'Ocultar numeros' : 'Ver numeros que recibiran el mensaje'}
                        </button>
                        <button
                          onClick={() => startEdit(r)}
                          className="text-sm text-indigo-600 hover:text-indigo-800 font-semibold"
                        >
                          Editar
                        </button>
                        <button
                          onClick={() => handleDelete(r.id, r.name)}
                          className="text-sm text-red-600 hover:text-red-800 font-semibold"
                        >
                          Eliminar
                        </button>
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="border-t border-slate-100 bg-slate-50 p-4">
                        {loadingEligible === r.id && !eligible && (
                          <p className="text-sm text-slate-400 text-center py-2">Cargando...</p>
                        )}
                        {eligible && (
                          <>
                            <div className="grid grid-cols-3 gap-2 mb-3">
                              <div className="bg-white rounded-lg p-2 text-center border border-slate-200">
                                <p className="text-xs text-slate-500">Total</p>
                                <p className="text-lg font-bold text-slate-800">{eligible.total}</p>
                              </div>
                              <div className="bg-amber-50 rounded-lg p-2 text-center border border-amber-200">
                                <p className="text-xs text-amber-600">Pendientes</p>
                                <p className="text-lg font-bold text-amber-700">{eligible.pending}</p>
                              </div>
                              <div className="bg-emerald-50 rounded-lg p-2 text-center border border-emerald-200">
                                <p className="text-xs text-emerald-600">Ya notificados</p>
                                <p className="text-lg font-bold text-emerald-700">{eligible.alreadyNotified}</p>
                              </div>
                            </div>

                            {eligible.consumers.length === 0 ? (
                              <p className="text-sm text-slate-400 text-center py-4">Ningun cliente califica por ahora</p>
                            ) : (
                              <div className="bg-white rounded-lg border border-slate-200 max-h-64 overflow-y-auto">
                                {eligible.consumers.map((c: any) => (
                                  <div key={c.accountId} className="flex items-center justify-between p-3 border-b border-slate-100 last:border-0">
                                    <div className="flex-1 min-w-0">
                                      <p className="text-sm font-medium text-slate-800 truncate">
                                        {c.phoneNumber}
                                        {c.displayName && <span className="text-slate-500"> - {c.displayName}</span>}
                                      </p>
                                      <p className="text-xs text-slate-400 mt-0.5">
                                        {c.daysSince} dias sin visitar
                                        {c.cedula && ` - ${c.cedula}`}
                                      </p>
                                    </div>
                                    {c.alreadyNotified ? (
                                      <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-xs font-medium flex-shrink-0 ml-2">Enviado</span>
                                    ) : (
                                      <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-xs font-medium flex-shrink-0 ml-2">Pendiente</span>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {/* Notifications history grouped by rule */}
        <section>
          <h2 className="text-lg font-semibold text-slate-800 mb-4">Notificaciones enviadas</h2>
          {notifications.length === 0 ? (
            <div className="bg-white rounded-2xl p-8 text-center border border-slate-100">
              <p className="text-slate-400">Sin notificaciones enviadas todavia</p>
            </div>
          ) : (() => {
            // Group notifications by rule name
            const grouped: Record<string, any[]> = {}
            for (const n of notifications) {
              const key = n.rule?.name || 'Sin regla'
              if (!grouped[key]) grouped[key] = []
              grouped[key].push(n)
            }
            return (
              <div className="space-y-4">
                {Object.entries(grouped).map(([ruleName, items]) => (
                  <div key={ruleName} className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
                    <div className="bg-emerald-50 px-4 py-3 border-b border-emerald-100 flex items-center justify-between">
                      <p className="text-sm font-semibold text-emerald-800">{ruleName}</p>
                      <span className="text-xs text-emerald-600 font-medium">{items.length} notificacion{items.length !== 1 ? 'es' : ''}</span>
                    </div>
                    <div className="divide-y divide-slate-100 max-h-80 overflow-y-auto">
                      {items.map((n: any) => (
                        <div key={n.id} className="p-4 flex items-center justify-between hover:bg-slate-50 transition">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-slate-800 truncate">{n.consumerAccount?.phoneNumber}</p>
                            <p className="text-xs text-slate-500 mt-0.5">
                              {n.daysSinceVisit} dias sin visitar - {n.bonusGranted ? 'Bono otorgado' : 'Solo mensaje'}
                            </p>
                          </div>
                          <span className="text-xs text-slate-400 flex-shrink-0 ml-4">
                            {new Date(n.sentAt).toLocaleDateString('es-VE')}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )
          })()}
        </section>
      </div>
    </div>
  )
}
