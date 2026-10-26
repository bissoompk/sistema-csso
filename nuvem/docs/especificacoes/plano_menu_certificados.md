# Menu lateral de Certificados e Treinamentos: organização final e plano de implementação

Conferi no código os pontos em que as quatro análises divergiam: `src/modulos.ts`, `templates/base.html`, `src/servicos/hub_treinamentos.ts`, os títulos `<h1>` das telas e os testes que citam os rótulos. Não editei nenhum arquivo.

## Decisões onde as análises divergiam

1. **Onde fica Indicadores: no grupo "Acompanhamento", junto de Reciclagem.** Fica no grupo, e não no topo como sugeria a lente "ia". No topo, ele ficaria colado ao Início sem ser porta de trabalho. Para o perfil admin_ti, que só vê Indicadores, o subtítulo some pela regra do "grupo único sem título" (item C). Assim o argumento do título órfão também cai.
2. **Rótulos mudam pouco.** A lateral tem 252px, o que deixa uns 19 caracteres antes de o rótulo quebrar em duas linhas. Por isso o subtítulo do grupo dá o contexto e o rótulo continua curto. Só mudam os rótulos que hoje enganam:
   - "Certificados" passa a ser **"Emitidos"**. Repetia o nome do módulo e ficava ao lado de "Meus certificados". Agora faz par com "Fila de emissão".
   - "E-mails" passa a ser **"Envios por e-mail"**. O rótulo atual parece caixa de entrada, mas a tela mostra o que saiu.
   - "Catálogo" passa a ser **"Treinamentos"**, dentro do grupo "Cadastros". Hoje fica a poucas linhas de "Catálogos", da Base compartilhada, e do "Catálogo" da Gestão de EPI.
   - "Participantes" passa a ser **"Juntar duplicados"**. A tela só junta cadastros duplicados.
3. **Rótulos que ficam como estão:**
   - **"Pedidos pelo link"** é termo firmado. Aparece no hub, em turma_link.html:75, em turma_ficha.html:405 e no `<h1>` da tela, e o subtítulo "Turmas e inscrições" já diz que é inscrição. "Inscrições a conferir", com 21 caracteres, quebraria a linha.
   - **"Fila de emissão"** fica. "Emitir certificados" prometeria uma ação que a PROGEP e o auditor não têm.
   - **"Modelos"** fica. "Modelos de certificado" tem 22 caracteres e quebraria. O subtítulo "Cadastros", o title e o `<h1>` (que já é "Modelos de certificado") dão o contexto.
   - **"Instrutores"** fica. É vigiado pelo teste telas_simplificadas.test.ts:34.
   - **"Reciclagem"** fica. É o termo do SST.
4. **Os itens pessoais vão para um grupo "Meu espaço", no fim.** É o mesmo nome do menu que o servidor comum recebe, para o sistema falar uma língua só. No fim, eles não passam à frente de Turmas na porta de entrada.
5. **Os grupos ficam declarados no módulo, não em cada item.** Assim não muda o construtor posicional de `Item`, nem MEU_ESPACO, BASE ou celular.ts. A lista plana `itens` passa a ser derivada dos grupos e continua existindo.
6. **Ficam de fora desta etapa:**
   - Contagens no menu: custariam consulta ao banco em toda página e podem acusar no teste idas_ao_banco.
   - Grupo "Cadastros" recolhido num `<details>`: escondia o destaque de onde a pessoa está.
   - Esconder a Fila da PROGEP ou "Setores promotores" da secretaria: quebraria o contrato de que o item repete a permissão da rota.
   - Saber se o admin_ti deve ter `indicador.ver`: é decisão de RBAC, a tomar à parte.

## 1. Estrutura final

Nenhum caminho muda e nenhuma permissão muda.

