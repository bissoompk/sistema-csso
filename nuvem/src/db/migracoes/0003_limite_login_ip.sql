CREATE TABLE "limite_login_ip" (
	"ip" varchar(64) PRIMARY KEY NOT NULL,
	"falhas" integer NOT NULL,
	"janela_inicio" timestamp with time zone NOT NULL,
	"bloqueado_ate" timestamp with time zone
);
