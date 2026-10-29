# Cambios

## 0.2.0
- Las conexiones se sincronizan entre equipos con la Sincronización de configuración de VS Code (`hbd.syncConnections`, activado por defecto).
- Las contraseñas siguen siendo locales a cada equipo y se piden la primera vez.
- Si el archivo SQLite o la clave SSH no existen en el equipo, se ofrece buscarlos y la ruta se guarda solo para ese equipo.
- Opción para sincronizar también el historial de consultas (`hbd.history.sync`).
- Importación de conexiones de DBeaver (`data-sources.json`), con usuarios y contraseñas opcionales desde `credentials-config.json`. El comando *Importar conexiones* detecta el formato automáticamente.

## 0.1.0
- Versión inicial: PostgreSQL, MySQL, MariaDB, SQL Server y SQLite; explorador, editor SQL, grilla de resultados, editor de tablas, diagrama ER, importación CSV, dump SQL, historial y túneles SSH.
