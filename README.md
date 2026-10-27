# hBD — Cliente de bases de datos para VS Code

Cliente universal de bases de datos inspirado en **DBeaver**, integrado en VS Code.

Motores soportados: **PostgreSQL**, **MySQL**, **MariaDB**, **SQL Server** y **SQLite** (SQLite usa `sql.js`/WebAssembly, sin dependencias nativas).

## Funcionalidades

### Conexiones
- Formulario de conexión con **prueba de conexión**, host/puerto/base/usuario, SSL, *trust server certificate* (SQL Server).
- **Túnel SSH** con contraseña o clave privada (+ passphrase).
- Contraseñas guardadas en el **almacenamiento seguro** de VS Code (o solo durante la sesión).
- **Carpetas** para agrupar conexiones, **color** por conexión (p. ej. rojo = producción).
- Conexiones de **solo lectura** (bloquea INSERT/UPDATE/DELETE/DDL).
- Duplicar, editar, eliminar, **exportar/importar** conexiones (JSON, sin contraseñas).

### Explorador de base de datos
- Árbol: conexión → bases de datos → esquemas → tablas, vistas, vistas materializadas, funciones, procedimientos, secuencias → columnas, índices, claves foráneas, triggers.
- **Filtro de objetos** por nombre y **búsqueda de objetos** en toda la base.
- Arrastrar un objeto al editor inserta su nombre calificado.
- Menú contextual: ver datos, propiedades, DDL, generar SQL (SELECT/INSERT/UPDATE/DELETE), contar filas, exportar, importar CSV, vaciar (TRUNCATE), eliminar (DROP), copiar nombre, crear base/esquema, plantilla de nueva tabla, diagrama ER, dump SQL.
- **Gestor de sesiones** (pg_stat_activity, PROCESSLIST, dm_exec_sessions) e **información del servidor**.

### Editor SQL
- Cada editor `.sql` se asocia a una conexión/base (barra de estado y CodeLens superior para cambiarla).
- **Ctrl+Enter**: ejecutar la sentencia bajo el cursor (o la selección). **Alt+X**: ejecutar el script. **Ctrl+Shift+E**: plan de ejecución (EXPLAIN). **Ctrl+Shift+F**: formatear SQL.
- CodeLens **▶ Ejecutar** / **Explain** sobre cada sentencia.
- Divisor de sentencias inteligente: comillas, comentarios, `$$` de PostgreSQL, bloques `BEGIN…END`, `DELIMITER` de MySQL, `GO` de SQL Server y líneas en blanco como delimitador (configurable).
- **Parámetros** `:nombre` y `${variable}`: se piden antes de ejecutar.
- **Autocompletado** de palabras clave, esquemas, tablas, vistas y columnas (incluye alias: `c.` → columnas de `cliente c`).
- **Transacciones**: auto-commit o modo manual, con botones Commit/Rollback en la barra de estado.
- Confirmación ante sentencias peligrosas (DROP, TRUNCATE, UPDATE/DELETE sin WHERE).
- **Historial de consultas** (vista lateral) para reabrir o re-ejecutar, y **log de ejecución** (canal de salida *hBD*).

### Resultados
- Panel inferior con **pestañas múltiples** (una por result set, más una de estadísticas para scripts); pestañas **fijables**.
- Grilla virtualizada: selección de celdas/rangos, columnas redimensionables, orden por columna, filtro rápido.
- **Vista de registro** (fila vertical) y **panel de valor** (JSON formateado, abrir en editor).
- Copiar como TSV, CSV, JSON, SQL INSERT, Markdown o HTML.
- **Exportar** a CSV, TSV, JSON, SQL, XML, HTML, Markdown o texto alineado.

### Editor de tablas
- Pestañas **Datos / Propiedades / DDL**.
- Paginación en el servidor, filtro **WHERE** y **ORDER BY**, orden al hacer clic en el encabezado, contar filas.
- **Edición en línea**: modificar celdas, establecer NULL, agregar / duplicar / eliminar filas, **Guardar** (en una transacción), descartar y **ver el SQL** generado antes de guardar.
- Filtrar por el valor de una celda (=, <>, IS NULL) desde el menú contextual.

### Otros
- **Diagrama ER** de un esquema o de una tabla y sus relacionadas: arrastrar tablas, zoom, desplazamiento, solo claves, búsqueda y exportación a **SVG**.
- **Importar CSV** a una tabla (detección de delimitador, mapeo de columnas por nombre, una transacción).
- **Dump SQL** de una base/esquema (estructura, datos o ambos).

## Atajos

| Atajo | Acción |
|---|---|
| Ctrl+Enter | Ejecutar sentencia / selección |
| Alt+X | Ejecutar script |
| Ctrl+Shift+E | Plan de ejecución |
| Ctrl+Shift+F | Formatear SQL |
| Ctrl+] (en el explorador) | Nuevo editor SQL |
| Grilla: F2 / Enter | Editar celda |
| Grilla: Supr | Eliminar / restaurar fila |
| Grilla: Ctrl+C / Ctrl+Shift+C | Copiar / copiar con encabezados |
| Editor de tablas: Ctrl+S / F5 | Guardar cambios / recargar |

## Configuración

`hbd.maxRows`, `hbd.tableEditor.pageSize`, `hbd.showAllDatabases`, `hbd.script.stopOnError`, `hbd.blankLineDelimiter`, `hbd.history.maxEntries`, `hbd.codeLens.enabled`, `hbd.confirmDangerous`, `hbd.parameters.enabled`, `hbd.format.keywordCase`, `hbd.format.tabWidth`.

## Desarrollo

```bash
npm install
npm run compile     # o: npm run watch
```

Pulse **F5** en VS Code (configuración *Ejecutar extensión hBD*) para abrir una ventana con la extensión cargada.

Para generar el instalable: `npm run package` → `hbd-0.1.0.vsix`, e instalarlo con *Extensiones → … → Instalar desde VSIX*.

## Limitaciones conocidas

- Autenticación de Windows (SQL Server) y Oracle/otros motores no están soportados.
- Las consultas del editor SQL traen el resultado completo y muestran hasta `hbd.maxRows` filas; para tablas grandes use el editor de tablas (paginado en el servidor).
- La cancelación de consultas en curso no está implementada.
- Los procedimientos de SQL Server con varios result sets muestran solo el primero.
- SQLite carga el archivo en memoria y lo reescribe tras cada cambio confirmado (adecuado para bases pequeñas/medianas).
