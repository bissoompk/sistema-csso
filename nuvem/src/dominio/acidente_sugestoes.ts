/**
 * Sugestões de ação a partir do agente causador (Tabela II do Anexo III).
 *
 * É um RASCUNHO DE PARTIDA, não norma: a equipe de segurança do trabalho ainda
 * não definiu uma tabela de correspondência, e inventar uma por item (são 199)
 * seria pior do que não ter. Por isso a tabela é por FAMÍLIA do agente — faixas
 * contíguas do número da Tabela II — e só aponta o TIPO de ação (a hierarquia de
 * controles que o plano já usa) com um exemplo curto. A equipe revisa e corrige
 * este arquivo; a tela diz sempre que é sugestão e que quem decide é ela.
 *
 * Não grava nada, não cria ação e não lê texto livre (D2: sem IA).
 */
export type TipoAcao = "ENGENHARIA" | "ORGANIZACAO_TRABALHO" | "SINALIZACAO" | "MANUTENCAO" | "PROCEDIMENTO" | "TREINAMENTO" | "EPI" | "GESTAO";

export interface Sugestao {
  tipo: TipoAcao;
  /** o exemplo, em poucas palavras */
  exemplo: string;
}

export interface FamiliaDeAgente {
  codigo: string;
  rotulo: string;
  /** a faixa do número do agente na Tabela II, com os dois extremos */
  de: number;
  ate: number;
  sugestoes: readonly Sugestao[];
}

/** O que a tela diz junto das sugestões. */
export const AVISO_SUGESTAO = "Sugestão de partida, por família do agente: não é norma nem conclusão. A equipe de segurança decide o que entra no plano.";

