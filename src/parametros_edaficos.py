"""
Gestión de la matriz de parámetros edáficos del modelo MCDA.

La fuente original es el Excel assets/edaphic-model-parameters-v2.xlsx. La primera vez que se
consulta, la hoja «Parametros del modelo» se copia a la tabla `parametros_edaficos` de PostGIS.
A partir de ahí la tabla es la fuente de verdad: el administrador edita los puntajes desde la web
(solo la columna de puntaje) y el pipeline los lee de la base en cada ejecución. El Excel puede
descargarse con los puntajes vigentes, conservando el resto del archivo sin cambios.
"""
import io
import os
import re
from datetime import datetime, timezone

import openpyxl
import pandas as pd
from sqlalchemy import inspect, text

RAIZ_PROYECTO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUTA_EXCEL = os.path.join(RAIZ_PROYECTO, 'assets', 'edaphic-model-parameters-v2.xlsx')
HOJA_PARAMETROS = 'Parametros del modelo'
TABLA = 'parametros_edaficos'
COL_VARIABLE, COL_ATRIBUTO, COL_PUNTAJE, COL_CRITERIO, COL_REFERENCIA = 1, 2, 3, 4, 5


# Variables usadas por el submodelo edáfico y valor que reemplaza a los nulos (igual que MCDAEngine)
VARIABLES_MODELO = {
    'text_sups1': 'no determinada',
    'sgrup_sue1': 'no clasificado xx',
    'drenaje_s1': '-',
    'alcalin_s1': '-',
}


def normalizar_atributo(valor):
    """
    Clave de comparación entre la carta de suelos y la matriz: minúsculas, sin espacios extra y sin
    aclaraciones entre paréntesis. Así «Franco Limosa (Silt Loam)» del Excel coincide con «Franco limosa».
    """
    s = str(valor).strip().lower()
    s = re.sub(r'\s*\([^)]*\)', '', s)
    return re.sub(r'\s+', ' ', s).strip()


def normalizar_serie(serie):
    """Versión vectorizada de normalizar_atributo para columnas de pandas."""
    return (serie.astype(str).str.strip().str.lower()
            .str.replace(r'\s*\([^)]*\)', '', regex=True)
            .str.replace(r'\s+', ' ', regex=True).str.strip())


def uso_en_carta_de_suelos(engine):
    """
    Cuenta cuántos polígonos de proc_suelos_chaco tienen cada atributo (con la misma normalización que
    usa el modelo) y detecta los valores de la carta que no tienen puntaje en la matriz (reciben 0.0).
    """
    columnas = ', '.join(VARIABLES_MODELO)
    df = pd.read_sql(f'SELECT {columnas} FROM "proc_suelos_chaco"', con=engine)
    with engine.connect() as conn:
        claves = {(v.strip(), normalizar_atributo(a)) for v, a in conn.execute(text(f"SELECT variable, atributo FROM {TABLA}"))}
    conteos, sin_parametro = {}, []
    for var, nulo in VARIABLES_MODELO.items():
        crudos = df[var].fillna(nulo).astype(str)
        normalizados = normalizar_serie(crudos)
        for clave, n in normalizados.value_counts().items():
            conteos[f'{var}|{clave}'] = int(n)
            if (var, clave) not in claves:
                ejemplo = crudos[normalizados == clave].iloc[0].strip()
                sin_parametro.append({'variable': var, 'valor': ejemplo, 'poligonos': int(n)})
    return conteos, sin_parametro


def _texto(valor):
    return None if valor is None else str(valor).strip()


def leer_excel_parametros(ruta=RUTA_EXCEL):
    """Devuelve las filas de puntaje de la hoja de parámetros con su número de fila en el Excel."""
    wb = openpyxl.load_workbook(ruta, data_only=True)
    ws = wb[HOJA_PARAMETROS]

    fila_encabezado = next(
        (r for r in range(1, ws.max_row + 1)
         if _texto(ws.cell(r, COL_VARIABLE).value) == 'Variable'
         and _texto(ws.cell(r, COL_ATRIBUTO).value) == 'Atributo del Suelo'),
        None)
    if fila_encabezado is None:
        raise ValueError(f"No se encontró el encabezado 'Variable / Atributo del Suelo' en la hoja '{HOJA_PARAMETROS}'.")

    filas, seccion = [], None
    for r in range(fila_encabezado + 1, ws.max_row + 1):
        variable = _texto(ws.cell(r, COL_VARIABLE).value)
        atributo = _texto(ws.cell(r, COL_ATRIBUTO).value)
        puntaje = ws.cell(r, COL_PUNTAJE).value
        if variable and not atributo:
            seccion = variable  # fila de título de grupo, p. ej. «TEXTURA DEL SUELO (TEXT_SUPS1)»
            continue
        if not variable or not atributo or not isinstance(puntaje, (int, float)):
            continue
        filas.append({
            'fila_excel': r,
            'seccion': seccion,
            'variable': variable,
            'atributo': atributo,
            'puntaje': float(puntaje),
            'criterio': _texto(ws.cell(r, COL_CRITERIO).value),
            'referencia': _texto(ws.cell(r, COL_REFERENCIA).value),
        })
    return filas


def leer_hojas_complementarias(ruta=RUTA_EXCEL):
    """Contenido de las demás hojas del Excel (solo lectura), sin filas vacías."""
    wb = openpyxl.load_workbook(ruta, data_only=True)
    hojas = []
    for ws in wb.worksheets:
        if ws.title == HOJA_PARAMETROS:
            continue
        filas = []
        for fila in ws.iter_rows(values_only=True):
            valores = [_texto(v) or '' for v in fila]
            if any(valores):
                filas.append(valores)
        if filas:
            ancho = max(len(f) for f in filas)
            # quita columnas vacías a la izquierda (la hoja de leyenda empieza en la columna B)
            vacias = 0
            while vacias < ancho and all((f[vacias] if vacias < len(f) else '') == '' for f in filas):
                vacias += 1
            hojas.append({'nombre': ws.title, 'filas': [f[vacias:] for f in filas]})
    return hojas


