import os
import ee
import json
import pandas as pd
from google.oauth2 import service_account

SCOPES_GEE = ['https://www.googleapis.com/auth/earthengine']
RAIZ_PROYECTO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _es_cuenta_de_servicio(ruta):
    """True si el archivo es un JSON de cuenta de servicio de Google. Propaga PermissionError."""
    try:
        with open(ruta, encoding='utf-8-sig') as f:
            info = json.load(f)
        return isinstance(info, dict) and info.get("type") == "service_account" and "private_key" in info
    except (json.JSONDecodeError, UnicodeDecodeError, IsADirectoryError):
        return False


def _diagnostico_secretos():
    """Describe qué hay en /etc/secrets (solo nombres y permisos, nunca contenidos)."""
    carpeta = "/etc/secrets"
    if not os.path.exists(carpeta):
        return f"La carpeta {carpeta} no existe (no hay Secret Files montados en este servicio)."
    try:
        nombres = os.listdir(carpeta)
    except PermissionError:
        return f"Sin permiso para listar {carpeta}."
    if not nombres:
        return f"La carpeta {carpeta} está vacía."
    detalles = []
    for n in nombres:
        ruta = os.path.join(carpeta, n)
        legible = "legible" if os.access(ruta, os.R_OK) else "SIN permiso de lectura"
        detalles.append(f"'{n}' ({legible})")
    return f"Archivos en {carpeta}: " + ", ".join(detalles)


def cargar_credenciales_gee(key_file='config/credentials.json'):
    """
    Obtiene las credenciales de la cuenta de servicio de GEE probando, en orden:
      1. Variable de entorno GEE_CREDENTIALS_JSON con el contenido completo del JSON.
      2. Variable de entorno GEE_CREDENTIALS_PATH con la ruta a un archivo.
      3. Secret Files de Render: /etc/secrets/credentials.json y la raíz del repo.
      4. El archivo local `key_file` (relativo a la raíz del proyecto), como en desarrollo.
      5. Cualquier .json de cuenta de servicio dentro de /etc/secrets (por si tiene otro nombre).
    """
    contenido = os.getenv("GEE_CREDENTIALS_JSON")
    if contenido:
        try:
            info = json.loads(contenido)
        except json.JSONDecodeError as e:
            raise ValueError(f"GEE_CREDENTIALS_JSON no contiene un JSON válido: {e}")
        return service_account.Credentials.from_service_account_info(info, scopes=SCOPES_GEE)

    nombre = os.path.basename(key_file)
    candidatos = [
        os.getenv("GEE_CREDENTIALS_PATH"),
        os.path.join("/etc/secrets", nombre),
        os.path.join(RAIZ_PROYECTO, nombre),
        os.path.join(os.getcwd(), nombre),
        key_file if os.path.isabs(key_file) else os.path.join(RAIZ_PROYECTO, key_file),
    ]
    # Cualquier otro .json montado como Secret File
    if os.path.isdir("/etc/secrets"):
        try:
            candidatos += sorted(
                os.path.join("/etc/secrets", n) for n in os.listdir("/etc/secrets") if n.lower().endswith(".json")
            )
        except PermissionError:
            pass

    problemas = []
    vistos = set()
    for ruta in candidatos:
        if not ruta or ruta in vistos or not os.path.isfile(ruta):
            continue
        vistos.add(ruta)
        try:
            if _es_cuenta_de_servicio(ruta):
                print(f"Credenciales de GEE cargadas desde: {ruta}")
                return service_account.Credentials.from_service_account_file(ruta, scopes=SCOPES_GEE)
            problemas.append(f"'{ruta}' existe pero no es un JSON de cuenta de servicio válido")
        except PermissionError:
            problemas.append(f"'{ruta}' existe pero el proceso no tiene permiso de lectura")

    raise FileNotFoundError(
        "No se encontraron credenciales válidas de Google Earth Engine. "
        + (" | ".join(problemas) + ". " if problemas else "")
        + _diagnostico_secretos()
        + " Sube el JSON como Secret File llamado 'credentials.json' (y redespliega) "
        "o define la variable de entorno GEE_CREDENTIALS_JSON."
    )

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
        credentials = cargar_credenciales_gee(self.key_file)
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