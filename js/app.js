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
        const rol = session?.user ? 'admin' : 'visitante';

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

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors'
}).addTo(map);

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
        fillColor: obtenerColor(feature.properties.clasificacion_final),
        weight: 1.2,
        opacity: 1,
        color: '#ffffff',
        fillOpacity: 0.7
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
        fillOpacity: 0.95
    });

    layer.bringToFront();
}

function generarDiagnostico(props) {
    const pRojo = props.pct_rojo || 0;
    const pAmarillo = props.pct_amarillo || 0;
    const pVerde = props.pct_verde || 0;
    
    // Cálculo de Zona Libre
    const sumaOtbn = pRojo + pAmarillo + pVerde;
    const pLibre = (sumaOtbn >= 100) ? 0 : parseFloat((100 - sumaOtbn).toFixed(1));
    const pVerdeTotal = pVerde;

    // Determinación de la categoría dominante real según los porcentajes
    const dominaRojo = (pRojo > pAmarillo) && (pRojo > pVerdeTotal);
    const dominaAmarillo = (pAmarillo > pRojo) && (pAmarillo > pVerdeTotal);

    // Construcción dinámica de la lista de porcentajes
    let listaComposicion = [];
    if (pRojo > 0) listaComposicion.push(`<span>🟥 <b>Zona Roja (Restauración):</b> ${pRojo.toFixed(1)}%</span>`);
    if (pAmarillo > 0) listaComposicion.push(`<span>🟨 <b>Zona Amarilla (Manejo):</b> ${pAmarillo.toFixed(1)}%</span>`);
    if (pVerde > 0) listaComposicion.push(`<span>🟩 <b>Zona Verde (Productiva):</b> ${pVerde.toFixed(1)}%</span>`);
    if (pLibre > 0) listaComposicion.push(`<span>⬜ <b>Zona Libre (Agrícola/Otros):</b> ${pLibre}%</span>`);

    const htmlComposicion = `
        <div style="margin-top: 8px; padding-top: 6px; border-top: 1px solid rgba(0,0,0,0.1); font-size: 11px; display: flex; flex-direction: column; gap: 2px;">
            <b>Composición del polígono: <a href="#" class="ayuda-link" onclick="abrirGuia('composicion'); return false;" title="¿Cómo se calcula?">¿qué es esto?</a></b>
            ${listaComposicion.join('')}
        </div>`;

    const esUsoExcluido = props.clasificacion_final.includes('Uso excluido') || props.clasificacion_final.includes('excluido');
    const esBajaAptitud = props.aptitud_biofisica <= 0.60 || props.aptitud_suelo <= 0.40;

    // 1. Caso No Apto (Filtro Biofísico / MapBiomas)
    if (esBajaAptitud || esUsoExcluido) {
        let motivos = [];
        if (esBajaAptitud) motivos.push(`<b>Baja aptitud edafoclimática:</b> Puntaje biofísico insuficiente (${(props.aptitud_biofisica || 0).toFixed(2)}).`);
        if (esUsoExcluido) motivos.push(`<b>Uso de suelo no permitido (MapBiomas):</b> Cobertura no idónea.`);

        return `
            <div class="diagnostic-box fail" style="background:#f3f4f6; border: 1px solid #d1d5db; padding: 10px; border-radius: 6px;">
                <b style="color:#374151;">⚪ Terreno no apto</b>
                <ul style="margin: 5px 0 0; padding-left: 15px; font-size: 11px; color: #4b5563;">
                    ${motivos.map(m => `<li>${m}</li>`).join('')}
                </ul>
                ${htmlComposicion}
            </div>`;
    }

    // 2. Predominancia Real de Zona Roja
    if (dominaRojo) {
        return `
            <div class="diagnostic-box restoration" style="background:#fef2f2; border: 1px solid #fca5a5; padding: 10px; border-radius: 6px;">
                <b style="color:#991b1b;">🔴 Restauración ecológica (Predominante)</b>
                <p style="margin: 4px 0 0; font-size: 11px; color: #7f1d1d;">
                    La mayor superficie del polígono corresponde a Zona Roja. Terreno altamente idóneo para proyectos de restauración biológica sin alterar la estructura del bosque circundante.
                </p>
                ${htmlComposicion}
            </div>`;
    }

    // 3. Predominancia Real de Zona Amarilla
    if (dominaAmarillo) {
        return `
            <div class="diagnostic-box warning" style="background:#fefce8; border: 1px solid #fef08a; padding: 10px; border-radius: 6px;">
                <b style="color:#854d0e;">🟨 Enriquecimiento sostenible (Predominante)</b>
                <p style="margin: 4px 0 0; font-size: 11px; color: #713f12;">
                    La mayoría del terreno pertenece a Zona Amarilla. Se permite la intervención para plantar quebracho en parches degradados, abrir sutilmente líneas de enriquecimiento o clausurar sectores temporalmente para asegurar que los plantines jóvenes sobrevivan al ganado.
                </p>
                ${htmlComposicion}
            </div>`;
    }

    // 4. Predominancia Real de Zona Verde / Libre
    return `
        <div class="diagnostic-box pass" style="background:#f0fdf4; border: 1px solid #86efac; padding: 10px; border-radius: 6px;">
            <b style="color:#166534;">🟩 Reforestación productiva (Predominante)</b>
            <p style="margin: 4px 0 0; font-size: 11px; color: #14532d;">
                Predomina la superficie de Zona Verde o Libre. Idóneo para plantaciones en bloque o cortinas forestales de quebracho colorado.
            </p>
            ${htmlComposicion}
        </div>`;
}

