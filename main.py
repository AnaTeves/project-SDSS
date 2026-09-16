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

"""
Script ejecutor central del proyecto.
Configura el entorno, coordina la comunicación entre las APIs en la nube y las bases de datos locales, y ejecuta el procesamiento híbrido (Ráster/Vectorial) necesario para alimentar el pipeline de decisión.
"""

# Abre el archivo ráster local de la OTBN (`assets/capa_otbn.tif`) de forma eficiente mediante `rasterio`.
def aplicar_mascara_otbn(suelos_gdf, ruta_otbn, umbral_permitido=0.85):

    if not os.path.exists(ruta_otbn):
        raise FileNotFoundError(f"No se encontró el ráster de la OTBN en la ruta especificada: {ruta_otbn}")

    # Reproyecta dinámicamente el GeoDataFrame local al Sistema de Referencia de Coordenadas (CRS) del ráster.
    with rasterio.open(ruta_otbn) as raster:
        suelos_raster_crs = suelos_gdf.to_crs(raster.crs)
        mascara = []

        for geometria in suelos_raster_crs.geometry:
            try:
                valores, _ = mask(
                    raster,
                    [mapping(geometria)],
                    crop=True,
                    filled=False,
                    all_touched=False
                )
                valores_validos = valores.compressed()
                
                if valores_validos.size > 0:
                    proporcion_permitida = np.mean(valores_validos == 1)
                    mascara.append(1 if proporcion_permitida >= umbral_permitido else 0)
                else:
                    mascara.append(0) # si no hay datos se restringe con 0
            except ValueError:
                mascara.append(0) # fuera de los limites se restringe 0 por precaucion

    suelos_gdf = suelos_gdf.copy()
    suelos_gdf['val_otbn'] = pd.Series(mascara, index=suelos_gdf.index).fillna(0).astype(int)
    return suelos_gdf


def ejecutar_pipeline():
    db = DBConnector()
    gee = GEEConnector(key_file='config/credentials.json', project_id='tesis-492901')

    # Conecta con PostGIS e importa los registros vectoriales de la tabla `"proc_suelos_chaco"`.
    print(">> Leyendo capas vectoriales desde PostgreSQL/PostGIS...")
    query_suelos = """
        SELECT id, geom, sgrup_sue1, text_sups1, drenaje_s1, alcalin_s1
        FROM "proc_suelos_chaco";
    """
    suelos_gdf = db.cargar_capa_postgis(query_suelos, geom_col='geom')
    print(f"{len(suelos_gdf)} polígonos de suelo cargados exitosamente.")

    # Ejecuta la máscara de la OTBN sobre los polígonos importados y audita la distribución de resultados.
    print("Aplicando cruce espacial local con la capa legal de la OTBN")
    ruta_otbn = os.path.join('assets', 'capa_otbn.tif')
    suelos_gdf = aplicar_mascara_otbn(suelos_gdf, ruta_otbn, umbral_permitido=1.0)

    print("Distribución de la columna 'val_otbn' (1=Permitido, 0=Restringido):")
    print(suelos_gdf['val_otbn'].value_counts())

    # Envía el GeoDataFrame a los clústeres de Google Earth Engine para enriquecerlo con las variables de NDVI, precipitación y coberturas de MapBiomas.
    suelos_enriquecidos = gee.enriquecer_gdf(suelos_gdf)

    # Instancia el pipeline integrador, cargando una única vez en memoria la matriz de parámetros de Excel, y calcula la aptitud final del territorio.
    print("Computando modelo matemático de aptitud y categorización territorial")
    pipeline = ReforestationPipeline()
    resultado_final = pipeline.calcular_aptitud_y_reforestacion(suelos_enriquecidos)

    # Exporta el GeoDataFrame final consolidado de vuelta a PostGIS en la tabla `'mapa_aptitud_final'`.
    print("Exportando resultados a la base de datos")
    db.guardar_resultado(resultado_final, nombre_tabla='mapa_aptitud_final')
    print("PIPELINE FINALIZADO")


if __name__ == '__main__':
    ejecutar_pipeline()