export const FAMILIAS_DE_AGENTE: readonly FamiliaDeAgente[] = [
  {
    codigo: "SUPERFICIES", rotulo: "Superfícies, escadas, telhados e estruturas", de: 1, ate: 26,
    sugestoes: [
      { tipo: "ENGENHARIA", exemplo: "corrimão, guarda-corpo, piso antiderrapante, iluminação, correção do desnível" },
      { tipo: "MANUTENCAO", exemplo: "inspeção e reparo da superfície ou da estrutura" },
      { tipo: "SINALIZACAO", exemplo: "piso molhado, desnível, área interditada" },
      { tipo: "PROCEDIMENTO", exemplo: "se houve queda de nível, rever o trabalho em altura (NR-35)" },
    ],
  },
  {
    codigo: "FERRAMENTAS", rotulo: "Ferramentas manuais e portáteis", de: 27, ate: 63,
    sugestoes: [
      { tipo: "ENGENHARIA", exemplo: "proteção e dispositivos de segurança da ferramenta" },
      { tipo: "MANUTENCAO", exemplo: "inspeção, afiação e troca de ferramenta danificada" },
      { tipo: "TREINAMENTO", exemplo: "uso correto da ferramenta e da tarefa" },
      { tipo: "EPI", exemplo: "luvas, óculos ou proteção adequada à tarefa" },
    ],
  },
  {
    codigo: "MAQUINAS", rotulo: "Máquinas e transportadores", de: 64, ate: 86,
    sugestoes: [
      { tipo: "ENGENHARIA", exemplo: "proteção de partes móveis e intertravamento (NR-12)" },
      { tipo: "PROCEDIMENTO", exemplo: "bloqueio e etiquetagem na manutenção e na limpeza" },
      { tipo: "TREINAMENTO", exemplo: "operação segura e o que fazer quando a máquina trava" },
      { tipo: "SINALIZACAO", exemplo: "zonas de perigo e parada de emergência identificadas" },
    ],
  },
  {
    codigo: "GUINDAR_TRANSMISSAO", rotulo: "Equipamento de guindar e transmissão de energia mecânica", de: 87, ate: 103,
    sugestoes: [
      { tipo: "ENGENHARIA", exemplo: "proteção das partes móveis e limitadores" },
      { tipo: "MANUTENCAO", exemplo: "inspeção de cabos, ganchos e acessórios de içamento" },
      { tipo: "PROCEDIMENTO", exemplo: "plano de içamento e isolamento da área de movimentação de carga" },
      { tipo: "TREINAMENTO", exemplo: "operador e sinaleiro habilitados" },
    ],
  },
  {
    codigo: "ELETRICO", rotulo: "Equipamento elétrico", de: 104, ate: 114,
    sugestoes: [
      { tipo: "ENGENHARIA", exemplo: "isolamento, aterramento e proteção contra choque (NR-10)" },
      { tipo: "PROCEDIMENTO", exemplo: "desenergização, bloqueio e verificação de ausência de tensão" },
      { tipo: "TREINAMENTO", exemplo: "habilitação e autorização para serviço em eletricidade" },
      { tipo: "MANUTENCAO", exemplo: "inspeção da instalação e do equipamento envolvido" },
    ],
  },
  {
    codigo: "PRESSAO", rotulo: "Motores, bombas, caldeiras e vasos sob pressão", de: 115, ate: 126,
    sugestoes: [
      { tipo: "ENGENHARIA", exemplo: "dispositivos de segurança e alívio de pressão" },
      { tipo: "MANUTENCAO", exemplo: "inspeção periódica e prontuário do equipamento (NR-13)" },
      { tipo: "PROCEDIMENTO", exemplo: "operação, partida e parada; trabalho em ambiente de pressão anormal" },
      { tipo: "TREINAMENTO", exemplo: "operador treinado para o equipamento" },
    ],
  },
  {
    codigo: "CALOR_RADIACAO", rotulo: "Aquecimento e radiação", de: 127, ate: 135,
    sugestoes: [
      { tipo: "ENGENHARIA", exemplo: "blindagem, enclausuramento ou isolamento da fonte" },
      { tipo: "PROCEDIMENTO", exemplo: "acesso restrito e registro de exposição; para radiação ionizante, o serviço de proteção radiológica" },
      { tipo: "SINALIZACAO", exemplo: "área controlada ou supervisionada sinalizada" },
      { tipo: "TREINAMENTO", exemplo: "orientação sobre o risco e a conduta em caso de exposição" },
    ],
  },
  {
    codigo: "VEICULOS", rotulo: "Veículos e equipamentos de movimentação", de: 136, ate: 152,
    sugestoes: [
      { tipo: "ORGANIZACAO_TRABALHO", exemplo: "separar a circulação de pedestres e de veículos" },
      { tipo: "PROCEDIMENTO", exemplo: "regras de trânsito interno, condução e estacionamento" },
      { tipo: "TREINAMENTO", exemplo: "condutor ou operador habilitado e orientado" },
      { tipo: "MANUTENCAO", exemplo: "revisão do veículo ou do equipamento envolvido" },
      { tipo: "SINALIZACAO", exemplo: "sinalização de velocidade, cruzamento e áreas de manobra" },
    ],
  },
  {
    codigo: "QUIMICOS", rotulo: "Substâncias químicas e líquidos", de: 153, ate: 170,
    sugestoes: [
      { tipo: "ENGENHARIA", exemplo: "ventilação ou exaustão, capela e contenção de derramamento" },
      { tipo: "PROCEDIMENTO", exemplo: "FISPQ/FDS à mão, armazenamento, rotulagem e descarte" },
      { tipo: "EPI", exemplo: "luvas, óculos e proteção respiratória conforme a FISPQ/FDS" },
      { tipo: "TREINAMENTO", exemplo: "manuseio seguro e primeiros socorros do produto" },
    ],
  },
  {
    codigo: "ANIMAL", rotulo: "Produtos de origem animal", de: 171, ate: 175,
    sugestoes: [
      { tipo: "PROCEDIMENTO", exemplo: "rotina de biossegurança e de manuseio de material biológico" },
      { tipo: "EPI", exemplo: "luvas e proteção conforme o agente biológico" },
      { tipo: "TREINAMENTO", exemplo: "manuseio seguro e conduta após exposição" },
    ],
  },
  {
    codigo: "MATERIAIS", rotulo: "Materiais, combustíveis e produtos", de: 176, ate: 199,
    sugestoes: [
      { tipo: "ORGANIZACAO_TRABALHO", exemplo: "armazenamento e movimentação organizados, carga dentro do limite" },
      { tipo: "PROCEDIMENTO", exemplo: "para inflamáveis e combustíveis, armazenamento e fontes de ignição (NR-20)" },
      { tipo: "EPI", exemplo: "luvas, calçado e proteção adequados ao material" },
      { tipo: "TREINAMENTO", exemplo: "manuseio e movimentação segura do material" },
    ],
  },
];

/** A família do agente pelo número dele na Tabela II (`ordem`), ou nada se fora de todas. */
export function familia_do_agente(ordem: number | null | undefined): FamiliaDeAgente | null {
  if (ordem === null || ordem === undefined) return null;
  return FAMILIAS_DE_AGENTE.find((f) => ordem >= f.de && ordem <= f.ate) ?? null;
}

/** As sugestões ainda sem ação do mesmo tipo no plano (ações canceladas já foram tiradas por quem chama). */
export function sugestoes_faltantes(familia: FamiliaDeAgente, tipos_no_plano: readonly string[]): Sugestao[] {
  return familia.sugestoes.filter((s) => !tipos_no_plano.includes(s.tipo));
}
