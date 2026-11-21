== mysql owner
CREATE USER IF NOT EXISTS 'anphat'@'localhost' IDENTIFIED VIA unix_socket WITH MAX_USER_CONNECTIONS 20;
GRANT ALL PRIVILEGES ON `anphat\_%`.* TO 'anphat'@'localhost';
== mysql create
CREATE DATABASE IF NOT EXISTS `anphat_shop` CHARACTER SET utf8mb4;
== mysql grant
GRANT SELECT ON `anphat_shop`.* TO 'anphat_app'@'localhost';
REVOKE ALL PRIVILEGES ON `anphat_shop`.* FROM 'anphat_app'@'localhost';
GRANT SELECT, INSERT ON `anphat_shop`.* TO 'anphat_app'@'localhost';
== pg owner
CREATE ROLE "anphat" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 20;
== pg create
CREATE DATABASE "anphat_shop" OWNER "anphat" ENCODING 'UTF8' TEMPLATE template0;
REVOKE ALL ON DATABASE "anphat_shop" FROM PUBLIC;
== pg grant
\connect "anphat_shop"
REVOKE ALL ON SCHEMA public FROM "anphat_app";
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM "anphat_app";
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM "anphat_app";
ALTER DEFAULT PRIVILEGES FOR ROLE "anphat" IN SCHEMA public REVOKE ALL ON TABLES FROM "anphat_app";
ALTER DEFAULT PRIVILEGES FOR ROLE "anphat" IN SCHEMA public REVOKE ALL ON SEQUENCES FROM "anphat_app";
\connect postgres
REVOKE ALL ON DATABASE "anphat_shop" FROM "anphat_app";
GRANT CONNECT, TEMPORARY ON DATABASE "anphat_shop" TO "anphat_app";
\connect "anphat_shop"
GRANT USAGE ON SCHEMA public TO "anphat_app";
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO "anphat_app";
ALTER DEFAULT PRIVILEGES FOR ROLE "anphat" IN SCHEMA public GRANT SELECT, INSERT ON TABLES TO "anphat_app";
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO "anphat_app";
ALTER DEFAULT PRIVILEGES FOR ROLE "anphat" IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO "anphat_app";
