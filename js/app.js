// ==========================================
// CONFIGURACIÓN DE SUPABASE
// ==========================================
const SUPABASE_URL = "https://zhzvztpfwtalxgdqxdmf.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpoenZ6dHBmd3RhbHhnZHF4ZG1mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEzMTUxMjcsImV4cCI6MjEwNjg5MTEyN30.TOEkXRsz5lnfFRG5vHPIujj0EQsVo9Vhre5Q0_UMORU"; 

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Variables de estado global
let capaSeleccionada = null;
const capasPorId = {};

async function registrarAcceso(rol, email = 'anonimo') {
    try {
        await supabaseClient
            .from('registros_acceso')
            .insert([{ 
                rol_usuario: rol, 
                email: email 
            }]);
        console.log(`Acceso registrado: ${rol}`);
    } catch (err) {
        console.error("Error registrando acceso:", err);
    }
}

async function registrarConsultaPoligono(idPoligono) {
    try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        const email = session?.user?.email || 'anonimo';
        const rol = session?.user?.app_metadata?.role === 'admin' ? 'admin' : 'visitante';

        await supabaseClient
            .from('registros_acceso')
            .insert([{ 
                rol_usuario: rol, 
                email: email,
                poligono_consultado: idPoligono
            }]);
        console.log(`Consulta registrada para el polígono #${idPoligono}`);
    } catch (err) {
        console.error("Error registrando consulta de polígono:", err);
    }
}

// ==========================================
// INICIALIZACIÓN DEL MAPA LEAFLET
// ==========================================
const map = L.map('map', {
    zoomControl: false
}).setView([-26.3, -60.8], 7.5);

L.control.zoom({ position: 'bottomright' }).addTo(map);

// Mapas de fondo: OpenStreetMap (por defecto) o imagen satelital con nombres de lugares
const fondoMapa = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors'
}).addTo(map);
const fondoSatelite = L.layerGroup([
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 19,
        attribution: 'Imágenes © Esri, Maxar, Earthstar Geographics y la comunidad de usuarios de SIG'
    }),
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 19, pane: 'shadowPane'
    })
]);

// Opacidad de relleno de los polígonos de aptitud (ajustable desde la leyenda)
let opacidadPoligonos = 0.7;

// Estilos dinámicos para los polígonos
function obtenerColor(clasificacion) {
    switch (clasificacion) {
        case 'Apto - Reforestación productiva (Zona verde)': return '#22c55e'; // Verde
        case 'Apto - Enriquecimiento sostenible (Zona amarilla)':  return '#eab308'; // Amarillo
        case 'Apto - Prioridad restauración ecológica (Zona roja)':return '#ef4444'; // Rojo (pero apto biofísico)
        case 'No apto (Uso excluido)':                             return '#6b7280'; // Gris (MapBiomas)
        default:                                                   return '#1e293b'; // Gris Oscuro (No apto biofísico)
    }
}

function estiloFeature(feature) {
    return {
        fillColor: VISTAS[vistaActual].color(feature.properties),
        weight: 1.2,
        opacity: 1,
        color: '#ffffff',
        fillOpacity: opacidadPoligonos
    };
}

function resaltarPoligono(layer) {
    if (capaSeleccionada && capaSeleccionada !== layer) {
        capaSeleccionada.setStyle(estiloFeature(capaSeleccionada.feature));
    }

    capaSeleccionada = layer;

    layer.setStyle({
        color: '#161d2d',    // Borde negro/oscuro destacado
        weight: 3.5,         // Borde grueso
        fillOpacity: Math.min(0.95, opacidadPoligonos + 0.25)
    });

    layer.bringToFront();
}

// ==========================================
// VISTAS DEL MAPA: recomendación final, idoneidad biofísica y zonificación OTBN
// ==========================================
// Mismas reglas que el modelo (reforestacion_pipeline.py y validacion_censo.py)
function esAptoBiofisico(p) {
    return (p.aptitud_biofisica || 0) >= 0.60 && (p.aptitud_suelo || 0) > 0.40;
}
function claseFAO(p) {
    const a = p.aptitud_biofisica || 0;
    if ((p.aptitud_suelo || 0) <= 0.40 || a < 0.40) return 'N';
    if (a < 0.60) return 'S3';
    if (a < 0.80) return 'S2';
    return 'S1';
}
function composicionOTBN(p) {
    const rojo = p.pct_rojo || 0, amarillo = p.pct_amarillo || 0, verde = p.pct_verde || 0;
    const libre = Math.max(0, 100 - rojo - amarillo - verde);
    return { rojo, amarillo, verde, libre };
}
// Zona que define el tipo de intervención (regla del modelo: verde si no dominan roja ni amarilla)
function zonaModelo(p) {
    const c = composicionOTBN(p);
    if (c.rojo > c.amarillo && c.rojo > c.verde) return 'roja';
    if (c.amarillo > c.rojo && c.amarillo > c.verde) return 'amarilla';
    return 'verde';
}
// Zona con mayor superficie, distinguiendo la superficie sin bosque nativo categorizado (vista OTBN)
function zonaMayoritaria(p) {
    const c = composicionOTBN(p);
    return Object.entries({ roja: c.rojo, amarilla: c.amarillo, verde: c.verde, libre: c.libre })
        .sort((a, b) => b[1] - a[1])[0][0];
}

const FAO = {
    S1: { color: '#1e3a8a', nombre: 'Óptima (S1)', detalle: 'aptitud biofísica ≥ 0.80' },
    S2: { color: '#3b82f6', nombre: 'Moderada (S2)', detalle: '0.60 a 0.80 · apta' },
    S3: { color: '#93c5fd', nombre: 'Marginal (S3)', detalle: '0.40 a 0.60 · no alcanza el umbral' },
    N:  { color: '#e2e8f0', nombre: 'No apta (N)', detalle: 'menor a 0.40 o suelo restrictivo' },
};
const ZONAS_OTBN = {
    roja:     { color: '#dc2626', nombre: 'Zona roja (categoría I)', detalle: 'muy alto valor de conservación' },
    amarilla: { color: '#facc15', nombre: 'Zona amarilla (categoría II)', detalle: 'mediano valor de conservación' },
    verde:    { color: '#16a34a', nombre: 'Zona verde (categoría III)', detalle: 'bajo valor de conservación' },
    libre:    { color: '#a8a29e', nombre: 'Sin categoría OTBN', detalle: 'superficie sin bosque nativo (cultivos, pasturas, desmontes, áreas urbanas o vegetación no boscosa)' },
};

const VISTAS = {
    final: {
        titulo: 'Recomendación final',
        descripcion: 'Combina la idoneidad biofísica, la cobertura actual y la zonificación OTBN.',
        color: p => obtenerColor(p.clasificacion_final),
        leyenda: () => [
            ['#22c55e', 'Apto · reforestación productiva (zona verde)'],
            ['#eab308', 'Apto · enriquecimiento sostenible (zona amarilla)'],
            ['#ef4444', 'Apto · prioridad restauración (zona roja)'],
            ['#6b7280', 'No apto · uso del suelo excluido'],
            ['#1e293b', 'No apto biofísicamente'],
        ],
    },
    biofisica: {
        titulo: 'Idoneidad biofísica',
        descripcion: 'Calculada por el modelo a partir de suelo, lluvia y NDVI. No considera la normativa.',
        color: p => FAO[claseFAO(p)].color,
        leyenda: () => Object.values(FAO).map(c => [c.color, `${c.nombre}: ${c.detalle}`]),
    },
    otbn: {
        titulo: 'Zonificación OTBN',
        descripcion: 'Restricción normativa (Ley 26.331). La OTBN solo zonifica el bosque nativo: donde no hay bosque, el territorio queda sin categoría. Cada polígono toma el color de la zona con mayor superficie.',
        color: p => ZONAS_OTBN[zonaMayoritaria(p)].color,
        leyenda: () => Object.values(ZONAS_OTBN).map(z => [z.color, `${z.nombre}: ${z.detalle}`]),
    },
};
let vistaActual = 'final';

function dibujarLeyendaVista() {
    const v = VISTAS[vistaActual];
    document.querySelectorAll('.vista-btn').forEach(b => b.classList.toggle('activo', b.dataset.vista === vistaActual));
    document.getElementById('leyenda-vista').innerHTML = `
        <p class="vista-descripcion">${v.descripcion}</p>
        ${v.leyenda().map(([color, texto]) => `
            <div class="legend-item"><div class="legend-color" style="background:${color};"></div> ${texto}</div>`).join('')}`;
}

function cambiarVista(vista) {
    vistaActual = vista;
    dibujarLeyendaVista();
    if (geojsonLayer) geojsonLayer.eachLayer(l => {
        l.setStyle(estiloFeature(l.feature));
        if (l === capaSeleccionada) resaltarPoligono(l);
    });
}

