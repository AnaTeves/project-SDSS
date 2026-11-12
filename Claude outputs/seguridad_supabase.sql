-- =====================================================================
-- SITCHA · Corrección de los avisos del Asesor de seguridad de Supabase
-- Ejecutar en Supabase > SQL Editor. Hacerlo por partes, en orden.
--
-- Contexto: el backend (Render) se conecta con DATABASE_URL usando el rol
-- propietario de las tablas, que NO está sujeto a RLS. Por eso, bloquear
-- el acceso de la API pública (roles anon y authenticated) no afecta al
-- mapa, al pipeline, al PDF ni a la matriz edáfica. La única tabla que el
-- navegador usa directamente es registros_acceso (auditoría).
-- =====================================================================


-- ---------------------------------------------------------------------
-- PARTE 1 · Errores "RLS deshabilitado en público" + aviso "RLS habilitado
-- sin política" (parametros_edaficos)
-- Activa RLS en todas las tablas de datos y agrega una política explícita
-- que niega el acceso por la API pública. Recorre las tablas del esquema
-- public automáticamente, así no depende de escribir bien cada nombre.
-- ---------------------------------------------------------------------
DO $$
DECLARE
    t text;
BEGIN
    FOR t IN
        SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname NOT IN ('spatial_ref_sys', 'registros_acceso')
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t) THEN
            EXECUTE format(
                'CREATE POLICY "sin_acceso_api_publica" ON public.%I AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)',
                t);
        END IF;
        RAISE NOTICE 'RLS activado: %', t;
    END LOOP;
END $$;


-- ---------------------------------------------------------------------
-- PARTE 2 · Advertencia "La política de RLS siempre es cierta"
-- (registros_acceso). Reemplaza la política abierta por tres reglas:
--   · visitantes anónimos: solo pueden insertar su visita como 'visitante'
--   · usuarios con sesión: insertan con su propio correo y su rol real
--   · lectura (auditoría): solo el administrador (rol en app_metadata)
-- ---------------------------------------------------------------------
ALTER TABLE public.registros_acceso ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    p text;
BEGIN
    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'registros_acceso'
    LOOP
        EXECUTE format('DROP POLICY %I ON public.registros_acceso', p);
    END LOOP;
END $$;

CREATE POLICY "insertar_visita_anonima" ON public.registros_acceso
    FOR INSERT TO anon
    WITH CHECK (
        rol_usuario = 'visitante'
        AND email = 'anonimo'
    );

CREATE POLICY "insertar_visita_con_sesion" ON public.registros_acceso
    FOR INSERT TO authenticated
    WITH CHECK (
        (
            (rol_usuario = 'visitante' AND email = 'anonimo')
            OR (
                email = (SELECT auth.jwt() ->> 'email')
                AND rol_usuario = CASE
                    WHEN (SELECT auth.jwt() -> 'app_metadata' ->> 'role') = 'admin' THEN 'admin'
                    ELSE 'visitante'
                END
            )
        )
    );

CREATE POLICY "leer_auditoria_solo_admin" ON public.registros_acceso
    FOR SELECT TO authenticated
    USING ((SELECT auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- Nadie puede modificar ni borrar registros por la API (no se crean políticas
-- de UPDATE/DELETE, así que quedan denegadas).


-- ---------------------------------------------------------------------
-- PARTE 3 · Error "Vista del definidor de seguridad" (vista_metadatos_pdf)
-- La vista no la usa el código actual (el PDF se arma en el backend).
-- Opción A (recomendada si no la usás en ningún lado): eliminarla.
--   DROP VIEW IF EXISTS public.vista_metadatos_pdf;
-- Opción B: conservarla, pero que respete los permisos de quien consulta
-- y quitarle el acceso público:
-- ---------------------------------------------------------------------
ALTER VIEW IF EXISTS public.vista_metadatos_pdf SET (security_invoker = on);
REVOKE ALL ON public.vista_metadatos_pdf FROM anon, authenticated;


-- ---------------------------------------------------------------------
-- PARTE 4 · Objetos de PostGIS (ejecutar cada sentencia por separado).
-- Pertenecen a la extensión; si alguna devuelve "must be owner" o
-- "permission denied", no es un problema del proyecto: ver la nota final.
-- ---------------------------------------------------------------------

-- 4a. Advertencias "El público / usuarios con sesión pueden ejecutar la
--     función st_estimatedextent" (SECURITY DEFINER)
REVOKE EXECUTE ON FUNCTION public.st_estimatedextent(text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.st_estimatedextent(text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.st_estimatedextent(text, text, text, boolean) FROM PUBLIC, anon, authenticated;

-- 4b. Error "RLS deshabilitado" en spatial_ref_sys (catálogo público de
--     sistemas de coordenadas EPSG, sin datos del proyecto)
REVOKE ALL ON public.spatial_ref_sys FROM anon, authenticated;


-- ---------------------------------------------------------------------
-- VERIFICACIÓN
-- ---------------------------------------------------------------------
SELECT c.relname AS tabla, c.relrowsecurity AS rls_activo,
       (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS politicas
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY 1;

-- ---------------------------------------------------------------------
-- NOTAS (no requieren SQL)
-- · "Extensión en el esquema public" (postgis): PostGIS no puede moverse de
--   esquema sin desinstalarse, y eso borraría las columnas de geometría de
--   todas las tablas. Se acepta como riesgo conocido: queda como advertencia.
-- · Si 4a o 4b fallan por permisos, esos avisos también son de PostGIS y
--   pueden aceptarse: spatial_ref_sys solo contiene definiciones públicas
--   de proyecciones y st_estimatedextent no expone datos del sistema.
-- · "Protección de contraseña filtrada": se activa en Authentication >
--   Sign In / Providers > Email > "Prevent use of leaked passwords".
--   Supabase la ofrece desde el plan Pro; en el plan gratuito queda como aviso.
-- ---------------------------------------------------------------------
