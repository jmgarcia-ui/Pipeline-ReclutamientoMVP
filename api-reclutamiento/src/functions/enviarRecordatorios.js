const { app } = require('@azure/functions')
const sql = require('mssql')

app.timer('enviarRecordatorios', {
  //schedule: '0 0 9 * * *', //todos los dias a las 9UTC (4am - hora peru)
  schedule: '0 */2 * * * *', // cada dos minutos
  handler: async (timer, context) => {
    context.log('Ejecutando recordatorios de repostulacion')

    try {
      const pool = await getSqlPool()

      const reportes = await obtenerReportesPendientes(pool)

      context.log(`Reportes pendientes: ${reportes.length}`)

      for (const reporte of reportes) {
        await registrarRecordatorio(pool, reporte)
        context.log(`Recordatorio registrado para postulacion ${reporte.id_postulacion}`)
      }
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

async function obtenerReportesPendientes(pool) {
  const result = await pool.request()
    .query(`
      SELECT
        r.id_reporte,
        r.id_postulacion,
        r.fecha_repostulacion,
        c.correo,
        c.nombres,
        c.apellidos
      FROM dbo.ReporteMejora r
      INNER JOIN dbo.Postulacion p ON p.id_postulacion = r.id_postulacion
      INNER JOIN dbo.Candidato c ON c.id_candidato = p.id_candidato
      WHERE r.fecha_repostulacion <= GETDATE()
        AND NOT EXISTS (
          SELECT 1
          FROM dbo.Notificacion n
          WHERE n.id_postulacion = r.id_postulacion
            AND n.tipo = 'RECORDATORIO_REPOSTULACION'
        )
    `)

  return result.recordset
}

async function registrarRecordatorio(pool, reporte) {
  await pool.request()
    .input('idPostulacion', sql.Int, reporte.id_postulacion)
    .input('tipo', sql.VarChar(50), 'RECORDATORIO_REPOSTULACION')
    .input('destinatario', sql.VarChar(255), reporte.correo)
    .input('asunto', sql.VarChar(255), 'Ya puedes volver a postular')
    .input('estadoEnvio', sql.VarChar(30), 'SIMULADO')
    .input('detalleError', sql.NVarChar(sql.MAX), null)
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