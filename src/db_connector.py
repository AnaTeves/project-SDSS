import os
from sqlalchemy import create_engine
import geopandas as gpd

class DBConnector:
    def __init__(self, connection_string=None):
        self.db_url = connection_string or os.getenv(
            "DATABASE_URL", 
            "postgresql://postgres:postgre@localhost:5432/postgres"
        )
        self.engine = create_engine(self.db_url)

    def cargar_capa_postgis(self, query, geom_col='geom'):
        """Lee una consulta SQL directamente a un GeoDataFrame."""
        return gpd.read_postgis(query, con=self.engine, geom_col=geom_col)

    def guardar_resultado(self, gdf, nombre_tabla):
        """Persiste el GeoDataFrame con las nuevas categorías en PostGIS."""
        gdf.to_postgis(nombre_tabla, con=self.engine, if_exists='replace', index=False)
        print(f"Capa '{nombre_tabla}' exportada exitosamente a PostGIS.")