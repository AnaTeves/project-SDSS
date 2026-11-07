import os
import sys
import geopandas as gpd
import numpy as np
import pandas as pd
import rasterio
from sqlalchemy import inspect
from rasterio.errors import WindowError
from rasterio.features import geometry_mask, geometry_window
from rasterio.windows import Window
from shapely.geometry import mapping
from src.db_connector import DBConnector
from src.gee_connector import GEEConnector
from src.reforestacion_pipeline import ReforestationPipeline
import time
import io
import asyncio
import httpx
from fastapi import FastAPI, Response, HTTPException
from fpdf import FPDF

"""
Script ejecutor central del proyecto.
Configura el entorno, coordina la comunicación entre las APIs en la nube y las bases de datos locales, y ejecuta el procesamiento híbrido (Ráster/Vectorial) necesario para alimentar el pipeline de decisión.
"""

# Etapas del pipeline. El servidor las expone al frontend para dibujar el modal de progreso.
ETAPAS_PIPELINE = [
    "Conexión con PostGIS y Google Earth Engine",
    "Carga de polígonos de suelo (PostGIS)",
    "Cruce espacial con la capa legal OTBN",
    "Enriquecimiento satelital (NDVI, lluvia, MapBiomas)",
    "Modelo MCDA de aptitud y clasificación",
    "Exportación de resultados a la base de datos",
]


def _reporte_consola(etapa, mensaje, subprogreso=None):
    """Reporte por defecto cuando el pipeline se ejecuta desde la terminal."""
    if subprogreso is None:
        print(f"[{etapa + 1}/{len(ETAPAS_PIPELINE)}] {mensaje}")


# Filas del ráster que se leen por bloque. Limita la memoria usada por polígono
# (necesario en servidores con poca RAM, como el plan gratuito de Render).
FILAS_POR_BLOQUE = 512


def _verificar_raster_otbn(ruta_otbn):
    if not os.path.exists(ruta_otbn):
        raise FileNotFoundError(f"No se encontró el ráster de la OTBN en: {ruta_otbn}")
    # Si el .tif llegó como puntero de Git LFS (archivo de texto de ~130 bytes) en lugar del ráster real
    if os.path.getsize(ruta_otbn) < 1024:
        with open(ruta_otbn, 'rb') as f:
            if f.read(64).startswith(b'version https://git-lfs'):
                raise RuntimeError(
                    "El ráster OTBN es un puntero de Git LFS, no el archivo real. "
                    "El servidor no descargó los archivos LFS al desplegar."
                )


def _porcentajes_otbn(raster, geometria):
    """
    Calcula el % de píxeles rojo (1), amarillo (2) y verde (3) de un polígono.
    Equivale a rasterio.mask(crop=True, filled=False, all_touched=True) seguido de .filled(0):
    el denominador es la ventana rectangular que cubre al polígono, y los píxeles fuera del
    polígono o sin dato cuentan como 0 (zona libre). La diferencia es que la ventana se lee
    por bloques de filas, de modo que la memoria no depende del tamaño del polígono.
    """
    formas = [mapping(geometria)]
    try:
        ventana = geometry_window(raster, formas)
    except WindowError:
        raise ValueError("El polígono no se superpone con el ráster OTBN.")

    col0, fila0 = int(ventana.col_off), int(ventana.row_off)
    alto, ancho = int(ventana.height), int(ventana.width)
    total_pixeles = alto * ancho
    if total_pixeles <= 0:
        return 0.0, 0.0, 0.0

    conteos = {1: 0, 2: 0, 3: 0}
    for desde in range(0, alto, FILAS_POR_BLOQUE):
        filas = min(FILAS_POR_BLOQUE, alto - desde)
        bloque = Window(col0, fila0 + desde, ancho, filas)
        datos = raster.read(1, window=bloque, masked=True)  # enmascara los píxeles sin dato
        fuera = geometry_mask(formas, out_shape=(filas, ancho),
                              transform=raster.window_transform(bloque), all_touched=True)
        valores = datos.data[~(fuera | np.ma.getmaskarray(datos))]
        for clase in conteos:
            conteos[clase] += int(np.count_nonzero(valores == clase))
        del datos, fuera, valores

    return tuple(round(conteos[c] / total_pixeles * 100, 2) for c in (1, 2, 3))


