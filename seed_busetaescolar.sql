-- =========================================================
-- Datos de prueba (Seed) para BusetaEscolarApp (Cuenca, Ecuador)
-- =========================================================

-- Limpiar datos anteriores para evitar errores de llaves duplicadas (id_chofer=2 already exists)
-- Esto borra todo y reinicia los contadores (SERIAL) a 1
TRUNCATE TABLE usuarios, colegios, perfil_chofer, perfil_padre, buses, rutas, paradas, estudiantes, padres_estudiantes, viajes, asistencias, incidentes, notificaciones, ubicaciones_bus RESTART IDENTITY CASCADE;

-- 1. USUARIOS (La contraseña para TODOS es: 123456)
-- Con el RESTART IDENTITY, los IDs serán: 1 (admin), 2 (chofer), 3 (padre 1), 4 (padre 2)
INSERT INTO usuarios (password_hash, rol, nombre_completo, correo, telefono, activo) VALUES
('$2b$10$DVLISq5yHqBQ9olbyFHRYO0OMLFqMUY7J14bFRYsNcBjvp4OTOEFa', 'admin', 'Administrador Sistema', 'admin@buseta.com', '0999999999', true),
('$2b$10$DVLISq5yHqBQ9olbyFHRYO0OMLFqMUY7J14bFRYsNcBjvp4OTOEFa', 'chofer', 'Carlos Conductor', 'carlos@buseta.com', '0988888888', true),
('$2b$10$DVLISq5yHqBQ9olbyFHRYO0OMLFqMUY7J14bFRYsNcBjvp4OTOEFa', 'padre', 'Pablo Perez', 'pablo@buseta.com', '0977777777', true),
('$2b$10$DVLISq5yHqBQ9olbyFHRYO0OMLFqMUY7J14bFRYsNcBjvp4OTOEFa', 'padre', 'Maria Madre', 'maria@buseta.com', '0966666666', true);

-- 2. PERFIL CHOFER (ID = 2)
INSERT INTO perfil_chofer (id_chofer, licencia, foto_url, tarifa_mensual) VALUES
(2, 'LIC-12345', 'https://ui-avatars.com/api/?name=Carlos+Conductor', 60.00);

-- 3. PERFIL PADRE (IDs = 3 y 4)
INSERT INTO perfil_padre (id_padre, foto_url) VALUES
(3, 'https://ui-avatars.com/api/?name=Pablo+Perez'),
(4, 'https://ui-avatars.com/api/?name=Maria+Madre');

-- 4. COLEGIOS (Ubicados en Cuenca)
INSERT INTO colegios (nombre, direccion, lat, lng) VALUES
('Colegio Benigno Malo', 'Av. Fray Vicente Solano', -2.9065, -79.0040),
('Unidad Educativa Asunción', 'Av. 12 de Abril', -2.9003, -79.0113);

-- 5. BUSES
INSERT INTO buses (placa, modelo, capacidad, id_chofer_asignado) VALUES
('ABA-1234', 'Mercedes Benz Sprinter', 20, 2);

-- 6. RUTAS (Usamos el Colegio Benigno Malo ID=1)
INSERT INTO rutas (nombre, turno, id_colegio, id_chofer, id_bus, hora_salida_estimada) VALUES
('Ruta Sur - Mañana', 'MANANA', 1, 2, 1, '06:30:00'),
('Ruta Sur - Tarde', 'TARDE', 1, 2, 1, '13:30:00');

-- 7. PARADAS (Para la Ruta 1: Sur - Mañana, ubicadas en Cuenca)
INSERT INTO paradas (id_ruta, orden, nombre, hora_estimada, lat, lng) VALUES
(1, 1, 'Parque Calderón', '06:35:00', -2.8974, -79.0045),
(1, 2, 'Feria Libre', '06:45:00', -2.8995, -79.0277),
(1, 3, 'Mall del Río', '06:55:00', -2.9189, -79.0116);

-- 8. ESTUDIANTES
INSERT INTO estudiantes (nombre_completo, fecha_nacimiento, foto_url, grado, id_colegio, id_ruta, id_parada) VALUES
('Juanito Perez', '2015-05-10', 'https://ui-avatars.com/api/?name=Juanito+Perez', '5to Basica', 1, 1, 1),
('Anita Perez', '2017-08-20', 'https://ui-avatars.com/api/?name=Anita+Perez', '3ro Basica', 1, 1, 1),
('Pedrito Gomez', '2014-11-05', 'https://ui-avatars.com/api/?name=Pedrito+Gomez', '6to Basica', 1, 1, 2);

-- 9. PADRES_ESTUDIANTES
-- Pablo (ID=3) es padre de Juanito (ID=1) y Anita (ID=2)
INSERT INTO padres_estudiantes (id_padre, id_estudiante, parentesco) VALUES
(3, 1, 'PADRE'),
(3, 2, 'PADRE');
-- Maria (ID=4) es madre de Pedrito (ID=3)
INSERT INTO padres_estudiantes (id_padre, id_estudiante, parentesco) VALUES
(4, 3, 'MADRE');

-- 10. VIAJES (Instancia de la Ruta 1 para el dia actual)
INSERT INTO viajes (id_ruta, fecha, hora_inicio, estado) VALUES
(1, CURRENT_DATE, CURRENT_TIMESTAMP, 'EN_CURSO');

-- 11. ASISTENCIAS
INSERT INTO asistencias (id_viaje, id_estudiante, subio, motivo, observacion) VALUES
(1, 1, TRUE, NULL, 'Subió sin problemas'),
(1, 2, FALSE, 'Enfermedad', 'Padre notificó que no asistirá'),
(1, 3, TRUE, NULL, NULL);

-- 12. INCIDENTES (En Cuenca)
INSERT INTO incidentes (id_viaje, id_chofer, id_usuario_reporta, tipo, mensaje, lat, lng, estado) VALUES
(1, 2, 2, 'TRAFICO', 'Tráfico pesado en la Av. de las Américas', -2.9015, -79.0150, 'ABIERTO');

-- 13. NOTIFICACIONES
INSERT INTO notificaciones (id_usuario_destino, id_viaje, titulo, mensaje, tipo, leida) VALUES
(3, 1, 'Bus cerca', 'El bus escolar está a 5 minutos de su parada.', 'CERCA', FALSE),
(4, 1, 'Estudiante subió', 'Pedrito Gomez ha subido al bus.', 'SUBIO', TRUE);

-- 14. UBICACIONES EN VIVO (Coordenadas en Cuenca)
INSERT INTO ubicaciones_bus (id_viaje, lat, lng) VALUES
(1, -2.8974, -79.0045),
(1, -2.8980, -79.0050),
(1, -2.8990, -79.0060);
