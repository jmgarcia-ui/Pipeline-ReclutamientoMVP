import { useMemo, useState } from 'react'

const API_URL = import.meta.env.VITE_API_URL || ''
const MOCK_SUBMIT = import.meta.env.VITE_MOCK_SUBMIT !== 'false'

const puestos = [
  { id: 'backend', nombre: 'Desarrollador Backend' },
  { id: 'frontend', nombre: 'Desarrollador Frontend' },
  { id: 'datos', nombre: 'Analista de Datos' },
  { id: 'soporte', nombre: 'Soporte TI' },
]

const initialForm = {
  nombres: '',
  apellidos: '',
  correo: '',
  telefono: '',
  puesto: 'backend',
  linkedin: '',
  cv: null,
  consentimiento: false,
}

function CvForm() {
  const [form, setForm] = useState(initialForm)
  const [errors, setErrors] = useState({})
  const [status, setStatus] = useState('idle')
  const [message, setMessage] = useState('')

  const fileLabel = useMemo(() => form.cv?.name || 'PDF, DOC o DOCX', [form.cv])
  const isSubmitting = status === 'submitting'

  const updateField = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }))
    setErrors((current) => ({ ...current, [field]: '' }))
  }

  const validate = () => {
    const nextErrors = {}
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

    if (!form.nombres.trim()) nextErrors.nombres = 'Ingresa tus nombres.'
    if (!form.apellidos.trim()) nextErrors.apellidos = 'Ingresa tus apellidos.'
    if (!emailPattern.test(form.correo)) nextErrors.correo = 'Ingresa un correo valido.'
    if (!form.telefono.trim()) nextErrors.telefono = 'Ingresa un numero de contacto.'
    if (!form.puesto) nextErrors.puesto = 'Selecciona un puesto.'
    if (!form.cv) nextErrors.cv = 'Adjunta tu CV.'
    if (form.cv && form.cv.size > 8 * 1024 * 1024) {
      nextErrors.cv = 'El archivo no debe superar 8 MB.'
    }
    if (!form.consentimiento) {
      nextErrors.consentimiento = 'Acepta el uso de datos para continuar.'
    }

    setErrors(nextErrors)
    return Object.keys(nextErrors).length === 0
  }

  const submitToApi = async (payload) => {
    if (MOCK_SUBMIT || !API_URL) {
      await new Promise((resolve) => setTimeout(resolve, 850))
      return { idPostulacion: crypto.randomUUID() }
    }

    const response = await fetch(`${API_URL}/postulaciones`, {
      method: 'POST',
      body: payload,
    })

    if (!response.ok) {
      let detail = 'No se pudo enviar la postulacion.'
      try {
        const data = await response.json()
        detail = data?.message || data?.error || detail
      } catch {
        // The generic message is clearer than exposing a raw HTML error page.
      }
      throw new Error(detail)
    }

    return response.json()
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    setMessage('')

    if (!validate()) {
      setStatus('error')
      setMessage('Revisa los campos marcados.')
      return
    }

    const payload = new FormData()
    payload.append('nombres', form.nombres.trim())
    payload.append('apellidos', form.apellidos.trim())
    payload.append('correo', form.correo.trim())
    payload.append('telefono', form.telefono.trim())
    payload.append('puesto', form.puesto)
    payload.append('linkedin', form.linkedin.trim())
    payload.append('cv', form.cv)

    try {
      setStatus('submitting')
      const result = await submitToApi(payload)
      setStatus('success')
      setMessage(`Postulacion enviada. Codigo: ${result.idPostulacion}`)
      setForm(initialForm)
    } catch (error) {
      setStatus('error')
      setMessage(error.message)
    }
  }

  return (
    <section className="form-card" aria-labelledby="form-title">
      <div className="form-header">
        <p className="eyebrow">Pipeline de seleccion</p>
        <h1 id="form-title">Postulacion</h1>
        <p>Completa tus datos y adjunta tu CV.</p>
      </div>

      <form className="cv-form" onSubmit={handleSubmit} noValidate>
        <div className="form-row">
          <Field label="Nombres" error={errors.nombres}>
            <input
              value={form.nombres}
              onChange={(event) => updateField('nombres', event.target.value)}
              placeholder="Juan Marco"
              autoComplete="given-name"
            />
          </Field>

          <Field label="Apellidos" error={errors.apellidos}>
            <input
              value={form.apellidos}
              onChange={(event) => updateField('apellidos', event.target.value)}
              placeholder="Garcia Mendoza"
              autoComplete="family-name"
            />
          </Field>
        </div>

        <div className="form-row">
          <Field label="Correo electronico" error={errors.correo}>
            <input
              type="email"
              value={form.correo}
              onChange={(event) => updateField('correo', event.target.value)}
              placeholder="correo@dominio.com"
              autoComplete="email"
            />
          </Field>

          <Field label="Numero de contacto" error={errors.telefono}>
            <input
              value={form.telefono}
              onChange={(event) => updateField('telefono', event.target.value)}
              placeholder="+51 999 999 999"
              autoComplete="tel"
              inputMode="tel"
            />
          </Field>
        </div>

        <Field label="Puesto" error={errors.puesto}>
          <select value={form.puesto} onChange={(event) => updateField('puesto', event.target.value)}>
            {puestos.map((puesto) => (
              <option key={puesto.id} value={puesto.id}>
                {puesto.nombre}
              </option>
            ))}
          </select>
        </Field>

        <Field label="LinkedIn o portafolio" optional>
          <input
            value={form.linkedin}
            onChange={(event) => updateField('linkedin', event.target.value)}
            placeholder="https://linkedin.com/in/usuario"
            autoComplete="url"
          />
        </Field>

        <Field label="CV" error={errors.cv}>
          <label className="file-upload">
            <input
              type="file"
              accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              onChange={(event) => updateField('cv', event.target.files?.[0] || null)}
            />
            <span>Seleccionar archivo</span>
            <strong>{fileLabel}</strong>
          </label>
        </Field>

        <label className={`consent ${errors.consentimiento ? 'is-invalid' : ''}`}>
          <input
            type="checkbox"
            checked={form.consentimiento}
            onChange={(event) => updateField('consentimiento', event.target.checked)}
          />
          <span>Acepto el tratamiento de mis datos para esta postulacion.</span>
        </label>
        {errors.consentimiento && <p className="field-error">{errors.consentimiento}</p>}

        <div className="form-actions">
          <button type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Enviando...' : 'Enviar CV'}
          </button>
          {message && <p className={`submit-message ${status}`}>{message}</p>}
        </div>
      </form>
    </section>
  )
}

function Field({ label, error, optional = false, children }) {
  return (
    <label className={`field ${error ? 'is-invalid' : ''}`}>
      <span className="field-label">
        {label}
        {optional && <small>Opcional</small>}
      </span>
      {children}
      {error && <span className="field-error">{error}</span>}
    </label>
  )
}

export default CvForm
