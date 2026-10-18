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
Endpoint encargado de compilar los 3 paneles analíticos de Grafana para un polígono específico 
en un único documento PDF optimizado en memoria RAM.
"""
@app.get("/api/v1/poligonos/{poligono_id}/reporte-pdf")
async def descargar_reporte_pdf(poligono_id: int):
    query_meta = text("""
        SELECT 
            m.id, 
            m.sgrup_sue1 AS subgrupo, 
            m.text_sups1 AS textura,
            m.clasificacion_final,
            m.aptitud_final,
            v.superficie_ha, 
            v.lat_centro, 
            v.lon_centro, 
            v.x_posgar, 
            v.y_posgar, 
            v.lat_min, 
            v.lat_max, 
            v.lon_min, 
            v.lon_max 
        FROM mapa_aptitud_final m
        JOIN vista_metadatos_pdf v ON m.id = v.id
        WHERE m.id = :id;
    """)
    
    try:
        with engine.connect() as connection:
            res_meta = connection.execute(query_meta, {"id": poligono_id}).fetchone()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error consultando metadatos en la BD: {str(e)}")

    if not res_meta:
        raise HTTPException(status_code=404, detail=f"No se encontraron metadatos para el polígono ID {poligono_id}")
    
    # Descargar los 3 paneles en paralelo usando asyncio.gather para máxima velocidad
    try:
        foto_panel_1, foto_panel_2, foto_panel_3= await asyncio.gather(
            descargar_panel_grafana(poligono_id, panel_id=1),
            descargar_panel_grafana(poligono_id, panel_id=3),
            descargar_panel_grafana(poligono_id, panel_id=5)
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error obteniendo reportes visuales: {str(e)}")

    # Construcción del documento PDF mediante fpdf2
    pdf = FPDF()
    
    # --- PÁGINA 1 ---
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 18)
    pdf.cell(0, 15, f"Reporte de Aptitud Forestal - Polígono #{poligono_id}", new_x="LMARGIN", new_y="NEXT", align="C")
    pdf.ln(2)

    # --- TARJETA DE METADATOS DE GEORREFERENCIACIÓN ---
    start_y = pdf.get_y()
    pdf.set_fill_color(245, 247, 250)
    pdf.set_draw_color(200, 205, 215)
    
    # Recuadro contenedor de la tarjeta
    pdf.rect(15, start_y, 180, 28, style="DF")
    
    # Formatear valores
    sup_ha = safe_float(res_meta.superficie_ha)
    subgrupo = res_meta.subgrupo if res_meta.subgrupo else "No especificado"
    textura = res_meta.textura if res_meta.textura else "No especificada"
    lat_c = safe_float(res_meta.lat_centro)
    lon_c = safe_float(res_meta.lon_centro)
    x_pos = formatear_posgar(res_meta.x_posgar)
    y_pos = formatear_posgar(res_meta.y_posgar)
    bbox_str = f"N: {safe_float(res_meta.lat_max)}° | S: {safe_float(res_meta.lat_min)}° | E: {safe_float(res_meta.lon_max)}° | O: {safe_float(res_meta.lon_min)}°"

    # Fila 1: ID y Superficie
    pdf.set_xy(18, start_y + 2.5)
    pdf.set_font("Helvetica", "B", 8.5)
    pdf.cell(85, 4.5, f"Polígono ID: #{poligono_id}", new_x="RIGHT", new_y="TOP")
    pdf.cell(85, 4.5, f"Superficie Total: {sup_ha} ha", new_x="LMARGIN", new_y="NEXT")
    
    # Fila 2: Atributos del suelo
    pdf.set_x(18)
    pdf.cell(85, 4.5, f"Subgrupo de Suelo: {subgrupo}", new_x="RIGHT", new_y="TOP")
    pdf.cell(85, 4.5, f"Textura Superficial: {textura}", new_x="LMARGIN", new_y="NEXT")

    # Fila 3: Coordenadas
    pdf.set_x(18)
    pdf.set_font("Helvetica", "", 8)
    pdf.cell(85, 4.5, f"Centroide WGS84: {lat_c}° S, {lon_c}° O", new_x="RIGHT", new_y="TOP")
    pdf.cell(85, 4.5, f"Sistema Oficial: POSGAR 98 / Arg 5 (EPSG:22175)", new_x="LMARGIN", new_y="NEXT")
    
    # Fila 4: POSGAR X / Y
    pdf.set_x(18)
    pdf.cell(85, 4.5, f"POSGAR X (Este): {x_pos} m", new_x="RIGHT", new_y="TOP")
    pdf.cell(85, 4.5, f"POSGAR Y (Norte): {y_pos} m", new_x="LMARGIN", new_y="NEXT")
    
    # Fila 5: Bounding Box
    pdf.set_x(18)
    pdf.set_font("Helvetica", "I", 7.5)
    pdf.cell(170, 4.5, f"Encuadre (Bounding Box WGS84): {bbox_str}", new_x="LMARGIN", new_y="NEXT")
    
    pdf.set_y(start_y + 36)

    # --- RECUADRO DE DICTAMEN DE APTITUD (APTO / NO APTO) ---
    clasificacion_raw = str(res_meta.clasificacion_final or "").strip().lower()
    es_apto = "apto" in clasificacion_raw and "no" not in clasificacion_raw

    banner_y = pdf.get_y()
    if es_apto:
        pdf.set_fill_color(235, 247, 238)  # Verde suave
        pdf.set_draw_color(46, 125, 50)    # Verde bordes
        pdf.set_text_color(27, 94, 32)     # Verde texto
        titulo_dictamen = "DICTAMEN: POLÍGONO HABILITADO / APTO PARA REFORESTACIÓN"
        desc_dictamen = (
            "El predio analizado cumple satisfactoriamente con la aptitud edafoclimática requerida, "
            "la normativa legal de la OTBN (Ley 26.331) y la compatibilidad de uso del suelo."
        )
    else:
        pdf.set_fill_color(253, 237, 237)  # Rojo suave
        pdf.set_draw_color(198, 40, 40)    # Rojo bordes
        pdf.set_text_color(183, 28, 28)    # Rojo texto
        titulo_dictamen = "DICTAMEN: POLÍGONO NO APTO / RESTRINGIDO"
        desc_dictamen = (
            "El predio presenta restricciones ambientales o legales (descalificación por OTBN o "
            "cobertura de suelo incompatible) que impiden la práctica de reforestación de Quebracho Colorado."
        )

    pdf.rect(15, banner_y, 180, 16, style="DF")
    pdf.set_xy(18, banner_y + 2)
    pdf.set_font("Helvetica", "B", 10)
    pdf.cell(174, 4, titulo_dictamen, new_x="LMARGIN", new_y="NEXT")
    
    pdf.set_x(18)
    pdf.set_font("Helvetica", "", 8)
    pdf.multi_cell(174, 3.5, desc_dictamen, new_x="LMARGIN", new_y="NEXT")
    
    # Restablecer color de texto a negro por defecto
    pdf.set_text_color(0, 0, 0)
    pdf.set_y(banner_y + 19)

    # PRIMER IMAGEN: Panel de Aptitud Edafoclimática y Vigor Vegetal
    pdf.set_font("Helvetica", "B", 11)
    pdf.cell(0, 10, "1. Indicadores de aptitud edafoclimática y vigor vegetal", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(2)

    pdf.set_font("Helvetica", "", 9)
    texto = (
        "Este análisis sintetiza las tres variables biofísicas primarias del territorio en una escala "
        "normalizada de 0.00 a 1.00: (a) Aptitud del suelo, calculada mediante evaluación multicriterio (MCDA) "
        "sobre textura (35%), subgrupo (25%), drenaje (25%) y alcalinidad (15%); (b) Lluvia normalizada, "
        "mediante función borrosa trapezoidal basada en el rango óptimo de 900 a 1500 mm/año; y (c) NDVI normalizado, "
        "que estandariza la biomasa vegetativa a partir de series temporales satelitales."
        )
    pdf.multi_cell(0, 4, texto, new_x="LMARGIN", new_y="NEXT", align="J") 
    pdf.ln(2)
    pdf.image(io.BytesIO(foto_panel_1), x=15, w=180)

    # --- PÁGINA 2 ---
    pdf.add_page()
    # SEGUNDA IMAGEN: Criterios de viabilidad: Biofísica, Legalidad (OTBN) y Cobertura
    pdf.set_font("Helvetica", "B", 11)
    pdf.cell(0, 10, "2. Criterios de viabilidad: Biofísica, Legalidad (OTBN) y Cobertura", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(2)
    
    pdf.set_font("Helvetica", "", 9)
    texto = (
        "El dictamen final del territorio integra tres filtros independientes: "
        "(1) Aptitud Biofísica Base, que mide la calidad edafoclimática (0-100%); "
        "(2) Cobertura Legal OTBN, que exige un cumplimiento mínimo del 98% bajo la Ley N° 26.331; y "
        "(3) Compatibilidad de Uso de Suelo (MapBiomas), que actúa como filtro binario (100% idóneo, "
        "0% si solapa con áreas urbanas, agua o usos excluidos). Un polígono es habilitado únicamente "
        "si aprueba los tres criterios en simultáneo."
            )
    pdf.multi_cell(0, 4, texto, new_x="LMARGIN", new_y="NEXT", align="J") 
    pdf.ln(2)
    pdf.image(io.BytesIO(foto_panel_3), x=15, w=180)
    pdf.ln(4)

    pdf.set_font("Helvetica", "B", 11)
    pdf.cell(0, 10, "3. Trazabilidad del Análisis Espacial", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(2)

    pdf.image(io.BytesIO(foto_panel_2), x=15, w=180)
    pdf.ln(4)

    # Exportación del buffer binario directo al navegador del usuario
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