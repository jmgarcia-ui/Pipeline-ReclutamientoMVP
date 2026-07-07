const { app } = require('@azure/functions')
const { BlobServiceClient } = require('@azure/storage-blob')
const { EmailClient } = require('@azure/communication-email')
const sql = require('mssql')

const DocumentIntelligence = require('@azure-rest/ai-document-intelligence').default
const { isUnexpected, getLongRunningPoller } = require('@azure-rest/ai-document-intelligence')

app.eventGrid('procesarCv', {
  handler: async (event, context) => {
    context.log('Evento recibido:', event.eventType)

    if (event.eventType !== 'Microsoft.Storage.BlobCreated') {
      context.log('Evento ignorado:', event.eventType)
      return
    }

    const blobUrl = event.data?.url
    if (!blobUrl) {
      context.log('Evento sin URL de blob.')
      return
    }

    context.log('Blob URL:', blobUrl)

    try {
      const pool = await getSqlPool()

      const postulacion = await obtenerPostulacion(pool, blobUrl)
      if (!postulacion) {
        context.log('No se encontro postulacion para el blob:', blobUrl)
        return
      }

      await actualizarEstadoPostulacion(pool, postulacion.id_postulacion, 'PROCESANDO')
      

      const buffer = await descargarBlob(blobUrl)
      const textoCv = await extraerTextoDocumentIntelligence(buffer)

      const evaluacion = evaluarCompatibilidad(textoCv, postulacion)

      await guardarEvaluacion(pool, postulacion.id_postulacion, evaluacion)

      if (evaluacion.resultado === 'RECHAZADO') {
        await guardarReporteMejora(pool, postulacion.id_postulacion, evaluacion)
      } else {
        await eliminarReporteMejora(pool, postulacion.id_postulacion)
      }

      await actualizarEstadoPostulacion(pool, postulacion.id_postulacion, evaluacion.resultado)
      await guardarNotificacion(pool, postulacion, evaluacion)

      context.log(`CV evaluado. Postulacion=${postulacion.id_postulacion}, Score=${evaluacion.porcentaje}`)
    } catch (error) {
      context.error(error)
    }
  },
})

async function getSqlPool() {
  return sql.connect({
    server: process.env.SQL_SERVER,
    database: process.env.SQL_DATABASE,
    user: process.env.SQL_USER,
    password: process.env.SQL_PASSWORD,
    options: {
      encrypt: true,
      trustServerCertificate: false,
    },
  })
}

async function obtenerPostulacion(pool, blobUrl) {
  const result = await pool.request()
    .input('urlCv', sql.NVarChar, blobUrl)
    .query(`
      SELECT TOP 1
        p.id_postulacion,
        p.id_puesto,
        pu.nombre,
        pu.requisitos_tecnicos,
        pu.requisitos_educacion,
        pu.requisito_experiencia,
        pu.porcentaje_minimo,
        c.correo,
        c.nombres,
        c.apellidos
      FROM dbo.Postulacion p
      INNER JOIN dbo.Puesto pu ON pu.id_puesto = p.id_puesto
      INNER JOIN dbo.Candidato c ON c.id_candidato = p.id_candidato
      WHERE p.url_cv = @urlCv
    `)

  return result.recordset[0]
}

async function descargarBlob(blobUrl) {
  const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.BLOB_CONNECTION_STRING)
  const containerClient = blobServiceClient.getContainerClient(process.env.BLOB_CONTAINER_CVS)

  const url = new URL(blobUrl)
  const parts = url.pathname.split('/').filter(Boolean)
  const blobName = decodeURIComponent(parts.slice(1).join('/'))

  const blobClient = containerClient.getBlobClient(blobName)
  return blobClient.downloadToBuffer()
}

async function extraerTextoDocumentIntelligence(buffer) {
  const endpoint = process.env.DOCUMENT_INTELLIGENCE_ENDPOINT
  const key = process.env.DOCUMENT_INTELLIGENCE_KEY
  const model = process.env.DOCUMENT_INTELLIGENCE_MODEL || 'prebuilt-read'

  const client = DocumentIntelligence(endpoint, { key })

  const initialResponse = await client
    .path('/documentModels/{modelId}:analyze', model)
    .post({
      contentType: 'application/json',
      body: {
        base64Source: buffer.toString('base64'),
      },
    })

  if (isUnexpected(initialResponse)) {
    throw initialResponse.body.error
  }

  const poller = getLongRunningPoller(client, initialResponse)
  const result = await poller.pollUntilDone()

  return result.body.analyzeResult?.content || ''
}

