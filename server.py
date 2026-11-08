import sys
import os
import jwt
from jwt import PyJWKClient
from os import getenv
import io
import httpx
import asyncio
from fastapi import FastAPI, HTTPException, Response, BackgroundTasks, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import create_engine, text
from dotenv import load_dotenv
from fpdf import FPDF
import subprocess
import threading
import time
import traceback
from datetime import datetime, timezone
from main import ejecutar_pipeline, ETAPAS_PIPELINE
from pydantic import BaseModel, Field
from typing import List
from src import parametros_edaficos, reporte_pdf
from supabase import create_client, Client

# Cargar variables de entorno desde el archivo .env
load_dotenv()

"""
Modulo backend desarrollado con FastAPI encargado de exponer los resultados del modelo de aptitud forestal a traves de endpoints web REST.
Funciona como la capa de servicio que conecta la base de datos con cualquier visualizador web interactivo.
"""

app = FastAPI(
    title="API de Soporte de Decisiones - Reforestación de Quebracho",
    description="Servicios geoespaciales para el visualizador interactivo de aptitud forestal",
    version="1.0.0"
)

security = HTTPBearer()

# Leer la URL desde la variable de entorno
DATABASE_URL = os.getenv("DATABASE_URL")
GRAFANA_BASE_URL = os.getenv("GRAFANA_BASE_URL", "https://grafana.net")
GRAFANA_TOKEN = os.getenv("GRAFANA_API_TOKEN")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY")
SUPABASE_URL = getenv("SUPABASE_URL")
if not SUPABASE_URL or not SUPABASE_ANON_KEY:
    raise ValueError("ERROR: SUPABASE_URL o SUPABASE_ANON_KEY no están configuradas")

"""
Implementa FastAPI Middleware para habilitar el Intercambio de Recursos de Origen Cruzado (CORS) sin restricciones de puertos.
"""
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# rear el motor de conexión
engine = create_engine(DATABASE_URL)

# Cliente HTTP global y asíncrono exclusivo para Grafana
http_client = httpx.AsyncClient(timeout=20.0)

etl_en_progreso = False  # Flag global para controlar la ejecución del pipeline ETL

# Estado detallado del pipeline que consulta el modal de progreso del frontend.
# Nota: vive en memoria del proceso, por eso el servidor debe correr con 1 solo worker.
_estado_lock = threading.Lock()
estado_etl = {
    "estado": "inactivo",          # inactivo | ejecutando | completado | error
    "etapas": ETAPAS_PIPELINE,
    "etapa_actual": None,          # índice de la etapa en ejecución
    "mensaje": "",
    "subprogreso": None,           # 0.0 a 1.0 dentro de la etapa (si aplica)
    "inicio": None,
    "fin": None,
    "duracion_seg": None,
    "resultado": None,
    "error": None,
    "log": [],
}

def _actualizar_estado(**cambios):
    with _estado_lock:
        estado_etl.update(cambios)

def _reportar_progreso(etapa, mensaje, subprogreso=None):
    """Callback que main.ejecutar_pipeline invoca en cada avance."""
    print(f"[ETL {etapa + 1}/{len(ETAPAS_PIPELINE)}] {mensaje}")
    with _estado_lock:
        if estado_etl["etapa_actual"] != etapa:
            estado_etl["subprogreso"] = None
        estado_etl["etapa_actual"] = etapa
        estado_etl["mensaje"] = mensaje
        if subprogreso is not None:
            estado_etl["subprogreso"] = round(float(subprogreso), 3)
        # Solo se registran en el log los mensajes "de etapa", no cada tick de subprogreso
        if subprogreso is None or subprogreso >= 1.0:
            hora = datetime.now().strftime("%H:%M:%S")
            estado_etl["log"] = (estado_etl["log"] + [f"{hora}  {mensaje}"])[-40:]

supabase: Client = create_client(SUPABASE_URL, SUPABASE_ANON_KEY)

