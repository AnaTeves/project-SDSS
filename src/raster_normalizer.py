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
        umbrales_lluvia=(700.0, 900.0, 1500.0, 2500.0)
    ):
        """
        Motor de normalización y fuzzificación de variables ambientales.
        Permite configurar umbrales ecológicos para análisis de escenarios.
        """
        self.clases_excluidas = clases_excluidas or [6, 9, 11, 14, 18, 19, 22, 23, 24, 25, 26, 27, 36, 57, 58, 61]
        
        # Umbrales configurables
        # Precipitación (mm/año): (mínimo, inicio del óptimo, fin del óptimo, máximo).
        # El mínimo se fijó en 700 mm (antes 400 mm). S. balansae se distribuye principalmente en el
        # Chaco Húmedo, con ocurrencias fragmentadas en el Chaco Seco (De Diego, 2025); el Distrito
        # Chaqueño Occidental, dominio de S. lorentzii, recibe entre 500 y 800 mm (Arambarri et al., 2011,
        # siguiendo a Cabrera), y en la transición de 800-850 mm ambas especies conviven con predominio de
        # S. balansae (Michela y Juárez de Galíndez, 2016). Con 400 mm, casi todo el oeste chaqueño
        # resultaba apto. La rampa 700-900 mm asigna aptitud parcial a la transición (800 mm -> 0.5).
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