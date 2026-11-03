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
        case 'Apto para reforestar y legal': return '#22c55e';
        case 'Apto pero ilegal':             return '#f59e0b';
        default:                             return '#ef4444';
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
    let motivos = [];
    const propOtbnVal = (props.prop_otbn !== null && props.prop_otbn !== undefined) 
        ? (props.prop_otbn * 100).toFixed(1) 
        : "0.0";

    if (props.aptitud_final === 0 || props.clasificacion_final !== 'Apto para reforestar y legal') {
        if (props.mascara_otbn === 0) {
            motivos.push(`<b>Restricción Legal (OTBN):</b> Cobertura permitida es del ${propOtbnVal}% (Requerido ≥ 98%).`);
        }
        if (props.aptitud_biofisica < 0.65) {
            motivos.push(`<b>Baja aptitud biofísica:</b> Puntaje insuficiente (${props.aptitud_biofisica.toFixed(2)}) por limitantes hídricas, edáficas o vegetativas.`);
        }
        if (motivos.length === 0) {
            motivos.push(`<b>Restricción de uso del suelo (MapBiomas):</b> Cobertura actual no idónea para reforestación.`);
        }

        return `
            <div class="diagnostic-box fail">
                <b>🔴 Causa de exclusión:</b>
                <ul style="margin: 5px 0 0; padding-left: 15px;">
                    ${motivos.map(m => `<li>${m}</li>`).join('')}
                </ul>
            </div>`;
    }

    return `
        <div class="diagnostic-box pass">
            <b>🟢 Terreno válido:</b> Cumple con los requisitos legales (OTBN ${propOtbnVal}%) e idoneidad edafoclimática.
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
    
    let badgeClass = 'badge-danger';
    if (props.clasificacion_final === 'Apto para reforestar y legal') badgeClass = 'badge-success';
    else if (props.clasificacion_final === 'Apto pero ilegal') badgeClass = 'badge-warning';

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
            ${crearBarraProgreso('NDVI', props.aptitud_ndvi)}
            <hr style="border:0; border-top: 1px solid #e2e8f0; margin: 8px 0;">
            ${crearBarraProgreso('Puntaje biofísico base', props.aptitud_biofisica)}
        </div>

        <div class="card">
            <div class="card-title">Atributos del suelo</div>
            <div style="font-size: 12px; color: #475569;">
                <b>Subgrupo:</b> ${props.subgrupo || 'Sin datos'}<br>
                <b>Textura Superficial:</b> ${props.textura || 'Sin datos'}
            </div>
        </div>

        <div style="text-align: center; padding: 10px; background: #e2e8f0; border-radius: 8px; margin-top: 10px;">
            <span style="font-size: 11px; text-transform: uppercase; color: #475569; font-weight: 700;">Puntaje final</span>
            <div style="font-size: 22px; font-weight: 700; color: #0f172a;">${props.aptitud_final.toFixed(2)}</div>
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
let geojsonLayer; // Declaramos la variable global para usarla en el buscador

fetch('https://backend-sdss.onrender.com/api/aptitud-suelos')
    .then(response => {
        if (!response.ok) throw new Error("Error en la respuesta de la red");
        return response.json();
    })
    .then(geoJsonData => {
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

// ==========================================
// LÓGICA DEL BUSCADOR DE POLÍGONOS
// ==========================================
const inputSearch = document.getElementById('search-polygon-id');
const btnSearch = document.getElementById('btn-search');

function ejecutarBusqueda() {
    const idBuscado = parseInt(inputSearch.value.trim());
    if (!idBuscado) return;

    const layer = capasPorId[idBuscado];
    if (layer) {
        map.panTo(layer.getBounds().getCenter());
        seleccionarPoligono(layer.feature, layer);
    } else {
        alert(`No se encontró el polígono con ID #${idBuscado}`);
    }
}

if (btnSearch) btnSearch.addEventListener('click', ejecutarBusqueda);
if (inputSearch) inputSearch.addEventListener('keypress', (e) => { if (e.key === 'Enter') ejecutarBusqueda(); });

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

async function ejecutarPipelineRemoto() {
    const confirmacion = confirm("⚠️ ¿Esta seguro que desea reprocesar el modelo? El proceso recalculara los 429 poligonos y actualizara la base de datos. Esto puede demorar 1 minuto.");
    
    if (!confirmacion) return;

    try {
        document.getElementById("btn-run-pipeline").disabled = true;

        // Obtenemos la sesión actual y el token de Supabase
        const { data: { session }, error } = await supabaseClient.auth.getSession();
        
        if (error || !session) {
            alert("❌ No se encontró una sesión activa. Por favor, vuelve a iniciar sesión.");
            document.getElementById("btn-run-pipeline").disabled = false;
            return;
        }

        // Enviamos la petición incluyendo el token en los headers
        const response = await fetch('https://backend-sdss.onrender.com/api/admin/run-etl', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${session.access_token}` // <- AQUÍ ENVIAMOS EL TOKEN
            }
        });

        const data = await response.json();

        if (response.ok) {
            alert("✅ " + data.mensaje);
        } else {
            alert("❌ Error en el servidor: " + (data.detail || "No fue posible iniciar el pipeline."));
        }
    } catch (err) {
        console.error("Error al llamar a la API del pipeline:", err);
        alert("❌ Error de conexión al intentar ejecutar el pipeline en el servidor.");
    } finally {
        document.getElementById("btn-run-pipeline").disabled = false;
    }
}