def verificar_token_supabase(credentials: HTTPAuthorizationCredentials = Depends(security)):
    """Delega la validación de seguridad directamente a Supabase"""
    token = credentials.credentials
    try:
        # Supabase hace la verificación de seguridad, caducidad y roles automáticamente
        respuesta = supabase.auth.get_user(token)
        
        if not respuesta.user:
            raise HTTPException(status_code=401, detail="Token rechazado por Supabase")
            
        return respuesta.user
        
    except Exception as e:
        raise HTTPException(status_code=401, detail=f"No autorizado: {str(e)}")

def verificar_admin(user=Depends(verificar_token_supabase)):
    """Además de un token válido, exige que el usuario tenga rol 'admin'."""
    app_meta = getattr(user, "app_metadata", None) or {}
    user_meta = getattr(user, "user_metadata", None) or {}
    rol = app_meta.get("role") or user_meta.get("role")
    if rol != "admin":
        raise HTTPException(status_code=403, detail="Se requiere rol de administrador.")
    return user

def tarea_etl_background():
    """Wrapper para manejar la ejecución del modelo, registrar el progreso y liberar el candado"""
    global etl_en_progreso
    t0 = time.perf_counter()
    try:
        # Ejecuta tu modelo directamente en la memoria de FastAPI, informando cada etapa
        resultado = ejecutar_pipeline(reportar=_reportar_progreso)
        hora = datetime.now().strftime("%H:%M:%S")
        with _estado_lock:
            estado_etl.update(
                estado="completado",
                etapa_actual=len(ETAPAS_PIPELINE),
                mensaje="Pipeline finalizado correctamente",
                subprogreso=None,
                resultado=resultado,
            )
            estado_etl["log"] = (estado_etl["log"] + [f"{hora}  Pipeline finalizado correctamente"])[-40:]
        _cache_censo["datos"] = None  # el polígono/categoría de cada punto puede haber cambiado
    except Exception as e:
        traceback.print_exc()
        print(f"Error crítico durante la ejecución del ETL: {e}")
        _actualizar_estado(estado="error", error=f"{type(e).__name__}: {e}", mensaje="El pipeline se detuvo por un error")
    finally:
        _actualizar_estado(
            fin=datetime.now(timezone.utc).isoformat(),
            duracion_seg=round(time.perf_counter() - t0, 1),
        )
        # Esto garantiza que el servidor se desbloquee incluso si el modelo falla
        etl_en_progreso = False

@app.on_event("shutdown")
async def shutdown_event():
    # Asegura cerrar las conexiones HTTP al apagar el servidor de Render
    await http_client.aclose()

def safe_float(valor):
    """Protege la serialización JSON contra valores nulos de la base de datos."""
    if valor is None:
        return 0.00
    try:
        return round(float(valor), 2)
    except (ValueError, TypeError):
        return 0.00

def formatear_posgar(valor):
    """Formatea números métricos con punto de miles y coma decimal (estándar español)."""
    if valor is None:
        return "N/A"
    return f"{valor:,.1f}".replace(",", "X").replace(".", ",").replace("X", ".")

# Función auxiliar asíncrona para descargar los paneles de Grafana
async def descargar_panel_grafana(poligono_id: int, panel_id: int) -> bytes:
    if not GRAFANA_TOKEN:
        raise HTTPException(status_code=500, detail="GRAFANA_API_TOKEN no configurado en el servidor")
        
    headers = {"Authorization": f"Bearer {GRAFANA_TOKEN}"}
    render_url = (
        f"{GRAFANA_BASE_URL}/render/d-solo/lufz7hf/reporte-de-poligono"
        f"?var-poligono_id={poligono_id}&panelId={panel_id}&width=700&height=350&theme=light"
    )
    try:
        res = await http_client.get(render_url, headers=headers)
        if res.status_code != 200:
            raise HTTPException(status_code=502, detail=f"Grafana Image Renderer devolvió error en panel {panel_id}")
        return res.content
    except httpx.RequestError:
        raise HTTPException(status_code=504, detail=f"Timeout al conectar con Grafana para el panel {panel_id}")