function evaluarCompatibilidad(textoCv, puesto) {
  const textoNormalizado = normalizar(textoCv)

  const requisitosTecnicos = String(puesto.requisitos_tecnicos || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

  const detectadas = []
  const faltantes = []

  for (const requisito of requisitosTecnicos) {
    if (cumpleRequisito(textoNormalizado, requisito)) {
      detectadas.push(requisito)
    } else {
      faltantes.push(requisito)
    }
  }

  const scoreTecnico = requisitosTecnicos.length === 0
    ? 0
    : detectadas.length / requisitosTecnicos.length

  const scoreExperiencia = calcularScoreExperiencia(textoNormalizado, puesto.requisito_experiencia)
  const scoreEducacion = calcularScoreEducacion(textoNormalizado, puesto.requisitos_educacion)

  const porcentaje = Math.round((
    scoreTecnico * 0.70 +
    scoreExperiencia * 0.20 +
    scoreEducacion * 0.10
  ) * 10000) / 100

  const minimo = Number(puesto.porcentaje_minimo || 70)
  const resultado = porcentaje >= minimo ? 'APROBADO' : 'RECHAZADO'

  return {
    porcentaje,
    resultado,
    resumen: textoCv.slice(0, 1200),
    fortalezas: detectadas.join(', '),
    faltantes: faltantes.join(', '),
    detectadas,
  }
}

function cumpleRequisito(textoNormalizado, requisito) {
  const requisitoNormalizado = normalizar(requisito)

  if (textoNormalizado.includes(requisitoNormalizado)) return true

  const equivalencias = {
    'node js': ['node', 'backend javascript', 'javascript backend'],
    'react': ['react js', 'reactjs', 'frontend react'],
    'sql': ['sql server', 'mysql', 'postgresql', 'base de datos'],
    'apis rest': ['api rest', 'rest api', 'servicios rest'],
    'azure functions': ['functions', 'serverless', 'funciones azure'],
    'git': ['github', 'gitlab', 'control de versiones'],
    'power bi': ['powerbi', 'dashboard', 'dashboards'],
  }

  const alias = equivalencias[requisitoNormalizado] || []
  return alias.some((item) => textoNormalizado.includes(normalizar(item)))
}

function calcularScoreExperiencia(textoNormalizado, requisitoExperiencia) {
  const senales = ['experiencia', 'proyecto', 'practicas', 'desarrolle', 'implemente', 'trabaje']
  const tieneSenal = senales.some((item) => textoNormalizado.includes(item))

  if (!requisitoExperiencia) return tieneSenal ? 1 : 0

  const palabrasClave = normalizar(requisitoExperiencia)
    .split(' ')
    .filter((palabra) => palabra.length > 4)

  const coincidencias = palabrasClave.filter((palabra) => textoNormalizado.includes(palabra)).length
  const scoreTexto = palabrasClave.length === 0 ? 0 : coincidencias / palabrasClave.length

  return Math.max(tieneSenal ? 0.6 : 0, Math.min(scoreTexto, 1))
}

function calcularScoreEducacion(textoNormalizado, requisitosEducacion) {
  const base = ['universidad', 'instituto', 'ingenieria', 'sistemas', 'software', 'computacion', 'tecnico', 'egresado', 'estudiante']
  const coincidenciasBase = base.filter((item) => textoNormalizado.includes(item)).length

  if (!requisitosEducacion) return coincidenciasBase > 0 ? 1 : 0

  const palabrasClave = normalizar(requisitosEducacion)
    .split(' ')
    .filter((palabra) => palabra.length > 5)

  const coincidencias = palabrasClave.filter((palabra) => textoNormalizado.includes(palabra)).length

  if (coincidencias > 0) return 1
  if (coincidenciasBase >= 2) return 0.8
  if (coincidenciasBase === 1) return 0.5

  return 0
}

function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9+#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function guardarEvaluacion(pool, idPostulacion, evaluacion) {
  await pool.request()
    .input('idPostulacion', sql.Int, idPostulacion)
    .query(`
      DELETE FROM dbo.HabilidadDetectada WHERE id_postulacion = @idPostulacion;
      DELETE FROM dbo.EvaluacionCV WHERE id_postulacion = @idPostulacion;
    `)

  await pool.request()
    .input('idPostulacion', sql.Int, idPostulacion)
    .input('porcentaje', sql.Decimal(5, 2), evaluacion.porcentaje)
    .input('resultado', sql.VarChar(30), evaluacion.resultado)
    .input('resumenCv', sql.NVarChar(sql.MAX), evaluacion.resumen)
    .input('fortalezas', sql.NVarChar(sql.MAX), evaluacion.fortalezas)
    .input('faltantes', sql.NVarChar(sql.MAX), evaluacion.faltantes)
    .query(`
      INSERT INTO dbo.EvaluacionCV (
        id_postulacion,
        porcentaje_compatibilidad,
        resultado,
        resumen_cv,
        fortalezas,
        habilidades_faltantes,
        fecha_evaluacion
      )
      VALUES (
        @idPostulacion,
        @porcentaje,
        @resultado,
        @resumenCv,
        @fortalezas,
        @faltantes,
        GETDATE()
      )
    `)

  for (const habilidad of evaluacion.detectadas) {
    await pool.request()
      .input('idPostulacion', sql.Int, idPostulacion)
      .input('nombreHabilidad', sql.VarChar(150), habilidad)
      .input('tipo', sql.VarChar(50), 'TECNICA')
      .input('fuente', sql.VarChar(100), 'Document Intelligence')
      .query(`
        INSERT INTO dbo.HabilidadDetectada (
          id_postulacion,
          nombre_habilidad,
          tipo,
          fuente
        )
        VALUES (
          @idPostulacion,
          @nombreHabilidad,
          @tipo,
          @fuente
        )
      `)
  }
}

