# SITCHA — Sistema de Soporte de Decisiones Geoespacial para la Reforestación con Quebracho Colorado

**Proyecto Final de Carrera** — Licenciatura en Sistemas de Información, FaCENA – UNNE
**Autora:** Ana Luz Teves Tessaro · **Profesor Orientador:** Lic. Darío Oscar Villegas · **Profesora Coordinadora:** Sonia Itatí Mariño

SITCHA es un Sistema de Soporte de Decisiones (DSS) WebGIS que evalúa la aptitud del territorio de la provincia del Chaco para intervenciones forestales con Quebracho Colorado (*Schinopsis balansae*). El núcleo del proyecto es un **pipeline ETL geoespacial**. El pipeline integra la carta de suelos del INTA, series satelitales de Google Earth Engine (NDVI, precipitación y cobertura de MapBiomas) y la zonificación legal del Ordenamiento Territorial de Bosques Nativos (OTBN). Con esos datos aplica un modelo de decisión multicriterio (AHP + MCDA) y publica la clasificación de los 429 polígonos de suelo en un visor web interactivo.

El administrador puede **ejecutar el pipeline desde la propia interfaz web** con el botón «Reprocesar modelo» y seguir su avance etapa por etapa.

> 🌐 **Demo:** `https://sdss-visor-mapa.vercel.app/`
> El visor está diseñado para uso en escritorio (no es responsive).

---

## Funcionalidades

**Perfil visitante**
- Mapa de aptitud con cinco categorías:
  - Zona verde: reforestación productiva.
  - Zona amarilla: enriquecimiento sostenible.
  - Zona roja: restauración ecológica.
  - No apto.
  - No apto por uso excluido.
- Panel de diagnóstico explicable por polígono: puntajes de suelo, lluvia y NDVI, composición OTBN y motivos de exclusión.
- Búsqueda por coordenadas y capa de quebrachos censados (Segundo Inventario Nacional de Bosques Nativos), que se puede ocultar.
- Reporte técnico en PDF por polígono, que incluye:
  - superficie y coordenadas en POSGAR 2007 / Faja 5;
  - desglose del cálculo de cada variable;
  - fuentes oficiales.
- Guía de uso integrada.

**Perfil administrador** (menú «Administración»)
- **Reprocesar modelo:** ejecuta el pipeline en segundo plano, con un modal que muestra la etapa en curso, la duración y los cambios respecto del mapa vigente.
- **Parámetros edáficos:** muestra la matriz completa y permite editar **solo los puntajes** (0–1). El siguiente reprocesamiento usa los valores nuevos. También permite descargar el Excel actualizado.
- **Auditoría:** polígonos más consultados del día, la semana o el mes.

---

## Arquitectura (cloud-local)

```
 Navegador (Vercel)          Render (FastAPI, un proceso)            Servicios gestionados
 ┌──────────────────┐  HTTPS  ┌───────────────────────────────┐      ┌──────────────────────────┐
 │ Leaflet · Turf.js│ ──────► │ server.py  (API REST + JWT)   │ ───► │ Supabase PostGIS + Auth  │
 │ Supabase JS      │  JWT    │ main.py    (pipeline, 6 etapas)│ ───► │ Google Earth Engine      │
 └──────────────────┘         └───────────────────────────────┘      └──────────────────────────┘
                                          ▲  otbn_porcentajes
                     Estación local ──────┘  (precalcular_otbn.py, QGIS, validacion_censo.py)
```

- **Local:** el cruce pesado y estático con el ráster OTBN (~276 MB) se calcula una sola vez en la PC y se guarda en la tabla `otbn_porcentajes`.
- **Nube:** el procesamiento recurrente se reparte así:
  - Earth Engine calcula las estadísticas zonales.
  - Render aplica el modelo.
  - Supabase almacena los resultados.
- **No distribuida:** hay un único nodo de cómputo propio, sin réplicas ni colas.

### Etapas del pipeline (`main.py`)

| # | Etapa | Entrada → Salida |
|---|-------|------------------|
| 0 | Precálculo OTBN (local, `precalcular_otbn.py`) | `assets/cat_otbn2.0.tif` + polígonos → `otbn_porcentajes` |
| 1 | Conexión | `DATABASE_URL`, credenciales GEE |
| 2 | Carga de suelos | `proc_suelos_chaco` |
| 3 | Lectura OTBN | `otbn_porcentajes` → `pct_rojo`, `pct_amarillo`, `pct_verde` |
| 4 | Extracción satelital (GEE) | assets 30 m → `val_ndvi`, `val_lluvia`, `val_uso_suelo` |
| 5 | Modelo MCDA | `parametros_edaficos` + variables → aptitud y clasificación |
| 6 | Comparación y exportación | → `mapa_aptitud_finalv2` |

---

## Modelo de decisión (resumen)

