"""
Precalcula el cruce de cada polígono de suelo con el ráster de la OTBN y lo guarda en PostGIS
(tabla `otbn_porcentajes`). Se ejecuta en el equipo local, donde está assets/cat_otbn2.0.tif,
y debe repetirse solo si cambian la capa OTBN o la tabla proc_suelos_chaco.

Uso:  python precalcular_otbn.py
"""
import time

from main import RUTA_OTBN, TABLA_OTBN, aplicar_mascara_otbn, guardar_porcentajes_otbn
from src.db_connector import DBConnector


def main():
    inicio = time.perf_counter()
    db = DBConnector()

    print("Leyendo polígonos de suelo desde PostGIS...")
    suelos = db.cargar_capa_postgis('SELECT id, geom FROM "proc_suelos_chaco";', geom_col='geom')
    print(f"{len(suelos)} polígonos cargados.")

    print(f"Cruzando con el ráster {RUTA_OTBN}...")
    suelos = aplicar_mascara_otbn(
        suelos, RUTA_OTBN,
        on_avance=lambda i, n: print(f"  polígono {i} de {n}", end="\r"),
    )
    print()

    guardar_porcentajes_otbn(db, suelos)
    print(f"Tabla '{TABLA_OTBN}' actualizada con {len(suelos)} registros "
          f"en {time.perf_counter() - inicio:.1f} s.")
    print(suelos[['id', 'pct_rojo', 'pct_amarillo', 'pct_verde']].head())


if __name__ == '__main__':
    main()