# Cruza cada polígono de suelo con el ráster local de la OTBN mediante `rasterio`.
def aplicar_mascara_otbn(suelos_gdf, ruta_otbn, on_avance=None):
    _verificar_raster_otbn(ruta_otbn)

    with rasterio.open(ruta_otbn) as raster:
        suelos_raster_crs = suelos_gdf.to_crs(raster.crs)

        pct_rojo, pct_amarillo, pct_verde = [], [], []
        total = len(suelos_raster_crs)

        for i, geometria in enumerate(suelos_raster_crs.geometry, start=1):
            try:
                rojo, amarillo, verde = _porcentajes_otbn(raster, geometria)
            except ValueError:
                rojo, amarillo, verde = 0.0, 0.0, 0.0
            pct_rojo.append(rojo)
            pct_amarillo.append(amarillo)
            pct_verde.append(verde)

            if on_avance and (i % 5 == 0 or i == total):
                on_avance(i, total)

    suelos_gdf = suelos_gdf.copy()
    suelos_gdf['pct_rojo'] = pct_rojo
    suelos_gdf['pct_amarillo'] = pct_amarillo
    suelos_gdf['pct_verde'] = pct_verde

    return suelos_gdf

RAIZ_PROYECTO = os.path.dirname(os.path.abspath(__file__))
RUTA_OTBN = os.path.join(RAIZ_PROYECTO, 'assets', 'cat_otbn2.0.tif')
TABLA_OTBN = 'otbn_porcentajes'
COLUMNAS_OTBN = ['pct_rojo', 'pct_amarillo', 'pct_verde']


def guardar_porcentajes_otbn(db, suelos_gdf):
    """Persiste en PostGIS los porcentajes OTBN por polígono (tabla no espacial)."""
    tabla = pd.DataFrame(suelos_gdf[['id'] + COLUMNAS_OTBN])
    tabla['calculado_en'] = pd.Timestamp.now(tz='America/Argentina/Buenos_Aires')
    tabla['raster_origen'] = os.path.basename(RUTA_OTBN)
    tabla.to_sql(TABLA_OTBN, con=db.engine, if_exists='replace', index=False)


def obtener_porcentajes_otbn(db, suelos_gdf, reportar):
    """
    Etapa 3 del pipeline. Por defecto lee los porcentajes precalculados de la tabla `otbn_porcentajes`
    (generada por precalcular_otbn.py), ya que la OTBN y la carta de suelos cambian rara vez y el
    cruce con el ráster de 276 MB excede la memoria del servidor gratuito.
    Con la variable de entorno OTBN_MODO=raster se recalcula con el ráster en esta misma ejecución.
    """
    modo = os.getenv('OTBN_MODO', 'precalculado').strip().lower()

    if modo != 'raster':
        reportar(2, f"Leyendo porcentajes OTBN precalculados (tabla {TABLA_OTBN})")
        if not inspect(db.engine).has_table(TABLA_OTBN):
            raise RuntimeError(
                f"No existe la tabla '{TABLA_OTBN}'. Ejecuta 'python precalcular_otbn.py' en tu equipo "
                "(con el ráster OTBN) o define OTBN_MODO=raster para calcularlos aquí."
            )
        otbn = pd.read_sql(f'SELECT id, {", ".join(COLUMNAS_OTBN)} FROM "{TABLA_OTBN}"', con=db.engine)
        faltantes = set(suelos_gdf['id']) - set(otbn['id'])
        if faltantes:
            raise RuntimeError(
                f"La tabla '{TABLA_OTBN}' no tiene datos para {len(faltantes)} polígonos de suelo "
                "(¿cambió proc_suelos_chaco?). Vuelve a ejecutar 'python precalcular_otbn.py'."
            )
        suelos_gdf = suelos_gdf.drop(columns=[c for c in COLUMNAS_OTBN if c in suelos_gdf.columns])
        suelos_gdf = suelos_gdf.merge(otbn, on='id', how='left')
        reportar(2, f"Porcentajes OTBN asignados a {len(suelos_gdf)} polígonos", 1.0)
        return suelos_gdf

    reportar(2, "Aplicando cruce espacial local con la capa legal de la OTBN")
    return aplicar_mascara_otbn(
        suelos_gdf,
        RUTA_OTBN,
        on_avance=lambda i, n: reportar(2, f"Cruce OTBN: polígono {i} de {n}", i / n),
    )