"""
Endpoint administrativo para disparar la actualización de datos (MCDA / ETL) por demanda.
Evita problemas de timeout respondiendo de inmediato gracias a BackgroundTasks.
"""
@app.post("/api/admin/run-etl")
async def run_etl(background_tasks: BackgroundTasks, admin_data=Depends(verificar_admin)):
    global etl_en_progreso

    if etl_en_progreso:
        raise HTTPException(status_code=409, detail="El modelo ya está en ejecución. Por favor espera.")

    # 1. Bloquear nuevas peticiones y reiniciar el estado de progreso
    etl_en_progreso = True
    hora = datetime.now().strftime("%H:%M:%S")
    _actualizar_estado(
        estado="ejecutando",
        etapa_actual=0,
        mensaje="Iniciando pipeline...",
        subprogreso=None,
        inicio=datetime.now(timezone.utc).isoformat(),
        fin=None,
        duracion_seg=None,
        resultado=None,
        error=None,
        log=[f"{hora}  Pipeline solicitado por {getattr(admin_data, 'email', 'admin')}"],
    )

    # 2. Enviar a segundo plano
    background_tasks.add_task(tarea_etl_background)

    # 3. Responder instantáneamente al frontend
    return {"mensaje": "Validación exitosa. Modelo iniciado en segundo plano.", "etapas": ETAPAS_PIPELINE}

@app.get("/api/admin/etl-status")
async def consultar_estado_etl(admin_data=Depends(verificar_admin)):
    with _estado_lock:
        estado = dict(estado_etl)
        estado["log"] = list(estado_etl["log"])
    estado["en_progreso"] = etl_en_progreso
    estado["total_etapas"] = len(ETAPAS_PIPELINE)
    return estado

# ==========================================
# PARÁMETROS EDÁFICOS (solo administrador)
# ==========================================
class CambioPuntaje(BaseModel):
    id: int
    puntaje: float = Field(..., ge=0.0, le=1.0)

class CambiosPuntajes(BaseModel):
    cambios: List[CambioPuntaje]

@app.get("/api/admin/parametros-edaficos")
def listar_parametros_edaficos(admin_data=Depends(verificar_admin)):
    """Matriz completa: hoja de parámetros (puntaje editable) y hojas complementarias del Excel (solo lectura)."""
    try:
        parametros = parametros_edaficos.obtener_parametros(engine)
        try:
            conteos, sin_parametro = parametros_edaficos.uso_en_carta_de_suelos(engine)
            for p in parametros:
                clave = f"{p['variable']}|{parametros_edaficos.normalizar_atributo(p['atributo'])}"
                p["poligonos"] = conteos.get(clave, 0)
        except Exception as e:
            print(f"No se pudo calcular el uso de los atributos: {e}")
            sin_parametro = None
        return {
            **parametros_edaficos.leer_encabezado_excel(),
            "parametros": parametros,
            "sin_parametro": sin_parametro,
            "hojas_complementarias": parametros_edaficos.leer_hojas_complementarias(),
            "variables_del_modelo": ["text_sups1", "sgrup_sue1", "drenaje_s1", "alcalin_s1"],
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"No se pudo leer la matriz de parámetros: {e}")

@app.put("/api/admin/parametros-edaficos")
def guardar_parametros_edaficos(datos: CambiosPuntajes, admin_data=Depends(verificar_admin)):
    """Actualiza únicamente la columna de puntaje. No se permite mientras el modelo se está reprocesando."""
    if etl_en_progreso:
        raise HTTPException(status_code=409, detail="El modelo se está reprocesando. Guarda los cambios cuando termine.")
    try:
        n = parametros_edaficos.actualizar_puntajes(
            engine, [c.model_dump() for c in datos.cambios], getattr(admin_data, "email", "admin"))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"No se pudieron guardar los puntajes: {e}")
    return {"mensaje": f"{n} puntaje(s) guardado(s). Reprocesa el modelo para aplicarlos.", "actualizados": n}