def leer_encabezado_excel(ruta=RUTA_EXCEL):
    wb = openpyxl.load_workbook(ruta, data_only=True)
    ws = wb[HOJA_PARAMETROS]
    return {'titulo': _texto(ws['A1'].value), 'descripcion': _texto(ws['A2'].value)}


def asegurar_tabla(engine):
    """Crea la tabla si no existe y la inicializa con los valores del Excel."""
    with engine.begin() as conn:
        conn.execute(text(f"""
            CREATE TABLE IF NOT EXISTS {TABLA} (
                id SERIAL PRIMARY KEY,
                fila_excel INTEGER UNIQUE NOT NULL,
                seccion TEXT,
                variable TEXT NOT NULL,
                atributo TEXT NOT NULL,
                puntaje DOUBLE PRECISION NOT NULL CHECK (puntaje >= 0 AND puntaje <= 1),
                puntaje_original DOUBLE PRECISION NOT NULL,
                criterio TEXT,
                referencia TEXT,
                actualizado_en TIMESTAMPTZ,
                actualizado_por TEXT
            );
        """))
        # Sin políticas: la tabla queda inaccesible para la API pública de Supabase (clave anónima);
        # el backend se conecta con el rol propietario y no se ve afectado.
        conn.execute(text(f"ALTER TABLE {TABLA} ENABLE ROW LEVEL SECURITY;"))
        cantidad = conn.execute(text(f"SELECT COUNT(*) FROM {TABLA}")).scalar()
        if cantidad == 0:
            for f in leer_excel_parametros():
                conn.execute(text(f"""
                    INSERT INTO {TABLA} (fila_excel, seccion, variable, atributo, puntaje, puntaje_original, criterio, referencia)
                    VALUES (:fila_excel, :seccion, :variable, :atributo, :puntaje, :puntaje, :criterio, :referencia)
                """), f)


def obtener_parametros(engine):
    asegurar_tabla(engine)
    with engine.connect() as conn:
        filas = conn.execute(text(f"""
            SELECT id, fila_excel, seccion, variable, atributo, puntaje, puntaje_original,
                   criterio, referencia, actualizado_en, actualizado_por
            FROM {TABLA} ORDER BY fila_excel
        """)).mappings().all()
    return [{**dict(f), 'actualizado_en': f['actualizado_en'].isoformat() if f['actualizado_en'] else None} for f in filas]


def actualizar_puntajes(engine, cambios, usuario):
    """
    Actualiza ÚNICAMENTE la columna puntaje. `cambios` es una lista de {id, puntaje}.
    Valida que cada id exista y que el puntaje esté entre 0 y 1. Todo o nada (una transacción).
    """
    asegurar_tabla(engine)
    if not cambios:
        return 0
    limpios = []
    for c in cambios:
        try:
            ident = int(c['id'])
            valor = round(float(c['puntaje']), 4)
        except (KeyError, TypeError, ValueError):
            raise ValueError("Cada cambio debe tener 'id' y 'puntaje' numéricos.")
        if not 0.0 <= valor <= 1.0:
            raise ValueError(f"El puntaje {valor} está fuera del rango 0 a 1.")
        limpios.append({'id': ident, 'puntaje': valor})

    ahora = datetime.now(timezone.utc)
    with engine.begin() as conn:
        existentes = {r[0] for r in conn.execute(text(f"SELECT id FROM {TABLA}"))}
        desconocidos = [c['id'] for c in limpios if c['id'] not in existentes]
        if desconocidos:
            raise ValueError(f"Parámetros inexistentes: {desconocidos}")
        for c in limpios:
            conn.execute(text(f"""
                UPDATE {TABLA} SET puntaje = :puntaje, actualizado_en = :ahora, actualizado_por = :usuario
                WHERE id = :id AND puntaje IS DISTINCT FROM :puntaje
            """), {**c, 'ahora': ahora, 'usuario': usuario})
    return len(limpios)


def generar_excel(engine):
    """El Excel original con los puntajes vigentes de la base (el resto del archivo no cambia)."""
    parametros = obtener_parametros(engine)
    wb = openpyxl.load_workbook(RUTA_EXCEL)
    ws = wb[HOJA_PARAMETROS]
    for p in parametros:
        ws.cell(p['fila_excel'], COL_PUNTAJE).value = p['puntaje']
    salida = io.BytesIO()
    wb.save(salida)
    return salida.getvalue()


def mapas_desde_bd(engine, variables):
    """
    Diccionarios {variable: {atributo_normalizado: puntaje}} leídos de la base, o None si la tabla
    todavía no existe (en ese caso el modelo usa el Excel).
    """
    if engine is None or not inspect(engine).has_table(TABLA):
        return None
    with engine.connect() as conn:
        filas = conn.execute(text(f"SELECT variable, atributo, puntaje FROM {TABLA}")).all()
    if not filas:
        return None
    mapas = {v: {} for v in variables}
    for variable, atributo, puntaje in filas:
        variable = variable.strip()
        if variable in mapas:
            mapas[variable][normalizar_atributo(atributo)] = float(puntaje)
    vacias = [v for v, m in mapas.items() if not m]
    if vacias:
        raise ValueError(f"La tabla '{TABLA}' no tiene parámetros para: {', '.join(vacias)}")
    return mapas
