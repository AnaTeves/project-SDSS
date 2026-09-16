import numpy as np

class AHPCalculator:
    def __init__(self):
        """
        Define la matriz de comparación por pares AHP para las variables macro.
        Pesos objetivo matemáticos exactos: Suelo = 0.40, Lluvia = 0.40, NDVI = 0.20
        Orden de variables: [Suelo, Lluvia, NDVI]
        """
        self.variables = ['suelo', 'lluvia', 'ndvi']
        
        # Relaciones matemáticas exactas para dar [0.4, 0.4, 0.2]:
        # - Suelo vs Lluvia = 1.0 (Son igual de importantes)
        # - Suelo vs NDVI = 2.0 (Suelo es el doble de importante que NDVI)
        # - Lluvia vs NDVI = 2.0 (Lluvia es el doble de importante que NDVI)
        self.matriz = np.array([
            [1.0,  1.0,  2.0],  # Suelo vs [Suelo, Lluvia, NDVI]
            [1.0,  1.0,  2.0],  # Lluvia vs [Suelo, Lluvia, NDVI]
            [0.5,  0.5,  1.0]   # NDVI vs [Suelo, Lluvia, NDVI]
        ])
        
        # Índice de Aleatoriedad Random (RI) para n=3
        self._ri = {1: 0.0, 2: 0.0, 3: 0.58}

    def calcular_pesos(self) -> dict:
        """
        Calcula los pesos utilizando el método del vector propio y valida la consistencia.
        Retorna exactamente: {'suelo': 0.40, 'lluvia': 0.40, 'ndvi': 0.20}
        """
        n = len(self.variables)
        
        # Cálculo de autovalores y autovectores
        valores_propios, vectores_propios = np.linalg.eig(self.matriz)
        
        idx_max = np.argmax(np.real(valores_propios))
        lambda_max = np.real(valores_propios[idx_max])
        
        vector_principal = np.real(vectores_propios[:, idx_max])
        pesos_normalizados = vector_principal / np.sum(vector_principal)
        
        # Validación de consistencia
        ci = (lambda_max - n) / (n - 1) if n > 1 else 0
        ri = self._ri.get(n, 1.0)
        cr = ci / ri if ri > 0 else 0
        
        if cr >= 0.10:
            raise ValueError(f"Matriz AHP inconsistente (CR = {cr:.4f}).")
            
        return dict(zip(self.variables, pesos_normalizados))