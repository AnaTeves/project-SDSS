# Sistema de Soporte de Decisiones Geoespaciales

Este repositorio contiene el motor analitico de datos geoespaciales desarrollado para el Proyecto Final de Carrera de la Licenciatura en Sistemas de Informacion. El sistema evalua la aptitud biofisica y viabilidad legal del territorio de la provincia del Chaco mediante un enfoque hibrido que integra bases de datos espaciales, analisis de teledeteccion en la nube y modelos matematicos de toma de decisiones.

---

## Tecnologias utilizadas
*   **Lenguaje:** Python 3.10
*   **Computación en la Nube:** Google Earth Engine API (`ee`)
*   **Análisis Geoespacial Local:** GeoPandas, Rasterio, Shapely
*   **Ingeniería de Datos:** NumPy, Pandas, SQLAlchemy
*   **Base de Datos:** PostgreSQL + PostGIS

---

## Arquitectura de software y componentes

### Conector de Google Earth Engine (gee_connector.py)
Clase orientada a objetos diseñada para interactuar con la API de **Google Earth Engine** utilizando una cuenta de servicio. Su objetivo principal es procesar analisis geoespaciales pesados directamente en la nube.
*   **Autenticación (`_autenticar`)**: Automatiza la conexión segura con los servidores de GEE utilizando el archivo de credenciales de la cuenta de servicio (`config/credentials.json`) y el ID del proyecto de la tesis.
*   **Carga de Capas (`obtener_capas_ambientales`)**: Conecta de forma remota con los *Assets* privados almacenados en GEE a una resolución espacial de 30 metros:
    *   `NDVI_Historico_30m`: Índice de vegetación de diferencia normalizada histórico.
    *   `Precipitacion_Anual_30m`: Datos acumulados de lluvia.
    *   `Uso_Suelo_Actual_30m`: Capa de clasificación de cobertura y uso del suelo.
*   **Procesamiento en la Nube (`enriquecer_gdf`)**: 
    1. Recibe un conjunto de polígonos locales (en formato GeoDataFrame).
    2. Los transforma dinámicamente a formato GeoJSON y los envía a los clústeres de cómputo de Google.
    3. Ejecuta un reductor espacial espacial (`ee.Reducer.mean()`) para calcular el promedio de los valores de NDVI, lluvia y uso de suelo que caen dentro de cada polígono.
    4. Devuelve los datos enriquecidos e integrados directamente en las columnas originales del GeoDataFrame local (`val_ndvi`, `val_lluvia`, `val_uso_suelo`).


### Conector de Base de Datos (db_connector.py)
Clase orientada a objetos encargada de centralizar la conexión y las operaciones de lectura/escritura de datos espaciales entre el script y una base de datos **PostgreSQL / PostGIS**.

*   **Gestión de Conexión (`__init__`)**: Inicializa el motor de base de datos (`create_engine`) utilizando variables de entorno (`DATABASE_URL`). Cuenta con un *fallback* configurado por defecto para entornos de desarrollo local en `localhost:5432`.
*   **Lectura Espacial (`cargar_capa_postgis`)**: Ejecuta consultas SQL personalizadas directamente en la base de datos y transforma los registros vectoriales en un objeto GeoDataFrame local, identificando de manera explícita la columna de geometría (`geom`).
*   **Persistencia de Resultados (`guardar_resultado`)**: Exporta y guarda GeoDataFrames procesados de vuelta en la base de datos PostGIS. Está configurado para reemplazar la tabla si ya existe (`if_exists='replace'`), asegurando la actualización limpia de las nuevas categorías espaciales calculadas.


### Motor Analítico de Decisión Multicriterio (mcda_engine.py)
Clase algorítmica encargada de la lógica matemática del modelo edáfico. Implementa una evaluación multicriterio (**MCDA**) basada en el Proceso de Jerarquía Analítica (**AHP**) para ponderar y clasificar la aptitud de las variables del suelo.

*   **Definición de Pesos AHP (`__init__`)**: Establece los pesos oficiales validados metodológicamente para las variables críticas del suelo:
    *   `text_sups1` *(Textura superficial)*: **35%** del peso total.
    *   `sgrup_sue1` *(Subgrupo de suelo)*: **25%** del peso total.
    *   `drenaje_s1` *(Drenaje)*: **25%** del peso total.
    *   `alcalin_s1` *(Alcalinidad/Salinidad)*: **15%** del peso total.
*   **Carga Dinámica de Parámetros (`_cargar_parametros_excel`)**: Lee una matriz de puntuación externa desde un archivo Excel (`assets/edaphic-model-parameters-v2.xlsx`). Realiza un proceso de normalización e indexación estricta de cadenas de texto (limpieza de espacios y conversión a minúsculas) para generar diccionarios de mapeo rápidos y evitar errores por diferencias de tipeo.
*   **Cálculo Vectorial de Aptitud (`calcular_puntaje_suelo`)**: 
    1. Recibe un DataFrame con las propiedades de los suelos.
    2. Aplica un **principio de precaución estricto**: estandariza los valores nulos o desconocidos y penaliza automáticamente con un puntaje de `0.0` si algún atributo no se encuentra clasificado en el Excel.
    3. Multiplica vectorialmente cada atributo por su peso correspondiente y acumula el total.
    4. Aplica una función de corte (`.clip(0, 1)`) para asegurar que el índice final de aptitud edáfica resultante esté estrictamente acotado en una escala continua entre **0.0 y 1.0**.