async function actualizarEstadoPostulacion(pool, idPostulacion, estado) {
  await pool.request()
    .input('idPostulacion', sql.Int, idPostulacion)
    .input('estado', sql.VarChar(30), estado)
    .query(`
      UPDATE dbo.Postulacion
      SET estado = @estado,
          fecha_actualizacion = GETDATE()
      WHERE id_postulacion = @idPostulacion
    `)
}

async function guardarReporteMejora(pool, idPostulacion, evaluacion) {
  await eliminarReporteMejora(pool, idPostulacion)

  const recomendaciones = construirRecomendaciones(evaluacion)
  const cursosSugeridos = construirCursosSugeridos(evaluacion)

  await pool.request()
    .input('idPostulacion', sql.Int, idPostulacion)
    .input('compatibilidadObtenida', sql.Decimal(5, 2), evaluacion.porcentaje)
    .input('recomendaciones', sql.NVarChar(sql.MAX), recomendaciones)
    .input('cursosSugeridos', sql.NVarChar(sql.MAX), cursosSugeridos)
    .query(`
      INSERT INTO dbo.ReporteMejora (
        id_postulacion,
        compatibilidad_obtenida,
        recomendaciones,
        cursos_sugeridos,
        fecha_repostulacion,
        fecha_generacion
      )
      VALUES (
        @idPostulacion,
        @compatibilidadObtenida,
        @recomendaciones,
        @cursosSugeridos,
        DATEADD(MONTH, 3, GETDATE()),
        GETDATE()
      )
    `)
}

async function eliminarReporteMejora(pool, idPostulacion) {
  await pool.request()
    .input('idPostulacion', sql.Int, idPostulacion)
    .query(`
      DELETE FROM dbo.ReporteMejora
      WHERE id_postulacion = @idPostulacion
    `)
}

function construirRecomendaciones(evaluacion) {
  if (!evaluacion.faltantes) {
    return 'Refuerza tus conocimientos tecnicos y prepara ejemplos concretos de proyectos para una proxima postulacion.'
  }

  const faltantes = evaluacion.faltantes
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

  return [
    'Tu CV aun no evidencia todos los requisitos tecnicos del puesto.',
    `Prioriza reforzar estas habilidades: ${faltantes.join(', ')}.`,
    'Agrega proyectos, repositorios, certificaciones o experiencias donde demuestres esas habilidades.',
    'Puedes volver a postular en 3 meses con una version actualizada de tu CV.',
  ].join('\n')
}

function construirCursosSugeridos(evaluacion) {
  const faltantes = evaluacion.faltantes
    ? evaluacion.faltantes.split(',').map((item) => item.trim()).filter(Boolean)
    : []

  if (faltantes.length === 0) {
    return 'Microsoft Learn, freeCodeCamp, Coursera, edX'
  }

  return faltantes.map((habilidad) => {
    const habilidadNormalizada = normalizar(habilidad)

    if (habilidadNormalizada.includes('node')) {
      return `${habilidad}: Node.js oficial, freeCodeCamp Backend APIs, Microsoft Learn Azure Functions`
    }

    if (habilidadNormalizada.includes('react')) {
      return `${habilidad}: React.dev, freeCodeCamp Front End Libraries`
    }

    if (habilidadNormalizada.includes('sql')) {
      return `${habilidad}: Microsoft Learn SQL, SQLBolt, Mode SQL Tutorial`
    }

    if (habilidadNormalizada.includes('azure')) {
      return `${habilidad}: Microsoft Learn Azure Fundamentals, Microsoft Learn Azure Functions`
    }

    if (habilidadNormalizada.includes('power bi')) {
      return `${habilidad}: Microsoft Learn Power BI, Power BI Guided Learning`
    }

    return `${habilidad}: Microsoft Learn, freeCodeCamp, Coursera o edX`
  }).join('\n')
}

