require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool(
  process.env.DATABASE_URL 
    ? { connectionString: process.env.DATABASE_URL }
    : {
        user: process.env.DB_USER,
        host: process.env.DB_HOST,
        database: process.env.DB_NAME,
        password: process.env.DB_PASSWORD,
        port: process.env.DB_PORT,
      }
);

const initializeDatabase = async () => {
  try {
    // Tablas del esquema provisional (db bus.txt): ya no se usan, se
    // reemplazan por el esquema definitivo de abajo. Los datos son de
    // prueba, así que se descartan en vez de migrarse.
    await pool.query(`
      DROP TABLE IF EXISTS driver_locations, incidents, notifications, children, users CASCADE;
    `);

    await pool.query(`
      DO $$ BEGIN
        CREATE TYPE rol_usuario AS ENUM ('padre', 'chofer', 'admin');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN
        CREATE TYPE turno_ruta AS ENUM ('MANANA', 'TARDE');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN
        CREATE TYPE estado_viaje AS ENUM ('PROGRAMADO', 'EN_CURSO', 'FINALIZADO', 'CANCELADO');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN
        CREATE TYPE tipo_incidente AS ENUM ('TRAFICO', 'ACCIDENTE', 'RETRASO', 'OTRO');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN
        CREATE TYPE estado_incidente AS ENUM ('ABIERTO', 'RESUELTO');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN
        CREATE TYPE tipo_notificacion AS ENUM ('CERCA', 'SUBIO', 'FINALIZADA', 'ALERTA');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN
        CREATE TYPE parentesco_tipo AS ENUM ('MADRE', 'PADRE', 'TUTOR');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id_usuario      SERIAL PRIMARY KEY,
        password_hash   VARCHAR(255) NOT NULL,
        rol             rol_usuario NOT NULL,
        nombre_completo VARCHAR(120) NOT NULL,
        correo          VARCHAR(120) NOT NULL UNIQUE,
        telefono        VARCHAR(20),
        activo          BOOLEAN NOT NULL DEFAULT TRUE,
        fecha_creacion  TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS colegios (
        id_colegio  SERIAL PRIMARY KEY,
        nombre      VARCHAR(120) NOT NULL,
        direccion   VARCHAR(200),
        lat         DOUBLE PRECISION,
        lng         DOUBLE PRECISION
      );

      CREATE TABLE IF NOT EXISTS perfil_chofer (
        id_chofer       INTEGER PRIMARY KEY REFERENCES usuarios(id_usuario) ON DELETE CASCADE,
        licencia        VARCHAR(30),
        foto_url        VARCHAR(255),
        tarifa_mensual  DECIMAL(10, 2) NOT NULL DEFAULT 50.00
      );

      CREATE TABLE IF NOT EXISTS perfil_padre (
        id_padre    INTEGER PRIMARY KEY REFERENCES usuarios(id_usuario) ON DELETE CASCADE,
        foto_url    VARCHAR(255)
      );

      CREATE TABLE IF NOT EXISTS buses (
        id_bus              SERIAL PRIMARY KEY,
        placa               VARCHAR(15) NOT NULL UNIQUE,
        modelo              VARCHAR(60),
        capacidad           INTEGER NOT NULL,
        id_chofer_asignado  INTEGER REFERENCES perfil_chofer(id_chofer)
      );

      CREATE TABLE IF NOT EXISTS rutas (
        id_ruta             SERIAL PRIMARY KEY,
        nombre              VARCHAR(80) NOT NULL,
        turno               turno_ruta NOT NULL,
        id_colegio          INTEGER NOT NULL REFERENCES colegios(id_colegio),
        id_chofer           INTEGER REFERENCES perfil_chofer(id_chofer),
        id_bus              INTEGER REFERENCES buses(id_bus),
        hora_salida_estimada TIME
      );

      CREATE TABLE IF NOT EXISTS paradas (
        id_parada       SERIAL PRIMARY KEY,
        id_ruta         INTEGER NOT NULL REFERENCES rutas(id_ruta) ON DELETE CASCADE,
        orden           INTEGER NOT NULL,
        nombre          VARCHAR(150) NOT NULL,
        hora_estimada   TIME,
        lat             DOUBLE PRECISION,
        lng             DOUBLE PRECISION,
        UNIQUE (id_ruta, orden)
      );

      CREATE TABLE IF NOT EXISTS estudiantes (
        id_estudiante   SERIAL PRIMARY KEY,
        nombre_completo VARCHAR(120) NOT NULL,
        fecha_nacimiento DATE,
        foto_url        VARCHAR(255),
        grado           VARCHAR(30),
        id_colegio      INTEGER NOT NULL REFERENCES colegios(id_colegio),
        id_ruta         INTEGER REFERENCES rutas(id_ruta),
        id_parada       INTEGER REFERENCES paradas(id_parada)
      );

      CREATE TABLE IF NOT EXISTS padres_estudiantes (
        id_padre        INTEGER NOT NULL REFERENCES perfil_padre(id_padre) ON DELETE CASCADE,
        id_estudiante   INTEGER NOT NULL REFERENCES estudiantes(id_estudiante) ON DELETE CASCADE,
        parentesco      parentesco_tipo NOT NULL,
        PRIMARY KEY (id_padre, id_estudiante)
      );

      CREATE TABLE IF NOT EXISTS viajes (
        id_viaje        SERIAL PRIMARY KEY,
        id_ruta         INTEGER NOT NULL REFERENCES rutas(id_ruta),
        fecha           DATE NOT NULL,
        hora_inicio     TIMESTAMP,
        hora_fin        TIMESTAMP,
        estado          estado_viaje NOT NULL DEFAULT 'PROGRAMADO',
        UNIQUE (id_ruta, fecha)
      );

      CREATE TABLE IF NOT EXISTS asistencias (
        id_asistencia   SERIAL PRIMARY KEY,
        id_viaje        INTEGER NOT NULL REFERENCES viajes(id_viaje) ON DELETE CASCADE,
        id_estudiante   INTEGER NOT NULL REFERENCES estudiantes(id_estudiante),
        subio           BOOLEAN NOT NULL DEFAULT FALSE,
        hora_registro   TIMESTAMP NOT NULL DEFAULT NOW(),
        motivo          VARCHAR(100),
        observacion     TEXT,
        UNIQUE (id_viaje, id_estudiante)
      );

      CREATE TABLE IF NOT EXISTS incidentes (
        id_incidente        SERIAL PRIMARY KEY,
        id_viaje            INTEGER REFERENCES viajes(id_viaje),
        id_chofer           INTEGER REFERENCES perfil_chofer(id_chofer),
        id_usuario_reporta  INTEGER NOT NULL REFERENCES usuarios(id_usuario),
        tipo                tipo_incidente NOT NULL,
        mensaje             TEXT NOT NULL,
        lat                 DOUBLE PRECISION,
        lng                 DOUBLE PRECISION,
        estado              estado_incidente NOT NULL DEFAULT 'ABIERTO',
        fecha_hora          TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS notificaciones (
        id_notificacion     SERIAL PRIMARY KEY,
        id_usuario_destino  INTEGER NOT NULL REFERENCES usuarios(id_usuario) ON DELETE CASCADE,
        id_viaje            INTEGER REFERENCES viajes(id_viaje),
        titulo              VARCHAR(120) NOT NULL,
        mensaje             VARCHAR(255) NOT NULL,
        tipo                tipo_notificacion NOT NULL,
        leida               BOOLEAN NOT NULL DEFAULT FALSE,
        fecha_hora          TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS ubicaciones_bus (
        id_ubicacion    BIGSERIAL PRIMARY KEY,
        id_viaje        INTEGER NOT NULL REFERENCES viajes(id_viaje) ON DELETE CASCADE,
        lat             DOUBLE PRECISION NOT NULL,
        lng             DOUBLE PRECISION NOT NULL,
        fecha_hora      TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_estudiantes_ruta ON estudiantes(id_ruta);
      CREATE INDEX IF NOT EXISTS idx_estudiantes_parada ON estudiantes(id_parada);
      CREATE INDEX IF NOT EXISTS idx_paradas_ruta ON paradas(id_ruta);
      CREATE INDEX IF NOT EXISTS idx_viajes_ruta_fecha ON viajes(id_ruta, fecha);
      CREATE INDEX IF NOT EXISTS idx_asistencias_viaje ON asistencias(id_viaje);
      CREATE INDEX IF NOT EXISTS idx_asistencias_estudiante ON asistencias(id_estudiante);
      CREATE INDEX IF NOT EXISTS idx_incidentes_chofer ON incidentes(id_chofer);
      CREATE INDEX IF NOT EXISTS idx_incidentes_viaje ON incidentes(id_viaje);
      CREATE INDEX IF NOT EXISTS idx_incidentes_usuario_reporta ON incidentes(id_usuario_reporta);
      CREATE INDEX IF NOT EXISTS idx_notificaciones_usuario ON notificaciones(id_usuario_destino, leida);
      CREATE INDEX IF NOT EXISTS idx_ubicaciones_viaje_fecha ON ubicaciones_bus(id_viaje, fecha_hora);
    `);

    const colegios = await pool.query('SELECT id_colegio FROM colegios LIMIT 1');
    if (colegios.rowCount === 0) {
      await pool.query(
        "INSERT INTO colegios (nombre) VALUES ('Colegio Principal')"
      );
    }

    console.log('Database initialized successfully: esquema definitivo listo.');
  } catch (err) {
    console.error('Error initializing database:', err);
  }
};

module.exports = {
  pool,
  initializeDatabase,
};
