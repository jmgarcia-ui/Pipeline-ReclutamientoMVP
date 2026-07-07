const { app } = require('@azure/functions');
const { BlobServiceClient } = require('@azure/storage-blob')
const sql = require('mssql')
const crypto =require('node:crypto')

app.http('crearPostulacion', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'postulaciones',
    handler: async (request, context) => {
        const headers = {
            'Access-Control-Allow-Origin': process.env.FRONTEND_ORIGIN || '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        }
        if (request.method == 'OPTIONS'){
            return { status: 204, headers }
        }

        try{
            const formData = await request.formData()

            const nombres = formData.get('nombres')?.trim()
            const apellidos = formData.get('apellidos')?.trim()
            const correo = formData.get('correo')?.trim().toLowerCase()
            const telefono = formData.get('telefono')?.trim()
            const puesto = formData.get('puesto')?.trim()
            const cv = formData.get('cv')
            // ....

            if(!nombres || !apellidos || !correo || !telefono || !puesto || !cv){
                return {
                    status: 400,
                    headers,
                    jsonBody: { error: 'Faltan campos obligatorios.'}
                }
            }

            const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.BLOB_CONNECTION_STRING)
            const containerClient = blobServiceClient.getContainerClient(process.env.BLOB_CONTAINER_CVS)

            const extension = cv.name.split('.').pop()
            const blobName = `postulaciones/${Date.now()}-${crypto.randomUUID()}.${extension}`
            const blockBlobClient = containerClient.getBlockBlobClient(blobName)

            const buffer = Buffer.from(await cv.arrayBuffer())

            await blockBlobClient.uploadData(buffer, {
                blobHTTPHeaders:{
                    blobContentType: cv.type || 'application/octet-stream',
                }
            })

            const pool = await sql.connect({
                server: process.env.SQL_SERVER,
                database: process.env.SQL_DATABASE,
                user: process.env.SQL_USER,
                password: process.env.SQL_PASSWORD,
                options: {
                    encrypt: true,
                    trustServerCertificate: false,
                },
            })

            const candidatoResult = await pool.request()
                .input('nombres', sql.NVarChar, nombres)
                .input('apellidos', sql.NVarChar, apellidos)
                .input('correo', sql.NVarChar, correo)
                .input('telefono', sql.NVarChar, telefono)
                .query(`
                    INSERT INTO dbo.Candidato (nombres, apellidos, correo, telefono, fecha_registro)
                    OUTPUT INSERTED.id_candidato
                    VALUES (@nombres, @apellidos, @correo, @telefono, GETDATE())
                `)
            
            const idCandidato = candidatoResult.recordset[0].id_candidato

            const puestoResult = await pool.request()
                .input('nombre', sql.NVarChar, `%${puesto}%`)
                .query(`
                    SELECT TOP 1 id_puesto
                    FROM dbo.Puesto
                    WHERE LOWER(nombre) LIKE LOWER(@nombre)
                `)
            if (puestoResult.recordset.length === 0){
                return {
                    status: 400,
                    headers,
                    jsonBody: { error: 'No se encontró el puesto en la base de datos.'}
                }
            }

            const idPuesto = puestoResult.recordset[0].id_puesto

            const postulacionResult = await pool.request()
                .input('idCandidato', sql.Int, idCandidato)
                .input('idPuesto', sql.Int, idPuesto)
                .input('urlCv', sql.NVarChar, blockBlobClient.url)
                .input('nombreArchivo', sql.NVarChar, cv.name)
                .input('estado', sql.NVarChar, 'RECIBIDA')
                .query(`
                    INSERT INTO dbo.Postulacion (
                        id_candidato,
                        id_puesto,
                        url_cv,
                        nombre_archivo,
                        estado,
                        fecha_postulacion,
                        fecha_actualizacion
                    )
                    OUTPUT INSERTED.id_postulacion
                    VALUES (
                        @idCandidato,
                        @idPuesto,
                        @urlCv,
                        @nombreArchivo,
                        @estado,
                        GETDATE(),
                        GETDATE()
                    )
                `)

            return {
                status: 201,
                headers,
                jsonBody: {
                    idPostulacion: postulacionResult.recordset[0].id_postulacion,
                    estado: 'RECIBIDA',
                    blobName,
                },
            }


        } catch(error){
            context.error(error)
            return {
                status: 500,
                headers,
                jsonBody:{ error: 'No se pudo registrarla postulación'}
            }
        }
    }
});