// ==========================================
// PANEL DE DIAGNÓSTICO
// ==========================================
const RECOMENDACIONES = {
    roja: { clase: 'restoration', icono: '🔴', titulo: 'Restauración ecológica',
            texto: 'La mayor superficie del polígono corresponde a zona roja. Solo admite proyectos de restauración y preservación, sin alterar la estructura del bosque circundante.' },
    amarilla: { clase: 'warning', icono: '🟨', titulo: 'Enriquecimiento sostenible',
            texto: 'La mayor superficie corresponde a zona amarilla. Admite plantar quebracho en parches degradados, abrir líneas de enriquecimiento o clausurar sectores para proteger a los plantines del ganado, sin desmonte.' },
    verde: { clase: 'pass', icono: '🟩', titulo: 'Reforestación productiva',
            texto: 'Predomina la zona verde o la superficie sin bosque nativo categorizado. Idóneo para plantaciones en bloque o cortinas forestales de quebracho colorado.' },
};

// Cadena de decisión: 1) idoneidad biofísica → 2) cobertura actual → 3) zonificación OTBN
function textoZona(props) {
    const zona = zonaModelo(props), comp = composicionOTBN(props);
    if (zona === 'verde' && comp.verde < comp.libre) return 'predomina la superficie sin categoría OTBN (sin bosque nativo), que el modelo asimila a la zona verde';
    return `domina la zona ${zona}`;
}

function generarDiagnostico(props) {
    const apto = esAptoBiofisico(props);
    const fao = FAO[claseFAO(props)];
    const excluido = (props.clasificacion_final || '').includes('excluido');
    const zona = zonaModelo(props);

    const paso = (estado, etiqueta, valor) => `
        <li class="paso ${estado}"><span class="paso-icono">${estado === 'ok' ? '✓' : estado === 'no' ? '✕' : '–'}</span>
            <span><b>${etiqueta}</b> ${valor}</span></li>`;

    const pasos = [
        paso(apto ? 'ok' : 'no', 'Idoneidad biofísica (modelo):',
             `${apto ? 'apta' : 'no apta'} · ${fao.nombre}, ${(props.aptitud_biofisica || 0).toFixed(2)}`),
        apto ? paso(excluido ? 'no' : 'ok', 'Cobertura actual (MapBiomas):',
                    excluido ? `excluida${props.uso_nombre ? ' · ' + escHTML(props.uso_nombre) : ''}` : `compatible${props.uso_nombre ? ' · ' + escHTML(props.uso_nombre) : ''}`)
             : paso('na', 'Cobertura actual (MapBiomas):', 'no se evalúa'),
        apto && !excluido ? paso('ok', 'Zonificación OTBN (normativa):', textoZona(props))
             : paso('na', 'Zonificación OTBN (normativa):', 'no define intervención'),
    ].join('');

    let resultado;
    if (!apto) {
        const motivos = [];
        if ((props.aptitud_suelo || 0) <= 0.40) motivos.push('el suelo es severamente restrictivo (aptitud del suelo ≤ 0.40)');
        else motivos.push(`la aptitud biofísica (${(props.aptitud_biofisica || 0).toFixed(2)}) no alcanza el mínimo de 0.60`);
        resultado = `<div class="diagnostic-box fail"><b>⚪ Terreno no apto</b><p>Las condiciones de suelo, lluvia y vegetación no son suficientes: ${motivos.join('; ')}.</p></div>`;
    } else if (excluido) {
        resultado = `<div class="diagnostic-box fail"><b>⚪ No apto por uso del suelo</b><p>El suelo y el clima serían aptos, pero la cobertura predominante actual es incompatible con la intervención forestal.</p></div>`;
    } else {
        const r = RECOMENDACIONES[zona];
        resultado = `<div class="diagnostic-box ${r.clase}"><b>${r.icono} ${r.titulo}</b><p>${r.texto}</p></div>`;
    }

    return `
        <div class="card decision">
            <div class="card-title">Cómo se llegó a la recomendación</div>
            <ol class="cadena-decision">${pasos}</ol>
            ${resultado}
        </div>`;
}

function crearBarraProgreso(label, valor, umbral = null) {
    valor = valor || 0;
    const porcentaje = Math.min(Math.max(valor * 100, 0), 100).toFixed(0);
    return `
        <div class="metric-row">
            <div class="metric-label">
                <span>${label}</span>
                <b>${valor.toFixed(2)}</b>
            </div>
            <div class="progress-bar-bg">
                <div class="progress-bar-fill" style="width: ${porcentaje}%;"></div>
                ${umbral !== null ? `<div class="progress-umbral" style="left:${umbral * 100}%" title="Umbral ${umbral.toFixed(2)}"></div>` : ''}
            </div>
        </div>`;
}

function tarjetaBiofisica(props) {
    const fao = FAO[claseFAO(props)];
    return `
        <div class="card bloque-modelo">
            <div class="card-title"><span class="etiqueta-origen modelo">Modelo</span> Idoneidad biofísica</div>
            <p class="bloque-ayuda">Indicadores calculados por el sistema. No dependen de la normativa.</p>
            ${crearBarraProgreso('Aptitud del suelo (40 %)', props.aptitud_suelo, 0.40)}
            ${crearBarraProgreso('Aptitud de la lluvia (40 %)', props.aptitud_lluvia)}
            ${crearBarraProgreso('Aptitud del NDVI (20 %)', props.aptitud_ndvi)}
            <hr style="border:0; border-top: 1px solid #e2e8f0; margin: 8px 0;">
            ${crearBarraProgreso('Aptitud biofísica', props.aptitud_biofisica, 0.60)}
            <div class="clase-fao"><i style="background:${fao.color}"></i><span>Clase FAO: <b>${fao.nombre}</b></span></div>
            <div class="atributos-suelo">
                <b>Subgrupo:</b> ${escHTML(props.subgrupo || 'Sin datos')}<br>
                <b>Textura superficial:</b> ${escHTML(props.textura || 'Sin datos')}
            </div>
            <p class="bloque-nota">Las marcas verticales indican los umbrales del modelo: suelo mayor a 0.40 y aptitud biofísica de al menos 0.60.</p>
        </div>`;
}

function tarjetaOTBN(props) {
    const c = composicionOTBN(props);
    const segmentos = [['roja', c.rojo], ['amarilla', c.amarillo], ['verde', c.verde], ['libre', c.libre]].filter(([, v]) => v > 0);
    const zona = zonaModelo(props);
    return `
        <div class="card bloque-normativa">
            <div class="card-title"><span class="etiqueta-origen normativa">Normativa</span> Zonificación OTBN (Ley 26.331)</div>
            <p class="bloque-ayuda">Restricción legal: indica qué tipo de intervención se permite, no si el terreno es idóneo.
                <a href="#" class="ayuda-link" onclick="abrirGuia('composicion'); return false;">¿cómo se calcula?</a></p>
            <div class="otbn-barra">${segmentos.map(([z, v]) => `<span style="width:${v}%;background:${ZONAS_OTBN[z].color}" title="${ZONAS_OTBN[z].nombre}: ${v.toFixed(1)} %"></span>`).join('')}</div>
            <ul class="otbn-lista">${segmentos.map(([z, v]) => `
                <li><i style="background:${ZONAS_OTBN[z].color}"></i>${ZONAS_OTBN[z].nombre}<b>${v.toFixed(1)} %</b></li>`).join('')}</ul>
            <p class="bloque-nota">Define la intervención: <b>${textoZona(props)}</b>.</p>
        </div>`;
}

// Cobertura predominante del polígono según MapBiomas (la que evalúa el filtro de uso excluido)
function tarjetaCobertura(props) {
    if (!props.uso_nombre) return '';
    let nota = '';
    if (props.uso_excluido === true) {
        nota = `<p class="cobertura-nota excluida">Cobertura excluida por el modelo: no se recomienda intervención forestal.</p>`;
    } else if (props.uso_excluido === false) {
        nota = `<p class="cobertura-nota compatible">Cobertura compatible con la intervención forestal.</p>`;
    }
    return `
        <div class="card bloque-cobertura">
            <div class="card-title"><span class="etiqueta-origen cobertura">Cobertura</span> Uso actual del suelo (MapBiomas)</div>
            <div class="cobertura-fila">
                <i style="background:${props.uso_color}"></i>
                <span><b>${escHTML(props.uso_nombre)}</b>${props.uso_codigo ? ` · código ${props.uso_codigo}` : ''}</span>
            </div>
            <p class="bloque-nota">Clase predominante dentro del polígono.</p>
            ${nota}
        </div>`;
}

