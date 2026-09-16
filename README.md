# Sistema de Soporte de Decisiones Geoespaciales (SDSS) - Reforestación Chaco

Proyecto Final de Carrera — Licenciatura en Sistemas de Información (FACENA - UNNE)
Autora: Ana Luz Teves Tessaro | Profesor Orientador: Lic. Darío Oscar Villegas

Sistema de soporte de decisiones geoespaciales basado en una arquitectura híbrida (Cloud-Local) para evaluar la aptitud biofísica y la viabilidad legal (OTBN) en la reforestación del Quebracho Colorado (Schinopsis balansae) en la Provincia del Chaco, Argentina.

---

## Tecnologias utilizadas
*   **Backend / API REST:** Python 3.10, FastAPI, Uvicorn
*   **Computación en la Nube:** Google Earth Engine API (`ee`)
*   **Análisis Geoespacial Local:** GeoPandas, Rasterio, Shapely
*   **Ingeniería de Datos:** NumPy, Pandas, SQLAlchemy
*   **Base de Datos:** PostgreSQL + PostGIS
*   **FrontEnd:** Leaflet.js, HTML5/JS

---

## Arquitectura y modulos
*   **gee_connector.py:** Autentica la conexión con los clústeres de Google Earth Engine y ejecuta reductores espaciales (ee.Reducer.mean()) para extraer NDVI, precipitación y uso del suelo.
*   **db_connector.py:** Gestiona la conexión y persistencia relacional espacial en PostGIS mediante SQLAlchemy.
*   **mcda_engine.py:** Implementa la evaluación multicriterio edáfica basada en Proceso de Jerarquía Analítica (AHP) leyendo parámetros desde assets/edaphic-model-parameters-v2.xlsx.
*   **raster_normalizer.py:** Normaliza variables físicas continuas a valores adimensionales mediante funciones de corte (NDVI), lógica borrosa trapezoidal (lluvia) y máscaras de restricción.
*   **ahp_calculator.py:** Calcula algebraicamente los autovectores y pesos macro del modelo, validando que la Razón de Consistencia cumpla con el criterio $CR < 0.10$.
*   **reforestation_pipeline.py:** Consolida la combinación lineal ponderada (MCDA), aplica las restricciones legales del Ordenamiento Territorial de Bosques Nativos (OTBN) y categoriza el territorio en tres niveles de aptitud.
*   **main.py:** Orquestador principal del pipeline que ejecuta la extracción espacial local del ráster OTBN y sincroniza las operaciones híbridas.
*   **server.py:** Servicio backend construido en FastAPI que expone las geometrías en estándar GeoJSON mediante ST_AsGeoJSON de PostGIS e integra soporte CORS.

---

## Instalacion y configuracion