| Grupo | Rótulo | Caminho | Permissão | Descrição (title) |
|---|---|---|---|---|
| (sem título) | Início | /treinamentos | certificado.ver | Os passos do trabalho e o que espera por você em cada um. |
| Turmas e inscrições | Turmas | /turmas | treinamento.ver | Da abertura das inscrições ao fecho da turma. |
| | Pedidos pelo link | /turmas/pedidos | turma.inscrever | Quem se inscreveu pelo link público e espera a conferência, de todas as turmas. |
| Certificados | Fila de emissão | /certificados/fila | certificado.ver | Aprovados sem certificado e travados, de todas as turmas: emitir e enviar. |
| | **Emitidos** | /certificados | certificado.ver | Certificados já emitidos: busca, segunda via, correção e anulação. |
| | **Envios por e-mail** | /certificados/emails | certificado.emitir | O que saiu por e-mail: na fila, enviados e com falha. |
| Acompanhamento | Reciclagem | /certificados/vencimentos | certificado.ver | Quem tem certificado vencido ou a vencer em 30 dias. |
| | Indicadores | /treinamentos/indicadores | indicador.ver | (a mesma de hoje) |
| Cadastros | **Treinamentos** | /treinamentos/catalogo | treinamento.ver | Catálogo de treinamentos: carga horária e validade da reciclagem. |
| | Modelos | /treinamentos/modelos | treinamento.gerenciar | Modelos de certificado: o .docx e o dicionário de tags. |
| | Instrutores | /treinamentos/assinaturas | assinatura.gerenciar | Quem assina o certificado: nome, título e rubrica. |
| | Setores promotores | /treinamentos/setores-promotores | treinamento.ver | (a mesma de hoje) |
| | **Juntar duplicados** | /treinamentos/participantes | participante.mesclar | Cadastros que parecem a mesma pessoa, para juntar num só. |
| Meu espaço | Meus treinamentos | /turmas/minhas | treinamento.ver, do_titular | (a mesma de hoje) |
| | Meus certificados | /certificados/meus | treinamento.ver, do_titular | (a mesma de hoje) |

Em todos os perfis, o primeiro item visível continua o mesmo de hoje:
- quem tem certificado.ver entra pelo Início;
- quem só tem treinamento.ver entra por Turmas (o teste modulos.test.ts:157 continua passando);
- o admin_ti entra por Indicadores.

Assim, `porta_de_entrada`, `primeira_tela`, `_modulo_de_recuo` e a saída do erro.html (`itens_modulo[0]`) não mudam.

**O que cada perfil passa a ver** (conta sem vínculo a servidor):
- **Coordenador, superintendente, engenheiro e médico (13):** Início · Turmas e inscrições (2) · Certificados (3) · Acompanhamento (2) · Cadastros (5). Com a conta vinculada a um servidor, ganham também o grupo Meu espaço (2).
- **Técnico (12):** o mesmo, sem "Juntar duplicados".
- **Secretaria (10):** Início · Turmas e Pedidos pelo link · Fila, Emitidos e Envios por e-mail · Reciclagem e Indicadores · Cadastros com Treinamentos e Setores promotores.
- **Consulta PROGEP e auditor (8):** Início · Turmas · Fila e Emitidos · Reciclagem e Indicadores · Treinamentos e Setores promotores.
- **Admin de TI:** só Indicadores, sem nenhum subtítulo.
- **Almoxarife:** o módulo continua oculto.
- **Servidor comum:** continua com o MEU_ESPACO, sem mudança.

## 2. Desenho técnico

### A. `src/modulos.ts`

- Criar o tipo do grupo:
  ```ts
  export interface GrupoMenu { readonly titulo: string | null; readonly itens: readonly Item[] }
  ```
- Em `DadosModulo`, acrescentar `grupos?: readonly GrupoMenu[]`.
- No construtor de `Modulo`:
  - lançar `Error` se vierem `grupos` e `itens` juntos;
  - montar `this.grupos = Object.freeze((d.grupos ?? [{titulo: null, itens: d.itens ?? []}]).map(g => Object.freeze({titulo: g.titulo, itens: Object.freeze([...g.itens])})))`;
  - derivar `this.itens = Object.freeze(this.grupos.flatMap(g => g.itens))`.
- Novo método `grupos_de(usuario): GrupoMenu[]`:
  - filtra os itens de cada grupo com `visivel_para`;
  - descarta os grupos que ficam vazios;
  - se sobrar um grupo só, devolve-o com `titulo: null`;
  - sempre devolve objetos novos, sem alterar os arrays congelados.
- O módulo "certificados" passa a declarar `grupos: [...]`, conforme a tabela acima, com os novos rótulos e descrições. Os comentários longos que hoje estão junto dos itens "Meus ..." seguem com eles.
- Processos SEI e EPI não mudam: caem num grupo único sem título e o HTML sai idêntico ao de hoje.
- `Navegacao` ganha `grupos_modulo: Grupo[]`, preenchido em `navegacao()` com `ativo ? ativo.grupos_de(usuario) : []`. O campo `itens_modulo` continua, porque erro.html e os testes usam.
- `itens_de`, `item_ativo`, `modulo_ativo`, `porta_de_entrada`, `primeira_tela`, ICONES (indexado por caminho) e MEU_ESPACO ficam intactos.