function seleccionarPoligono(feature, layer, registrar = true) {
    resaltarPoligono(layer);
    const props = feature.properties;
    if (props.id && registrar) {
        registrarConsultaPoligono(props.id);
    }
    const container = document.getElementById('detalle-suelo');

    let badgeClass = 'badge-danger';
    const claseTexto = props.clasificacion_final || "";
    if (claseTexto.includes('verde')) badgeClass = 'badge-success';
    else if (claseTexto.includes('Enriquecimiento sostenible')) badgeClass = 'badge-warning';
    else if (claseTexto.includes('Uso excluido')) badgeClass = 'badge-secondary';

    container.innerHTML = `
        <div style="margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; gap: 8px;">
            <span style="font-size: 14px; font-weight: 700;">Polígono #${props.id}</span>
            <span class="badge ${badgeClass}">${escHTML(props.clasificacion_final || '')}</span>
        </div>

        ${generarDiagnostico(props)}
        ${tarjetaBiofisica(props)}
        ${tarjetaCobertura(props)}
        ${tarjetaOTBN(props)}

        <button class="btn-reporte-pdf" onclick="descargarReportePDF(${props.id})">
            📄 Generar reporte técnico (PDF)
        </button>
    `;
}

function onEachFeature(feature, layer) {
    if (feature.properties && feature.properties.id) {
        capasPorId[feature.properties.id] = layer;
    }

    layer.on({
        mouseover: function(e) {
            if (layer !== capaSeleccionada) {
                e.target.setStyle({ fillOpacity: Math.min(0.9, opacidadPoligonos + 0.2), weight: 2.5 });
            }
        },
        mouseout: function(e) {
            if (layer !== capaSeleccionada) {
                layer.setStyle(estiloFeature(feature));
            }
        },
        click: function(e) {
            seleccionarPoligono(feature, layer);
        }
    });
}

// ==========================================
// CARGA DE DATOS DESDE FASTAPI (RENDER)
// ==========================================
const API_BASE = 'https://sdss-backend-69r5.onrender.com';
//const API_BASE = 'http://localhost:8000';

let geojsonLayer; // Declaramos la variable global para usarla en el buscador

// Carga (o recarga, tras reprocesar el modelo) la capa de polígonos
function cargarPoligonos() {
    // cache: 'no-store' evita que el navegador reutilice un mapa anterior tras reprocesar el modelo
    return fetch(`${API_BASE}/api/aptitud-suelos`, { cache: 'no-store' })
        .then(response => {
            if (!response.ok) throw new Error("Error en la respuesta de la red");
            return response.json();
        })
        .then(geoJsonData => {
            const idSeleccionado = capaSeleccionada?.feature?.properties?.id;
            if (geojsonLayer) {
                map.removeLayer(geojsonLayer);
                capaSeleccionada = null;
                Object.keys(capasPorId).forEach(k => delete capasPorId[k]);
            }
            // Guardamos la capa generada en la variable global
            geojsonLayer = L.geoJSON(geoJsonData, {
                style: estiloFeature,
                onEachFeature: onEachFeature
            }).addTo(map);
            // Si había un polígono abierto en el panel, se vuelve a mostrar con los valores nuevos
            if (idSeleccionado && capasPorId[idSeleccionado]) {
                const capa = capasPorId[idSeleccionado];
                seleccionarPoligono(capa.feature, capa, false);
            }
        })
        .catch(error => {
            console.error("Error cargando los polígonos:", error);
            document.getElementById('detalle-suelo').innerHTML = `<p style="color:red; font-size: 12px;">Error de conexión con la API FastAPI.</p>`;
        });
}

cargarPoligonos();

// ==========================================
// LÓGICA DEL BUSCADOR POR COORDENADAS
// ==========================================
const inputCoords = document.getElementById('search-coords');
const btnSearchCoords = document.getElementById('btn-search-coords');

function ejecutarBusquedaCoordenadas() {
    if (!geojsonLayer) return alert('El mapa aún está cargando los datos. Intenta en unos segundos.');
    
    const inputVal = inputCoords.value.trim();
    if (!inputVal) return;

    // Separar latitud y longitud
    const partes = inputVal.split(',');
    if (partes.length !== 2) return alert('Formato incorrecto. Usa: Latitud, Longitud (ej: -26.8, -60.5)');

    const lat = parseFloat(partes[0].trim());
    const lng = parseFloat(partes[1].trim());

    if (isNaN(lat) || isNaN(lng)) return alert('Coordenadas inválidas. Solo se aceptan números.');

    // Turf.js requiere el orden [Longitud, Latitud] para el análisis
    const punto = turf.point([lng, lat]);
    let encontrado = false;

    // Recorremos la capa que guardamos previamente
    geojsonLayer.eachLayer((layer) => {
        if (encontrado) return; // Cortar el ciclo si ya lo encontró

        // Turf verifica si el punto matemático cae dentro del polígono
        if (turf.booleanPointInPolygon(punto, layer.feature)) {
            encontrado = true;
            
            // Movemos la cámara del mapa hacia el polígono
            map.flyToBounds(layer.getBounds(), { maxZoom: 11, duration: 1.2 });
            
            // Reutilizamos tu función existente para resaltar y abrir el panel
            seleccionarPoligono(layer.feature, layer);
        }
    });

    if (!encontrado) {
        alert('Las coordenadas ingresadas no caen dentro de la zona de estudio del Chaco.');
    }
}

if (btnSearchCoords) btnSearchCoords.addEventListener('click', ejecutarBusquedaCoordenadas);
if (inputCoords) inputCoords.addEventListener('keypress', (e) => { if (e.key === 'Enter') ejecutarBusquedaCoordenadas(); });

// ==========================================
// REGISTRO DE AUDITORÍA Y ACCESOS
// ==========================================
async function registrarAcceso(rol, email = 'anonimo') {
    try {
        await supabaseClient
            .from('registros_acceso')
            .insert([{ rol_usuario: rol, email: email }]);
    } catch (err) {
        console.log("Nota: Registro de visitas no activo en Supabase aún.");
    }
}

// ==========================================
// AUTENTICACIÓN Y PORTAL DE ENTRADA
// ==========================================
const loginModal = document.getElementById("login-modal");
const accessOptions = document.querySelector(".access-options");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const userBadge = document.getElementById("user-badge");

const btnEnterVisitor = document.getElementById("btn-enter-visitor");
const btnToggleAdmin = document.getElementById("btn-toggle-admin");
const btnBackOptions = document.getElementById("btn-back-options");
const btnLoginTrigger = document.getElementById("btn-login-trigger");
const btnLogout = document.getElementById("btn-logout");

// Entrar como Visitante
if (btnEnterVisitor) {
    btnEnterVisitor.addEventListener("click", () => {
        if (loginModal) loginModal.classList.add("hidden");
        actualizarInterfazUsuario(null);
        registrarAcceso('visitante');
    });
}

// Mostrar/Ocultar Formulario de Login Admin
if (btnToggleAdmin) {
    btnToggleAdmin.addEventListener("click", () => {
        if (accessOptions) accessOptions.classList.add("hidden");
        if (loginForm) loginForm.classList.remove("hidden");
    });
}

if (btnBackOptions) {
    btnBackOptions.addEventListener("click", () => {
        if (loginForm) loginForm.classList.add("hidden");
        if (accessOptions) accessOptions.classList.remove("hidden");
    });
}

// Reabrir portal desde el botón superior
if (btnLoginTrigger) {
    btnLoginTrigger.addEventListener("click", () => {
        if (loginModal) {
            loginModal.classList.remove("hidden");
            if (loginForm) loginForm.classList.add("hidden");
            if (accessOptions) accessOptions.classList.remove("hidden");
        }
    });
}

// Submit Formulario Login
if (loginForm) {
    loginForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (loginError) loginError.classList.add("hidden");

        const email = document.getElementById("login-email").value.trim();
        const password = document.getElementById("login-password").value.trim();

        const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });

        if (error) {
            if (loginError) {
                loginError.textContent = "Error de acceso: " + error.message;
                loginError.classList.remove("hidden");
            }
        } else {
            if (loginModal) loginModal.classList.add("hidden");
            actualizarInterfazUsuario(data.user);
            registrarAcceso('admin', email);
        }
    });
}

// Cerrar Sesión
if (btnLogout) {
    btnLogout.addEventListener("click", async () => {
        await supabaseClient.auth.signOut();
        actualizarInterfazUsuario(null);
    });
}

