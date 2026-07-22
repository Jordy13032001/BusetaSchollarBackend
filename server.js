require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const { pool, initializeDatabase } = require('./database');

const app = express();
const port = process.env.PORT || 3000;
const SALT_ROUNDS = 10;

app.use(cors());
app.use(bodyParser.json());

// Initialize the database on startup
initializeDatabase();

// ---------- Helpers ----------

async function getDefaultColegioId(runner) {
  const r = await runner.query('SELECT id_colegio FROM colegios ORDER BY id_colegio ASC LIMIT 1');
  return r.rows[0].id_colegio;
}

// Un chofer siempre tiene exactamente una ruta activa: la app todavía no
// tiene pantallas para administrar rutas/buses, así que se auto-provisiona.
async function getOrCreateRutaForChofer(client, idChofer, nombreChofer) {
  const existente = await client.query(
    'SELECT id_ruta FROM rutas WHERE id_chofer = $1 ORDER BY id_ruta ASC LIMIT 1',
    [idChofer]
  );
  if (existente.rowCount > 0) return existente.rows[0].id_ruta;

  const idColegio = await getDefaultColegioId(client);
  const insert = await client.query(
    `INSERT INTO rutas (nombre, turno, id_colegio, id_chofer)
     VALUES ($1, 'MANANA', $2, $3) RETURNING id_ruta`,
    [`Ruta de ${nombreChofer}`, idColegio, idChofer]
  );
  return insert.rows[0].id_ruta;
}

async function getOrCreateViajeHoy(runner, idRuta) {
  const existente = await runner.query(
    'SELECT * FROM viajes WHERE id_ruta = $1 AND fecha = CURRENT_DATE',
    [idRuta]
  );
  if (existente.rowCount > 0) return existente.rows[0];

  const insert = await runner.query(
    `INSERT INTO viajes (id_ruta, fecha, estado) VALUES ($1, CURRENT_DATE, 'PROGRAMADO') RETURNING *`,
    [idRuta]
  );
  return insert.rows[0];
}

async function getChoferByCorreo(runner, correo) {
  const r = await runner.query(
    `SELECT u.id_usuario, u.nombre_completo, pc.id_chofer
     FROM usuarios u JOIN perfil_chofer pc ON pc.id_chofer = u.id_usuario
     WHERE u.correo = $1`,
    [correo]
  );
  return r.rows[0];
}

async function getViajeStats(runner, idRuta, idViaje) {
  const total = await runner.query('SELECT COUNT(*)::int AS n FROM estudiantes WHERE id_ruta = $1', [idRuta]);
  const asistencia = await runner.query(
    `SELECT
       COUNT(*) FILTER (WHERE subio) ::int AS subieron,
       COUNT(*) FILTER (WHERE NOT subio) ::int AS no_subieron
     FROM asistencias WHERE id_viaje = $1`,
    [idViaje]
  );
  return {
    total: total.rows[0].n,
    subieron: asistencia.rows[0].subieron,
    no_subieron: asistencia.rows[0].no_subieron,
  };
}

function viajeResponse(viaje, stats) {
  return {
    id_viaje: viaje.id_viaje,
    id_ruta: viaje.id_ruta,
    fecha: viaje.fecha,
    estado: viaje.estado,
    total: stats.total,
    subieron: stats.subieron,
    no_subieron: stats.no_subieron,
  };
}