### Normalizador Ambiental (raster_normalizer.py)
Clase algorítmica encargada de la estandarización y transformación de variables biofísicas continuas y categóricas. Traduce magnitudes físicas reales (como milímetros de lluvia o índices de reflectancia) en valores adimensionales de aptitud biológica.

*   **Normalización Ecológica de NDVI (`normalizar_ndvi`)**: Implementa una función de transformación lineal para el Índice de Vegetación de Diferencia Normalizada. Mapea los valores entre un rango configurable (por defecto **0.10 y 0.80**) y acota el resultado estrictamente entre **0.0 y 1.0**.
*   **Fuzzificación Trapezoidal de Lluvia (`normalizar_lluvia`)**: Aplica lógica borrosa para evaluar la precipitación anual. Utiliza cuatro umbrales ecológicos configurables (**400, 900, 1500 y 2500 mm**) para modelar un comportamiento trapezoidal:
    *   **Puntaje 0.0**: Regiones con estrés hídrico extremo por defecto de lluvia (<400 mm) o exceso destructivo (>2500 mm).
    *   **Puntaje 1.0 (Óptimo)**: Zonas con el rango de precipitación ideal para el ecosistema (entre 900 y 1500 mm).
    *   **Rampas de transición**: Penalizaciones o mejoras lineales en los rangos de sub-óptimos (400-900 mm y 1500-2500 mm).
*   **Máscara de Restricciones Territoriales (`generar_mascara_restricciones`)**: Evalúa de manera vectorial la capa de uso de suelo actual. Genera una máscara booleana que detecta clases nulas oID de coberturas excluidas del análisis de aptitud (por ejemplo: cuerpos de agua, zonas urbanas, infraestructuras, etc.), sirviendo como filtro restrictivo para el modelo.


### Calculador de Pesos Globales AHP (ahp_calculator.py)
Clase matemática encargada de calibrar y validar las prioridades macro del modelo jerárquico. Utiliza álgebra lineal para procesar matrices de comparación por pares y extraer pesos ponderados con validación estadística de consistencia.

*   **Matriz de Decisiones (`__init__`)**: Define las relaciones de importancia relativa entre las dimensiones del modelo de aptitud. Está calibrada matemáticamente para otorgar prioridad simétrica a la base edáfica y climática:
    *   *Suelo vs. Lluvia*: Igual importancia (1.0).
    *   *Suelo vs. NDVI*: Doble importancia para el suelo (2.0).
    *   *Lluvia vs. NDVI*: Doble importancia para la lluvia (2.0).
*   **Extracción por Vector Propio (`calcular_pesos`)**: 
    1. Calcula el máximo autovalor ($\lambda_{max}$) y su autovector asociado mediante descomposición matricial de `numpy`.
    2. Normaliza el vector principal para obtener los pesos finales exactos del modelo global: **Suelo (40%)**, **Lluvia (40%)**, y **NDVI (20%)**.
*   **Control Estadístico de Consistencia**: Automatiza el cálculo de la Razón de Consistencia ($CR = CI / RI$). Utiliza el Índice de Aleatoriedad estándar para matrices de $3 \times 3$ ($RI = 0.58$) y detiene el proceso de forma segura (`ValueError`) si la matriz supera el umbral crítico de Saaty ($CR \ge 0.10$), garantizando la validez lógica de las ponderaciones de la tesis.


### Pipeline Central de Integración Multicriterio (reforestation_pipeline.py)
Clase controladora (`ReforestationPipeline`) que actúa como el motor integrador y coordinador del sistema. Ejecuta secuencialmente la Combinación Lineal Ponderada (**MCDA**), cruza las limitantes biofísicas con las restricciones legales y clasifica el territorio para la toma de decisiones ecológicas.

*   **Inicialización Optimizada (`__init__`)**: Pre-carga en memoria las instancias del calculador AHP, el motor edáfico y el normalizador ambiental, reduciendo la sobrecarga de procesamiento en conjuntos de datos masivos.
*   **Cálculo e Integración Biofísica**: 
    1. Intenta extraer dinámicamente los pesos jerárquicos desde `AHPCalculator`. Cuenta con una política de respaldo tolerante a fallos (`PESOS_AHP_BASE`) para asegurar la continuidad del pipeline si la matriz fallara.
    2. Ejecuta en paralelo el cálculo de las sub-aptitudes: edáfica (MCDA), vegetativa (NDVI lineal) e hídrica (Fuzzy trapezoidal).
    3. Resuelve la **Combinación Lineal Ponderada** combinando los pesos ponderados AHP con las puntuaciones individuales de cada celda/polígono.