// Actualizar Roles en Interfaz y habilitar vistas exclusivas
function construirMenuAdmin() {
    const cont = document.createElement("div");
    cont.id = "admin-controls";
    cont.className = "admin-menu hidden";
    cont.innerHTML = `
        <button id="admin-menu-toggle" class="admin-menu-toggle" type="button" aria-haspopup="true" aria-expanded="false">
            <span class="admin-menu-icono">⚙️</span> Administración <span class="admin-menu-indicador" title="Reprocesando el modelo"></span><span class="admin-menu-flecha">▾</span>
        </button>
        <div id="admin-menu-lista" class="admin-menu-lista hidden" role="menu">
            <div class="admin-menu-sesion">
                <span>Sesión de administrador</span>
                <b id="admin-menu-email"></b>
            </div>
            <button type="button" role="menuitem" id="btn-dashboard"><span>📊</span> Auditoría de consultas</button>
            <button type="button" role="menuitem" id="btn-parametros"><span>🧪</span> Parámetros edáficos</button>
            <button type="button" role="menuitem" id="btn-run-pipeline"><span>🔄</span> Reprocesar modelo</button>
            <hr>
            <button type="button" role="menuitem" id="btn-admin-logout" class="admin-menu-salir"><span>↩</span> Cerrar sesión</button>
        </div>
    `;
    if (btnLogout && btnLogout.parentNode) btnLogout.parentNode.insertBefore(cont, btnLogout);

    const toggle = cont.querySelector("#admin-menu-toggle");
    const lista = cont.querySelector("#admin-menu-lista");
    const cerrar = () => { lista.classList.add("hidden"); toggle.setAttribute("aria-expanded", "false"); };
    toggle.addEventListener("click", e => {
        e.stopPropagation();
        const abrir = lista.classList.contains("hidden");
        lista.classList.toggle("hidden", !abrir);
        toggle.setAttribute("aria-expanded", String(abrir));
    });
    document.addEventListener("click", e => { if (!cont.contains(e.target)) cerrar(); });
    document.addEventListener("keydown", e => { if (e.key === "Escape") cerrar(); });
    const accion = (id, fn) => cont.querySelector("#" + id).addEventListener("click", () => { cerrar(); fn(); });
    accion("btn-dashboard", abrirPanelAuditoria);
    accion("btn-parametros", abrirParametrosEdaficos);
    accion("btn-run-pipeline", ejecutarPipelineRemoto);
    accion("btn-admin-logout", () => btnLogout && btnLogout.click());
    return cont;
}

function actualizarInterfazUsuario(user) {
    const adminControls = document.getElementById("admin-controls") || construirMenuAdmin();
    // El rol se lee de app_metadata, que el usuario no puede modificar (el backend aplica la misma regla)
    const esAdmin = !!user && (user.app_metadata?.role === 'admin');

    // Insignia: solo para visitantes; el administrador se identifica por su menú
    userBadge.textContent = "Modo: Visitante";
    userBadge.classList.add("visitor");
    userBadge.classList.remove("admin");
    userBadge.classList.toggle("hidden", esAdmin);

    adminControls.classList.toggle("hidden", !esAdmin);
    if (esAdmin) {
        document.getElementById("admin-menu-email").textContent = user.email || "";
        // Si el pipeline ya estaba corriendo (p. ej. se recargó la página), retomamos el seguimiento
        retomarPipelineSiCorre();
    }

    if (btnLoginTrigger) btnLoginTrigger.classList.toggle("hidden", !!user);
    // El administrador cierra sesión desde su menú; otros usuarios autenticados, con el botón
    if (btnLogout) btnLogout.classList.toggle("hidden", !user || esAdmin);
}

// Verificar sesión existente al cargar la página o recargar estados
supabaseClient.auth.getSession().then(({ data: { session } }) => {
    if (session) {
        if (loginModal) loginModal.classList.add("hidden");
        actualizarInterfazUsuario(session.user);
    } else {
        actualizarInterfazUsuario(null);
    }
});

// Listener adicional para detectar cambios de estado de autenticación globales
supabaseClient.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') {
        actualizarInterfazUsuario(null);
    } else if (event === 'SIGNED_IN' && session) {
        actualizarInterfazUsuario(session.user);
    }
});

// ==========================================
// FUNCIÓN PARA DESCARGAR EL REPORTE PDF
// ==========================================
function descargarReportePDF(poligonoId) {
    if (!poligonoId) {
        alert("ID de polígono inválido.");
        return;
    }
    
    const BACKEND_URL = API_BASE;
    
    // Apuntamos al endpoint dinámico de FPDF2 que agregamos en server.py
    const urlEndpoint = `${BACKEND_URL}/api/v1/poligonos/${poligonoId}/reporte-pdf`;
    
    // Redireccionamos el navegador a la URL del backend. 
    // Al tener la cabecera Content-Disposition, el navegador no abandonará 
    // la aplicación de Leaflet, simplemente iniciará la descarga en segundo plano.
    window.location.href = urlEndpoint;
} 

// ==========================================
// FUNCIONES EXCLUSIVAS DEL ADMINISTRADOR
// ==========================================

const PERIODOS_AUDITORIA = {
    dia:    { etiqueta: "Hoy",            desde: () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; } },
    semana: { etiqueta: "Últimos 7 días",  desde: () => new Date(Date.now() - 7 * 864e5) },
    mes:    { etiqueta: "Últimos 30 días", desde: () => new Date(Date.now() - 30 * 864e5) },
    todo:   { etiqueta: "Todo el período", desde: () => null },
};
let periodoAuditoria = "semana";

async function abrirPanelAuditoria() {
    let dashboardModal = document.getElementById("dashboard-modal");

    // El modal se crea dinámicamente la primera vez
    if (!dashboardModal) {
        dashboardModal = document.createElement("div");
        dashboardModal.id = "dashboard-modal";
        dashboardModal.className = "auditoria-modal";
        dashboardModal.innerHTML = `
            <div class="auditoria-header">
                <h2>📊 Panel de auditoría</h2>
                <button id="btn-close-dashboard" class="pipeline-close" type="button" aria-label="Cerrar">✕</button>
            </div>
            <p class="auditoria-sub">Polígonos más consultados por los usuarios del sistema.</p>
            <div class="auditoria-filtros" role="group" aria-label="Período">
                ${Object.entries(PERIODOS_AUDITORIA).map(([clave, p]) =>
                    `<button type="button" class="auditoria-filtro" data-periodo="${clave}">${p.etiqueta}</button>`).join("")}
            </div>
            <div id="dashboard-content"></div>
        `;
        document.body.appendChild(dashboardModal);
        document.getElementById("btn-close-dashboard").addEventListener("click", () => dashboardModal.classList.add("hidden"));
        dashboardModal.querySelectorAll(".auditoria-filtro").forEach(b => b.addEventListener("click", () => {
            periodoAuditoria = b.dataset.periodo;
            cargarAuditoria();
        }));
    }
    dashboardModal.classList.remove("hidden");
    cargarAuditoria();
}

async function cargarAuditoria() {
    const contentDiv = document.getElementById("dashboard-content");
    document.querySelectorAll(".auditoria-filtro").forEach(b => b.classList.toggle("activo", b.dataset.periodo === periodoAuditoria));
    contentDiv.innerHTML = '<p class="auditoria-vacio">Cargando métricas…</p>';

    try {
        // Requiere que el administrador tenga permiso de lectura sobre 'registros_acceso' (RLS)
        let consulta = supabaseClient
            .from('registros_acceso')
            .select('poligono_consultado, created_at')
            .not('poligono_consultado', 'is', null);
        const desde = PERIODOS_AUDITORIA[periodoAuditoria].desde();
        if (desde) consulta = consulta.gte('created_at', desde.toISOString());

        const { data, error } = await consulta;
        if (error) throw error;

        if (!data || data.length === 0) {
            contentDiv.innerHTML = `<p class="auditoria-vacio">No hay consultas registradas en este período (${PERIODOS_AUDITORIA[periodoAuditoria].etiqueta.toLowerCase()}).</p>`;
            return;
        }

        // Conteo de consultas y fecha de la última consulta por polígono
        const resumen = {};
        data.forEach(row => {
            const id = row.poligono_consultado;
            const r = resumen[id] || (resumen[id] = { id: Number(id), visitas: 0, ultima: null });
            r.visitas++;
            if (row.created_at && (!r.ultima || row.created_at > r.ultima)) r.ultima = row.created_at;
        });
        const ranking = Object.values(resumen).sort((a, b) => b.visitas - a.visitas);
        const fmt = iso => iso ? new Date(iso).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" }) : "—";

        contentDiv.innerHTML = `
            <p class="auditoria-total"><b>${data.length}</b> consultas sobre <b>${ranking.length}</b> polígonos · ${PERIODOS_AUDITORIA[periodoAuditoria].etiqueta}</p>
            <table class="auditoria-tabla">
                <thead><tr><th>#</th><th>Polígono</th><th>Consultas</th><th>Última consulta</th><th></th></tr></thead>
                <tbody>
                    ${ranking.map((p, i) => `
                        <tr>
                            <td>${i + 1}</td>
                            <td>#${p.id}</td>
                            <td><div class="auditoria-barra"><span style="width:${(p.visitas / ranking[0].visitas * 100).toFixed(0)}%"></span><b>${p.visitas}</b></div></td>
                            <td>${fmt(p.ultima)}</td>
                            <td><button type="button" class="btn-outline auditoria-ver" onclick="buscarDesdeDashboard(${p.id})">Ver en mapa</button></td>
                        </tr>`).join("")}
                </tbody>
            </table>`;
    } catch (err) {
        console.error("Error cargando auditoría:", err);
        contentDiv.innerHTML = `<p style="color:#b91c1c;">Error al cargar datos: ${escHTML(err.message)}</p>`;
    }
}