// 1. Registro de usuario
app.post('/api/registro', async (req, res) => {
  const { name, email, password, role } = req.body;

  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: 'Todos los campos son obligatorios' });
  }
  if (!['padre', 'chofer'].includes(role)) {
    return res.status(400).json({ error: 'Rol inválido' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const insertUsuario = await client.query(
      `INSERT INTO usuarios (password_hash, rol, nombre_completo, correo)
       VALUES ($1, $2, $3, $4) RETURNING id_usuario, nombre_completo, correo, rol`,
      [passwordHash, role, name, email]
    );
    const usuario = insertUsuario.rows[0];

    if (role === 'padre') {
      await client.query('INSERT INTO perfil_padre (id_padre) VALUES ($1)', [usuario.id_usuario]);
    } else {
      await client.query('INSERT INTO perfil_chofer (id_chofer) VALUES ($1)', [usuario.id_usuario]);
      await getOrCreateRutaForChofer(client, usuario.id_usuario, usuario.nombre_completo);
    }

    await client.query('COMMIT');
    res.status(201).json({
      message: 'Usuario registrado exitosamente',
      user: {
        id: usuario.id_usuario,
        name: usuario.nombre_completo,
        email: usuario.correo,
        role: usuario.rol,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error al registrar usuario:', err);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'El email ya está registrado' });
    }
    res.status(500).json({ error: 'Error interno del servidor' });
  } finally {
    client.release();
  }
});

// 2. Unirse como conductor (Postulación)
app.post('/api/unirse-conductor', async (req, res) => {
  const { email, placa, modelo, capacidad, tarifa_mensual } = req.body;
  if (!email || !placa || !modelo || !capacidad || !tarifa_mensual) {
    return res.status(400).json({ error: 'Todos los campos son requeridos' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const usuarioResult = await client.query(
      'SELECT id_usuario FROM usuarios WHERE correo = $1',
      [email]
    );
    if (usuarioResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    const idUsuario = usuarioResult.rows[0].id_usuario;

    // Verificar si ya tiene una solicitud pendiente
    const existente = await client.query(
      "SELECT id_solicitud FROM solicitudes_chofer WHERE id_usuario = $1 AND estado = 'PENDIENTE'",
      [idUsuario]
    );
    if (existente.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Ya tienes una solicitud pendiente' });
    }

    await client.query(
      `INSERT INTO solicitudes_chofer (id_usuario, placa, modelo, capacidad, tarifa_mensual)
       VALUES ($1, $2, $3, $4, $5)`,
      [idUsuario, placa, modelo, capacidad, tarifa_mensual]
    );

    await client.query('COMMIT');
    res.status(200).json({
      message: 'Solicitud enviada exitosamente para aprobación',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error al enviar solicitud:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  } finally {
    client.release();
  }
});

// ADMIN: Obtener solicitudes pendientes
app.get('/api/solicitudes', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.id_solicitud, u.nombre_completo, u.correo, s.placa, s.modelo, s.capacidad, s.tarifa_mensual, s.fecha_creacion
       FROM solicitudes_chofer s JOIN usuarios u ON u.id_usuario = s.id_usuario
       WHERE s.estado = 'PENDIENTE' ORDER BY s.fecha_creacion ASC`
    );
    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error al obtener solicitudes:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ADMIN: Aprobar solicitud
app.post('/api/solicitudes/:id/aprobar', async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const solResult = await client.query(
      "SELECT * FROM solicitudes_chofer WHERE id_solicitud = $1 AND estado = 'PENDIENTE'",
      [id]
    );
    if (solResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Solicitud no encontrada o ya procesada' });
    }
    const sol = solResult.rows[0];

    // Cambiar estado de solicitud
    await client.query("UPDATE solicitudes_chofer SET estado = 'APROBADA' WHERE id_solicitud = $1", [id]);

    // Cambiar rol y crear perfil
    const usuarioResult = await client.query("UPDATE usuarios SET rol = 'chofer' WHERE id_usuario = $1 RETURNING nombre_completo", [sol.id_usuario]);
    const nombreCompleto = usuarioResult.rows[0].nombre_completo;

    await client.query(
      'INSERT INTO perfil_chofer (id_chofer, tarifa_mensual) VALUES ($1, $2) ON CONFLICT (id_chofer) DO UPDATE SET tarifa_mensual = EXCLUDED.tarifa_mensual',
      [sol.id_usuario, sol.tarifa_mensual]
    );
    
    // Crear bus
    await client.query(
      'INSERT INTO buses (placa, modelo, capacidad, id_chofer_asignado) VALUES ($1, $2, $3, $4) ON CONFLICT (placa) DO NOTHING',
      [sol.placa, sol.modelo, sol.capacidad, sol.id_usuario]
    );

    // Auto-provisionar ruta default
    await getOrCreateRutaForChofer(client, sol.id_usuario, nombreCompleto);

    await client.query('COMMIT');
    res.status(200).json({ message: 'Solicitud aprobada y perfil de chofer creado' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error al aprobar solicitud:', err);
    res.status(500).json({ error: 'Error interno' });
  } finally {
    client.release();
  }
});

// ADMIN: Rechazar solicitud
app.post('/api/solicitudes/:id/rechazar', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      "UPDATE solicitudes_chofer SET estado = 'RECHAZADA' WHERE id_solicitud = $1 AND estado = 'PENDIENTE' RETURNING *",
      [id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Solicitud no encontrada o ya procesada' });
    res.status(200).json({ message: 'Solicitud rechazada' });
  } catch (err) {
    console.error('Error al rechazar solicitud:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// 3. Login básico
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email y contraseña son requeridos' });
  }

  try {
    const result = await pool.query('SELECT * FROM usuarios WHERE correo = $1', [email]);
    if (result.rowCount === 0) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const usuario = result.rows[0];
    const passwordOk = await bcrypt.compare(password, usuario.password_hash);
    if (!passwordOk) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    let roles = [];
    if (usuario.rol === 'admin') {
      roles = ['admin'];
    } else {
      // Check perfil_padre
      const isPadre = await pool.query('SELECT 1 FROM perfil_padre WHERE id_padre = $1', [usuario.id_usuario]);
      if (isPadre.rowCount > 0) roles.push('padre');

      // Check perfil_chofer
      const isChofer = await pool.query('SELECT 1 FROM perfil_chofer WHERE id_chofer = $1', [usuario.id_usuario]);
      if (isChofer.rowCount > 0) roles.push('chofer');
      
      // Fallback
      if (roles.length === 0) roles.push(usuario.rol);
    }

    res.status(200).json({
      message: 'Login exitoso',
      user: {
        id: usuario.id_usuario,
        name: usuario.nombre_completo,
        email: usuario.correo,
        role: usuario.rol,
        roles: roles
      },
    });
  } catch (err) {
    console.error('Error en el login:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// 4. Obtener lista de choferes disponibles
app.get('/api/choferes', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id_usuario AS id_chofer, u.nombre_completo, u.correo, pc.tarifa_mensual, b.placa, b.modelo
       FROM perfil_chofer pc 
       JOIN usuarios u ON u.id_usuario = pc.id_chofer
       LEFT JOIN buses b ON b.id_chofer_asignado = pc.id_chofer
       ORDER BY u.nombre_completo`
    );
    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error al obtener choferes:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// 5. Agregar estudiante y contratar chofer (reemplaza /api/hijos)
app.post('/api/estudiantes', async (req, res) => {
  const { nombre_completo, direccion, lat, lng, correo_padre, correo_chofer } = req.body;
  if (!nombre_completo || !direccion || !correo_padre || !correo_chofer) {
    return res.status(400).json({ error: 'Todos los campos son requeridos' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const padreResult = await client.query(
      "SELECT u.id_usuario FROM usuarios u JOIN perfil_padre p ON u.id_usuario = p.id_padre WHERE u.correo = $1",
      [correo_padre]
    );
    if (padreResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Padre no encontrado' });
    }
    const idPadre = padreResult.rows[0].id_usuario;

    const chofer = await getChoferByCorreo(client, correo_chofer);
    if (!chofer) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Chofer no encontrado' });
    }
    const idRuta = await getOrCreateRutaForChofer(client, chofer.id_chofer, chofer.nombre_completo);
    const idColegio = await getDefaultColegioId(client);

    const estudianteInsert = await client.query(
      `INSERT INTO estudiantes (nombre_completo, id_colegio, id_ruta)
       VALUES ($1, $2, $3) RETURNING id_estudiante`,
      [nombre_completo, idColegio, idRuta]
    );
    const idEstudiante = estudianteInsert.rows[0].id_estudiante;

    const ordenResult = await client.query(
      'SELECT COALESCE(MAX(orden), 0) + 1 AS siguiente FROM paradas WHERE id_ruta = $1',
      [idRuta]
    );
    const orden = ordenResult.rows[0].siguiente;

    const paradaInsert = await client.query(
      `INSERT INTO paradas (id_ruta, orden, nombre, lat, lng)
       VALUES ($1, $2, $3, $4, $5) RETURNING id_parada`,
      [idRuta, orden, direccion, lat ?? null, lng ?? null]
    );

    await client.query('UPDATE estudiantes SET id_parada = $1 WHERE id_estudiante = $2', [
      paradaInsert.rows[0].id_parada,
      idEstudiante,
    ]);

    await client.query(
      "INSERT INTO padres_estudiantes (id_padre, id_estudiante, parentesco) VALUES ($1, $2, 'PADRE')",
      [idPadre, idEstudiante]
    );

    await client.query('COMMIT');
    res.status(201).json({
      message: 'Estudiante agregado exitosamente',
      child: {
        id_estudiante: idEstudiante,
        nombre_completo,
        direccion,
        lat: lat ?? null,
        lng: lng ?? null,
        correo_padre,
        correo_chofer,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error al agregar estudiante:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  } finally {
    client.release();
  }
});

const ESTUDIANTES_RUTA_SELECT = `
  SELECT e.id_estudiante, e.nombre_completo, p.nombre AS direccion,
         TO_CHAR(p.hora_estimada, 'HH24:MI') AS hora_estimada, p.lat, p.lng,
         up.correo AS correo_padre, uc.correo AS correo_chofer,
         COALESCE(a.subio, false) AS subio
  FROM estudiantes e
  JOIN rutas r ON r.id_ruta = e.id_ruta
  JOIN perfil_chofer pc ON pc.id_chofer = r.id_chofer
  JOIN usuarios uc ON uc.id_usuario = pc.id_chofer
  LEFT JOIN paradas p ON p.id_parada = e.id_parada
  LEFT JOIN padres_estudiantes pe ON pe.id_estudiante = e.id_estudiante
  LEFT JOIN usuarios up ON up.id_usuario = pe.id_padre
  LEFT JOIN viajes v ON v.id_ruta = r.id_ruta AND v.fecha = CURRENT_DATE
  LEFT JOIN asistencias a ON a.id_viaje = v.id_viaje AND a.id_estudiante = e.id_estudiante
`;

// 6. Obtener ruta del chofer
app.get('/api/chofer/:correo/ruta', async (req, res) => {
  const { correo } = req.params;
  try {
    const result = await pool.query(
      `${ESTUDIANTES_RUTA_SELECT} WHERE uc.correo = $1 ORDER BY p.orden NULLS LAST`,
      [correo]
    );
    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error al obtener ruta:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// 7. Obtener hijos de un padre
app.get('/api/padre/:correo/hijos', async (req, res) => {
  const { correo } = req.params;
  try {
    const result = await pool.query(
      `${ESTUDIANTES_RUTA_SELECT} WHERE up.correo = $1 ORDER BY e.id_estudiante`,
      [correo]
    );
    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error al obtener hijos:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// 8. Obtener notificaciones
app.get('/api/notificaciones/:parent_email', async (req, res) => {
  const { parent_email } = req.params;
  try {
    const result = await pool.query(
      `SELECT n.id_notificacion AS id, n.titulo AS title, n.mensaje AS message,
              TO_CHAR(n.fecha_hora, 'YYYY-MM-DD HH24:MI') AS timestamp, n.tipo AS type,
              u.correo AS parent_email
       FROM notificaciones n JOIN usuarios u ON u.id_usuario = n.id_usuario_destino
       WHERE u.correo = $1 ORDER BY n.id_notificacion DESC`,
      [parent_email]
    );
    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error al obtener notificaciones:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// 9. Reportar incidente (lo puede reportar un padre o un chofer)
app.post('/api/incidentes', async (req, res) => {
  const { description, parent_email } = req.body;
  if (!description || !parent_email) return res.status(400).json({ error: 'Faltan datos' });

  try {
    const usuarioResult = await pool.query('SELECT id_usuario FROM usuarios WHERE correo = $1', [parent_email]);
    if (usuarioResult.rowCount === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const insert = await pool.query(
      `INSERT INTO incidentes (id_usuario_reporta, tipo, mensaje)
       VALUES ($1, 'OTRO', $2)
       RETURNING id_incidente, mensaje, estado, TO_CHAR(fecha_hora, 'YYYY-MM-DD HH24:MI') AS fecha_hora`,
      [usuarioResult.rows[0].id_usuario, description]
    );
    res.status(201).json(insert.rows[0]);
  } catch (err) {
    console.error('Error al reportar incidente:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// 10. Obtener incidentes reportados por un usuario
app.get('/api/incidentes/:parent_email', async (req, res) => {
  const { parent_email } = req.params;
  try {
    const result = await pool.query(
      `SELECT i.id_incidente, i.mensaje, i.estado,
              TO_CHAR(i.fecha_hora, 'YYYY-MM-DD HH24:MI') AS fecha_hora
       FROM incidentes i JOIN usuarios u ON u.id_usuario = i.id_usuario_reporta
       WHERE u.correo = $1 ORDER BY i.id_incidente DESC`,
      [parent_email]
    );
    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error al obtener incidentes:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// 11. Actualizar ubicación del chofer (atada al viaje activo)
app.post('/api/chofer/ubicacion', async (req, res) => {
  const { driver_email, lat, lng, id_viaje } = req.body;
  if (!driver_email || lat === undefined || lng === undefined || !id_viaje) {
    return res.status(400).json({ error: 'Faltan datos' });
  }
  try {
    const insert = await pool.query(
      `INSERT INTO ubicaciones_bus (id_viaje, lat, lng)
       VALUES ($1, $2, $3)
       RETURNING lat, lng, TO_CHAR(fecha_hora, 'YYYY-MM-DD HH24:MI:SS') AS updated_at`,
      [id_viaje, lat, lng]
    );
    res.status(200).json({ driver_email, ...insert.rows[0] });
  } catch (err) {
    console.error('Error al actualizar ubicacion:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// 12. Obtener última ubicación conocida del chofer
app.get('/api/chofer/ubicacion/:driver_email', async (req, res) => {
  const { driver_email } = req.params;
  try {
    const chofer = await getChoferByCorreo(pool, driver_email);
    if (!chofer) return res.status(404).json({ error: 'Chofer no encontrado' });

    const result = await pool.query(
      `SELECT ub.lat, ub.lng, TO_CHAR(ub.fecha_hora, 'YYYY-MM-DD HH24:MI:SS') AS updated_at
       FROM ubicaciones_bus ub
       JOIN viajes v ON v.id_viaje = ub.id_viaje
       JOIN rutas r ON r.id_ruta = v.id_ruta
       WHERE r.id_chofer = $1 AND v.fecha = CURRENT_DATE
       ORDER BY ub.fecha_hora DESC LIMIT 1`,
      [chofer.id_chofer]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'No location' });
    res.status(200).json({ driver_email, ...result.rows[0] });
  } catch (err) {
    console.error('Error al obtener ubicacion:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// 13. Iniciar el viaje del día para un chofer
app.post('/api/chofer/:correo/viajes/iniciar', async (req, res) => {
  const { correo } = req.params;
  try {
    const chofer = await getChoferByCorreo(pool, correo);
    if (!chofer) return res.status(404).json({ error: 'Chofer no encontrado' });

    const idRuta = await getOrCreateRutaForChofer(pool, chofer.id_chofer, chofer.nombre_completo);
    let viaje = await getOrCreateViajeHoy(pool, idRuta);
    if (viaje.estado === 'PROGRAMADO') {
      const update = await pool.query(
        "UPDATE viajes SET estado = 'EN_CURSO', hora_inicio = NOW() WHERE id_viaje = $1 RETURNING *",
        [viaje.id_viaje]
      );
      viaje = update.rows[0];
    }

    const stats = await getViajeStats(pool, idRuta, viaje.id_viaje);
    res.status(200).json(viajeResponse(viaje, stats));
  } catch (err) {
    console.error('Error al iniciar viaje:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// 14. Finalizar el viaje del día para un chofer
app.post('/api/chofer/:correo/viajes/finalizar', async (req, res) => {
  const { correo } = req.params;
  try {
    const chofer = await getChoferByCorreo(pool, correo);
    if (!chofer) return res.status(404).json({ error: 'Chofer no encontrado' });

    const { fecha_celular } = req.body;

    const idRuta = await getOrCreateRutaForChofer(pool, chofer.id_chofer, chofer.nombre_completo);
    const viajeResult = await pool.query(
      'SELECT * FROM viajes WHERE id_ruta = $1 AND fecha = CURRENT_DATE',
      [idRuta]
    );
    if (viajeResult.rowCount === 0) {
      return res.status(404).json({ error: 'No hay viaje activo hoy' });
    }

    // Try to ensure column exists
    await pool.query('ALTER TABLE viajes ADD COLUMN IF NOT EXISTS hora_fin_celular VARCHAR(50)');

    const update = await pool.query(
      "UPDATE viajes SET estado = 'FINALIZADO', hora_fin = NOW(), hora_fin_celular = $2 WHERE id_viaje = $1 RETURNING *",
      [viajeResult.rows[0].id_viaje, fecha_celular || null]
    );
    const viaje = update.rows[0];
    const stats = await getViajeStats(pool, idRuta, viaje.id_viaje);
    res.status(200).json(viajeResponse(viaje, stats));
  } catch (err) {
    console.error('Error al finalizar viaje:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// 15. Estado/resumen del viaje actual de un chofer
app.get('/api/chofer/:correo/viajes/actual', async (req, res) => {
  const { correo } = req.params;
  try {
    const chofer = await getChoferByCorreo(pool, correo);
    if (!chofer) return res.status(404).json({ error: 'Chofer no encontrado' });

    const idRuta = await getOrCreateRutaForChofer(pool, chofer.id_chofer, chofer.nombre_completo);
    const viaje = await getOrCreateViajeHoy(pool, idRuta);
    const stats = await getViajeStats(pool, idRuta, viaje.id_viaje);
    res.status(200).json(viajeResponse(viaje, stats));
  } catch (err) {
    console.error('Error al obtener viaje actual:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// 16. Marcar asistencia de un estudiante en un viaje
app.post('/api/viajes/:id_viaje/asistencia', async (req, res) => {
  const { id_viaje } = req.params;
  const { id_estudiante, subio, motivo } = req.body;
  if (id_estudiante === undefined || subio === undefined) {
    return res.status(400).json({ error: 'Faltan datos' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const upsert = await client.query(
      `INSERT INTO asistencias (id_viaje, id_estudiante, subio, motivo)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id_viaje, id_estudiante)
       DO UPDATE SET subio = EXCLUDED.subio, motivo = EXCLUDED.motivo, hora_registro = NOW()
       RETURNING *`,
      [id_viaje, id_estudiante, subio, motivo ?? null]
    );

    if (subio) {
      const estudiante = await client.query(
        'SELECT nombre_completo FROM estudiantes WHERE id_estudiante = $1',
        [id_estudiante]
      );
      const padres = await client.query(
        'SELECT id_padre FROM padres_estudiantes WHERE id_estudiante = $1',
        [id_estudiante]
      );
      const nombre = estudiante.rows[0]?.nombre_completo ?? 'Tu hijo';
      for (const padre of padres.rows) {
        await client.query(
          `INSERT INTO notificaciones (id_usuario_destino, id_viaje, titulo, mensaje, tipo)
           VALUES ($1, $2, 'Subió a la buseta', $3, 'SUBIO')`,
          [padre.id_padre, id_viaje, `${nombre} subió a la buseta`]
        );
      }
    }

    await client.query('COMMIT');
    res.status(200).json(upsert.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error al registrar asistencia:', err);
    res.status(500).json({ error: 'Error interno' });
  } finally {
    client.release();
  }
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