### B. `templates/base.html` (linhas 172-180)

O bloco passa a ser:

```njk
<div class="menu menu-modulo" role="group" aria-label="Telas de {{ m.nome }}">
  {% for g in grupos_modulo %}
  {% if g.titulo %}<div class="menu-grupo" role="group" aria-labelledby="grupo-{{ m.codigo }}-{{ loop.index }}">
    <span class="rotulo-grupo" id="grupo-{{ m.codigo }}-{{ loop.index }}">{{ g.titulo }}</span>{% endif %}
    {% for item in g.itens %}…o mesmo <a> de hoje (href, title, classe 'ativo', aria-current, ícone)…{% endfor %}
  {% if g.titulo %}</div>{% endif %}
  {% endfor %}
</div>
```

- O `role="group"` faz valer o `aria-label` que já existe e hoje é ignorado pelo leitor de tela, porque está numa `div` sem papel.
- O subtítulo é um `<span>` que não recebe foco, e não um `<h2>` ou `<h3>`. Assim o esqueleto de títulos da página e a contagem de Tab do salto não mudam.
- Não há script nem style inline, então a CSP continua atendida.
- Atualizar o comentário da linha 56, que fala em "até 13 itens do menu do módulo".

### C. CSS

Em `public/estaticos/css/csso.css`, perto da linha 450:

```css
.lateral .menu-modulo .menu-grupo { display:flex; flex-direction:column; gap:1px; margin-top:10px; }
.lateral .menu-modulo .rotulo-grupo { font-family:var(--mono); font-size:10.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--lateral-texto-fraco); padding:0 12px 3px 34px; }
```

- O recuo à esquerda alinha o subtítulo ao texto do item, depois do ícone. Conferir o valor no navegador.
- A cor `--lateral-texto-fraco` já foi medida em 6,52:1, acima do mínimo de 4,5:1.
- Esse estilo é próprio e mais leve que `.rotulo-secao`, para não ter o mesmo peso de "MÓDULOS" e "BASE COMPARTILHADA".

No `@media (max-width:900px)` (csso.css:2689):

```css
.lateral .menu-modulo .menu-grupo { flex:1 1 100%; flex-direction:row; flex-wrap:wrap; margin-top:6px; }
.lateral .menu-modulo .rotulo-grupo { width:100%; padding-left:10px; }
```

Sem essa regra, cada grupo vira um bloco só na faixa do celular. Em `tema.css` (por volta da linha 161), conferir que `.modulos-lateral .menu-modulo` não anula o margin-top e, se precisar, repetir lá as regras do grupo.

### D. `templates/paginas/modulos.html` (por coerência)

- Iterar `m.grupos_de(usuario)`.
- Pôr um `<h3 class="rotulo-grupo-mapa">` antes de cada `.grade-telas` quando o grupo tiver título. Aqui o `<h3>` é correto, porque fica abaixo do `<h2>` do cartão.
- O contador continua vindo de `m.itens_de(usuario)|length`.

### E. Mesmo vocabulário nas telas e no hub

| Onde | Hoje | Passa a ser |
|---|---|---|
| Cartões do hub (hub_treinamentos.ts) | "Certificados" | "Emitidos" |
| | "E-mails" | "Envios por e-mail" |
| | "Catálogo e modelos" / "Catálogo" | "Treinamentos e modelos" / "Treinamentos" |
| emails.html (`<h1>`) | "E-mails" | "Envios por e-mail" |
| emails.html (title) | "E-mails enviados" | "Envios por e-mail" |
| certificados.html (`<h1>` e title) | "Certificados" | "Certificados emitidos" |
| participantes.html (`<h1>` e title) | "Participantes" | "Juntar cadastros duplicados" |

O catálogo mantém o `<h1>` "Catálogo de treinamentos". Conferir também:
- os textos que dizem "Treinamentos → Setores promotores" em catalogo_lista.html:24, 178 e 707, que continuam válidos;
- os textos de certificados.html:97-104;
- a ajuda e o DESVIOS.md, com um grep por "E-mails", "Participantes" e "Catálogo".

Um extra opcional, apontado pela lente "fluxo": pôr na tela do catálogo um link para Modelos, para cumprir o que o cartão "Treinamentos e modelos" promete.

## 3. Testes