// Cierra el panel, centra el mapa en el polígono y abre su diagnóstico (sin contarlo como consulta)
window.buscarDesdeDashboard = function (idPoligono) {
    const dashboardModal = document.getElementById("dashboard-modal");
    if (dashboardModal) dashboardModal.classList.add("hidden");
    const capa = capasPorId[idPoligono];
    if (!capa) { alert(`El polígono #${idPoligono} no está en el mapa actual.`); return; }
    map.flyToBounds(capa.getBounds(), { maxZoom: 11, duration: 1.2 });
    seleccionarPoligono(capa.feature, capa, false);
};

// ==========================================
// REPROCESAMIENTO DEL MODELO (PIPELINE main.py)
// ==========================================
const pipelineUI = {
    modal:    document.getElementById("pipeline-modal"),
    confirm:  document.getElementById("pipeline-confirm"),
    progress: document.getElementById("pipeline-progress"),
    steps:    document.getElementById("pipeline-steps"),
    bar:      document.getElementById("pipeline-bar"),
    message:  document.getElementById("pipeline-message"),
    badge:    document.getElementById("pipeline-status-badge"),
    timer:    document.getElementById("pipeline-timer"),
    log:      document.getElementById("pipeline-log"),
    error:    document.getElementById("pipeline-error"),
    btnClose:  document.getElementById("pipeline-close"),
    btnCancel: document.getElementById("pipeline-cancel"),
    btnAccept: document.getElementById("pipeline-accept"),
    btnHide:   document.getElementById("pipeline-hide"),
    btnDone:   document.getElementById("pipeline-done"),
};

let pipelinePollId = null;
let pipelineTimerId = null;
let pipelineInicio = null;
let pipelineEtapasDibujadas = null;
let pipelineFallosConsecutivos = 0;
let pipelineUltimoEstado = null;   // último estado "ejecutando" recibido del servidor

async function obtenerTokenAdmin() {
    const { data: { session }, error } = await supabaseClient.auth.getSession();
    if (error || !session) throw new Error("No se encontró una sesión activa. Vuelve a iniciar sesión.");
    return session.access_token;
}

function botonPipeline() { return document.getElementById("btn-run-pipeline"); }

function marcarBotonPipeline(enCurso) {
    const btn = botonPipeline();
    if (!btn) return;
    btn.classList.toggle("running", enCurso);
    btn.innerHTML = enCurso ? "<span>⏳</span> Procesando… ver progreso" : "<span>🔄</span> Reprocesar modelo";
    const toggle = document.getElementById("admin-menu-toggle");
    if (toggle) toggle.classList.toggle("procesando", enCurso);
}

function mostrarModalPipeline(vista) {
    pipelineUI.modal.classList.remove("hidden");
    pipelineUI.confirm.classList.toggle("hidden", vista !== "confirm");
    pipelineUI.progress.classList.toggle("hidden", vista !== "progress");
}

function ocultarModalPipeline() {
    pipelineUI.modal.classList.add("hidden");
}

// Punto de entrada del botón "Reprocesar modelo"
function ejecutarPipelineRemoto() {
    // Si ya hay un proceso siguiéndose, el botón solo vuelve a mostrar el progreso
    if (pipelinePollId) {
        mostrarModalPipeline("progress");
        return;
    }
    pipelineUI.btnAccept.disabled = false;
    pipelineUI.btnAccept.textContent = "Sí, reprocesar";
    mostrarModalPipeline("confirm");
}

async function iniciarPipeline() {
    pipelineUI.btnAccept.disabled = true;
    pipelineUI.btnAccept.textContent = "Iniciando…";

    try {
        const token = await obtenerTokenAdmin();
        const response = await fetch(`${API_BASE}/api/admin/run-etl`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            }
        });
        const data = await response.json().catch(() => ({}));

        if (response.ok || response.status === 409) {
            // 409 = ya estaba corriendo: igual mostramos su progreso
            prepararVistaProgreso(data.etapas);
            mostrarModalPipeline("progress");
            iniciarSeguimientoPipeline();
        } else {
            throw new Error(data.detail || `Error ${response.status} al iniciar el pipeline.`);
        }
    } catch (err) {
        console.error("Error al iniciar el pipeline:", err);
        prepararVistaProgreso();
        mostrarModalPipeline("progress");
        renderizarEstadoPipeline({ estado: "error", error: err.message, mensaje: "No fue posible iniciar el pipeline" });
    }
}

function prepararVistaProgreso(etapas) {
    pipelineUI.error.classList.add("hidden");
    pipelineUI.btnDone.classList.add("hidden");
    pipelineUI.btnHide.classList.remove("hidden");
    pipelineUI.btnClose.disabled = false;
    pipelineUI.bar.className = "pipeline-bar-fill";
    pipelineUI.bar.style.width = "0%";
    pipelineUI.badge.className = "pipeline-badge running";
    pipelineUI.badge.textContent = "En ejecución";
    pipelineUI.message.textContent = "Iniciando...";
    pipelineUI.log.textContent = "";
    pipelineUI.timer.textContent = "00:00";
    pipelineEtapasDibujadas = null;
    if (etapas) dibujarEtapas(etapas);
}

function dibujarEtapas(etapas) {
    pipelineEtapasDibujadas = etapas;
    pipelineUI.steps.innerHTML = etapas.map((nombre, i) => `
        <li class="pipeline-step" data-idx="${i}">
            <span class="step-icon">${i + 1}</span>
            <span class="step-name">${nombre}</span>
            <span class="step-sub"></span>
        </li>`).join("");
}

function formatearDuracion(seg) {
    seg = Math.max(0, Math.floor(seg));
    const m = String(Math.floor(seg / 60)).padStart(2, "0");
    const s = String(seg % 60).padStart(2, "0");
    return `${m}:${s}`;
}

function renderizarEstadoPipeline(st) {
    const etapas = st.etapas || pipelineEtapasDibujadas || [];
    if (etapas.length && (!pipelineEtapasDibujadas || pipelineEtapasDibujadas.length !== etapas.length)) {
        dibujarEtapas(etapas);
    }
    const total = etapas.length || 1;
    const actual = st.etapa_actual ?? 0;

    // Estado visual de cada etapa
    pipelineUI.steps.querySelectorAll(".pipeline-step").forEach(li => {
        const idx = Number(li.dataset.idx);
        const icon = li.querySelector(".step-icon");
        const sub = li.querySelector(".step-sub");
        li.className = "pipeline-step";
        sub.textContent = "";
        icon.textContent = idx + 1;

        if (st.estado === "completado" || idx < actual) {
            li.classList.add("done");
            icon.textContent = "✓";
        } else if (idx === actual) {
            if (st.estado === "error") {
                li.classList.add("failed");
                icon.textContent = "✕";
            } else {
                li.classList.add("active");
                icon.textContent = "";
                if (st.subprogreso != null && st.subprogreso < 1) {
                    sub.textContent = `${Math.round(st.subprogreso * 100)}%`;
                }
            }
        }
    });

    // Barra global: etapas completas + fracción de la actual
    let pct;
    if (st.estado === "completado") pct = 100;
    else pct = ((Math.min(actual, total) + (st.subprogreso || 0)) / total) * 100;
    pipelineUI.bar.style.width = `${Math.min(pct, 100).toFixed(1)}%`;

    if (st.mensaje) pipelineUI.message.textContent = st.mensaje;
    if (st.log) {
        pipelineUI.log.textContent = st.log.join("\n");
        pipelineUI.log.scrollTop = pipelineUI.log.scrollHeight;
    }
    if (st.inicio && !pipelineInicio) pipelineInicio = new Date(st.inicio);

    if (st.estado === "completado") {
        finalizarSeguimientoPipeline();
        pipelineUI.badge.className = "pipeline-badge done";
        pipelineUI.badge.textContent = "Completado";
        pipelineUI.bar.classList.add("done");
        const r = st.resultado || {};
        pipelineUI.message.textContent =
            `✅ Modelo reprocesado${r.poligonos ? `: ${r.poligonos} polígonos actualizados` : ""}` +
            `${st.duracion_seg ? ` en ${formatearDuracion(st.duracion_seg)}` : ""}.` +
            (r.cambios ? ` Respecto del mapa anterior: ${r.cambios.aptitud_suelo} con otra aptitud de suelo y ${r.cambios.clasificacion} con otra categoría.` : "") +
            ` Actualizando mapa…`;
        if (st.duracion_seg) pipelineUI.timer.textContent = formatearDuracion(st.duracion_seg);
        cargarPoligonos().then(() => {
            pipelineUI.message.textContent = pipelineUI.message.textContent.replace("Actualizando mapa…", "Mapa actualizado.");
        });
    } else if (st.estado === "error") {
        finalizarSeguimientoPipeline();
        pipelineUI.badge.className = "pipeline-badge error";
        pipelineUI.badge.textContent = "Error";
        pipelineUI.bar.classList.add("error");
        pipelineUI.error.textContent = "❌ " + (st.error || "Error desconocido");
        pipelineUI.error.classList.remove("hidden");
        if (st.duracion_seg) pipelineUI.timer.textContent = formatearDuracion(st.duracion_seg);
    }
}

