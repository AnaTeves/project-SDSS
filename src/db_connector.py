import os
from sqlalchemy import create_engine
import geopandas as gpd
from dotenv import load_dotenv
from sqlalchemy import text, inspect

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

    def obtener_metadatos_pdf(self, poligono_id):
        """
        Consulta la vista vista_metadatos_pdf para un polígono específico
        y devuelve un diccionario listo para usar en el generador de PDF.
        """
        query = f"SELECT * FROM vista_metadatos_pdf WHERE id = {int(poligono_id)};"
        df = pd.read_sql(query, con=self.engine)
        
        if not df.empty:
            return df.iloc[0].to_dict()
        else:
            raise ValueError(f"No se encontraron metadatos para el polígono ID: {poligono_id}")

    # Exporta y guarda GeoDataFrames procesados de vuelta a PostGIS.
    def guardar_resultado(self, gdf, nombre_tabla='mapa_aptitud_final'):
        inspector = inspect(self.engine)
        
        # Si la tabla ya existe, la vaciamos sin destruir su estructura
        if inspector.has_table(nombre_tabla):
            with self.engine.begin() as conn:
                conn.execute(text(f"DELETE FROM {nombre_tabla};"))
            modo_guardado = 'append'
        else:
            modo_guardado = 'replace'
            
        # Insertar los nuevos datos procesados
        gdf.to_postgis(nombre_tabla, con=self.engine, if_exists=modo_guardado, index=False)
        print(f"Datos guardados exitosamente en la tabla '{nombre_tabla}'.")