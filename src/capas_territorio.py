"""
Capas de contexto territorial para el visor (no intervienen en el modelo):

- Cobertura y uso del suelo de MapBiomas Chaco (colección 5): se sirve como teselas generadas por
  Google Earth Engine a partir del mismo asset que usa el pipeline, con la paleta oficial.
- Límites departamentales del Chaco: se descargan una vez del servicio WFS del Instituto Geográfico
  Nacional (IGN), se recortan a la provincia y se guardan en memoria.
"""
import json
import threading
import time

import requests
from shapely.geometry import mapping, shape
from shapely.ops import unary_union
from sqlalchemy import text

# Códigos, nombres y colores oficiales de la colección 5 de MapBiomas Chaco
CLASES_MAPBIOMAS = {
    3:  ('Leñosa cerrada', '#1f8d49'),
    4:  ('Leñosa abierta', '#7dc975'),
    45: ('Leñosa dispersa', '#807a40'),
    6:  ('Leñosa inundable', '#026975'),
    12: ('Pastizal', '#d6bc74'),
    43: ('Pastizal cerrado', '#c2d26b'),
    42: ('Pastizal abierto', '#a5b35b'),
    44: ('Pastizal disperso', '#cbe286'),
    11: ('Pastizal inundable', '#519799'),
    15: ('Pastura', '#edde8e'),
    18: ('Agricultura', '#e974ed'),
    19: ('Cultivos anuales', '#c27ba0'),
    57: ('Cultivo simple', '#f99fff'),
    58: ('Cultivo múltiple', '#d84690'),
    36: ('Cultivo arbustivo', '#d082de'),
    9:  ('Plantación forestal', '#7a5900'),
    23: ('Playas y dunas', '#ffa07a'),
    24: ('Área urbana', '#d4271e'),
    25: ('Otras áreas no vegetadas', '#db4d4f'),
    61: ('Salares', '#f5d5d5'),
    26: ('Cuerpo de agua', '#2532e4'),
    27: ('No observado', '#ffffff'),
    # Clases de nivel 1 (por si el asset contiene la clase general)
    1:  ('Vegetación natural leñosa', '#1f8d49'),
    10: ('Vegetación natural herbácea', '#d6bc74'),
    14: ('Área agropecuaria', '#ffefc3'),
    22: ('Área sin vegetación', '#d4271e'),
}

ASSET_USO = 'users/lutevestessaro/Uso_Suelo_Actual_30m'


def describir_uso(codigo, clases_excluidas):
    """Nombre, color y condición de exclusión de un código de MapBiomas (None o 0 = sin dato)."""
    try:
        codigo = int(codigo)
    except (TypeError, ValueError):
        codigo = 0
    if codigo == 0:
        return {'uso_codigo': None, 'uso_nombre': 'Sin dato de cobertura', 'uso_color': '#cbd5e1', 'uso_excluido': None}
    nombre, color = CLASES_MAPBIOMAS.get(codigo, (f'Clase {codigo}', '#94a3b8'))
    return {'uso_codigo': codigo, 'uso_nombre': nombre, 'uso_color': color, 'uso_excluido': codigo in clases_excluidas}


def leyenda_mapbiomas(clases_excluidas):
    return [{'codigo': c, 'nombre': n, 'color': col, 'excluida': c in clases_excluidas}
            for c, (n, col) in CLASES_MAPBIOMAS.items() if c not in (1, 10, 14, 22)]


# ------------------------------------------------------------------ MapBiomas (teselas de GEE)
_TTL_TESELAS = 6 * 3600
_cache_teselas = {'url': None, 'creado': 0.0}
_lock_gee = threading.Lock()


def url_teselas_mapbiomas():
    """URL {z}/{x}/{y} de Earth Engine para la capa de cobertura, renovada cada 6 horas."""
    with _lock_gee:
        if _cache_teselas['url'] and time.time() - _cache_teselas['creado'] < _TTL_TESELAS:
            return _cache_teselas['url']
        import ee
        from src.gee_connector import GEEConnector
        try:
            ee.Number(1).getInfo()          # ¿ya inicializado en este proceso?
        except Exception:
            GEEConnector()
        codigos = list(CLASES_MAPBIOMAS)
        imagen = ee.Image(ASSET_USO).remap(codigos, list(range(len(codigos))))
        mapa = imagen.getMapId({'min': 0, 'max': len(codigos) - 1,
                                'palette': [CLASES_MAPBIOMAS[c][1].lstrip('#') for c in codigos]})
        _cache_teselas.update(url=mapa['tile_fetcher'].url_format, creado=time.time())
        return _cache_teselas['url']


# ------------------------------------------------------------------ Departamentos (WFS del IGN)
URL_WFS_IGN = 'https://wms.ign.gob.ar/geoserver/ows'
BBOX_CHACO = (-63.6, -28.2, -58.1, -23.8)
_cache_departamentos = {'datos': None}
_lock_dep = threading.Lock()


def _contorno_provincia(engine):
    """Geometría (EPSG:4326) de limite_chaco, cualquiera sea el nombre de su columna geométrica."""
    with engine.connect() as conn:
        col = conn.execute(text("SELECT f_geometry_column FROM geometry_columns "
                                "WHERE f_table_schema = 'public' AND f_table_name = 'limite_chaco' LIMIT 1")).scalar()
        if not col:
            return None
        filas = conn.execute(text(f'SELECT ST_AsGeoJSON(ST_Transform("{col}", 4326)) FROM limite_chaco')).scalars().all()
    geoms = [shape(json.loads(g)) for g in filas if g]
    return unary_union(geoms).buffer(0) if geoms else None


def _corregir_ejes(geom):
    """Si el servicio devolvió latitud/longitud invertidas, las intercambia."""
    from shapely.ops import transform
    x, y = geom.representative_point().coords[0]
    return transform(lambda a, b, z=None: (b, a), geom) if -35 < x < -20 else geom


def departamentos_chaco(engine):
    with _lock_dep:
        if _cache_departamentos['datos'] is not None:
            return _cache_departamentos['datos']
        params = {
            'service': 'WFS', 'version': '1.0.0', 'request': 'GetFeature',
            'typeName': 'ign:departamento', 'outputFormat': 'application/json',
            'srsName': 'EPSG:4326', 'bbox': ','.join(str(v) for v in BBOX_CHACO) + ',EPSG:4326',
        }
        r = requests.get(URL_WFS_IGN, params=params, timeout=60)
        r.raise_for_status()
        crudo = r.json()

        provincia = _contorno_provincia(engine)
        features = []
        for f in crudo.get('features', []):
            if not f.get('geometry'):
                continue
            geom = _corregir_ejes(shape(f['geometry']))
            if provincia is not None and not provincia.contains(geom.representative_point()):
                continue
            props = f.get('properties') or {}
            nombre = next((props[k] for k in ('nam', 'NAM', 'nombre', 'NOMBRE', 'fna') if props.get(k)), 'Departamento')
            features.append({
                'type': 'Feature',
                'properties': {'nombre': str(nombre).strip()},
                'geometry': mapping(geom.simplify(0.001, preserve_topology=True)),
            })
        datos = {'type': 'FeatureCollection', 'features': features,
                 'fuente': 'Instituto Geográfico Nacional (IGN), capa ign:departamento'}
        if features:
            _cache_departamentos['datos'] = datos
        return datos