// Construye un estado de error conservando la última etapa conocida
function estadoErrorDesdeUltimo(mensajeError) {
    const ultimo = pipelineUltimoEstado || {};
    return {
        ...ultimo,
        estado: "error",
        subprogreso: null,
        mensaje: "El pipeline se detuvo",
        error: mensajeError,
    };
}

async function consultarEstadoPipeline() {
    try {
        const token = await obtenerTokenAdmin();
        const res = await fetch(`${API_BASE}/api/admin/etl-status`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const st = await res.json();
        pipelineFallosConsecutivos = 0;

        // El servidor respondió pero ya no tiene registro de la ejecución: se reinició a mitad de camino
        if (pipelineUltimoEstado && !st.en_progreso && st.estado === "inactivo") {
            const etapa = (pipelineUltimoEstado.etapas || [])[pipelineUltimoEstado.etapa_actual] || "desconocida";
            renderizarEstadoPipeline(estadoErrorDesdeUltimo(
                `El servidor se reinició durante la etapa «${etapa}» y la ejecución se perdió. ` +
                "En el plan gratuito de Render esto suele deberse a falta de memoria (revisa los logs del servicio)."
            ));
            return;
        }
        if (st.estado === "ejecutando") pipelineUltimoEstado = st;
        renderizarEstadoPipeline(st);
    } catch (err) {
        pipelineFallosConsecutivos++;
        console.warn("No se pudo consultar el estado del pipeline:", err);
        pipelineUI.message.textContent = "Reintentando conexión con el servidor…";
        // ~60 s sin respuesta (Render tarda en reiniciar un servicio caído)
        if (pipelineFallosConsecutivos >= 30) {
            renderizarEstadoPipeline(estadoErrorDesdeUltimo(
                "Se perdió la conexión con el servidor. El proceso podría seguir ejecutándose; vuelve a abrir este panel más tarde."
            ));
        }
    }
}

function iniciarSeguimientoPipeline() {
    detenerTimersPipeline();
    pipelineInicio = new Date();
    pipelineFallosConsecutivos = 0;
    pipelineUltimoEstado = null;
    marcarBotonPipeline(true);

    pipelineTimerId = setInterval(() => {
        pipelineUI.timer.textContent = formatearDuracion((Date.now() - pipelineInicio.getTime()) / 1000);
    }, 1000);

    consultarEstadoPipeline();
    pipelinePollId = setInterval(consultarEstadoPipeline, 2000);
}

function detenerTimersPipeline() {
    clearInterval(pipelinePollId);
    clearInterval(pipelineTimerId);
    pipelinePollId = null;
    pipelineTimerId = null;
}

function finalizarSeguimientoPipeline() {
    detenerTimersPipeline();
    pipelineInicio = null;
    marcarBotonPipeline(false);
    pipelineUI.btnHide.classList.add("hidden");
    pipelineUI.btnDone.classList.remove("hidden");
}

// Al iniciar sesión como admin: si el pipeline ya está corriendo, reabrimos su seguimiento
async function retomarPipelineSiCorre() {
    if (pipelinePollId) return;
    try {
        const token = await obtenerTokenAdmin();
        const res = await fetch(`${API_BASE}/api/admin/etl-status`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) return;
        const st = await res.json();
        if (st.en_progreso) {
            prepararVistaProgreso(st.etapas);
            iniciarSeguimientoPipeline();
            if (st.inicio) pipelineInicio = new Date(st.inicio);
            pipelineUltimoEstado = st;
            renderizarEstadoPipeline(st);
            mostrarModalPipeline("progress");
        }
    } catch (_) { /* silencioso */ }
}

// Listeners del modal
pipelineUI.btnAccept.addEventListener("click", iniciarPipeline);
pipelineUI.btnCancel.addEventListener("click", ocultarModalPipeline);
pipelineUI.btnClose.addEventListener("click", ocultarModalPipeline);
pipelineUI.btnHide.addEventListener("click", ocultarModalPipeline);
pipelineUI.btnDone.addEventListener("click", ocultarModalPipeline);


// ==========================================
// PARÁMETROS EDÁFICOS (solo administrador)
// Muestra el Excel de parámetros completo; solo la columna de puntaje es editable.
// ==========================================
const paramUI = {
    modal:   document.getElementById("param-modal"),
    tabs:    document.getElementById("param-tabs"),
    body:    document.getElementById("param-body"),
    filtro:  document.getElementById("param-filtro"),
    estado:  document.getElementById("param-estado"),
    mensaje: document.getElementById("param-mensaje"),
    btnGuardar:    document.getElementById("param-guardar"),
    btnDescargar:  document.getElementById("param-descargar"),
    btnCerrar:     document.getElementById("param-cerrar"),
    btnCerrarX:    document.getElementById("param-cerrar-x"),
    btnReprocesar: document.getElementById("param-reprocesar"),
};
let paramDatos = null;          // respuesta del backend
let paramCambios = new Map();   // id -> puntaje nuevo
let paramHoja = "parametros";   // pestaña activa

function escHTML(v) {
    return String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function fetchAdmin(ruta, opciones = {}) {
    const token = await obtenerTokenAdmin();
    const res = await fetch(`${API_BASE}${ruta}`, {
        ...opciones,
        headers: { ...(opciones.headers || {}), 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || `Error ${res.status}`);
    }
    return res;
}

function mostrarMensajeParam(texto, tipo = "info") {
    paramUI.mensaje.textContent = texto;
    paramUI.mensaje.className = `param-mensaje ${tipo}`;
    paramUI.mensaje.classList.toggle("hidden", !texto);
}

async function abrirParametrosEdaficos() {
    paramUI.modal.classList.remove("hidden");
    paramUI.btnReprocesar.classList.add("hidden");
    mostrarMensajeParam("");
    if (paramCambios.size && paramDatos) { renderParametros(); return; }   // conserva cambios sin guardar
    paramUI.body.innerHTML = '<p class="param-cargando">Cargando matriz de parámetros…</p>';
    try {
        const res = await fetchAdmin("/api/admin/parametros-edaficos");
        paramDatos = await res.json();
        paramCambios = new Map();
        paramHoja = "parametros";
        renderTabs();
        renderParametros();
    } catch (err) {
        paramUI.body.innerHTML = "";
        mostrarMensajeParam("❌ " + err.message, "error");
    }
}

function renderTabs() {
    const hojas = [{ clave: "parametros", nombre: "Parametros del modelo" },
        ...(paramDatos.hojas_complementarias || []).map((h, i) => ({ clave: "h" + i, nombre: h.nombre }))];
    paramUI.tabs.innerHTML = hojas.map(h =>
        `<button type="button" class="param-tab ${h.clave === paramHoja ? "activa" : ""}" data-hoja="${h.clave}">${escHTML(h.nombre)}${h.clave === "parametros" ? ' <span class="param-tab-nota">editable</span>' : ""}</button>`
    ).join("");
    paramUI.tabs.querySelectorAll(".param-tab").forEach(b => b.addEventListener("click", () => {
        paramHoja = b.dataset.hoja;
        renderTabs();
        renderParametros();
    }));
    paramUI.filtro.classList.toggle("hidden", paramHoja !== "parametros");
}

function renderParametros() {
    if (!paramDatos) return;
    if (paramHoja !== "parametros") {
        const hoja = paramDatos.hojas_complementarias[Number(paramHoja.slice(1))];
        paramUI.body.innerHTML = `<table class="param-tabla solo-lectura"><tbody>${
            hoja.filas.map((f, i) => {
                const llenas = f.filter(c => c !== "");
                const ancho = Math.max(...hoja.filas.map(x => x.length));
                if (llenas.length === 1 && f[0] !== "")   // fila de título o descripción: ocupa todo el ancho
                    return `<tr class="${i === 0 ? "param-titulo-fila" : ""}"><td colspan="${ancho}">${escHTML(f[0])}</td></tr>`;
                return `<tr>${f.map(c => `<td>${escHTML(c)}</td>`).join("")}</tr>`;
            }).join("")
        }</tbody></table>`;
        actualizarEstadoParam();
        return;
    }
    const q = (paramUI.filtro.value || "").trim().toLowerCase();
    const usadas = new Set(paramDatos.variables_del_modelo || []);
    const sinParam = paramDatos.sin_parametro || [];
    const avisoSinParam = sinParam.length ? `<div class="param-aviso"><b>⚠ Valores de la carta de suelos sin puntaje en la matriz</b> (el modelo les asigna 0.0):
        ${sinParam.map(x => `<span>${escHTML(x.variable)}: «${escHTML(x.valor)}» (${x.poligonos} pol.)</span>`).join("")}</div>` : "";
    let html = `<div class="param-cabecera"><b>${escHTML(paramDatos.titulo)}</b><span>${escHTML(paramDatos.descripcion)}</span></div>${avisoSinParam}
        <table class="param-tabla"><thead><tr>
            <th>Variable</th><th>Atributo del suelo</th><th class="col-poligonos" title="Polígonos de la carta de suelos con este atributo">Polígonos</th><th class="col-puntaje">Puntaje (0-1)</th>
            <th>Criterio biológico y justificación científica</th><th>Referencia clave</th>
        </tr></thead><tbody>`;
    let seccion = null;
    for (const p of paramDatos.parametros) {
        const texto = `${p.variable} ${p.atributo} ${p.criterio || ""} ${p.referencia || ""}`.toLowerCase();
        if (q && !texto.includes(q)) continue;
        if (p.seccion !== seccion) {
            seccion = p.seccion;
            const noUsada = !usadas.has(p.variable);
            html += `<tr class="param-seccion"><td colspan="6">${escHTML(seccion)}${noUsada ? ' <span class="param-no-usada">no se utiliza en la versión actual del modelo</span>' : ""}</td></tr>`;
        }
        const valor = paramCambios.has(p.id) ? paramCambios.get(p.id) : p.puntaje;
        const modificado = paramCambios.has(p.id);
        const editadoAntes = p.puntaje !== p.puntaje_original;
        html += `<tr class="${modificado ? "param-modificado" : ""}">
            <td class="param-var">${escHTML(p.variable)}</td>
            <td>${escHTML(p.atributo)}</td>
            <td class="col-poligonos ${p.poligonos === 0 ? "sin-uso" : ""}" title="${p.poligonos === 0 ? "Ningún polígono tiene este atributo: modificarlo no cambia el mapa" : "Polígonos de la carta de suelos con este atributo"}">${p.poligonos ?? "–"}</td>
            <td class="col-puntaje">
                <input type="number" min="0" max="1" step="0.05" value="${valor}" data-id="${p.id}" data-actual="${p.puntaje}"
                       title="Valor original del Excel: ${p.puntaje_original}${p.actualizado_por ? ` · Editado por ${escHTML(p.actualizado_por)}` : ""}">
                ${editadoAntes ? `<span class="param-orig" title="Valor original del Excel">orig. ${p.puntaje_original}</span>` : ""}
            </td>
            <td class="param-texto">${escHTML(p.criterio)}</td>
            <td class="param-ref">${escHTML(p.referencia)}</td>
        </tr>`;
    }
    html += "</tbody></table>";
    paramUI.body.innerHTML = html;
    paramUI.body.querySelectorAll('input[type="number"]').forEach(inp => inp.addEventListener("input", onCambioPuntaje));
    actualizarEstadoParam();
}

function onCambioPuntaje(e) {
    const inp = e.target;
    const id = Number(inp.dataset.id);
    const actual = Number(inp.dataset.actual);
    const v = inp.value === "" ? NaN : Number(inp.value);
    const valido = !Number.isNaN(v) && v >= 0 && v <= 1;
    inp.classList.toggle("invalido", !valido);
    if (valido && Math.abs(v - actual) > 1e-9) paramCambios.set(id, v);
    else if (valido) paramCambios.delete(id);
    else paramCambios.set(id, NaN);
    inp.closest("tr").classList.toggle("param-modificado", paramCambios.has(id));
    actualizarEstadoParam();
}

function actualizarEstadoParam() {
    const invalidos = [...paramCambios.values()].filter(v => Number.isNaN(v)).length;
    const n = paramCambios.size;
    paramUI.estado.textContent = invalidos
        ? `${invalidos} valor(es) fuera de rango (0 a 1)`
        : n ? `${n} cambio(s) sin guardar` : "Sin cambios";
    paramUI.estado.classList.toggle("con-cambios", n > 0);
    paramUI.btnGuardar.disabled = n === 0 || invalidos > 0;
}

async function guardarParametros() {
    const cambios = [...paramCambios.entries()].map(([id, puntaje]) => ({ id, puntaje }));
    if (!cambios.length) return;
    paramUI.btnGuardar.disabled = true;
    paramUI.btnGuardar.textContent = "Guardando…";
    try {
        const res = await fetchAdmin("/api/admin/parametros-edaficos", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cambios })
        });
        const data = await res.json();
        // Refrescar desde el servidor para mostrar los valores efectivamente guardados
        const res2 = await fetchAdmin("/api/admin/parametros-edaficos");
        paramDatos = await res2.json();
        paramCambios = new Map();
        renderParametros();
        mostrarMensajeParam("✅ " + data.mensaje, "ok");
        paramUI.btnReprocesar.classList.remove("hidden");
    } catch (err) {
        mostrarMensajeParam("❌ " + err.message, "error");
    } finally {
        paramUI.btnGuardar.textContent = "Guardar cambios";
        actualizarEstadoParam();
    }
}

