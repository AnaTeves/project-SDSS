import os
from sqlalchemy import create_engine
import geopandas as gpd
from dotenv import load_dotenv

# Le indicamos a Python que lea el archivo .env oculto
load_dotenv()

"""
Clase encargada de centralizar la conexion y las operaciones de lectura/escritura de datos espaciales entre el script y la base de datos.
"""
class DBConnector:
    # Inicializa el motor de base de datos usando variables de entorno
    def __init__(self, connection_string=None):
        # Solo usamos os.getenv(). Si está en None, Python buscará en el archivo .env
        self.db_url = connection_string or os.getenv("DATABASE_URL")

        if not self.db_url:
            raise ValueError("ERROR: No se encontró DATABASE_URL. Verifica tu archivo .env")

        self.engine = create_engine(self.db_url)

    # Ejecuta consultas SQL de forma segura y transforma los registros vectoriales en un objeto GeoDataFrame local
    def cargar_capa_postgis(self, query, geom_col='geom'):
        return gpd.read_postgis(query, con=self.engine, geom_col=geom_col)

    # Exporta y guarda GeoDataFrames procesados de vuelta a PostGIS.
    def guardar_resultado(self, gdf, nombre_tabla):
        gdf.to_postgis(nombre_tabla, con=self.engine, if_exists='replace', index=False)
        print(f"Capa '{nombre_tabla}' exportada exitosamente a PostGIS.")