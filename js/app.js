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
            <b>Composición del polígono:</b>
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

function seleccionarPoligono(feature, layer) {
    resaltarPoligono(layer);
    const props = feature.properties;
    if (props.id) {
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
const API_BASE = 'https://backend-sdss.onrender.com';
//const API_BASE = 'http://localhost:8000';

let geojsonLayer; // Declaramos la variable global para usarla en el buscador

// Carga (o recarga, tras reprocesar el modelo) la capa de polígonos
function cargarPoligonos() {
    return fetch(`${API_BASE}/api/aptitud-suelos`)
        .then(response => {
            if (!response.ok) throw new Error("Error en la respuesta de la red");
            return response.json();
        })
        .then(geoJsonData => {
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
function actualizarInterfazUsuario(user) {
    let adminControls = document.getElementById("admin-controls");
    if (!adminControls) {
        adminControls = document.createElement("div");
        adminControls.id = "admin-controls";
        adminControls.className = "hidden"; // Oculto por defecto
        adminControls.style.cssText = "display: none; align-items: center; gap: 8px; margin-right: 12px;";
        adminControls.innerHTML = `
            <button id="btn-dashboard" style="background:#1e293b; color:#fff; border:none; padding:7px 12px; border-radius:6px; cursor:pointer; font-size:12px; font-weight:600; display:flex; align-items:center; gap:5px; height:34px;">
                📊 Panel
            </button>
            <button id="btn-run-pipeline" style="background:#2563eb; color:#fff; border:none; padding:7px 12px; border-radius:6px; cursor:pointer; font-size:12px; font-weight:600; display:flex; align-items:center; gap:5px; height:34px;">
                🔄 Reprocesar modelo
            </button>
        `;

        if (btnLogout && btnLogout.parentNode) {
            btnLogout.parentNode.insertBefore(adminControls, btnLogout);
        }

        // Listeners para los botones de administrador
        document.getElementById("btn-dashboard").addEventListener("click", abrirPanelAuditoria);
        document.getElementById("btn-run-pipeline").addEventListener("click", ejecutarPipelineRemoto);
    }

    if (user) {
        const userRole = user.user_metadata?.role || 'visitante';

        if (userRole === 'admin') {
            userBadge.textContent = "Modo: Administrador";
            userBadge.classList.add("admin");
            userBadge.classList.remove("visitor");
            adminControls.classList.remove("hidden");
            adminControls.style.display = "inline-flex";
            // Si el pipeline ya estaba corriendo (p. ej. se recargó la página), retomamos el seguimiento
            retomarPipelineSiCorre();
        } else {
            userBadge.textContent = "Modo: Visitante";
            userBadge.classList.add("visitor");
            userBadge.classList.remove("admin");
            adminControls.classList.add("hidden");
            adminControls.style.display = "none";
        }

        if (btnLoginTrigger) btnLoginTrigger.classList.add("hidden");
        if (btnLogout) btnLogout.classList.remove("hidden");
    } else {
        // Estado explícito al cerrar sesión
        userBadge.textContent = "Modo: Visitante";
        userBadge.classList.add("visitor");
        userBadge.classList.remove("admin");
        
        if (btnLoginTrigger) btnLoginTrigger.classList.remove("hidden");
        if (btnLogout) btnLogout.classList.add("hidden");
        if (adminControls) {
            adminControls.classList.add("hidden");
            adminControls.style.display = "none";
        }
    }
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
    
    const BACKEND_URL = "https://backend-sdss.onrender.com";
    
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

async function abrirPanelAuditoria() {
    let dashboardModal = document.getElementById("dashboard-modal");
    
    // Si no existe el modal en el HTML, lo creamos dinámicamente
    if (!dashboardModal) {
        dashboardModal = document.createElement("div");
        dashboardModal.id = "dashboard-modal";
        dashboardModal.style.cssText = "position:fixed; top:50px; left:50%; transform:translateX(-50%); background:white; padding:20px; border-radius:8px; box-shadow:0 4px 15px rgba(0,0,0,0.2); z-index:9999; width:80%; max-width:600px; max-height:80vh; overflow-y:auto;";
        
        dashboardModal.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #ccc; padding-bottom:10px; margin-bottom:15px;">
                <h2 style="margin:0;">Panel de Auditoría y Métricas</h2>
                <button id="btn-close-dashboard" style="background:red; color:white; border:none; padding:5px 10px; cursor:pointer; border-radius:3px;">Cerrar</button>
            </div>
            <div id="dashboard-content">Cargando métricas desde Supabase...</div>
        `;
        document.body.appendChild(dashboardModal);
        
        document.getElementById("btn-close-dashboard").addEventListener("click", () => {
            dashboardModal.classList.add("hidden");
        });
    }
    
    dashboardModal.classList.remove("hidden");
    const contentDiv = document.getElementById("dashboard-content");
    contentDiv.innerHTML = "Cargando métricas desde Supabase...";

    try {
        // Consultar a Supabase para agrupar y contar polígonos consultados
        // Requiere que la tabla 'registros_acceso' tenga datos y permisos de lectura para el admin
        const { data, error } = await supabaseClient
            .from('registros_acceso')
            .select('poligono_consultado')
            .not('poligono_consultado', 'is', null);

        if (error) throw error;

        if (!data || data.length === 0) {
            contentDiv.innerHTML = "<p>No hay consultas registradas aún.</p>";
            return;
        }

        // Conteo de frecuencias (Mapa de Calor Lógico)
        const conteo = {};
        data.forEach(row => {
            conteo[row.poligono_consultado] = (conteo[row.poligono_consultado] || 0) + 1;
        });

        // Ordenar de mayor a menor
        const poligonosPopulares = Object.keys(conteo)
            .map(id => ({ id: parseInt(id), visitas: conteo[id] }))
            .sort((a, b) => b.visitas - a.visitas);

        // Generar tabla HTML
        let tablaHTML = `
            <p>Se muestran los polígonos de suelo con mayor interés (búsquedas por visitantes o usuarios de campo).</p>
            <table style="width:100%; border-collapse: collapse; margin-top:10px;">
                <thead>
                    <tr style="background:#f1f5f9; text-align:left;">
                        <th style="padding:8px; border: 1px solid #cbd5e1;">ID Polígono</th>
                        <th style="padding:8px; border: 1px solid #cbd5e1;">Total de Consultas</th>
                        <th style="padding:8px; border: 1px solid #cbd5e1;">Acción</th>
                    </tr>
                </thead>
                <tbody>
        `;

        poligonosPopulares.forEach(p => {
            tablaHTML += `
                <tr>
                    <td style="padding:8px; border: 1px solid #cbd5e1;">#${p.id}</td>
                    <td style="padding:8px; border: 1px solid #cbd5e1;">${p.visitas}</td>
                    <td style="padding:8px; border: 1px solid #cbd5e1;">
                        <button onclick="buscarDesdeDashboard(${p.id})" style="padding:4px 8px; cursor:pointer;">Ver en Mapa</button>
                    </td>
                </tr>
            `;
        });

        tablaHTML += `</tbody></table>`;
        contentDiv.innerHTML = tablaHTML;

    } catch (err) {
        console.error("Error cargando dashboard:", err);
        contentDiv.innerHTML = `<p style="color:red;">Error al cargar datos: ${err.message}</p>`;
    }
}

// Función auxiliar para que el administrador salte del dashboard al mapa
window.buscarDesdeDashboard = function(idPoligono) {
    const dashboardModal = document.getElementById("dashboard-modal");
    if (dashboardModal) dashboardModal.classList.add("hidden"); // Cierra modal
    
    // Inyecta valor en el input de búsqueda existente y dispara el click
    const inputSearch = document.getElementById('search-polygon-id');
    const btnSearch = document.getElementById('btn-search');
    
    if (inputSearch && btnSearch) {
        inputSearch.value = idPoligono;
        btnSearch.click();
    }
}

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
    btn.innerHTML = enCurso ? "⏳ Procesando… (ver)" : "🔄 Reprocesar modelo";
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
            `${st.duracion_seg ? ` en ${formatearDuracion(st.duracion_seg)}` : ""}. Actualizando mapa…`;
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

async function consultarEstadoPipeline() {
    try {
        const token = await obtenerTokenAdmin();
        const res = await fetch(`${API_BASE}/api/admin/etl-status`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const st = await res.json();
        pipelineFallosConsecutivos = 0;
        renderizarEstadoPipeline(st);
    } catch (err) {
        pipelineFallosConsecutivos++;
        console.warn("No se pudo consultar el estado del pipeline:", err);
        pipelineUI.message.textContent = "Reintentando conexión con el servidor…";
        if (pipelineFallosConsecutivos >= 10) {
            renderizarEstadoPipeline({
                estado: "error",
                error: "Se perdió la conexión con el servidor. El proceso podría seguir ejecutándose; vuelve a abrir este panel más tarde.",
            });
        }
    }
}

function iniciarSeguimientoPipeline() {
    detenerTimersPipeline();
    pipelineInicio = new Date();
    pipelineFallosConsecutivos = 0;
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
