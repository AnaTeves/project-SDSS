import pandas as pd
import numpy as np

from src.ahp_calculator import AHPCalculator
from src.mcda_engine import MCDAEngine
from src.raster_normalizer import RasterNormalizer


# Pesos de respaldo si fallara el cálculo dinámico del AHP
PESOS_AHP_BASE = {'suelo': 0.40, 'lluvia': 0.40, 'ndvi': 0.20}

class ReforestationPipeline:
    def __init__(self):
        """
        Inicializa y pre-carga en memoria todos los motores analíticos de soporte
        para garantizar máxima eficiencia computacional O(N).
        """
        self.calculador_ahp = AHPCalculator()
        self.motor_suelo = MCDAEngine()
        self.motor_raster = RasterNormalizer()

    def calcular_aptitud_y_reforestacion(self, df_enriquecido: pd.DataFrame, pesos_macro=None) -> pd.DataFrame:
        """
        Motor principal de integración MCDA. Evalúa variables edafoclimáticas locales,
        cruza restricciones legales (OTBN) y de uso (MapBiomas), y clasifica el territorio.
        """
        print("\n====== Iniciando Pipeline de Aptitud para Reforestación ======")
        df_resultado = df_enriquecido.copy()
        
        # 1. Obtención de pesos a través de tu clase AHP (Retorna {'suelo': 0.4, 'lluvia': 0.4, 'ndvi': 0.2})
        try:
            pesos = pesos_macro or self.calculador_ahp.calcular_pesos()
            print(f"Pesos AHP determinados exitosamente: {pesos}")
        except Exception as e:
            print(f"Error al calcular pesos AHP, usando base por defecto. Motivo: {e}")
            pesos = PESOS_AHP_BASE

        # 2. Cómputo de sub-aptitudes normalizadas (Escala 0.0 a 1.0)
        print("[1/4] Procesando normalizaciones y modelos edafoclimáticos locales...")
        
        # Invocación directa acoplada a las firmas exactas de tus clases
        df_resultado['aptitud_suelo'] = self.motor_suelo.calcular_puntaje_suelo(df_resultado)
        df_resultado['aptitud_ndvi'] = self.motor_raster.normalizar_ndvi(df_resultado)
        df_resultado['aptitud_lluvia'] = self.motor_raster.normalizar_lluvia(df_resultado)

        # 3. Combinación Lineal Ponderada (Aptitud Biofísica Pura)
        print("[2/4] Aplicando Combinación Lineal Ponderada (MCDA)...")
        df_resultado['aptitud_biofisica'] = (
            (df_resultado['aptitud_suelo'] * pesos['suelo']) +
            (df_resultado['aptitud_lluvia'] * pesos['lluvia']) +
            (df_resultado['aptitud_ndvi'] * pesos['ndvi'])
        ).clip(0.0, 1.0)

        # 4. Evaluación Vectorial de Restricciones Críticas (MapBiomas y OTBN)
        print("[3/4] Evaluando restricciones de uso de suelo y gobernanza legal (OTBN)...")
        
        # Capa MapBiomas (True = Excluido, False = Permitido)
        es_uso_excluido = self.motor_raster.generar_mascara_restricciones(df_resultado)
        
        # Capa OTBN: Robustez ante nulos de PostGIS (0 = Restringido, 1 = Permitido)
        if 'val_otbn' not in df_resultado.columns:
            print("ADVERTENCIA: La columna 'val_otbn' no existe. Se asume restricción total (0).")
            df_resultado['val_otbn'] = 0
            
        df_resultado['mascara_otbn'] = pd.to_numeric(df_resultado['val_otbn'], errors='coerce').fillna(0).astype(int)
        es_ilegal_otbn = df_resultado['mascara_otbn'] == 0

        # Umbral científico de aptitud biofísica y viabilidad del sustrato edáfico
        UMBRAL_APTITUD = 0.60
        es_apto_biofisico = (df_resultado['aptitud_biofisica'] >= UMBRAL_APTITUD) & (df_resultado['aptitud_suelo'] > 0.10)

        # 5. Clasificación Estricta en las 3 Categorías Solicitadas
        print("[4/4] Clasificando polígonos bajo criterios edafoclimáticos y legales...")
        condiciones = [
            (es_apto_biofisico) & (~es_ilegal_otbn) & (~es_uso_excluido),   # Caso 1: Apto y Legal
            (es_apto_biofisico) & ((es_ilegal_otbn) | (es_uso_excluido)),   # Caso 2: Apto pero Ilegal
            (~es_apto_biofisico)                                            # Caso 3: No Apto
        ]
        
        categorias = [
            'Apto para reforestar y legal',
            'Apto pero ilegal',
            'No apto'
        ]
        
        # Asignación eficiente en C vía NumPy
        df_resultado['clasificacion_final'] = np.select(condiciones, categorias, default='No apto')

        # Aplicación del Kill Switch definitivo (Puntaje 0 si no es legal o si es inapto)
        df_resultado['aptitud_final'] = np.where(
            (df_resultado['clasificacion_final'] == 'Apto para reforestar y legal'),
            df_resultado['aptitud_biofisica'],
            0.00
        )
        
        print(f"Proceso MCDA finalizado. Polígonos evaluados: {len(df_resultado)}")
        return df_resultado
