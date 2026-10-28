-- Os agentes causadores 107 e 165 vinham cortados no legado e foram completados
-- por palpite («..., ETC»). O texto completo é o da Tabela 14 do eSocial v2.5
-- (302 → 303040400 e 305004700). Só troca o que ainda tem o rótulo do palpite
-- (idempotente; quem já ajustou o rótulo à mão não é tocado) e não mexe no
-- `rotulo_legado`, que é a chave de casamento da migração da planilha.
UPDATE "acidente_agente_causador"
   SET "rotulo" = 'PAINEL DE CONTROLE, BARRAMENTO, CHAVE, INTERRUPTOR, DISJUNTOR, FUSÍVEL'
 WHERE "ordem" = 107
   AND "rotulo" = 'PAINEL DE CONTROLE, BARRAMENTO, CHAVE, INTERRUPTOR, ETC';--> statement-breakpoint
UPDATE "acidente_agente_causador"
   SET "rotulo" = 'COMPOSTO ORGÂNICO HALOGENADO (TRICLORETILENO, PERCLORETILENO, CLORETO DE METILO, SUBSTÂNCIAS REFRIGERANTES)'
 WHERE "ordem" = 165
   AND "rotulo" = 'COMPOSTO ORGÂNICO HALOGENADO (TRICLORETILENO, ETC)';