function crearBarraProgreso(label, valor) {
    const porcentaje = Math.min(Math.max(valor * 100, 0), 100).toFixed(0);
    return `
        <div class="metric-row">
            <div class="metric-label">
                <span>${label}</span>
                <b>${valor.toFixed(2)}</b>
            </div>
            <div class="progress-bar-bg">
                <div class="progress-bar-fill" style="width: ${porcentaje}%;"></div>
            </div>
        </div>`;
}

function seleccionarPoligono(feature, layer, registrar = true) {
    resaltarPoligono(layer);
    const props = feature.properties;
    if (props.id && registrar) {
        registrarConsultaPoligono(props.id);
    }
    const container = document.getElementById('detalle-suelo');
    
    let badgeClass = 'badge-danger'; // Gris oscuro / Rojo por defecto
    const claseTexto = props.clasificacion_final || "";
    
    if (claseTexto.includes('verde')) badgeClass = 'badge-success'; // Verde
    else if (claseTexto.includes('Enriquecimiento sostenible')) badgeClass = 'badge-warning'; // Amarillo
    else if (claseTexto.includes('Uso excluido')) badgeClass = 'badge-secondary'; // Gris

    container.innerHTML = `
        <div style="margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center;">
            <span style="font-size: 14px; font-weight: 700;">Polígono #${props.id}</span>
            <span class="badge ${badgeClass}">${props.clasificacion_final}</span>
        </div>

        ${generarDiagnostico(props)}

        <div class="card" style="margin-top: 12px;">
            <div class="card-title">Métricas de Idoneidad Biofísica</div>
            ${crearBarraProgreso('Aptitud Suelo', props.aptitud_suelo)}
            ${crearBarraProgreso('Aptitud Lluvia', props.aptitud_lluvia)}
            ${crearBarraProgreso('Índice de Vegetación de Diferencia Normalizada', props.aptitud_ndvi)}
            <hr style="border:0; border-top: 1px solid #e2e8f0; margin: 8px 0;">
            ${crearBarraProgreso('Puntaje biofísico base', props.aptitud_biofisica)}
        </div>

        <div class="card">
            <div class="card-title">Atributos del suelo</div>
            <div style="font-size: 12px; color: #475569;">
                <b>Subgrupo:</b> ${props.subgrupo || 'Sin datos'}<br>
                <b>Textura superficial:</b> ${props.textura || 'Sin datos'}
            </div>
        </div>

        <div style="text-align: center; padding: 10px; background: #e2e8f0; border-radius: 8px; margin-top: 10px;">
            <span style="font-size: 11px; text-transform: uppercase; color: #475569; font-weight: 700;">Puntaje final</span>
            <div style="font-size: 22px; font-weight: 700; color: #0f172a;">
    ${(props.aptitud_biofisica || props.aptitud_final).toFixed(2)}
</div>
        </div>

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
                e.target.setStyle({ fillOpacity: 0.9, weight: 2.5 });
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
    const esAdmin = !!user && (user.user_metadata?.role === 'admin');

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