async function guardarNotificacion(pool, postulacion, evaluacion) {
  const esAprobado = evaluacion.resultado === 'APROBADO'

  const tipo = esAprobado ? 'APROBACION' : 'RECHAZO_CON_REPORTE'
  const asunto = esAprobado
    ? 'Resultado de postulacion: avanzas a la siguiente etapa'
    : 'Resultado de postulacion: plan de mejora disponible'

  const cuerpo = esAprobado
    ? construirCorreoAprobacion(postulacion, evaluacion)
    : construirCorreoRechazo(postulacion, evaluacion)

  let estadoEnvio = 'SIMULADO'
  let detalleError = null

  if (process.env.EMAIL_SEND_ENABLED === 'true') {
    try {
      await enviarCorreo(postulacion.correo, asunto, cuerpo)
      estadoEnvio = 'ENVIADO'
    } catch (error) {
      estadoEnvio = 'ERROR'
      detalleError = error.message
    }
  }

  await pool.request()
    .input('idPostulacion', sql.Int, postulacion.id_postulacion)
    .input('tipo', sql.VarChar(50), tipo)
    .input('destinatario', sql.VarChar(255), postulacion.correo)
    .input('asunto', sql.VarChar(255), asunto)
    .input('estadoEnvio', sql.VarChar(30), estadoEnvio)
    .input('detalleError', sql.NVarChar(sql.MAX), detalleError)
    .query(`
      INSERT INTO dbo.Notificacion (
        id_postulacion,
        tipo,
        destinatario,
        asunto,
        estado_envio,
        fecha_envio,
        detalle_error
      )
      VALUES (
        @idPostulacion,
        @tipo,
        @destinatario,
        @asunto,
        @estadoEnvio,
        GETDATE(),
        @detalleError
      )
    `)
}

function construirCorreoAprobacion(postulacion, evaluacion) {
  return [
    `Hola ${postulacion.nombres},`,
    '',
    `Tu CV alcanzo ${evaluacion.porcentaje}% de compatibilidad con el puesto.`,
    'Avanzas a la siguiente etapa del proceso de seleccion. El equipo de reclutamiento revisara tu perfil y se pondra en contacto contigo.',
    '',
    'Gracias por postular.',
  ].join('\n')
}

function construirCorreoRechazo(postulacion, evaluacion) {
  const recomendaciones = construirRecomendaciones(evaluacion)
  const cursosSugeridos = construirCursosSugeridos(evaluacion)
  const habilidadesFaltantes = evaluacion.faltantes || 'No se identificaron habilidades faltantes especificas.'
  const fechaRepostulacion = new Date()
  fechaRepostulacion.setMonth(fechaRepostulacion.getMonth() + 3)

  return [
    `Hola ${postulacion.nombres},`,
    '',
    `Gracias por postular. Tu CV alcanzo ${evaluacion.porcentaje}% de compatibilidad con el puesto.`,
    'En esta oportunidad no avanzas a la siguiente etapa, pero generamos un plan de mejora para ayudarte a fortalecer tu perfil.',
    '',
    'Habilidades por reforzar:',
    habilidadesFaltantes,
    '',
    'Recomendaciones:',
    recomendaciones,
    '',
    'Cursos sugeridos:',
    cursosSugeridos,
    '',
    `Puedes volver a postular desde: ${fechaRepostulacion.toISOString().slice(0, 10)}`,
    '',
    'Te esperamos nuevamente con una version actualizada de tu CV.',
  ].join('\n')
}

async function enviarCorreo(destinatario, asunto, cuerpo) {
  const emailClient = new EmailClient(process.env.COMMUNICATION_SERVICES_CONNECTION_STRING)

  const message = {
    senderAddress: process.env.EMAIL_SENDER_ADDRESS,
    content: {
      subject: asunto,
      plainText: cuerpo,
    },
    recipients: {
      to: [{ address: destinatario }],
    },
  }

  const poller = await emailClient.beginSend(message)
  const result = await poller.pollUntilDone()

  if (result.status !== 'Succeeded') {
    throw new Error(`No se pudo enviar el correo. Estado: ${result.status}`)
  }
}
