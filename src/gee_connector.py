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
        
        # Unificar las 3 capas en una sola imagen multibanda
        multibanda = ee.Image.cat([capas['ndvi'], capas['lluvia'], capas['uso']])

        geojson_data = json.loads(suelos_gdf.to_json())
        fc = ee.FeatureCollection(geojson_data)

        # Ejecuta un reductor espacial para calcular el promedio de los valores de NDVI, lluvias y uso de suelo que caen dentro de cada poligono
        resultados_fc = multibanda.reduceRegions(
            collection=fc,
            reducer=ee.Reducer.mean(),
            scale=30
        )

        # Retornar propiedades y acoplarlas al GeoDataFrame original
        features = resultados_fc.getInfo()['features']
        datos_extraidos = [f['properties'] for f in features]
        df_metrics = pd.DataFrame(datos_extraidos)

        # Mapear columnas calculadas
        suelos_gdf['val_ndvi'] = df_metrics['val_ndvi']
        suelos_gdf['val_lluvia'] = df_metrics['val_lluvia']
        suelos_gdf['val_uso_suelo'] = df_metrics['val_uso_suelo'].fillna(0).astype(int)

        print("Datos ambientales acoplados exitosamente desde la nube")
        return suelos_gdf