@app.get("/api/admin/parametros-edaficos/excel")
def descargar_parametros_excel(admin_data=Depends(verificar_admin)):
    """Excel original con los puntajes vigentes en la base."""
    try:
        contenido = parametros_edaficos.generar_excel(engine)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"No se pudo generar el Excel: {e}")
    return Response(
        content=contenido,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="edaphic-model-parameters-actualizado.xlsx"'},
    )

"""
Endpoint encargado de compilar los 3 paneles analíticos de Grafana para un polígono específico 
en un único documento PDF optimizado en memoria RAM.
"""
@app.get("/api/v1/poligonos/{poligono_id}/reporte-pdf")
async def descargar_reporte_pdf(poligono_id: int):
    """
    Reporte técnico del polígono: georreferenciación (reproyección a POSGAR 98 faja 5), dictamen, desglose
    del cálculo de cada variable, composición OTBN, censo forestal, paneles de Grafana y fuentes oficiales.
    Los paneles de Grafana son opcionales: si el servicio no responde, el reporte se genera sin ellos.
    """
    paneles = []
    titulos = [
        (1, "Indicadores de aptitud edafoclimática y vigor vegetal"),
        (5, "Criterios de viabilidad: biofísica, legalidad (OTBN) y cobertura"),
        (3, "Trazabilidad del análisis espacial"),
    ]
    if GRAFANA_TOKEN:
        resultados = await asyncio.gather(
            *(descargar_panel_grafana(poligono_id, panel_id=i) for i, _ in titulos), return_exceptions=True)
        for (_, titulo), res in zip(titulos, resultados):
            if isinstance(res, (bytes, bytearray)):
                paneles.append((titulo, res))
            else:
                print(f"Reporte PDF: panel de Grafana omitido ({titulo}): {res}")

    try:
        contenido = await asyncio.to_thread(reporte_pdf.generar_reporte, engine, poligono_id, paneles)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error generando el reporte PDF: {type(e).__name__}: {e}")
    if contenido is None:
        raise HTTPException(status_code=404, detail=f"No se encontró el polígono ID {poligono_id}")

    return Response(content=contenido, media_type="application/pdf", headers={
        "Content-Disposition": f'attachment; filename="Reporte_Aptitud_Poligono_{poligono_id}.pdf"'
    })

"""
Formatea y consolida los 429 polígonos del territorio evaluado bajo la estructura estándar de una `FeatureCollection` geoespacial, inyectando todas las sub-aptitudes calculadas, variables edáficas primarias y el dictamen legal (OTBN) dentro del bloque de `properties` de cada elemento.
"""
@app.get("/api/aptitud-suelos")
def obtener_aptitud_suelos():
    """
    Ejecuta la consulta SQL directamente en PostGIS transformando de forma eficiente las geometrías complejas de la base de datos al estándar web global EPSG:4326 mediante la función `ST_Transform`.
    """
    query = """
        SELECT 
            id,
            sgrup_sue1 AS subgrupo,
            text_sups1 AS textura,
            aptitud_suelo,
            aptitud_lluvia,
            aptitud_ndvi,
            aptitud_biofisica,
            pct_rojo,
            pct_amarillo,
            pct_verde,
            clasificacion_final,
            aptitud_final,
            ST_AsGeoJSON(ST_Transform(geom, 4326))::json AS geometria
        FROM "mapa_aptitud_finalv2";
    """
    # conexion segura a la base de datos
    try:
        with engine.connect() as connection:
            result = connection.execute(text(query))
            features = []

            """
            safe_float: Cuenta con una función protectora que captura valores nulos o tipos de datos corruptos provenientes de la base de datos. Redondea automáticamente las métricas físicas y matemáticas a dos decimales, garantizando un payload JSON liviano y un parseo sin errores en el navegador.
            """
            for row in result:
                feature = {
                    "type": "Feature",
                    "geometry": row.geometria,
                    "properties": {
                        "id": row.id,
                        "subgrupo": row.subgrupo,
                        "textura": row.textura,
                        "aptitud_suelo": row.aptitud_suelo,
                        "aptitud_lluvia": row.aptitud_lluvia,
                        "aptitud_ndvi": row.aptitud_ndvi,
                        "aptitud_biofisica": row.aptitud_biofisica,
                        "pct_rojo": row.pct_rojo,
                        "pct_amarillo": row.pct_amarillo,
                        "pct_verde": row.pct_verde,
                        "clasificacion_final": row.clasificacion_final,
                        "aptitud_final": row.aptitud_final
                    }
                }
                features.append(feature)
                
            return {
                "type": "FeatureCollection",
                "features": features
            }
            
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error en PostGIS: {e}")