async function descargarExcelParametros() {
    try {
        const res = await fetchAdmin("/api/admin/parametros-edaficos/excel");
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "edaphic-model-parameters-actualizado.xlsx";
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        if (paramCambios.size) mostrarMensajeParam("El Excel descargado contiene los puntajes guardados; los cambios sin guardar no se incluyen.", "info");
    } catch (err) {
        mostrarMensajeParam("❌ " + err.message, "error");
    }
}

function cerrarParametros() {
    if (paramCambios.size && !confirm("Hay cambios sin guardar. ¿Cerrar de todos modos? (se conservarán hasta que recargues la página)")) return;
    paramUI.modal.classList.add("hidden");
}

paramUI.filtro.addEventListener("input", renderParametros);
paramUI.btnGuardar.addEventListener("click", guardarParametros);
paramUI.btnDescargar.addEventListener("click", descargarExcelParametros);
paramUI.btnCerrar.addEventListener("click", cerrarParametros);
paramUI.btnCerrarX.addEventListener("click", cerrarParametros);
paramUI.btnReprocesar.addEventListener("click", () => {
    paramUI.modal.classList.add("hidden");
    ejecutarPipelineRemoto();
});


// ==========================================
// GUÍA DE USO (todos los perfiles)
// ==========================================
const guiaUI = {
    modal: document.getElementById("guia-modal"),
    contenido: document.getElementById("guia-contenido"),
    nav: document.querySelectorAll(".guia-nav a"),
};

function marcarSeccionGuia(id) {
    guiaUI.nav.forEach(a => a.classList.toggle("activa", a.getAttribute("href") === "#" + id));
}

window.abrirGuia = function (seccion) {
    guiaUI.modal.classList.remove("hidden");
    const destino = seccion ? document.getElementById("guia-" + seccion) : null;
    if (destino) {
        guiaUI.contenido.scrollTop = destino.offsetTop - guiaUI.contenido.offsetTop;
        destino.classList.remove("guia-destacada");
        void destino.offsetWidth;
        destino.classList.add("guia-destacada");
        marcarSeccionGuia(destino.id);
    } else {
        guiaUI.contenido.scrollTop = 0;
        marcarSeccionGuia("guia-que-es");
    }
};

guiaUI.nav.forEach(a => a.addEventListener("click", e => {
    e.preventDefault();
    const destino = document.querySelector(a.getAttribute("href"));
    guiaUI.contenido.scrollTop = destino.offsetTop - guiaUI.contenido.offsetTop;
    marcarSeccionGuia(destino.id);
}));
guiaUI.contenido.addEventListener("scroll", () => {
    const tope = guiaUI.contenido.scrollTop + guiaUI.contenido.offsetTop + 40;
    let actual = null;
    guiaUI.contenido.querySelectorAll("section").forEach(sec => { if (sec.offsetTop <= tope) actual = sec.id; });
    if (actual) marcarSeccionGuia(actual);
});
document.getElementById("btn-guia").addEventListener("click", () => abrirGuia());
document.getElementById("guia-cerrar").addEventListener("click", () => guiaUI.modal.classList.add("hidden"));
guiaUI.modal.addEventListener("click", e => { if (e.target === guiaUI.modal) guiaUI.modal.classList.add("hidden"); });


// ==========================================
// CAPA DE QUEBRACHOS CENSADOS (todos los perfiles)
// ==========================================
map.createPane('censo');
map.getPane('censo').style.zIndex = 450;   // por encima de los polígonos
const rendererCenso = L.svg({ pane: 'censo' });
let capaCenso = null;

