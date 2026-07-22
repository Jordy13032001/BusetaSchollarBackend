const { pool } = require('./database');
const bcrypt = require('bcrypt');

async function f() {
  try {
    const hash = await bcrypt.hash('admin123', 10);
    await pool.query(
      'INSERT INTO usuarios (correo, password_hash, nombre_completo, rol) VALUES ($1, $2, $3, $4) ON CONFLICT (correo) DO NOTHING',
      ['admin@buseta.com', hash, 'Administrador General', 'admin']
    );
    console.log('Admin creado exitosamente');
  } catch(e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
}
f();