# ==========================================
# CAPA DE QUEBRACHOS CENSADOS (pública)
# ==========================================
_cache_censo = {"datos": None}

@app.get("/api/censo-quebracho")
def obtener_censo_quebracho():
    """
    Puntos del Segundo Inventario Nacional de Bosques Nativos (2021) con presencia de Schinopsis balansae
    en el Chaco (tabla quebracho_final). Los individuos que comparten coordenadas (misma unidad de
    muestreo) se agrupan en un único punto con la cantidad de individuos. Si es posible, se informa
    el polígono de suelo del DSS donde cae cada punto. Los datos son estáticos y se guardan en memoria.
    """
    if _cache_censo["datos"] is not None:
        return _cache_censo["datos"]

    base = """
        SELECT CASE WHEN ST_SRID(geometry) = 0 THEN ST_SetSRID(geometry, 4326) ELSE geometry END AS g
        FROM "quebracho_final" WHERE geometry IS NOT NULL
    """
    con_poligono = f"""
        WITH puntos AS ({base}),
        agrupados AS (SELECT g, COUNT(*) AS individuos FROM puntos GROUP BY g)
        SELECT ST_AsGeoJSON(ST_Transform(a.g, 4326), 6) AS geojson, a.individuos,
               m.id AS poligono_id, m.clasificacion_final
        FROM agrupados a
        LEFT JOIN LATERAL (
            SELECT id, clasificacion_final FROM mapa_aptitud_finalv2 m
            WHERE ST_Intersects(m.geom, ST_Transform(a.g, ST_SRID(m.geom))) LIMIT 1
        ) m ON TRUE;
    """
    sin_poligono = f"""
        WITH puntos AS ({base})
        SELECT ST_AsGeoJSON(ST_Transform(g, 4326), 6) AS geojson, COUNT(*) AS individuos,
               NULL::int AS poligono_id, NULL::text AS clasificacion_final
        FROM puntos GROUP BY g;
    """
    filas = None
    for consulta in (con_poligono, sin_poligono):
        try:
            with engine.connect() as connection:
                filas = connection.execute(text(consulta)).mappings().all()
            break
        except Exception as e:
            print(f"Consulta del censo falló, se intenta una variante más simple: {e}")
    if filas is None:
        raise HTTPException(status_code=500, detail="No se pudo leer la tabla del censo forestal (quebracho_final).")

    import json as _json
    features = [{
        "type": "Feature",
        "geometry": _json.loads(f["geojson"]),
        "properties": {
            "individuos": int(f["individuos"]),
            "poligono_id": f["poligono_id"],
            "clasificacion_final": f["clasificacion_final"],
        },
    } for f in filas]
    _cache_censo["datos"] = {
        "type": "FeatureCollection",
        "features": features,
        "total_individuos": sum(x["properties"]["individuos"] for x in features),
        "fuente": "Segundo Inventario Nacional de Bosques Nativos de la República Argentina (2021)",
    }
    return _cache_censo["datos"]

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="127.0.0.1", port=8000, reload=True)