| Componente | Fórmula / regla |
|---|---|
| Pesos AHP | Matriz `[[1,1,2],[1,1,2],[½,½,1]]` → suelo 0.40, lluvia 0.40, NDVI 0.20 (CR = 0) |
| Suelo | `S_suelo = clip(0.35·textura + 0.25·subgrupo + 0.25·drenaje + 0.15·alcalinidad, 0, 1)` |
| NDVI | `S_ndvi = clip((NDVI − 0.10) / 0.70, 0, 1)` |
| Lluvia (mm) | 0 si P < 700 o P > 2500 · rampa 700–900 · 1 entre 900 y 1500 · descenso 1500–2500 |
| Aptitud | `A_bio = clip(0.40·S_suelo + 0.40·S_lluvia + 0.20·S_ndvi, 0, 1)`; se anula si `S_suelo ≤ 0.40` |
| Apto | `A_bio ≥ 0.60` y `S_suelo > 0.40` |
| Uso excluido | moda MapBiomas ∈ {6, 9, 11, 14, 18, 19, 22, 23, 24, 25, 26, 27, 36, 57, 58, 61} o sin dato |
| Zona OTBN | domina rojo / amarillo si supera a las otras dos; en otro caso, verde |

---

## Estructura del repositorio

```
├── index.html, css/, js/app.js       # Visor WebGIS (frontend estático)
├── server.py                         # API FastAPI (endpoints públicos y de administración)
├── main.py                           # Orquestador del pipeline ETL
├── precalcular_otbn.py               # Precálculo local de porcentajes OTBN
├── validacion_censo.py               # Validación contra el censo forestal (clases FAO)
├── src/
│   ├── db_connector.py               # Conexión a PostGIS (SQLAlchemy)
│   ├── gee_connector.py              # Autenticación y reducciones zonales en Earth Engine
│   ├── ahp_calculator.py             # Pesos AHP y relación de consistencia
│   ├── mcda_engine.py                # Submodelo edáfico
│   ├── raster_normalizer.py          # Normalización de NDVI, lluvia y máscara de uso
│   ├── reforestacion_pipeline.py     # Combinación lineal ponderada y clasificación
│   ├── parametros_edaficos.py        # Matriz editable (tabla parametros_edaficos / Excel)
│   └── reporte_pdf.py                # Reporte PDF por polígono (fpdf2)
├── assets/edaphic-model-parameters-v2.xlsx   # Matriz de parámetros edáficos inicial
└── requirements.txt
```

---

## Instalación local

**Requisitos:** Python 3.10 o superior, una base PostgreSQL con PostGIS (se usó Supabase) y una cuenta de servicio de Google Earth Engine.

```bash
git clone <URL-del-repositorio>
cd proyectofinal
python -m venv .venv
.venv\Scripts\activate          # Windows  (Linux/macOS: source .venv/bin/activate)
pip install -r requirements.txt
```

### Puesta en marcha

```bash
# 1. (una sola vez, en la PC local) precalcular la OTBN; requiere assets/cat_otbn2.0.tif
python precalcular_otbn.py

# 2. levantar la API
uvicorn server:app --reload --port 8000

# 3. (opcional) ejecutar el pipeline por consola en lugar de hacerlo desde la web
python main.py
```

Para usar el frontend contra la API local, cambiá `API_BASE` en `js/app.js` a `http://localhost:8000` y serví la carpeta con cualquier servidor estático, por ejemplo `python -m http.server 5500`.

---

## Despliegue

- **Backend (Render):**
  - Servicio web con start command `uvicorn server:app --host 0.0.0.0 --port $PORT`.
  - Cargá las variables de entorno anteriores; para las credenciales de GEE usá `GEE_CREDENTIALS_JSON` o un *secret file*.
- **Frontend (Vercel):** sitio estático con `index.html`, `css/` y `js/`.
- **Rol administrador:** se lee de `app_metadata` (no editable por el usuario). Para asignarlo:

---

## API

| Método | Endpoint | Acceso |
|---|---|---|
| GET | `/api/aptitud-suelos` | público |
| GET | `/api/censo-quebracho` | público |
| GET | `/api/v1/poligonos/{id}/reporte-pdf` | público |
| POST | `/api/admin/run-etl` | administrador |
| GET | `/api/admin/etl-status` | administrador |
| GET / PUT | `/api/admin/parametros-edaficos` | administrador |
| GET | `/api/admin/parametros-edaficos/excel` | administrador |

---

## Fuentes de datos

- **Carta de suelos:** INTA (proc_suelos_chaco).
- **Datos satelitales:** NDVI Sentinel-2, precipitación y cobertura MapBiomas Chaco, procesados en Google Earth Engine a 30 m.
- **OTBN:** Ordenamiento Territorial de Bosques Nativos de la provincia del Chaco (Ley N.° 26.331).
- **Validación:** Segundo Inventario Nacional de Bosques Nativos, con 374 registros de *S. balansae*.

---

## Licencia y uso

Trabajo académico desarrollado como Proyecto Final de Carrera en la FaCENA – UNNE. La herramienta asiste a técnicos y tomadores de decisiones y **no reemplaza el juicio experto** ni la evaluación de campo.