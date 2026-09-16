import numpy as np
import pandas as pd

"""
Clase algorítmica encargada de la estandarización y transformación de variables biofísicas continuas y categóricas.
Traduce magnitudes físicas reales en valores adimensionales de aptitud biológica.
"""

class RasterNormalizer:
    def __init__(
        self, 
        clases_excluidas=None, 
        umbrales_ndvi=(0.10, 0.80),
        umbrales_lluvia=(400.0, 900.0, 1500.0, 2500.0)
    ):
        """
        Motor de normalización y fuzzificación de variables ambientales.
        Permite configurar umbrales ecológicos para análisis de escenarios.
        """
        self.clases_excluidas = clases_excluidas or [10, 11, 12, 13, 15, 16, 17, 18, 19, 20, 21, 24, 30, 32, 33]
        
        # Umbrales configurables
        self.ndvi_min, self.ndvi_max = umbrales_ndvi
        self.p_min, self.p_opt_inf, self.p_opt_sup, self.p_max = umbrales_lluvia

    """"
    Implementa una función de transformación lineal para el Índice de Vegetación de Diferencia Normalizada.
    Mapea los valores entre un rango configurable (por defecto 0.10 y 0.80) y acota el resultado estrictamente entre 0.0 y 1.0.
    """
    def normalizar_ndvi(self, df: pd.DataFrame) -> pd.Series:
        if 'val_ndvi' not in df.columns:
            raise KeyError("La columna 'val_ndvi' no existe en el DataFrame.")
            
        ndvi = df['val_ndvi'].fillna(self.ndvi_min)
        ndvi_norm = (ndvi - self.ndvi_min) / (self.ndvi_max - self.ndvi_min)
        return ndvi_norm.clip(0.0, 1.0)

    """
    Aplica lógica borrosa para evaluar la precipitación anual.
    Utiliza cuatro umbrales ecológicos configurables para modelar un comportamiento trapezoidal
    """
    def normalizar_lluvia(self, df: pd.DataFrame) -> pd.Series:
        if 'val_lluvia' not in df.columns:
            raise KeyError("La columna 'val_lluvia' no existe en el DataFrame.")
            
        lluvia = df['val_lluvia'].fillna(self.p_min)
        
        condiciones = [
            (lluvia < self.p_min) | (lluvia > self.p_max),
            (lluvia >= self.p_min) & (lluvia < self.p_opt_inf),
            (lluvia >= self.p_opt_inf) & (lluvia <= self.p_opt_sup),
            (lluvia > self.p_opt_sup) & (lluvia <= self.p_max)
        ]
        
        valores = [
            0.0,
            (lluvia - self.p_min) / (self.p_opt_inf - self.p_min),
            1.0,
            1.0 - ((lluvia - self.p_opt_sup) / (self.p_max - self.p_opt_sup))
        ]
        
        lluvia_norm = np.select(condiciones, valores, default=0.0)
        return pd.Series(lluvia_norm, index=df.index).clip(0.0, 1.0)

    """
    Evalúa de manera vectorial la capa de uso de suelo actual.
    Genera una máscara booleana que detecta clases nulas oID de coberturas excluidas del análisis de aptitud
    """
    def generar_mascara_restricciones(self, df: pd.DataFrame) -> pd.Series:
        if 'val_uso_suelo' not in df.columns:
            return pd.Series(False, index=df.index)
        
        es_excluido = df['val_uso_suelo'].isin(self.clases_excluidas) | df['val_uso_suelo'].isna()
        return es_excluido