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

# Abre el archivo ráster local de la OTBN (`assets/capa_otbn.tif`) de forma eficiente mediante `rasterio`.
def aplicar_mascara_otbn(suelos_gdf, ruta_otbn):
    if not os.path.exists(ruta_otbn):
        raise FileNotFoundError(f"No se encontró el ráster de la OTBN en: {ruta_otbn}")

    with rasterio.open(ruta_otbn) as raster:
        suelos_raster_crs = suelos_gdf.to_crs(raster.crs)
        
        pct_rojo, pct_amarillo, pct_verde = [], [], []

        for geometria in suelos_raster_crs.geometry:
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

def ejecutar_pipeline():
    tiempo_inicio = time.perf_counter()
    db = DBConnector()
    gee = GEEConnector(key_file='config/credentials.json', project_id='tesis-492901')

    # Conecta con PostGIS e importa los registros vectoriales de la tabla `"proc_suelos_chaco"`.
    print("Leyendo capas vectoriales desde PostgreSQL/PostGIS")
    query_suelos = """
        SELECT id, geom, sgrup_sue1, text_sups1, drenaje_s1, alcalin_s1
        FROM "proc_suelos_chaco";
    """
    suelos_gdf = db.cargar_capa_postgis(query_suelos, geom_col='geom')
    print(f"{len(suelos_gdf)} polígonos de suelo cargados exitosamente.")

    # Ejecuta la máscara de la OTBN sobre los polígonos importados y audita la distribución de resultados.
    print("Aplicando cruce espacial local con la capa legal de la OTBN")
    ruta_otbn = os.path.join('assets', 'cat_otbn2.0.tif')
    suelos_gdf = aplicar_mascara_otbn(suelos_gdf, ruta_otbn)

    print("Muestra de los porcentajes de OTBN extraídos:")
    print(suelos_gdf[['pct_rojo', 'pct_amarillo', 'pct_verde']].head())

    # Envía el GeoDataFrame a los clústeres de Google Earth Engine para enriquecerlo con las variables de NDVI, precipitación y coberturas de MapBiomas.
    suelos_enriquecidos = gee.enriquecer_gdf(suelos_gdf)

    # Instancia el pipeline integrador, cargando una única vez en memoria la matriz de parámetros de Excel, y calcula la aptitud final del territorio.
    print("Computando modelo matemático de aptitud y categorización territorial")
    pipeline = ReforestationPipeline()
    resultado_final = pipeline.calcular_aptitud_y_reforestacion(suelos_enriquecidos)

    # Exporta el GeoDataFrame final consolidado de vuelta a PostGIS en la tabla `'mapa_aptitud_final'`.
    print("Exportando resultados a la base de datos")
    db.guardar_resultado(resultado_final, nombre_tabla='mapa_aptitud_finalv2')
    tiempo_fin = time.perf_counter()
    tiempo_total = tiempo_fin - tiempo_inicio
    print("PIPELINE FINALIZADO")
    print(f"MÉTRICA DE RENDIMIENTO: Tiempo total de procesamiento: {tiempo_total:.2f} segundos.")

if __name__ == '__main__':
    ejecutar_pipeline()