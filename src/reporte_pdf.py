"""
Generación del reporte técnico PDF de un polígono (fpdf2).

Reúne, para el polígono consultado:
  - identificación y georreferenciación (superficie y coordenadas obtenidas reproyectando la geometría
    a POSGAR 98 / Argentina faja 5, EPSG:22175, con PostGIS);
  - el dictamen y el desglose paso a paso del cálculo de cada variable del modelo;
  - la composición OTBN y la regla de dominancia;
  - los registros del censo forestal dentro del polígono;
  - las fuentes de datos oficiales utilizadas.
"""
from datetime import datetime
from zoneinfo import ZoneInfo

from fpdf import FPDF
from sqlalchemy import inspect, text

from src.ahp_calculator import AHPCalculator
from src.mcda_engine import MCDAEngine
from src.parametros_edaficos import normalizar_atributo
from src.raster_normalizer import RasterNormalizer

PESOS_AHP_BASE = {'suelo': 0.40, 'lluvia': 0.40, 'ndvi': 0.20}

NOMBRES_VARIABLES = {
    'text_sups1': 'Textura superficial',
    'sgrup_sue1': 'Subgrupo taxonómico',
    'drenaje_s1': 'Clase de drenaje',
    'alcalin_s1': 'Alcalinidad / sodicidad',
}
VALORES_NULOS = {'text_sups1': 'no determinada', 'sgrup_sue1': 'no clasificado xx', 'drenaje_s1': '-', 'alcalin_s1': '-'}

CATEGORIAS = {
    'Apto - Reforestación productiva (Zona verde)': (
        (235, 247, 238), (46, 125, 50), (27, 94, 32),
        'Terreno biofísicamente apto, con predominio de zona verde de la OTBN o superficie libre de bosque '
        'nativo. Admite plantaciones en bloque o cortinas forestales de quebracho colorado.'),
    'Apto - Enriquecimiento sostenible (Zona amarilla)': (
        (254, 249, 231), (202, 138, 4), (133, 77, 14),
        'Terreno biofísicamente apto en bosque de mediano valor de conservación (zona amarilla). Admite '
        'enriquecimiento bajo dosel nativo en parches degradados, sin cambio de uso del suelo.'),
    'Apto - Prioridad restauración ecológica (Zona roja)': (
        (253, 237, 237), (198, 40, 40), (153, 27, 27),
        'Terreno biofísicamente apto en bosque de muy alto valor de conservación (zona roja). Solo admite '
        'proyectos de restauración y preservación.'),
    'No apto (Uso excluido)': (
        (241, 245, 249), (100, 116, 139), (51, 65, 85),
        'Las condiciones biofísicas serían adecuadas, pero la cobertura actual del suelo (MapBiomas) es '
        'incompatible con la intervención forestal.'),
    'No apto': (
        (241, 245, 249), (30, 41, 59), (30, 41, 59),
        'Las condiciones de suelo, precipitación y vegetación no alcanzan el umbral mínimo de aptitud '
        'biofísica para Schinopsis balansae.'),
}

FUENTES = [
    ('Atributos edáficos', 'Instituto Nacional de Tecnología Agropecuaria (INTA), cartas de suelos de la provincia '
     'del Chaco: subgrupo taxonómico, textura superficial, clase de drenaje y alcalinidad de cada unidad cartográfica.'),
    ('Zonificación legal', 'Ordenamiento Territorial de Bosques Nativos (OTBN) de la provincia del Chaco, en el '
     'marco de la Ley Nacional N.° 26.331 de Presupuestos Mínimos de Protección Ambiental de los Bosques Nativos. '
     'Capa rasterizada con las categorías I (rojo), II (amarillo) y III (verde).'),
    ('Precipitación', 'CHIRPS (Climate Hazards Group InfraRed Precipitation with Station data), Climate Hazards '
     'Center, Universidad de California en Santa Bárbara. Promedio anual 2015-2025, procesado en Google Earth '
     'Engine y remuestreado a 30 m.'),
    ('Índice de vegetación', 'NDVI (Índice de Vegetación de Diferencia Normalizada), serie histórica 2015-2025 '
     'procesada en Google Earth Engine a 30 m de resolución.'),
    ('Cobertura y uso del suelo', 'MapBiomas Chaco, clasificación de cobertura y uso del suelo; se utiliza la '
     'clase predominante (moda) dentro del polígono.'),
    ('Censo forestal', 'Segundo Inventario Nacional de Bosques Nativos de la República Argentina (2021), Dirección '
     'Nacional de Bosques, Ministerio de Ambiente y Desarrollo Sostenible de la Nación.'),
    ('Parámetros del modelo', 'Matriz de puntajes edáficos con sustento en Prause et al. (2021), Barberis et al. '
     '(1998), Patiño et al. (1994) y Pérez et al. (1993); ponderación por Proceso Analítico Jerárquico (Saaty, 1987).'),
]