async function mostrarCapaCenso(visible) {
    const estado = document.getElementById("censo-estado");
    if (!visible) {
        if (capaCenso) map.removeLayer(capaCenso);
        estado.classList.add("hidden");
        return;
    }
    if (!capaCenso) {
        estado.textContent = "Cargando puntos del censo…";
        estado.classList.remove("hidden");
        try {
            const res = await fetch(`${API_BASE}/api/censo-quebracho`);
            if (!res.ok) throw new Error(`Error ${res.status}`);
            const datos = await res.json();
            capaCenso = L.geoJSON(datos, {
                pointToLayer: (feature, latlng) => L.circleMarker(latlng, {
                    pane: 'censo',
                    renderer: rendererCenso,
                    radius: Math.min(4 + Math.sqrt(feature.properties.individuos) * 1.6, 12),
                    color: '#ffffff', weight: 1.5,
                    fillColor: '#7c2d12', fillOpacity: 0.9,
                }),
                onEachFeature: (feature, layer) => {
                    const p = feature.properties;
                    const n = p.individuos;
                    layer.bindPopup(`<div class="censo-popup">
                        <b class="t">🌳 Quebracho colorado</b>
                        ${n} ${n === 1 ? "individuo registrado" : "individuos registrados"} en esta unidad de muestreo.
                        ${p.poligono_id ? `<br>Polígono de suelo <b>#${p.poligono_id}</b>: ${escHTML(p.clasificacion_final || "")}
                            <br><button type="button" onclick="buscarDesdeDashboard(${p.poligono_id})">Ver diagnóstico del polígono</button>` : ""}
                        <span class="fuente">Fuente: Segundo Inventario Nacional de Bosques Nativos (2021)</span>
                    </div>`);
                },
            });
            estado.textContent = `${datos.features.length} sitios de muestreo · ${datos.total_individuos} individuos`;
        } catch (err) {
            console.error("Error cargando el censo:", err);
            estado.textContent = "No se pudo cargar la capa del censo.";
            document.getElementById("toggle-censo").checked = false;
            return;
        }
    }
    if (document.getElementById("toggle-censo").checked) {
        capaCenso.addTo(map);
        estado.classList.remove("hidden");
    }
}

document.getElementById("toggle-censo").addEventListener("change", e => mostrarCapaCenso(e.target.checked));


// ==========================================
// CAPAS DE TERRITORIO (contexto; no modifican el modelo)
// ==========================================
map.createPane('territorio');
map.getPane('territorio').style.zIndex = 350;          // debajo de los polígonos de aptitud
map.createPane('limites');
map.getPane('limites').style.zIndex = 440;             // sobre los polígonos, debajo del censo
map.getPane('limites').style.pointerEvents = 'none';   // no interfiere con los clics en los polígonos

const territorioEstado = document.getElementById('territorio-estado');
function mensajeTerritorio(texto) {
    territorioEstado.textContent = texto || '';
    territorioEstado.classList.toggle('hidden', !texto);
}

// --- Mapa de fondo
document.querySelectorAll('.fondo-btn').forEach(btn => btn.addEventListener('click', () => {
    const satelite = btn.dataset.fondo === 'satelite';
    document.querySelectorAll('.fondo-btn').forEach(b => b.classList.toggle('activo', b === btn));
    if (satelite) { map.removeLayer(fondoMapa); fondoSatelite.addTo(map); }
    else { map.removeLayer(fondoSatelite); fondoMapa.addTo(map); }
}));

// --- Opacidad de los polígonos
const sliderOpacidad = document.getElementById('opacidad-poligonos');
function aplicarOpacidad(valor) {
    opacidadPoligonos = valor / 100;
    sliderOpacidad.value = valor;
    document.getElementById('opacidad-valor').textContent = `${valor} %`;
    if (geojsonLayer) geojsonLayer.eachLayer(l => {
        if (l === capaSeleccionada) l.setStyle({ fillOpacity: Math.min(0.95, opacidadPoligonos + 0.25) });
        else l.setStyle({ fillOpacity: opacidadPoligonos });
    });
}
sliderOpacidad.addEventListener('input', e => aplicarOpacidad(parseInt(e.target.value, 10)));

// --- Límites departamentales (IGN)
let capaDepartamentos = null, etiquetasDepartamentos = null;
const ZOOM_ETIQUETAS = 8;

function actualizarEtiquetasDepartamentos() {
    if (!etiquetasDepartamentos) return;
    const visibles = map.hasLayer(capaDepartamentos) && map.getZoom() >= ZOOM_ETIQUETAS;
    if (visibles && !map.hasLayer(etiquetasDepartamentos)) etiquetasDepartamentos.addTo(map);
    if (!visibles && map.hasLayer(etiquetasDepartamentos)) map.removeLayer(etiquetasDepartamentos);
}
map.on('zoomend', actualizarEtiquetasDepartamentos);

async function mostrarDepartamentos(visible) {
    const casilla = document.getElementById('toggle-departamentos');
    if (!visible) {
        if (capaDepartamentos) map.removeLayer(capaDepartamentos);
        actualizarEtiquetasDepartamentos();
        return;
    }
    if (!capaDepartamentos) {
        mensajeTerritorio('Cargando límites departamentales…');
        try {
            const res = await fetch(`${API_BASE}/api/capas/departamentos`);
            if (!res.ok) throw new Error(`Error ${res.status}`);
            const datos = await res.json();
            capaDepartamentos = L.geoJSON(datos, {
                pane: 'limites', interactive: false,
                style: { color: '#7c3aed', weight: 1.8, dashArray: '6 4', fill: false, opacity: 0.9 }
            });
            etiquetasDepartamentos = L.layerGroup(datos.features.map(f => {
                const centro = L.geoJSON(f).getBounds().getCenter();
                return L.tooltip({ permanent: true, direction: 'center', className: 'etiqueta-depto', pane: 'limites' })
                    .setLatLng(centro).setContent(escHTML(f.properties.nombre));
            }));
            mensajeTerritorio('');
        } catch (err) {
            console.error('Error cargando departamentos:', err);
            mensajeTerritorio('No se pudieron cargar los límites departamentales (servicio del IGN).');
            casilla.checked = false;
            return;
        }
    }
    if (casilla.checked) {
        capaDepartamentos.addTo(map);
        actualizarEtiquetasDepartamentos();
    }
}
document.getElementById('toggle-departamentos').addEventListener('change', e => mostrarDepartamentos(e.target.checked));

// --- Cobertura del suelo (MapBiomas Chaco, teselas de Earth Engine)
let capaMapbiomas = null, opacidadPrevia = null;

function dibujarLeyendaMapbiomas(leyenda) {
    const cont = document.getElementById('mapbiomas-leyenda');
    cont.innerHTML = `<div class="mb-grid">${leyenda.map(c => `
        <div class="mb-item${c.excluida ? ' excluida' : ''}" title="Código ${c.codigo}${c.excluida ? ' · cobertura excluida' : ''}">
            <i style="background:${c.color}"></i>${escHTML(c.nombre)}${c.excluida ? ' ✕' : ''}
        </div>`).join('')}</div>
        <p class="mb-nota">✕ = cobertura excluida por el modelo. Fuente: MapBiomas Chaco, colección 5.</p>`;
}

async function mostrarMapbiomas(visible) {
    const casilla = document.getElementById('toggle-mapbiomas');
    const leyenda = document.getElementById('mapbiomas-leyenda');
    if (!visible) {
        if (capaMapbiomas) map.removeLayer(capaMapbiomas);
        leyenda.classList.add('hidden');
        if (opacidadPrevia !== null) { aplicarOpacidad(opacidadPrevia); opacidadPrevia = null; }
        return;
    }
    if (!capaMapbiomas) {
        mensajeTerritorio('Generando la capa de cobertura en Google Earth Engine…');
        try {
            const res = await fetch(`${API_BASE}/api/capas/mapbiomas`);
            if (!res.ok) throw new Error(`Error ${res.status}`);
            const datos = await res.json();
            capaMapbiomas = L.tileLayer(datos.url, {
                pane: 'territorio', opacity: 0.85, maxZoom: 19,
                attribution: 'Cobertura: MapBiomas Chaco (col. 5) · Google Earth Engine'
            });
            dibujarLeyendaMapbiomas(datos.leyenda);
            mensajeTerritorio('');
        } catch (err) {
            console.error('Error cargando MapBiomas:', err);
            mensajeTerritorio('No se pudo generar la capa de cobertura. Intentá nuevamente en unos minutos.');
            casilla.checked = false;
            return;
        }
    }
    if (casilla.checked) {
        capaMapbiomas.addTo(map);
        leyenda.classList.remove('hidden');
        // Se aclaran los polígonos para que se vea la cobertura debajo
        if (opacidadPoligonos > 0.25) { opacidadPrevia = Math.round(opacidadPoligonos * 100); aplicarOpacidad(20); }
    }
}
document.getElementById('toggle-mapbiomas').addEventListener('change', e => mostrarMapbiomas(e.target.checked));

// --- Selector de vista del mapa
document.querySelectorAll('.vista-btn').forEach(btn => btn.addEventListener('click', () => cambiarVista(btn.dataset.vista)));
dibujarLeyendaVista();
