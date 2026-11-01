# Plano de resposta a incidente de segurança — Sistema SISA (nuvem)

**Rascunho para aprovação da UFVJM.** Nomes, telefones e e-mails dos responsáveis
ficam na §9, preenchidos pela unidade; **não os escreva em outro lugar do repositório**.
Base: LGPD arts. 46 a 48 e Resolução CD/ANPD nº 15/2024 (comunicação de incidente).

## 1. O que é incidente

Qualquer evento que comprometa a confidencialidade, a integridade ou a
disponibilidade de dado pessoal do sistema. Exemplos:

- conta de alguém usada por outra pessoa; senha ou segundo fator vazados;
- **cadeia da trilha rompida** (`/saude/db`, alerta "cadeia rompida");
- backup, exportação ou planilha importada fora do lugar; chave ou variável do
  Netlify/Supabase exposta (`CSSO_CHAVE_SECRETA`, senha do banco, SMTP);
- acesso indevido ao banco ou ao Storage; envio de e-mail ou certificado à pessoa errada;
- sistema fora do ar por mais de um dia útil.

Na dúvida, trate como incidente e registre; descartar depois custa menos que descobrir tarde.

## 2. Quem faz o quê

| Papel | Faz |
|---|---|
| Quem percebeu | Avisa o responsável técnico **na hora**; não apaga nada, não "conserta" |
| Responsável técnico (admin_ti) | Conduz a contenção e a investigação (§4 e §5) |
| Superintendência/chefia da CSSO | Decide, com o encarregado (DPO), se comunica ANPD e titulares |
| Encarregado (DPO) | Avalia o risco, redige e protocola a comunicação (§7) |

## 3. Relógio

- **Hora 0**: ciência do incidente. Anote data e hora no registro (§8).
- **Até 3 dias úteis**: prazo para comunicar a ANPD e os titulares quando houver risco ou dano
  relevante (Res. CD/ANPD 15/2024). Se faltar dado, comunique o que se sabe e complemente depois.

## 4. Contenção (primeiras horas) — nesta ordem

1. **Preserve**: faça um backup na hora (Netlify > função `backup-background`, ou o
   procedimento do `PRODUCAO.md` §5) e guarde cópia dos logs (Netlify > Logs > Functions).
2. **Conta suspeita**: em `/usuarios`, bloqueie/redefina a senha e, havendo segundo fator, "Desligar o
   segundo fator"; encerre as sessões.
3. **Segredo vazado**: troque a variável no Netlify e publique de novo.
   - Senha do banco: `PRODUCAO.md` §1.
   - `CSSO_CHAVE_SECRETA`: derruba todas as sessões **e inutiliza os segredos do segundo
     fator** (`PRODUCAO.md` §6). Avise as pessoas antes, quando der.
   - SMTP: troque a senha no provedor e no Netlify.
4. **Contenção total** (último recurso): tire o site do ar pelo Netlify (desative o deploy)
   até entender o que houve.
5. **Não** apague trilha, backup nem registro; a trilha é imutável por desenho (RN-19).

## 5. Investigação

- Trilha em `/auditoria`: quem fez o quê e quando (só identificadores, sem dado pessoal).
- `registro_acesso` (guardado 90 dias): IP e user-agent dos acessos.
- Cadeia: a rotina `CONFERENCIA_CADEIA` mostra a primeira linha rompida.
- Liste: quais **titulares**, quais **categorias de dado** (ROPA), por **quanto tempo**, e se
  havia dado de saúde (acidente, EPI) ou identificação restrita.
- Procure a causa e feche a porta antes de religar.

## 6. Recuperação

- Restaure do último backup bom (`PRODUCAO.md` §5) só se houver dado perdido ou adulterado.
- Rode a conferência da cadeia e confira `/saude/db` (`alertas` vazio).
- Registre o que mudou para que não se repita (§8).

## 7. Comunicação

1. O encarregado avalia se há **risco ou dano relevante** aos titulares. Havendo, comunica a
   **ANPD** (formulário de comunicação de incidente no site da ANPD) e os **titulares**.
2. Conteúdo mínimo: natureza do incidente; categorias e número aproximado de titulares;
   dados afetados; medidas técnicas adotadas; riscos; o que o titular pode fazer; contato do encarregado.
3. Aos titulares: linguagem simples, sem culpar, sem repetir o dado vazado. Use o e-mail
   cadastrado, **sem anexar** dado pessoal.
4. Os operadores (Netlify, Supabase, Google, provedor de SMTP) avisam o controlador de incidente
   do lado deles; confirme isso no contrato de cada um (item pendente do lote 3).

## 8. Registro do incidente

Guarde fora do sistema (processo SEI da CSSO): data/hora de ciência; quem avisou; o que foi visto;
medidas e horários; titulares afetados (número, **não nomes**); decisão sobre a ANPD, com data; causa;
ação corretiva. Nada disso entra no repositório.

## 9. Contatos (a unidade preenche, fora do repositório)

Responsável técnico · Chefia da CSSO · Encarregado (DPO) · Suporte Netlify · Suporte Supabase ·
Segurança da informação da UFVJM.

## 10. Ensaio

Uma vez por ano, ou antes de ir à produção: simule "conta vazada" e "chave vazada" e cronometre §4.
Anote o resultado e ajuste este plano.
