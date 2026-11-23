-- Dev bootstrap only. Production roles are provisioned by infrastructure with real secrets.
-- kidos_app: group role that receives table grants in migrations. Cannot bypass RLS.
-- kidos_app_login: the login the application connects with.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kidos_app') THEN
    CREATE ROLE kidos_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kidos_app_login') THEN
    CREATE ROLE kidos_app_login LOGIN PASSWORD 'kidos_app_dev' NOSUPERUSER NOBYPASSRLS IN ROLE kidos_app;
  END IF;
END
$$;
