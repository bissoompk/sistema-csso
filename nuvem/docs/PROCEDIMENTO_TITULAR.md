# Procedimento para pedidos do titular — Sistema SISA (nuvem)

**Rascunho para aprovação da UFVJM.** Base: LGPD art. 18 (direitos), art. 19 (prazo de
resposta) e art. 16 (conservação autorizada). Complementa `docs/ROPA_NUVEM.md`.

## 1. Quem atende

O **encarregado (DPO)** recebe o pedido; a CSSO executa no sistema. Enquanto o encarregado não for
indicado, a chefia da CSSO responde e registra. O canal (e-mail institucional ou protocolo SEI) é
divulgado ao titular pela unidade.

## 2. Passo 1 — Confirmar quem pede

Dado pessoal só vai a quem prova ser o titular:

- **Tem conta**: o pedido sai de dentro da conta, ou do e-mail cadastrado.
- **Sem conta**: responda **só ao e-mail que já está no cadastro**, nunca a um digitado agora
  (é a mesma regra do link de acesso do participante, ROPA §5.10).
- **Terceiro (procurador)**: só com procuração. Na dúvida, o encarregado decide.
- Nunca peça CPF por e-mail nem aceite foto de documento por canal aberto.

## 3. Passo 2 — Prazo

- Confirmação simples (existência de tratamento): **imediata**.
- Declaração completa: **até 15 dias** do pedido (LGPD art. 19, II). Se não der, avise o titular
  e diga quando responderá.
- Registre data do pedido e data da resposta no processo SEI.

## 4. Passo 3 — Por direito

| Pedido (art. 18) | O que fazer |
|---|---|
| Confirmar que há tratamento / acesso | Em "Minha atividade" o titular vê o que o sistema registrou sobre ele (treinamentos, certificados, EPI, processos, conta). O que ali faltar: a CSSO consulta o cadastro e responde por escrito, **sem enviar dado de outras pessoas** |
| Correção | Servidor/participante: a CSSO corrige pela tela (a correção de participante reemite o certificado). A trilha guarda "campo alterado", sem os valores (RN-19) |
| Anonimização, bloqueio ou eliminação | Só do que for **desnecessário ou tratado sem base legal**. Certificado emitido, trilha e acidente têm **guarda por obrigação legal ou regulatória** (art. 16, I): explique ao titular o que fica e por quê. O que não tiver guarda: o encarregado autoriza e a CSSO elimina |
| Portabilidade | Entrega o certificado e os dados do cadastro em formato aberto (PDF/CSV), enviada ao e-mail do cadastro |
| Informação sobre compartilhamento | Responda com a lista de operadores do ROPA (Netlify, Supabase, Google/conversor de PDF, provedor de SMTP) e a finalidade de cada um |
| Revogar consentimento | Vitrine pública: cancele o aviso de turma. Demais tratamentos não dependem de consentimento (têm base legal própria) |
| Oposição / revisão de decisão automatizada | O sistema não decide nada de forma automatizada sobre a pessoa; responda isso e registre o pedido |

## 5. Passo 4 — Registrar e responder

1. Registre no SEI: data, titular (por nome ou matrícula, **fora do repositório**), direito, decisão, quem executou.
2. Responda por escrito, em linguagem simples. Dado pessoal vai **no corpo ou em anexo protegido**,
   nunca copiado em cima de outro e-mail, nem para outro destinatário.
3. Havendo recusa parcial, diga o fundamento legal e que o titular pode reclamar à ANPD.

## 6. O que não fazer

- Não consultar o banco direto para "adiantar": use as telas, que gravam trilha.
- Não responder com dado de terceiros (colegas de turma, acidentados de outra pessoa).
- Não eliminar trilha nem acidente por pedido: há guarda obrigatória; a eliminação do que sobra tem
  ata (ver "Expurgo parcial de Acidentes" no `PRODUCAO.md`).

## 7. Pontos a confirmar com o encarregado

1. Canal oficial de recebimento e quem assina a resposta.
2. Prazos de guarda de cada categoria (ROPA/`POLITICA_RETENCAO.md`) citáveis ao titular.
3. Se a UFVJM quer um formulário padrão (modelo de resposta) para os casos mais frequentes.