*   **Evaluación Legal y Restricciones del Territorio**:
    *   *Uso de suelo*: Filtra zonas mediante la máscara restrictiva del normalizador ambiental (MapBiomas).
    *   *Gobernanza legal (OTBN)*: Realiza un análisis robusto sobre la capa ráster del Ordenamiento Territorial de Bosques Nativos. Gestiona de forma estricta los nulos provenientes de la base de datos de PostGIS, asumiendo una restricción total (valor 0) bajo el criterio de precaución jurídica.
*   **Matriz de Clasificación de Tres Niveles**: Categoriza eficientemente los polígonos del territorio evaluando si superan el **umbral científico de aptitud ($\ge 0.60$)** y el filtro mínimo de sustrato edáfico ($>0.10$):
    1. `Apto para reforestar y legal`: Supera los umbrales biofísicos y está completamente permitido por la ley y el uso del suelo.
    2. `Apto pero ilegal`: Posee un alto potencial ecológico, pero su reforestación está restringida por la normativa vigente (OTBN) o coberturas incompatibles.
    3. `No apto`: El territorio no cumple con las condiciones edafoclimáticas mínimas requeridas.
*   **Kill Switch Definitivo (`aptitud_final`)**: Aplica un filtro de corte de seguridad absoluto. Si un polígono es clasificado como inapto o ilegal, su puntaje final de aptitud es forzado directamente a `0.00`, garantizando que las métricas finales solo reflejen zonas de viabilidad ambiental e institucional absoluta.


### Orquestador Principal del Sistema (main.py)
Script ejecutor central del proyecto. Configura el entorno, coordina la comunicación entre las APIs en la nube y las bases de datos locales, y ejecuta el procesamiento híbrido (Ráster/Vectorial) necesario para alimentar el pipeline de decisión.

*   **Análisis Matricial Local (`aplicar_mascara_otbn`)**: 
    1. Abre el archivo ráster local de la OTBN (`assets/capa_otbn.tif`) de forma eficiente mediante `rasterio`.
    2. Reproyecta dinámicamente el GeoDataFrame local al Sistema de Referencia de Coordenadas (CRS) del ráster.
    3. Realiza un recorte espacial (*masking*) para cada polígono de suelo usando `shapely.geometry.mapping`.
    4. Evalúa matricialmente mediante `numpy` la proporción de celdas válidas internas que cumplen con la normativa (valor 1). Con un umbral configurado de forma estricta al **100% (`umbral_permitido=1.0`)**, determina si el polígono está legalmente habilitado.
    5. Aplica un principio de precaución riguroso: cualquier error de geometría, falta de datos o polígono fuera de los límites del ráster es penalizado y restringido automáticamente con `0`.
*   **Flujo General de Ejecución (`ejecutar_pipeline`)**:
    1.  **Ingesta de Datos**: Conecta con PostGIS e importa los registros vectoriales de la tabla `"proc_suelos_chaco"`.
    2.  **Filtro Legal Local**: Ejecuta la máscara de la OTBN sobre los polígonos importados y audita la distribución de resultados.
    3.  **Cómputo Remoto**: Envía el GeoDataFrame a los clústeres de Google Earth Engine para enriquecerlo con las variables de NDVI, precipitación y coberturas de MapBiomas.
    4.  **Modelación Multicriterio**: Instancia el pipeline integrador, cargando una única vez en memoria la matriz de parámetros de Excel, y calcula la aptitud final del territorio.
    5.  **Persistencia**: Exporta el GeoDataFrame final consolidado de vuelta a PostGIS en la tabla `'mapa_aptitud_final'`.


### API de Servicios Geoespaciales (server.py)
Módulo backend desarrollado con **FastAPI** encargado de exponer los resultados del modelo de aptitud forestal a través de endpoints web REST. Funciona como la capa de servicio que conecta la base de datos con cualquier visualizador web interactivo (Frontend).

*   **Configuración de CORS**: Implementa *FastAPI Middleware* para habilitar el Intercambio de Recursos de Origen Cruzado (`CORSMiddleware`) sin restricciones de puertos. Esto permite que mapas desarrollados de forma local (en React, Vue, OpenLayers o Leaflet) consuman la API sin bloqueos de seguridad del navegador.
*   **Reproyección Dinámica a GeoJSON (`ST_AsGeoJSON`)**: Ejecuta consultasSQL directamente en PostGIS transformando de forma eficiente las geometrías complejas de la base de datos al estándar web global **EPSG:4326** mediante la función `ST_Transform`.
*   **Serialización Segura (`safe_float`)**: Cuenta con una función protectora que captura valores nulos o tipos de datos corruptos provenientes de la base de datos. Redondea automáticamente las métricas físicas y matemáticas a dos decimales, garantizando un payload JSON liviano y un parseo sin errores en el navegador.
*   **Endpoint de Consulta (`/api/aptitud-suelos`)**: Formatea y consolida los 429 polígonos del territorio evaluado bajo la estructura estándar de una `FeatureCollection` geoespacial, inyectando todas las sub-aptitudes calculadas, variables edáficas primarias y el dictamen legal (OTBN) dentro del bloque de `properties` de cada elemento.

---

## Instalacion y configuracion

---

## Modo de uso