_REEMPLAZOS = {
    '≤': '<=', '≥': '>=', '–': '-', '—': '-', '→': '->', '×': 'x',
    '“': '"', '”': '"', '‘': "'", '’': "'", '…': '...', '·': '-',
    '•': '-', '≈': '~', '−': '-',
}


def t(valor):
    """Texto compatible con las fuentes base de fpdf (Latin-1)."""
    s = '' if valor is None else str(valor)
    for a, b in _REEMPLAZOS.items():
        s = s.replace(a, b)
    return s.encode('latin-1', 'replace').decode('latin-1')


def num(valor, dec=2, sufijo=''):
    try:
        if valor is None:
            return 's/d'
        return f"{float(valor):,.{dec}f}".replace(',', 'X').replace('.', ',').replace('X', '.') + sufijo
    except (TypeError, ValueError):
        return 's/d'


class ReportePDF(FPDF):
    def __init__(self, poligono_id):
        super().__init__(orientation='P', unit='mm', format='A4')
        self.poligono_id = poligono_id
        self.set_margins(15, 15, 15)
        self.set_auto_page_break(auto=True, margin=18)

    def footer(self):
        self.set_y(-12)
        self.set_font('Helvetica', '', 7.5)
        self.set_text_color(120, 120, 120)
        self.cell(0, 5, t(f'SITCHA - Reporte técnico del polígono #{self.poligono_id}'), align='L')
        self.set_x(self.l_margin)
        self.cell(0, 5, t(f'Página {self.page_no()} de {{nb}}'), align='R')
        self.set_text_color(0, 0, 0)

    # ---------------------------------------------------------------- bloques
    def titulo_seccion(self, texto):
        if self.get_y() > 250:
            self.add_page()
        self.ln(3)
        self.set_font('Helvetica', 'B', 11)
        self.set_text_color(15, 23, 42)
        self.cell(0, 7, t(texto), new_x='LMARGIN', new_y='NEXT')
        self.set_draw_color(203, 213, 225)
        self.line(15, self.get_y(), 195, self.get_y())
        self.ln(2)
        self.set_text_color(0, 0, 0)

    def subtitulo(self, texto):
        if self.get_y() > 260:
            self.add_page()
        self.set_font('Helvetica', 'B', 9)
        self.set_text_color(30, 64, 175)
        self.cell(0, 6, t(texto), new_x='LMARGIN', new_y='NEXT')
        self.set_text_color(0, 0, 0)

    def parrafo(self, texto, tam=8.5, estilo=''):
        self.set_font('Helvetica', estilo, tam)
        self.multi_cell(0, 4.2, t(texto), align='J', new_x='LMARGIN', new_y='NEXT')
        self.ln(1)

    def tabla(self, encabezados, filas, anchos, alineaciones=None, resaltar_ultima=False):
        alineaciones = alineaciones or ['L'] * len(anchos)
        alto = 5.5
        if self.get_y() + alto * (len(filas) + 1) > 275:
            self.add_page()
        self.set_font('Helvetica', 'B', 7.8)
        self.set_fill_color(30, 41, 59)
        self.set_text_color(255, 255, 255)
        for h, w, a in zip(encabezados, anchos, alineaciones):
            self.cell(w, alto, t(h), border=0, align=a, fill=True)
        self.ln(alto)
        self.set_text_color(0, 0, 0)
        for i, fila in enumerate(filas):
            ultima = resaltar_ultima and i == len(filas) - 1
            self.set_font('Helvetica', 'B' if ultima else '', 7.8)
            self.set_fill_color(*((226, 232, 240) if ultima else ((248, 250, 252) if i % 2 == 0 else (255, 255, 255))))
            for valor, w, a in zip(fila, anchos, alineaciones):
                texto = t(valor)
                # recorta textos que no entran en la celda
                while self.get_string_width(texto) > w - 2 and len(texto) > 3:
                    texto = texto[:-4] + '...'
                self.cell(w, alto, texto, border=0, align=a, fill=True)
            self.ln(alto)
        self.ln(2)

    def ficha(self, pares, columnas=2):
        """Pares etiqueta/valor en una grilla con fondo."""
        ancho = 180 / columnas
        self.set_fill_color(245, 247, 250)
        for i in range(0, len(pares), columnas):
            for etiqueta, valor in pares[i:i + columnas]:
                self.set_font('Helvetica', 'B', 7.8)
                w_et = self.get_string_width(t(etiqueta)) + 2
                self.cell(w_et, 5.5, t(etiqueta), fill=True)
                self.set_font('Helvetica', '', 7.8)
                self.cell(ancho - w_et, 5.5, t(valor), fill=True)
            self.ln(5.5)
        self.ln(2)


