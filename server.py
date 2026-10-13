import json
import os
import io
import httpx
import asyncio
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import create_engine, text
from dotenv import load_dotenv
from fpdf import FPDF

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

# Leer la URL desde la variable de entorno
DATABASE_URL = os.getenv("DATABASE_URL")
GRAFANA_BASE_URL = os.getenv("GRAFANA_BASE_URL", "https://grafana.net")
GRAFANA_TOKEN = os.getenv("GRAFANA_API_TOKEN")

if not DATABASE_URL:
    raise ValueError("ERROR: DATABASE_URL no está configurada en el archivo .env")

# rear el motor de conexión
engine = create_engine(DATABASE_URL)

# Cliente HTTP global y asíncrono exclusivo para Grafana
http_client = httpx.AsyncClient(timeout=20.0)

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
Endpoint encargado de compilar los 3 paneles analíticos de Grafana para un polígono específico 
en un único documento PDF optimizado en memoria RAM.
"""
@app.get("/api/v1/poligonos/{poligono_id}/reporte-pdf")
async def descargar_reporte_pdf(poligono_id: int):
    # 1. Descargar los 3 paneles en paralelo usando asyncio.gather para máxima velocidad
    try:
        # Reemplazá panelId=1, 2, 3 por tus IDs reales inspeccionados de Grafana
        foto_panel_1, foto_panel_2, foto_panel_3 = await asyncio.gather(
            descargar_panel_grafana(poligono_id, panel_id=1),
            descargar_panel_grafana(poligono_id, panel_id=2),
            descargar_panel_grafana(poligono_id, panel_id=3)
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error obteniendo reportes visuales: {str(e)}")

    # 2. Construcción fluida del documento PDF mediante fpdf2
    pdf = FPDF()
    
    # --- PÁGINA 1 ---
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 18)
    pdf.cell(0, 15, f"Reporte de Aptitud Forestal - Polígono #{poligono_id}", new_x="LMARGIN", new_y="NEXT", align="C")
    pdf.ln(5)
    
    pdf.set_font("Helvetica", "B", 12)
    pdf.cell(0, 10, "1. Evaluación de Aptitud Biofísica y Suelos", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(2)
    pdf.image(io.BytesIO(foto_panel_1), x=15, w=180)

    # --- PÁGINA 2 ---
    pdf.add_page()
    pdf.cell(0, 10, "2. Análisis Pluviométrico y Tendencias NDVI", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(2)
    pdf.image(io.BytesIO(foto_panel_2), x=15, w=180)
    pdf.ln(10)
    
    pdf.cell(0, 10, "3. Restricciones de la Máscara Legal OTBN", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(2)
    pdf.image(io.BytesIO(foto_panel_3), x=15, w=180)

    # 3. Exportación del buffer binario directo al navegador del usuario
    pdf_output = bytes(pdf.output())
    
    headers_resp = {
        "Content-Disposition": f'attachment; filename="Reporte_Aptitud_Poligono_{poligono_id}.pdf"'
    }
    return Response(content=pdf_output, media_type="application/pdf", headers=headers_resp)

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
            mascara_otbn,
            prop_otbn,
            clasificacion_final,
            aptitud_final,
            ST_AsGeoJSON(ST_Transform(geom, 4326))::json AS geometria
        FROM "mapa_aptitud_final";
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
                        "aptitud_suelo": safe_float(row.aptitud_suelo),
                        "aptitud_lluvia": safe_float(row.aptitud_lluvia),
                        "aptitud_ndvi": safe_float(row.aptitud_ndvi),
                        "aptitud_biofisica": safe_float(row.aptitud_biofisica),
                        "mascara_otbn": int(row.mascara_otbn) if row.mascara_otbn is not None else 0,
                        "prop_otbn": safe_float(row.prop_otbn),
                        "clasificacion_final": row.clasificacion_final if row.clasificacion_final else "No apto",
                        "aptitud_final": safe_float(row.aptitud_final)
                    }
                }
                features.append(feature)
                
            return {
                "type": "FeatureCollection",
                "features": features
            }
            
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error en PostGIS: {e}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="127.0.0.1", port=8000, reload=True)