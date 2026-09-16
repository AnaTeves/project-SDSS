import numpy as np
import pandas as pd

"""
Clase algorítmica encargada de la lógica matemática del modelo edáfico.
Implementa una evaluación multicriterio (MCDA) basada en el Proceso de Jerarquía Analítica (AHP) para ponderar y clasificar la aptitud de las variables del suelo.
"""
class MCDAEngine:
    def __init__(self, excel_path='assets/edaphic-model-parameters-v2.xlsx'):
        """
        Establece los pesos oficiales validados metodológicamente para las variables críticas del suelo.
        """
        self.pesos_suelo = {
            'text_sups1': 0.35,
            'sgrup_sue1': 0.25,
            'drenaje_s1': 0.25,
            'alcalin_s1': 0.15
        }
        
        self.mapas = self._cargar_parametros_excel(excel_path)

    """
    Lee una matriz de puntuación externa desde un archivo Excel.
    Realiza un proceso de normalización e indexación estricta de cadenas de texto (limpieza de espacios y conversión a minúsculas) para generar diccionarios de mapeo rápidos y evitar errores por diferencias de tipeo.
    """
    def _cargar_parametros_excel(self, path: str) -> dict:
        df_params = pd.read_excel(path, sheet_name='Parametros del modelo', skiprows=3)
        df_clean = df_params.dropna(subset=['Variable', 'Atributo del Suelo']).copy()
        
        # Normalización estricta de la variable para evitar fallas de coincidencia
        df_clean['Variable'] = df_clean['Variable'].astype(str).str.strip()
        df_clean['Atributo del Suelo'] = df_clean['Atributo del Suelo'].astype(str).str.strip().str.lower()
        
        mapas = {}
        for var in self.pesos_suelo.keys():
            sub_df = df_clean[df_clean['Variable'] == var]
            
            if sub_df.empty:
                raise ValueError(f"Error crítico: No se encontraron parámetros en el Excel para la variable '{var}'")
                
            mapas[var] = dict(zip(sub_df['Atributo del Suelo'], sub_df['Puntaje (0-1)']))
        return mapas

    """
    Calcula de forma vectorial el puntaje edáfico optimizando el uso de memoria.
    Aplica principio de precaución estricto: la falta de datos penaliza con 0.0.
    """
    def calcular_puntaje_suelo(self, df: pd.DataFrame) -> pd.Series:
        valores_nulos = {
            'text_sups1': 'no determinada',
            'sgrup_sue1': 'no clasificado xx',
            'drenaje_s1': '-',
            'alcalin_s1': '-'
        }
        
        puntaje_acumulado = None
        
        for var, peso in self.pesos_suelo.items():
            if var not in df.columns:
                raise KeyError(f"La columna requerida '{var}' no existe en el DataFrame de entrada")
            
            # Procesamiento y estandarización de strings
            col_normalizada = df[var].fillna(valores_nulos[var]).astype(str).str.strip().str.lower()
            
            # Mapeo estricto. Si no está en el Excel (incluyendo los nulos si no fueron puntuados), devuelve 0.0
            valores_mapeados = col_normalizada.map(self.mapas[var]).fillna(0.0)
            
            # Acumulación ponderada
            if puntaje_acumulado is None:
                puntaje_acumulado = valores_mapeados * peso
            else:
                puntaje_acumulado += valores_mapeados * peso

        # Aplica una función de corte (`.clip(0, 1)`) para asegurar que el índice final de aptitud edáfica resultante esté estrictamente acotado en una escala continua entre 0.0 y 1.0.
        return puntaje_acumulado.clip(0, 1)