import os
import sys
import geopandas as gpd
import numpy as np
import pandas as pd
import rasterio
from rasterio.mask import mask
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


# Abre el archivo ráster local de la OTBN (`assets/capa_otbn.tif`) de forma eficiente mediante `rasterio`.
def aplicar_mascara_otbn(suelos_gdf, ruta_otbn, on_avance=None):
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

    with rasterio.open(ruta_otbn) as raster:
        suelos_raster_crs = suelos_gdf.to_crs(raster.crs)

        pct_rojo, pct_amarillo, pct_verde = [], [], []
        total = len(suelos_raster_crs)

        for i, geometria in enumerate(suelos_raster_crs.geometry, start=1):
            if on_avance and (i % 10 == 0 or i == total):
                on_avance(i, total)
            try:
                # all_touched=True asegura capturar bordes de píxeles en micro-parcelas
                valores, _ = mask(raster, [mapping(geometria)], crop=True, filled=False, all_touched=True)
                
                # .filled(0) absorbe los huecos "Sin Datos" y los vuelve 0 (Zonas libres)
                valores_validos = valores.filled(0).flatten()
                
                if valores_validos.size > 0:
                    total_pixeles = valores_validos.size
                    
                    # 1=Rojo, 2=Amarillo, 3=Verde
                    rojo = np.sum(valores_validos == 1) / total_pixeles * 100
                    amarillo = np.sum(valores_validos == 2) / total_pixeles * 100
                    verde = np.sum(valores_validos == 3) / total_pixeles * 100
                    
                    pct_rojo.append(round(rojo, 2))
                    pct_amarillo.append(round(amarillo, 2))
                    pct_verde.append(round(verde, 2))
                else:
                    pct_rojo.append(0.0)
                    pct_amarillo.append(0.0)
                    pct_verde.append(0.0)
                    
            except ValueError:
                pct_rojo.append(0.0)
                pct_amarillo.append(0.0)
                pct_verde.append(0.0)

    suelos_gdf = suelos_gdf.copy()
    suelos_gdf['pct_rojo'] = pct_rojo
    suelos_gdf['pct_amarillo'] = pct_amarillo
    suelos_gdf['pct_verde'] = pct_verde
    
    return suelos_gdf

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

    # ETAPA 2: Ejecuta la máscara de la OTBN sobre los polígonos importados.
    reportar(2, "Aplicando cruce espacial local con la capa legal de la OTBN")
    ruta_otbn = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'assets', 'cat_otbn2.0.tif')
    suelos_gdf = aplicar_mascara_otbn(
        suelos_gdf,
        ruta_otbn,
        on_avance=lambda i, n: reportar(2, f"Cruce OTBN: polígono {i} de {n}", i / n),
    )

    print("Muestra de los porcentajes de OTBN extraídos:")
    print(suelos_gdf[['pct_rojo', 'pct_amarillo', 'pct_verde']].head())

    # ETAPA 3: Envía el GeoDataFrame a Google Earth Engine (NDVI, precipitación y MapBiomas).
    reportar(3, "Solicitando cómputo espacial a Google Earth Engine (puede tardar)")
    suelos_enriquecidos = gee.enriquecer_gdf(suelos_gdf)

    # ETAPA 4: Instancia el pipeline integrador y calcula la aptitud final del territorio.
    reportar(4, "Computando modelo matemático de aptitud y categorización territorial")
    pipeline = ReforestationPipeline()
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