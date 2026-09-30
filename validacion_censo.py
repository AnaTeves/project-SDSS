import os
import pandas as pd
import geopandas as gpd
import matplotlib.pyplot as plt
import seaborn as sns
from sqlalchemy import create_engine
from src.db_connector import DBConnector

# Configuración visual para gráficos académicos
plt.style.use('seaborn-v0_8-whitegrid')
plt.rcParams['font.sans-serif'] = 'Inter'
plt.rcParams['font.family'] = 'sans-serif'

def ejecutar_validacion_censo(tabla_censo='quebracho_final'):
    """
    Realiza el análisis cuantitativo de solapamiento entre los puntos del censo
    y la capa de aptitud territorial calculada por el DSS.
    """
    db = DBConnector()
    engine = db.engine
    
    # 1. Cargar el mapa de aptitud final
    query_mapa = """
        SELECT id, aptitud_biofisica, mascara_otbn, prop_otbn, 
            clasificacion_final, aptitud_final, geom 
        FROM mapa_aptitud_final;
    """
    mapa_gdf = db.cargar_capa_postgis(query_mapa, geom_col='geom')
    
    # 2. Cargar los puntos del censo forestal
    query_censo = f"SELECT * FROM \"{tabla_censo}\";"
    try:
        censo_gdf = db.cargar_capa_postgis(query_censo, geom_col='geometry')
    except Exception as e:
        print(f"Error cargando la tabla '{tabla_censo}' de PostGIS: {e}")
        return

    print(f"Total de polígonos evaluados: {len(mapa_gdf)}")
    print(f"Total de puntos del censo: {len(censo_gdf)}")

    # 3. Homogeneizar Sistemas de Referencia de Coordenadas (CRS)
    if censo_gdf.crs != mapa_gdf.crs:
        print(f"Reproyectando puntos del censo de {censo_gdf.crs} a {mapa_gdf.crs}...")
        censo_gdf = censo_gdf.to_crs(mapa_gdf.crs)

    # 4. Cruce Espacial (Spatial Join: Puntos en Polígonos)
    print("Ejecutando Spatial Join (Puntos Censo x Polígonos DSS)...")
    cruce_gdf = gpd.sjoin(censo_gdf, mapa_gdf, how='inner', predicate='within')

    total_puntos_validados = len(cruce_gdf)
    print(f"\nPuntos censados que interceptan con la zona de estudio: {total_puntos_validados}")

    if total_puntos_validados == 0:
        print("No hubo intersección espacial entre los puntos del censo y los polígonos.")
        return

    # ==========================================
    # METRICA A: MATRIZ DE COINCIDENCIA / CONTAGIO
    # ==========================================
    print("\n--- MATRIZ DE COINCIDENCIA POR CLASIFICACIÓN FINAL ---")
    conteo_clasificacion = cruce_gdf['clasificacion_final'].value_counts()
    porcentaje_clasificacion = (conteo_clasificacion / total_puntos_validados) * 100

    df_resumen = pd.DataFrame({
        'Cantidad_Puntos': conteo_clasificacion,
        'Porcentaje (%)': porcentaje_clasificacion.round(2)
    })
    print(df_resumen)

    # ==========================================
    # METRICA B: TASA DE ACIERTO BIOFÍSICO (> 0.65)
    # ==========================================
    puntos_aptos_biofisico = cruce_gdf[cruce_gdf['aptitud_biofisica'] >= 0.65]
    tasa_acierto_biofisico = (len(puntos_aptos_biofisico) / total_puntos_validados) * 100

    print("\n--- TASA DE ACIERTO BIOFÍSICO ---")
    print(f"Puntos con Aptitud Biofísica >= 0.65: {len(puntos_aptos_biofisico)} / {total_puntos_validados}")
    print(f"Tasa de Validación Biofísica: {tasa_acierto_biofisico:.2f}%")

    # ==========================================
    # GENERACIÓN DEL GRÁFICO PARA EL INFORME (300 DPI)
    # ==========================================
    fig, ax = plt.subplots(figsize=(8, 5), dpi=300)
    
    colores = {
        'Apto para reforestar y legal': '#22c55e',
        'Apto pero ilegal': '#f59e0b',
        'No apto': '#ef4444'
    }
    
    # Asignar paleta basada en las categorías presentes
    palette = [colores.get(cat, '#64748b') for cat in df_resumen.index]

    bars = sns.barplot(
        x=df_resumen.index,
        y=df_resumen['Porcentaje (%)'],
        palette=palette,
        ax=ax
    )

    # Añadir valores sobre las barras
    for p in bars.patches:
        height = p.get_height()
        ax.annotate(
            f'{height:.1f}%',
            (p.get_x() + p.get_width() / 2., height),
            ha='center', va='bottom',
            xytext=(0, 5),
            textcoords='offset points',
            fontsize=10, fontweight='bold'
        )

    ax.set_title('Distribución de Puntos Censados de Schinopsis balansae según el DSS', fontsize=12, fontweight='bold', pad=15)
    ax.set_ylabel('Porcentaje de Puntos Censados (%)', fontsize=10)
    ax.set_xlabel('Clasificación Asignada por el Modelo', fontsize=10)
    ax.set_ylim(0, max(df_resumen['Porcentaje (%)']) * 1.15)
    plt.xticks(rotation=15, ha='right')
    plt.tight_layout()

    # Guardar imagen
    os.makedirs('reports/figures', exist_ok=True)
    ruta_grafico = 'reports/figures/grafico_validacion_censo.png'
    plt.savefig(ruta_grafico, dpi=300, bbox_inches='tight')
    print(f"\nGráfico guardado exitosamente en: {ruta_grafico}")

    return df_resumen, tasa_acierto_biofisico

if __name__ == '__main__':
    ejecutar_validacion_censo(tabla_censo='quebracho_final')