# -------------------------------------------------------------------- datos
def _leer_poligono(engine, poligono_id):
    with engine.connect() as conn:
        fila = conn.execute(text('SELECT * FROM mapa_aptitud_finalv2 WHERE id = :id'), {'id': poligono_id}).mappings().first()
        if fila is None:
            return None, None, None
        fila = {k: v for k, v in dict(fila).items() if k != 'geom'}
        # Georreferenciación calculada sobre la geometría: superficie y coordenadas planas reproyectando a
        # POSGAR 98 / Argentina faja 5 (EPSG:22175); centroide y encuadre en WGS84 (EPSG:4326).
        meta = conn.execute(text("""
            SELECT ST_Area(ST_Transform(geom, 22175)) / 10000.0 AS superficie_ha,
                   ST_Y(ST_Transform(ST_Centroid(geom), 4326)) AS lat_centro,
                   ST_X(ST_Transform(ST_Centroid(geom), 4326)) AS lon_centro,
                   ST_X(ST_Transform(ST_Centroid(geom), 22175)) AS x_posgar,
                   ST_Y(ST_Transform(ST_Centroid(geom), 22175)) AS y_posgar,
                   ST_YMin(ST_Transform(geom, 4326)) AS lat_min,
                   ST_YMax(ST_Transform(geom, 4326)) AS lat_max,
                   ST_XMin(ST_Transform(geom, 4326)) AS lon_min,
                   ST_XMax(ST_Transform(geom, 4326)) AS lon_max
            FROM mapa_aptitud_finalv2 WHERE id = :id
        """), {'id': poligono_id}).mappings().first()
        meta = dict(meta) if meta else {}
        censo = None
        try:
            censo = conn.execute(text("""
                SELECT COUNT(*) AS individuos, COUNT(DISTINCT q.geometry) AS sitios
                FROM "quebracho_final" q, mapa_aptitud_finalv2 m
                WHERE m.id = :id AND ST_Intersects(
                    m.geom,
                    ST_Transform(CASE WHEN ST_SRID(q.geometry) = 0 THEN ST_SetSRID(q.geometry, 4326) ELSE q.geometry END,
                                 ST_SRID(m.geom)))
            """), {'id': poligono_id}).mappings().first()
            censo = dict(censo) if censo else None
        except Exception as e:  # la tabla del censo es opcional para el reporte
            print(f"Reporte PDF: no se pudo consultar el censo: {e}")
    return fila, meta, censo


def _pesos_macro():
    try:
        return AHPCalculator().calcular_pesos(), True
    except Exception:
        return PESOS_AHP_BASE, False


