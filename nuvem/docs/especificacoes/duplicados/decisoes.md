# Decisões do usuário (23/10/2026) — cadastros duplicados

1. Tela "Juntar cadastros duplicados": SAI DO MENU; vira contador de "possíveis duplicados" (no Início/hub de Treinamentos) + atalho na ficha do participante. A junção continua existindo.
2. Link público: AVISAR O VISITANTE sem divulgar nada — modelo "esqueci a senha" (aviso_visitante.md): resposta idêntica na tela + linha neutra; aviso por e-mail só ao endereço JÁ cadastrado, sem nome/SIAPE/dados digitados; casa por e-mail+nome ou SIAPE+nome (este com limite de 1 aviso por destinatário/24 h); só nome ou externo sem e-mail → nada ao visitante, equipe vê "parece com PTC-XXXX" na conferência.
   - Corrigir brecha: `E-mail inválido: '<endereço>'` (participante.ts:171) vazando ao visitante (422).
   - Tempo de resposta constante (já inscrito sai mais cedo).
   - Limites (IP, destinatário) no banco, não na memória.
   - Já inscrito: aviso "não precisa pedir de novo" (pelo e-mail cadastrado). E-mail não cita a turma na etapa 1.
   - Sem captcha. Avisos sem SMTP: vencem em 24 h.
   - Botões "sou eu"/"não fui eu" + confirmado_em: ETAPA 2 (depois). "Sou eu" nunca acrescenta o e-mail digitado.
3. Lote: perguntar linha a linha ("parece com Fulano" na prévia; usar este / criar novo).
4. Importação SIAPE: só sugerir (relatório de parecidos), não ligar sozinho.
5. Confirmar o e-mail quando a pessoa clica no link enviado: SIM (gravar participante_email.confirmado_em — acesso aos certificados por link mágico conta).
6. CPF: NÃO como chave; só certificado. (Corrigir comentários desatualizados treinamento.ts:292 e DESVIOS.md:718.)
7. Guardar pares "não é a mesma pessoa": SIM.
8. Operador sem leitura nominal cadastrando externo: criar e marcar suspeito.
9. Desfazer junção: registrar já o que cada junção move; botão desfazer só depois.
10. Carga de certificados antigos (IntegraSST/planilhas): SIM — vai haver (fazer depois, com casamento + relatório de ambíguos).
Também: aviso ao escolher servidor da base na ficha da turma quando já tem cadastro de externo; critério único de "parecido".
