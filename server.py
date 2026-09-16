import json
import os
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import create_engine, text

app = FastAPI(
    title="API de Soporte de Decisiones - Reforestación de Quebracho",
    description="Servicios geoespaciales para el visualizador interactivo de aptitud forestal",
    version="1.0.0"
)

# Permitir CORS para desarrollo local sin restricciones de puerto
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DB_URL = os.getenv(
    "DATABASE_URL", 
    "postgresql://postgres:postgre@localhost:5432/postgres"
)
engine = create_engine(DB_URL)

def safe_float(valor):
    """Protege la serialización JSON contra valores nulos de la base de datos."""
    if valor is None:
        return 0.00
    try:
        return round(float(valor), 2)
    except (ValueError, TypeError):
        return 0.00

@app.get("/api/aptitud-suelos")
def obtener_aptitud_suelos():
    """
    Consulta PostGIS y retorna los 429 polígonos en formato estándar GeoJSON (EPSG 4326).
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
