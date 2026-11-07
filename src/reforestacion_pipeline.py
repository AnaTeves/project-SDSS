import pandas as pd
import numpy as np

from src.ahp_calculator import AHPCalculator
from src.mcda_engine import MCDAEngine
from src.raster_normalizer import RasterNormalizer

# Pesos de respaldo si fallara el cálculo dinámico del AHP
PESOS_AHP_BASE = {'suelo': 0.40, 'lluvia': 0.40, 'ndvi': 0.20}

"""
Clase controladora que actúa como el motor integrador y coordinador del sistema.
Ejecuta secuencialmente la Combinación Lineal Ponderada (MCDA), cruza las limitantes biofísicas con las restricciones legales y clasifica el territorio para la toma de decisiones ecológicas.
"""
class ReforestationPipeline:
    def __init__(self, engine=None):
        """
        Inicializa y pre-carga en memoria todos los motores analíticos de soporte
        para garantizar máxima eficiencia computacional O(N).
        Reduce la sobrecarga de procesamiento en conjuntos de datos masivos.
        """
        self.calculador_ahp = AHPCalculator()
        self.motor_suelo = MCDAEngine(engine=engine)
        self.motor_raster = RasterNormalizer()

    def calcular_aptitud_y_reforestacion(self, df_enriquecido: pd.DataFrame, pesos_macro=None) -> pd.DataFrame:
        """
        Motor principal de integración MCDA. Evalúa variables edafoclimáticas locales,
        cruza restricciones legales (OTBN) y de uso (MapBiomas), y clasifica el territorio.
        """
        print("\n====== Iniciando Pipeline de Aptitud para Reforestación ======")
        df_resultado = df_enriquecido.copy()
        
        # Obtención de pesos a través de la clase AHP 
        try:
            pesos = pesos_macro or self.calculador_ahp.calcular_pesos()
            print(f"Pesos AHP determinados exitosamente: {pesos}")
        except Exception as e:
            print(f"Error al calcular pesos AHP, usando base por defecto. Motivo: {e}")
            pesos = PESOS_AHP_BASE

        # Cómputo de sub-aptitudes normalizadas (Escala 0.0 a 1.0)
        print("[1/4] Procesando normalizaciones y modelos edafoclimáticos locales")
        
        # Invocación directa acoplada a las firmas exactas
        df_resultado['aptitud_suelo'] = self.motor_suelo.calcular_puntaje_suelo(df_resultado)
        df_resultado['aptitud_ndvi'] = self.motor_raster.normalizar_ndvi(df_resultado)
        df_resultado['aptitud_lluvia'] = self.motor_raster.normalizar_lluvia(df_resultado)

        # Combinación Lineal Ponderada (Aptitud Biofísica Pura)
        print("[2/4] Aplicando Combinación Lineal Ponderada (MCDA)")
        df_resultado['aptitud_biofisica'] = (
            (df_resultado['aptitud_suelo'] * pesos['suelo']) +
            (df_resultado['aptitud_lluvia'] * pesos['lluvia']) +
            (df_resultado['aptitud_ndvi'] * pesos['ndvi'])
        ).clip(0.0, 1.0)

        df_resultado.loc[df_resultado['aptitud_suelo'] <= 0.40, 'aptitud_biofisica'] = 0.0

        # Evaluación Vectorial de Restricciones Críticas (MapBiomas y OTBN)
        print("[3/4] Evaluando restricciones de uso de suelo y gobernanza legal (OTBN)")
        
        # Capa MapBiomas (True = Excluido, False = Permitido)
        es_uso_excluido = self.motor_raster.generar_mascara_restricciones(df_resultado)
        
        # Capa OTBN: Robustez ante nulos de PostGIS (0 = Restringido, 1 = Permitido)
        for col in ['pct_rojo', 'pct_amarillo', 'pct_verde']:
            if col not in df_resultado.columns:
                df_resultado[col] = 0.0

        # Cálculo en variables temporales (no se añaden como columnas a la base de datos)
        pct_libre_temp = (100.0 - (df_resultado['pct_rojo'] + df_resultado['pct_amarillo'] + df_resultado['pct_verde'])).clip(lower=0.0)

        # Criterio de Mayoría evaluado sobre las variables temporales
        es_domina_rojo = (df_resultado['pct_rojo'] > df_resultado['pct_amarillo']) & (df_resultado['pct_rojo'] > df_resultado['pct_verde'])
        es_domina_amarillo = (df_resultado['pct_amarillo'] > df_resultado['pct_rojo']) & (df_resultado['pct_amarillo'] > df_resultado['pct_verde'])

        # Umbral científico de aptitud biofísica y viabilidad del sustrato edáfico
        UMBRAL_APTITUD = 0.60
        es_apto_biofisico = (df_resultado['aptitud_biofisica'] >= UMBRAL_APTITUD) & (df_resultado['aptitud_suelo'] >= 0.40)

        # Clasificación Estricta en las 3 Categorías
        print("[4/4] Clasificando polígonos bajo criterios edafoclimáticos y legales...")
        
        condiciones = [
            (~es_apto_biofisico),
            (es_apto_biofisico) & (es_uso_excluido),
            (es_apto_biofisico) & (es_domina_rojo),
            (es_apto_biofisico) & (es_domina_amarillo),
            (es_apto_biofisico)  # Domina Verde o Libre
        ]
        
        categorias = [
            'No apto',
            'No apto (Uso excluido)',
            'Apto - Prioridad restauración ecológica (Zona roja)',
            'Apto - Enriquecimiento sostenible (Zona amarilla)',
            'Apto - Reforestación productiva (Zona verde)'
        ]
        
        df_resultado['clasificacion_final'] = np.select(condiciones, categorias, default='No apto')

        # Kill Switch Dinámico: Retiene el puntaje solo para zonas Productivas o de Enriquecimiento
        df_resultado['aptitud_final'] = np.where(
            df_resultado['clasificacion_final'].str.contains('Apto'),
            df_resultado['aptitud_biofisica'],
            0.00
        )
        
        print(f"Proceso MCDA finalizado. Polígonos evaluados: {len(df_resultado)}")
        return df_resultado