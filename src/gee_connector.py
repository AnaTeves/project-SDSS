import ee
import json
import pandas as pd
from google.oauth2 import service_account

"""
Clase diseñada para interactuar con la API de Google Earth Engine utilizando una cuenta de servicio.
Su objetivo principal es procesar analisis geoespaciales pesados directamente en la nube.
"""
class GEEConnector:
    def __init__(self, key_file='config/credentials.json', project_id='tesis-492901'):
        self.key_file = key_file
        self.project_id = project_id
        self._autenticar()

    """
    Automatiza la conexión segura con los servidores de GEE utilizando el archivo de credenciales de la cuenta de servicio (`config/credentials.json`) y el ID del proyecto.
    """
    def _autenticar(self):
        scopes = ['https://www.googleapis.com/auth/earthengine']
        credentials = service_account.Credentials.from_service_account_file(
            self.key_file, 
            scopes=scopes
        )
        ee.Initialize(credentials=credentials, project=self.project_id)
        print("Conexion exitosa con Google Earth Engine Assets")

    """
    Conecta de forma remota con los Assets privados almacenados en GEE a una resolución espacial de 30 metros.
    """
    def obtener_capas_ambientales(self):
        return {
            'ndvi': ee.Image('users/lutevestessaro/NDVI_Historico_30m').rename('val_ndvi'), # Indice de vegetacion de diferencia normalizada
            'lluvia': ee.Image('users/lutevestessaro/Precipitacion_Anual_30m').rename('val_lluvia'), # Precipitacion anual promedio
            'uso': ee.Image('users/lutevestessaro/Uso_Suelo_Actual_30m').rename('val_uso_suelo') # Capa de clasificacion de cobertura y uso de suelo
        }

    def enriquecer_gdf(self, suelos_gdf):
        """
        Envía los polígonos a GEE, calcula los promedios de NDVI, Lluvia y Uso de Suelo
        en la nube y retorna el GeoDataFrame con los valores adjuntos.
        """
        print("Solicitando cómputo espacial a los clusteres de Google Earth Engine")
        capas = self.obtener_capas_ambientales()
        
        geojson_data = json.loads(suelos_gdf.to_json())
        fc = ee.FeatureCollection(geojson_data)

        # separacion de reducciones por tipo de variable (Promedio vs Moda)
        multibanda_continua = ee.Image.cat([capas['ndvi'], capas['lluvia']])
        capa_categorica = capas['uso']

        # Reducción 1: Promedio (Mean) para NDVI y Lluvia
        fc_continua = multibanda_continua.reduceRegions(
            collection=fc,
            reducer=ee.Reducer.mean(),
            scale=30
        )
        
        # Reducción 2: Mayoría (Mode) para Uso de Suelo
        fc_categorica = capa_categorica.reduceRegions(
            collection=fc,
            reducer=ee.Reducer.mode(),
            scale=30
        )

        # Manejo de excepciones para evitar colapsos de red
        try:
            print("Descargando métricas continuas (NDVI, Lluvia)...")
            datos_cont = [f['properties'] for f in fc_continua.getInfo()['features']]
            df_cont = pd.DataFrame(datos_cont)
            
            print("Descargando métricas categóricas (Uso de Suelo)...")
            datos_cat = [f['properties'] for f in fc_categorica.getInfo()['features']]
            df_cat = pd.DataFrame(datos_cat)
        except Exception as e:
            raise ConnectionError(f"Error al obtener datos de Earth Engine: {e}")

        # Renombrar la columna de la moda de MapBiomas para mantener consistencia
        if 'mode' in df_cat.columns:
            df_cat.rename(columns={'mode': 'val_uso_suelo'}, inplace=True)

        # Fusión (Join) segura usando id
        df_metrics = pd.merge(
            df_cont[['id', 'val_ndvi', 'val_lluvia']], 
            df_cat[['id', 'val_uso_suelo']], 
            on='id'
        )

        # se inyectan los datos calculados al GeoDataFrame original
        suelos_gdf = suelos_gdf.merge(df_metrics, on='id', how='left')
        
        # Sanitización final de la capa de MapBiomas
        suelos_gdf['val_uso_suelo'] = suelos_gdf['val_uso_suelo'].fillna(0).astype(int)

        print("Datos ambientales acoplados y alineados exitosamente desde la nube.")
        return suelos_gdf