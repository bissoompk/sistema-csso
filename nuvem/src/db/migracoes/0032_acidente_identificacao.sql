CREATE TABLE "acidente_identificacao" (
	"acidentado_id" integer NOT NULL,
	"sexo" varchar(14),
	"cpf" varchar(11),
	"rg" varchar(20),
	"data_nascimento" date,
	"cep" varchar(8),
	"logradouro" varchar(160),
	"numero" varchar(20),
	"complemento" varchar(80),
	"bairro" varchar(80),
	"cidade" varchar(80),
	"uf" varchar(2),
	"telefone" varchar(11),
	"email" varchar(160),
	"registrado_por" integer,
	"registrado_em" timestamp with time zone NOT NULL,
	CONSTRAINT "pk_acidente_identificacao" PRIMARY KEY("acidentado_id"),
	CONSTRAINT "ck_acid_ident_sexo" CHECK (sexo IN ('FEMININO','MASCULINO','OUTRO','NAO_INFORMADO')),
	CONSTRAINT "ck_acid_ident_cpf" CHECK (cpf ~ '^(?:[0-9]{11})$'),
	CONSTRAINT "ck_acid_ident_cep" CHECK (cep ~ '^(?:[0-9]{8})$'),
	CONSTRAINT "ck_acid_ident_uf" CHECK (uf ~ '^(?:[A-Z]{2})$'),
	CONSTRAINT "ck_acid_ident_telefone" CHECK (telefone ~ '^(?:[0-9]{10,11})$')
);
--> statement-breakpoint
CREATE TABLE "acidente_testemunha_contato" (
	"testemunha_id" integer NOT NULL,
	"cep" varchar(8),
	"logradouro" varchar(160),
	"numero" varchar(20),
	"complemento" varchar(80),
	"bairro" varchar(80),
	"municipio" varchar(80),
	"uf" varchar(2),
	"telefone" varchar(11),
	CONSTRAINT "pk_acidente_testemunha_contato" PRIMARY KEY("testemunha_id"),
	CONSTRAINT "ck_acid_test_contato_cep" CHECK (cep ~ '^(?:[0-9]{8})$'),
	CONSTRAINT "ck_acid_test_contato_uf" CHECK (uf ~ '^(?:[A-Z]{2})$'),
	CONSTRAINT "ck_acid_test_contato_telefone" CHECK (telefone ~ '^(?:[0-9]{10,11})$')
);
--> statement-breakpoint
ALTER TABLE "acidente_identificacao" ADD CONSTRAINT "fk_acid_ident_acidentado" FOREIGN KEY ("acidentado_id") REFERENCES "public"."acidentado"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acidente_identificacao" ADD CONSTRAINT "fk_acid_ident_registrado_por" FOREIGN KEY ("registrado_por") REFERENCES "public"."usuario"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acidente_testemunha_contato" ADD CONSTRAINT "fk_acid_test_contato_testemunha" FOREIGN KEY ("testemunha_id") REFERENCES "public"."acidente_testemunha"("id") ON DELETE no action ON UPDATE no action;