### A atualizar
- **`testes/correcoes_certificados.test.ts:508`:** o cartão `"Certificados"` passa a ser `"Emitidos"`. As linhas 503 ("Reciclagem") e 507 ("Instrutores") ficam.
- **Busca por textos antigos:** rodar `grep -rn 'E-mails\|>Certificados<\|Catálogo e modelos\|>Participantes<' testes/` e ajustar o que vier do menu, do hub ou das telas renomeadas. certificados.test.ts:831 é a medida "Participantes" dos indicadores, não o menu, e não muda.

### Devem continuar passando sem mudança
- `modulos.test.ts`:
  - :23, a ordem de Processos SEI;
  - :51-55, o tamanho de `itens` e `itens_previstos`;
  - :150-151, o almoxarife;
  - :157, a primeira tela `/turmas`;
  - :194, :205-213 e `test_link_no_menu_sempre_abre` / `test_a_trilha_nunca_oferece_porta_trancada`.
- `telas_simplificadas.test.ts:33-38`.
- `correcoes_turmas.test.ts:345-349`.
- `correcoes_visual.test.ts:64, 83, 118 e 138-143`.

### A criar em `testes/modulos.test.ts`
1. Os caminhos de `por_codigo('certificados').grupos`, em ordem e com os títulos `[null, "Turmas e inscrições", "Certificados", "Acompanhamento", "Cadastros", "Meu espaço"]`.
2. `m.itens` é igual a `m.grupos.flatMap(g => g.itens)` em todo módulo.
3. Um `Modulo` com `grupos` e `itens` juntos lança erro. Um módulo só com `itens` vira um grupo com `titulo === null`.
4. `grupos_de` da secretaria tem 5 grupos e "Cadastros" só com `/treinamentos/catalogo` e `/treinamentos/setores-promotores`. Não há grupo "Meu espaço" sem vínculo.
5. Para quem tem só `indicador.ver` (admin_ti), `grupos_de` devolve um grupo com `titulo === null` e o item `/treinamentos/indicadores`, e `porta_de_entrada` é `/treinamentos/indicadores`.
6. Para a consulta PROGEP, a ordem dos caminhos visíveis é Início, Turmas, Fila, Emitidos, Reciclagem, Indicadores, Treinamentos, Setores promotores.
7. Com vínculo a servidor, "Meu espaço" é o último grupo e `primeira_tela(treinamento.ver + vínculo)` continua `/turmas`.
8. Módulos sem grupos (Processos SEI, EPI) devolvem um grupo só, sem título.

### A criar em `testes/telas_simplificadas.test.ts`, ou num arquivo novo de tela
9. O HTML de `/turmas` do coordenador contém `class="menu menu-modulo" role="group"`, e cada `aria-labelledby="grupo-certificados-N"` aponta para um `id` presente.
10. A ordem dos `href` dentro de `.menu-modulo` para a secretaria segue a tabela.
11. No HTML da secretaria não aparece o subtítulo "Meu espaço" dentro de `.menu-modulo`. Depois de vincular a conta a um servidor, ele aparece depois de "Juntar duplicados".
12. Em `/certificados/emails`, o item ativo, com `aria-current`, é "Envios por e-mail", e a trilha diz "Envios por e-mail". O mesmo vale para "Emitidos" em `/certificados/123`.
13. O admin_ti não tem nenhum `class="rotulo-grupo"` na lateral.

### Arquivos envolvidos
- /home/fabricio/projetos/ufvjm/sistema-csso/nuvem/src/modulos.ts
- /home/fabricio/projetos/ufvjm/sistema-csso/nuvem/templates/base.html
- /home/fabricio/projetos/ufvjm/sistema-csso/nuvem/public/estaticos/css/csso.css
- /home/fabricio/projetos/ufvjm/sistema-csso/nuvem/public/estaticos/css/tema.css
- /home/fabricio/projetos/ufvjm/sistema-csso/nuvem/templates/paginas/modulos.html
- /home/fabricio/projetos/ufvjm/sistema-csso/nuvem/src/servicos/hub_treinamentos.ts
- /home/fabricio/projetos/ufvjm/sistema-csso/nuvem/templates/paginas/emails.html
- /home/fabricio/projetos/ufvjm/sistema-csso/nuvem/templates/paginas/certificados.html
- /home/fabricio/projetos/ufvjm/sistema-csso/nuvem/templates/paginas/participantes.html
- /home/fabricio/projetos/ufvjm/sistema-csso/nuvem/testes/modulos.test.ts
- /home/fabricio/projetos/ufvjm/sistema-csso/nuvem/testes/correcoes_certificados.test.ts
- /home/fabricio/projetos/ufvjm/sistema-csso/nuvem/testes/telas_simplificadas.test.ts