def ejecutar_pipeline(reportar=None):
    """
    Ejecuta el pipeline completo.
    `reportar(etapa, mensaje, subprogreso=None)` es un callback opcional que recibe el índice
    de la etapa actual (0..len(ETAPAS_PIPELINE)-1), un mensaje descriptivo y, cuando aplica,
    el avance interno de la etapa (0.0 a 1.0). Lo usa el servidor para alimentar el modal web.
    """
    reportar = reportar or _reporte_consola
    tiempo_inicio = time.perf_counter()

    # ETAPA 0: conexiones
    reportar(0, "Conectando con PostGIS y autenticando en Google Earth Engine")
    db = DBConnector()
    gee = GEEConnector(key_file='config/credentials.json', project_id='tesis-492901')

    # ETAPA 1: Conecta con PostGIS e importa los registros vectoriales de la tabla `"proc_suelos_chaco"`.
    reportar(1, "Leyendo capas vectoriales desde PostgreSQL/PostGIS")
    query_suelos = """
        SELECT id, geom, sgrup_sue1, text_sups1, drenaje_s1, alcalin_s1
        FROM "proc_suelos_chaco";
    """
    suelos_gdf = db.cargar_capa_postgis(query_suelos, geom_col='geom')
    reportar(1, f"{len(suelos_gdf)} polígonos de suelo cargados exitosamente", 1.0)

    # ETAPA 2: Porcentajes de la OTBN por polígono (precalculados en PostGIS o calculados con el ráster).
    suelos_gdf = obtener_porcentajes_otbn(db, suelos_gdf, reportar)

    print("Muestra de los porcentajes de OTBN extraídos:")
    print(suelos_gdf[['pct_rojo', 'pct_amarillo', 'pct_verde']].head())

    # ETAPA 3: Envía el GeoDataFrame a Google Earth Engine (NDVI, precipitación y MapBiomas).
    reportar(3, "Solicitando cómputo espacial a Google Earth Engine (puede tardar)")
    suelos_enriquecidos = gee.enriquecer_gdf(suelos_gdf)

    # ETAPA 4: Instancia el pipeline integrador y calcula la aptitud final del territorio.
    reportar(4, "Computando modelo matemático de aptitud y categorización territorial")
    pipeline = ReforestationPipeline(engine=db.engine)
    reportar(4, f"Puntajes edáficos leídos desde {pipeline.motor_suelo.fuente_parametros}")
    resultado_final = pipeline.calcular_aptitud_y_reforestacion(suelos_enriquecidos)

    # ETAPA 5: Exporta el GeoDataFrame final consolidado de vuelta a PostGIS.
    reportar(5, "Exportando resultados a la tabla mapa_aptitud_finalv2")
    db.guardar_resultado(resultado_final, nombre_tabla='mapa_aptitud_finalv2')

    tiempo_total = time.perf_counter() - tiempo_inicio
    print("PIPELINE FINALIZADO")
    print(f"MÉTRICA DE RENDIMIENTO: Tiempo total de procesamiento: {tiempo_total:.2f} segundos.")
    return {"poligonos": int(len(resultado_final)), "duracion_seg": round(tiempo_total, 2)}

if __name__ == '__main__':
    ejecutar_pipeline()