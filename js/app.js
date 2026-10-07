// --- CONFIGURACIÓN DE SUPABASE ---
const SUPABASE_URL = "https://zhzvztpfwtalxgdqxdmf.supabase.co/rest/v1/";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpoenZ6dHBmd3RhbHhnZHF4ZG1mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEzMTUxMjcsImV4cCI6MjEwNjg5MTEyN30.TOEkXRsz5lnfFRG5vHPIujj0EQsVo9Vhre5Q0_UMORU"; 

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Diccionario para almacenar las capas por ID y permitir el buscador
const capasPorId = {};

// --- INICIALIZACIÓN DEL MAPA ---
const map = L.map('map').setView([-26.3, -60.8], 7.5);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors'
}).addTo(map);

// --- FUNCIONES AUXILIARES DEL MAPA ---
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
    const props = feature.properties;
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
    `;
}

function onEachFeature(feature, layer) {
    // Guardar referencia en el diccionario para el buscador
    if (feature.properties && feature.properties.id) {
        capasPorId[feature.properties.id] = layer;
    }

    layer.on({
        mouseover: function(e) { e.target.setStyle({ fillOpacity: 0.9, weight: 2.5 }); },
        mouseout: function(e) { layer.setStyle(estiloFeature(feature)); },
        click: function(e) { seleccionarPoligono(feature, layer); }
    });
}

// --- CARGA DE DATOS DE RENDER ---
fetch('https://backend-sdss.onrender.com/api/aptitud-suelos')
    .then(response => {
        if (!response.ok) throw new Error("Error en la respuesta de la red");
        return response.json();
    })
    .then(geoJsonData => {
        L.geoJSON(geoJsonData, {
            style: estiloFeature,
            onEachFeature: onEachFeature
        }).addTo(map);
    })
    .catch(error => {
        console.error("Error cargando los polígonos:", error);
        document.getElementById('detalle-suelo').innerHTML = `<p style="color:red; font-size: 12px;">Error de conexión con la API FastAPI.</p>`;
    });

// --- LÓGICA DEL BUSCADOR DE POLÍGONOS ---
const inputSearch = document.getElementById('search-polygon-id');
const btnSearch = document.getElementById('btn-search');

function ejecutarBusqueda() {
    const idBuscado = parseInt(inputSearch.value.trim());
    if (!idBuscado) return;

    const layer = capasPorId[idBuscado];
    if (layer) {
        map.flyToBounds(layer.getBounds(), { maxZoom: 12 });
        seleccionarPoligono(layer.feature, layer);
    } else {
        alert(`No se encontró el polígono con ID #${idBuscado}`);
    }
}

btnSearch.addEventListener('click', ejecutarBusqueda);
inputSearch.addEventListener('keypress', (e) => { if (e.key === 'Enter') ejecutarBusqueda(); });

// --- LÓGICA DE AUTENTICACIÓN (SUPABASE) ---
const btnLoginTrigger = document.getElementById("btn-login-trigger");
const btnLogout = document.getElementById("btn-logout");
const loginModal = document.getElementById("login-modal");
const closeModal = document.getElementById("close-modal");
const loginForm = document.getElementById("login-form");
const userBadge = document.getElementById("user-badge");
const loginError = document.getElementById("login-error");

btnLoginTrigger.addEventListener("click", () => loginModal.classList.remove("hidden"));
closeModal.addEventListener("click", () => loginModal.classList.add("hidden"));

loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    loginError.classList.add("hidden");

    const email = document.getElementById("login-email").value;
    const password = document.getElementById("login-password").value;

    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });

    if (error) {
        loginError.textContent = "Credenciales incorrectas: " + error.message;
        loginError.classList.remove("hidden");
    } else {
        loginModal.classList.add("hidden");
        actualizarInterfazUsuario(data.user);
    }
});

btnLogout.addEventListener("click", async () => {
    await supabaseClient.auth.signOut();
    actualizarInterfazUsuario(null);
});

function actualizarInterfazUsuario(user) {
    if (user) {
        userBadge.textContent = "Modo: Administrador";
        userBadge.className = "badge admin";
        btnLoginTrigger.classList.add("hidden");
        btnLogout.classList.remove("hidden");
    } else {
        userBadge.textContent = "Modo: Visitante";
        userBadge.className = "badge visitor";
        btnLoginTrigger.classList.remove("hidden");
        btnLogout.classList.add("hidden");
    }
}

supabaseClient.auth.getSession().then(({ data: { session } }) => {
    if (session) actualizarInterfazUsuario(session.user);
});