def generar_reporte(engine, poligono_id):
    """Devuelve los bytes del PDF, o None si el polígono no existe."""
    fila, meta, censo = _leer_poligono(engine, poligono_id)
    if fila is None:
        return None

    normalizador = RasterNormalizer()
    motor = MCDAEngine(engine=engine)
    pesos, ahp_ok = _pesos_macro()
    clasificacion = str(fila.get('clasificacion_final') or 'No apto')
    fondo, borde, color_txt, descripcion = CATEGORIAS.get(clasificacion, CATEGORIAS['No apto'])

    pdf = ReportePDF(poligono_id)
    pdf.add_page()

    # ---------------------------------------------------------------- encabezado
    pdf.set_fill_color(15, 23, 42)
    pdf.rect(0, 0, 210, 26, style='F')
    pdf.set_xy(15, 6)
    pdf.set_text_color(255, 255, 255)
    pdf.set_font('Helvetica', 'B', 15)
    pdf.cell(0, 7, t('Reporte técnico de aptitud forestal'), new_x='LMARGIN', new_y='NEXT')
    pdf.set_font('Helvetica', '', 9)
    emitido = datetime.now(ZoneInfo('America/Argentina/Buenos_Aires')).strftime('%d/%m/%Y %H:%M')
    pdf.cell(0, 5, t(f'Polígono #{poligono_id} - Schinopsis balansae (quebracho colorado chaqueño) - Emitido el {emitido}'),
             new_x='LMARGIN', new_y='NEXT')
    pdf.set_text_color(0, 0, 0)
    pdf.set_y(31)

    # ---------------------------------------------------------------- dictamen
    y0 = pdf.get_y()
    pdf.set_fill_color(*fondo)
    pdf.set_draw_color(*borde)
    pdf.set_line_width(0.5)
    pdf.rect(15, y0, 180, 21, style='DF')
    pdf.set_line_width(0.2)
    pdf.set_xy(19, y0 + 2.5)
    pdf.set_text_color(*color_txt)
    pdf.set_font('Helvetica', 'B', 10.5)
    pdf.cell(150, 5, t(f'DICTAMEN: {clasificacion.upper()}'))
    pdf.set_font('Helvetica', 'B', 10.5)
    pdf.cell(22, 5, t(f'{num(fila.get("aptitud_biofisica"))}'), align='R', new_x='LMARGIN', new_y='NEXT')
    pdf.set_x(19)
    pdf.set_font('Helvetica', '', 8)
    pdf.multi_cell(172, 3.8, t(descripcion), new_x='LMARGIN', new_y='NEXT')
    pdf.set_text_color(0, 0, 0)
    pdf.set_y(y0 + 24)
    pdf.set_font('Helvetica', 'I', 7)
    pdf.set_text_color(100, 116, 139)
    pdf.cell(0, 4, t('El valor a la derecha es el puntaje de aptitud biofísica (0 a 1). Este reporte es consultivo y no '
                     'reemplaza la evaluación de campo ni el dictamen de la autoridad de aplicación.'),
             new_x='LMARGIN', new_y='NEXT')
    pdf.set_text_color(0, 0, 0)

    # ---------------------------------------------------------------- 1. identificación
    pdf.titulo_seccion('1. Identificación y georreferenciación')
    pdf.ficha([
        ('Polígono:', f'#{poligono_id}'),
        ('Superficie:', num(meta.get('superficie_ha'), 2, ' ha')),
        ('Centroide (WGS84):', f"{num(meta.get('lat_centro'), 5)}°, {num(meta.get('lon_centro'), 5)}°"),
        ('Sistema plano:', 'POSGAR 98 / Argentina 5 (EPSG:22175)'),
        ('POSGAR X (Este):', num(meta.get('x_posgar'), 1, ' m')),
        ('POSGAR Y (Norte):', num(meta.get('y_posgar'), 1, ' m')),
        ('Latitud mín. / máx.:', f"{num(meta.get('lat_min'), 5)}° / {num(meta.get('lat_max'), 5)}°"),
        ('Longitud mín. / máx.:', f"{num(meta.get('lon_min'), 5)}° / {num(meta.get('lon_max'), 5)}°"),
    ])
    pdf.parrafo('La superficie y las coordenadas planas se obtienen reproyectando la geometría del polígono al sistema '
                'oficial POSGAR 98 / Argentina faja 5 (EPSG:22175), en metros, lo que permite calcular el área en '
                'hectáreas sin la distorsión de las coordenadas geográficas. El centroide y el encuadre se informan '
                'en grados decimales WGS84 (latitudes y longitudes negativas: sur y oeste).', tam=7.8)

    # ---------------------------------------------------------------- 2. resumen
    pdf.titulo_seccion('2. Resumen de resultados')
    pdf.tabla(
        ['Indicador', 'Valor (0 a 1)', 'Interpretación'],
        [
            ['Aptitud del suelo (S suelo)', num(fila.get('aptitud_suelo')), 'Calidad edáfica según la carta de suelos del INTA'],
            ['Aptitud de la precipitación (S lluvia)', num(fila.get('aptitud_lluvia')), 'Disponibilidad hídrica media anual'],
            ['Aptitud del NDVI (S ndvi)', num(fila.get('aptitud_ndvi')), 'Vigor de la vegetación histórica'],
            ['Aptitud biofísica (A biofísica)', num(fila.get('aptitud_biofisica')), 'Combinación ponderada; apto si >= 0,60'],
        ],
        [70, 25, 85], ['L', 'C', 'L'], resaltar_ultima=True)

    # ---------------------------------------------------------------- 3. desglose
    pdf.titulo_seccion('3. Desglose del cálculo')

    # 3.1 suelo
    pdf.subtitulo('3.1 Submodelo edáfico')
    filas_suelo, total_suelo = [], 0.0
    for var, peso in motor.pesos_suelo.items():
        crudo = fila.get(var)
        valor = crudo if crudo not in (None, '') else VALORES_NULOS[var]
        puntaje = motor.mapas.get(var, {}).get(normalizar_atributo(valor))
        aporte = (puntaje or 0.0) * peso
        total_suelo += aporte
        filas_suelo.append([NOMBRES_VARIABLES[var], str(valor),
                            num(puntaje) if puntaje is not None else 'sin puntaje (0,00)',
                            num(peso), num(aporte, 4)])
    total_suelo = min(max(total_suelo, 0.0), 1.0)
    filas_suelo.append(['S suelo = suma de aportes', '', '', '', num(total_suelo, 4)])
    pdf.tabla(['Variable', 'Valor en la carta INTA', 'Puntaje', 'Peso', 'Aporte'], filas_suelo,
              [42, 62, 30, 18, 28], ['L', 'L', 'C', 'C', 'R'], resaltar_ultima=True)
    pdf.parrafo(f'Los puntajes provienen de la matriz de parametrización edáfica vigente ({motor.fuente_parametros}). '
                'Si S suelo es 0,40 o menor, la aptitud biofísica se anula por el filtro no compensatorio: un clima '
                'favorable no compensa un suelo inadecuado.', tam=7.8)

    # 3.2 precipitación
    pdf.subtitulo('3.2 Precipitación media anual')
    p_min, p_inf, p_sup, p_max = normalizador.p_min, normalizador.p_opt_inf, normalizador.p_opt_sup, normalizador.p_max
    lluvia = fila.get('val_lluvia')
    if lluvia is None:
        detalle_lluvia = 'Sin dato de precipitación para el polígono.'
    else:
        P = float(lluvia)
        if P < p_min or P > p_max:
            detalle_lluvia = f'P = {num(P, 0)} mm está fuera del rango tolerado ({num(p_min, 0)} a {num(p_max, 0)} mm) -> S lluvia = 0,00'
        elif P < p_inf:
            detalle_lluvia = (f'P = {num(P, 0)} mm, tramo ascendente: (P - {num(p_min, 0)}) / ({num(p_inf, 0)} - {num(p_min, 0)}) = '
                              f'{num((P - p_min) / (p_inf - p_min))}')
        elif P <= p_sup:
            detalle_lluvia = f'P = {num(P, 0)} mm está dentro del óptimo ({num(p_inf, 0)} a {num(p_sup, 0)} mm) -> S lluvia = 1,00'
        else:
            detalle_lluvia = (f'P = {num(P, 0)} mm, tramo descendente: 1 - (P - {num(p_sup, 0)}) / ({num(p_max, 0)} - {num(p_sup, 0)}) = '
                              f'{num(1 - (P - p_sup) / (p_max - p_sup))}')
    pdf.parrafo(f'Función de pertenencia trapezoidal: 0 por debajo de {num(p_min, 0)} mm, ascenso lineal hasta '
                f'{num(p_inf, 0)} mm, aptitud máxima entre {num(p_inf, 0)} y {num(p_sup, 0)} mm y descenso hasta '
                f'{num(p_max, 0)} mm.', tam=7.8)
    pdf.parrafo(detalle_lluvia + f'   (valor del mapa: {num(fila.get("aptitud_lluvia"))})', tam=7.8, estilo='B')

    # 3.3 NDVI
    pdf.subtitulo('3.3 Índice de vegetación (NDVI)')
    ndvi = fila.get('val_ndvi')
    n_min, n_max = normalizador.ndvi_min, normalizador.ndvi_max
    if ndvi is None:
        detalle_ndvi = 'Sin dato de NDVI para el polígono.'
    else:
        valor = min(max((float(ndvi) - n_min) / (n_max - n_min), 0.0), 1.0)
        detalle_ndvi = (f'NDVI = {num(ndvi, 3)} -> (NDVI - {num(n_min)}) / ({num(n_max)} - {num(n_min)}), acotado entre 0 y 1 = {num(valor)}')
    pdf.parrafo(f'Normalización lineal entre {num(n_min)} (suelo descubierto) y {num(n_max)} (dosel denso).', tam=7.8)
    pdf.parrafo(detalle_ndvi + f'   (valor del mapa: {num(fila.get("aptitud_ndvi"))})', tam=7.8, estilo='B')

    # 3.4 combinación
    pdf.subtitulo('3.4 Combinación lineal ponderada (AHP)')
    s_s, s_l, s_n = (float(fila.get(k) or 0) for k in ('aptitud_suelo', 'aptitud_lluvia', 'aptitud_ndvi'))
    combinacion = pesos['suelo'] * s_s + pesos['lluvia'] * s_l + pesos['ndvi'] * s_n
    pdf.parrafo(f"Pesos del Proceso Analítico Jerárquico{'' if ahp_ok else ' (valores de referencia)'}: suelo "
                f"{num(pesos['suelo'])}, precipitación {num(pesos['lluvia'])} y NDVI {num(pesos['ndvi'])}.", tam=7.8)
    linea = (f"A biofísica = {num(pesos['suelo'])} x {num(s_s)} + {num(pesos['lluvia'])} x {num(s_l)} + "
             f"{num(pesos['ndvi'])} x {num(s_n)} = {num(min(combinacion, 1.0))}")
    if s_s <= 0.40:
        linea += ' -> anulada a 0,00 porque S suelo <= 0,40'
    pdf.parrafo(linea, tam=7.8, estilo='B')
    apto_bio = float(fila.get('aptitud_biofisica') or 0) >= 0.60 and s_s > 0.40
    pdf.parrafo(f"Condición de aptitud biofísica: A biofísica >= 0,60 y S suelo > 0,40 -> "
                f"{'CUMPLE' if apto_bio else 'NO CUMPLE'}.", tam=7.8)

    # 3.5 uso del suelo
    pdf.subtitulo('3.5 Cobertura y uso del suelo (MapBiomas)')
    clase = fila.get('val_uso_suelo')
    if clase is None:
        pdf.parrafo('Sin dato de cobertura para el polígono (se considera excluido).', tam=7.8)
    else:
        excluida = int(clase) in normalizador.clases_excluidas
        pdf.parrafo(f'Clase predominante (moda) en el polígono: código {int(clase)}. '
                    f"{'Pertenece a las coberturas excluidas' if excluida else 'No pertenece a las coberturas excluidas'} "
                    f"(códigos excluidos: {', '.join(str(c) for c in normalizador.clases_excluidas)}).", tam=7.8)

    # 3.6 OTBN
    pdf.subtitulo('3.6 Composición según el OTBN y regla de dominancia')
    rojo, amarillo, verde = (float(fila.get(k) or 0) for k in ('pct_rojo', 'pct_amarillo', 'pct_verde'))
    libre = max(0.0, 100 - rojo - amarillo - verde)
    pdf.tabla(['Categoría OTBN', 'Superficie del polígono'],
              [['Zona roja (categoría I, muy alto valor de conservación)', num(rojo, 2, ' %')],
               ['Zona amarilla (categoría II, mediano valor)', num(amarillo, 2, ' %')],
               ['Zona verde (categoría III, bajo valor)', num(verde, 2, ' %')],
               ['Superficie libre (sin bosque nativo categorizado)', num(libre, 2, ' %')]],
              [130, 50], ['L', 'R'])
    if rojo > amarillo and rojo > verde:
        dominante = 'domina la zona roja'
    elif amarillo > rojo and amarillo > verde:
        dominante = 'domina la zona amarilla'
    else:
        dominante = 'no dominan la zona roja ni la amarilla (corresponde zona verde o superficie libre)'
    pdf.parrafo('Los porcentajes resultan de contar las celdas del ráster OTBN que caen dentro del polígono. La '
                'recomendación se define por la categoría de bosque con mayor superficie (regla de dominancia); la '
                f'superficie libre no compite porque no impone restricciones legales. En este polígono {dominante}. '
                'En las porciones minoritarias rigen igualmente las restricciones de su propia categoría.', tam=7.8)

    # 3.7 clasificación
    pdf.subtitulo('3.7 Clasificación final')
    pdf.parrafo('Secuencia de reglas: (1) si no es biofísicamente apto -> No apto; (2) si es apto pero su cobertura '
                'está excluida -> No apto (Uso excluido); (3) si es apto y domina la zona roja -> Prioridad restauración '
                'ecológica; (4) si domina la amarilla -> Enriquecimiento sostenible; (5) en otro caso -> Reforestación '
                f'productiva. Resultado: {clasificacion}.', tam=7.8, estilo='')

    # ---------------------------------------------------------------- 4. censo
    pdf.titulo_seccion('4. Registros del censo forestal')
    if censo and censo.get('individuos'):
        pdf.parrafo(f"Dentro del polígono se registraron {censo['individuos']} individuos de Schinopsis balansae en "
                    f"{censo['sitios']} unidad(es) de muestreo del Segundo Inventario Nacional de Bosques Nativos (2021). "
                    'Su presencia confirma condiciones en las que la especie prospera y constituye una posible fuente '
                    'de semillas para planes de manejo o enriquecimiento.', tam=8)
    elif censo is not None:
        pdf.parrafo('El Segundo Inventario Nacional de Bosques Nativos (2021) no registra unidades de muestreo con '
                    'Schinopsis balansae dentro de este polígono. El inventario es un muestreo: la ausencia de registros '
                    'no implica ausencia de la especie.', tam=8)
    else:
        pdf.parrafo('No fue posible consultar los registros del censo forestal para este polígono.', tam=8)

    # ---------------------------------------------------------------- 5. fuentes
    pdf.titulo_seccion('5. Fuentes de datos oficiales')
    for nombre, detalle in FUENTES:
        if pdf.get_y() > 268:
            pdf.add_page()
        pdf.set_font('Helvetica', 'B', 7.8)
        pdf.cell(38, 4.2, t(nombre))
        pdf.set_font('Helvetica', '', 7.8)
        pdf.multi_cell(142, 4.2, t(detalle), align='J', new_x='LMARGIN', new_y='NEXT')
        pdf.ln(0.8)

    return bytes(pdf.output())
