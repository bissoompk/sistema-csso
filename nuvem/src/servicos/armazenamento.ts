/**
 * Onde moram os arquivos (blobs de anexo, documentos gerados, rubricas).
 *
 * Não existe no Python: lá o blob ia para `data/anexos/<sha[:2]>/<sha>` no
 * disco da máquina do setor. A função do Netlify não tem disco persistente
 * (PORTE.md §7), então o arquivo vai para o **Supabase Storage** — um bucket
 * privado, acessado com a chave de serviço, nunca exposto ao navegador. Em
 * desenvolvimento e teste, sem `SUPABASE_URL`, a mesma interface grava numa
 * pasta local (`nuvem/.dados/`, ou `CSSO_DIR_ARQUIVOS` — os testes apontam
 * para um diretório temporário).
 *
 * A chave é um caminho relativo com `/` (ex.: `anexos/ab/abcdef...`). Nada que
 * venha de fora vira chave sem passar por `conferirChave`.
 */
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { obterConfig } from "../config.js";

export interface Armazenamento {
  /** Grava (ou sobrescreve) o conteúdo na chave. */
  gravar(chave: string, bytes: Uint8Array, tipo?: string): Promise<void>;
  /** Lê o conteúdo; lança `ArquivoAusente` quando não há. */
  ler(chave: string): Promise<Uint8Array>;
  existe(chave: string): Promise<boolean>;
  remover(chave: string): Promise<void>;
  /** URL temporária para o navegador baixar direto (só no Storage). */
  urlAssinada?(chave: string, segundos: number, nomeDownload?: string): Promise<string>;
}

export class ArquivoAusente extends Error {
  constructor(public chave: string) {
    super(`arquivo ausente no armazenamento: ${chave}`);
  }
}

/** Chave relativa, sem `..`, sem barra inicial, sem caractere de controle. */
export function conferirChave(chave: string): string {
  const partes = chave.split("/");
  if (
    !chave ||
    chave.startsWith("/") ||
    chave.includes("\\") ||
    /[\x00-\x1f]/.test(chave) ||
    partes.some((p) => p === "" || p === "." || p === "..")
  ) {
    throw new Error(`chave de armazenamento invalida: ${JSON.stringify(chave)}`);
  }
  return chave;
}

// ---------------------------------------------------------------------
// Pasta local (desenvolvimento e testes)
// ---------------------------------------------------------------------
export class ArmazenamentoLocal implements Armazenamento {
  constructor(readonly raiz: string) {}

  private caminho(chave: string): string {
    return path.join(this.raiz, ...conferirChave(chave).split("/"));
  }

  async gravar(chave: string, bytes: Uint8Array): Promise<void> {
    const destino = this.caminho(chave);
    await mkdir(path.dirname(destino), { recursive: true });
    await writeFile(destino, bytes);
  }

  async ler(chave: string): Promise<Uint8Array> {
    try {
      return new Uint8Array(await readFile(this.caminho(chave)));
    } catch (erro) {
      if ((erro as NodeJS.ErrnoException).code === "ENOENT") throw new ArquivoAusente(chave);
      throw erro;
    }
  }

  async existe(chave: string): Promise<boolean> {
    try {
      return (await stat(this.caminho(chave))).isFile();
    } catch {
      return false;
    }
  }

  async remover(chave: string): Promise<void> {
    await rm(this.caminho(chave), { force: true });
  }
}

// ---------------------------------------------------------------------
// Supabase Storage (produção)
// ---------------------------------------------------------------------
type ClienteSupabase = import("@supabase/supabase-js").SupabaseClient;

export class ArmazenamentoSupabase implements Armazenamento {
  private cliente: ClienteSupabase | null = null;
  private bucketPronto: Promise<void> | null = null;

  constructor(
    readonly url: string,
    readonly chaveServico: string,
    readonly bucket: string,
  ) {}

  private async obter(): Promise<ReturnType<ClienteSupabase["storage"]["from"]>> {
    if (!this.cliente) {
      const { createClient } = await import("@supabase/supabase-js");
      this.cliente = createClient(this.url, this.chaveServico, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
    }
    // o bucket privado nasce na primeira gravação da instalação; depois disso
    // o `getBucket` só confirma (uma vez por instância da função)
    if (!this.bucketPronto) {
      const cliente = this.cliente;
      this.bucketPronto = (async () => {
        const { error } = await cliente.storage.getBucket(this.bucket);
        if (!error) return;
        const criado = await cliente.storage.createBucket(this.bucket, { public: false });
        if (criado.error && !/already exists/i.test(criado.error.message)) {
          throw new Error(`nao foi possivel criar o bucket ${this.bucket}: ${criado.error.message}`);
        }
      })().catch((erro) => {
        this.bucketPronto = null;
        throw erro;
      });
    }
    await this.bucketPronto;
    return this.cliente.storage.from(this.bucket);
  }

  async gravar(chave: string, bytes: Uint8Array, tipo = "application/octet-stream"): Promise<void> {
    const b = await this.obter();
    const { error } = await b.upload(conferirChave(chave), bytes, { contentType: tipo, upsert: true });
    if (error) throw new Error(`falha ao gravar ${chave} no Storage: ${error.message}`);
  }

  async ler(chave: string): Promise<Uint8Array> {
    const b = await this.obter();
    const { data, error } = await b.download(conferirChave(chave));
    if (error || !data) {
      if (!(await this.existe(chave))) throw new ArquivoAusente(chave);
      throw new Error(`falha ao ler ${chave} do Storage: ${error?.message ?? "sem dados"}`);
    }
    return new Uint8Array(await data.arrayBuffer());
  }

  async existe(chave: string): Promise<boolean> {
    const b = await this.obter();
    const { data, error } = await b.exists(conferirChave(chave));
    if (error) return false;
    return Boolean(data);
  }

  async remover(chave: string): Promise<void> {
    const b = await this.obter();
    const { error } = await b.remove([conferirChave(chave)]);
    if (error) throw new Error(`falha ao remover ${chave} do Storage: ${error.message}`);
  }

  async urlAssinada(chave: string, segundos: number, nomeDownload?: string): Promise<string> {
    const b = await this.obter();
    const { data, error } = await b.createSignedUrl(
      conferirChave(chave),
      segundos,
      nomeDownload ? { download: nomeDownload } : undefined,
    );
    if (error || !data) throw new Error(`falha ao assinar URL de ${chave}: ${error?.message ?? "sem dados"}`);
    return data.signedUrl;
  }
}

// ---------------------------------------------------------------------
// A instância do processo
// ---------------------------------------------------------------------
let _armazenamento: Armazenamento | null = null;

/** Pasta local: `CSSO_DIR_ARQUIVOS`, ou `nuvem/.dados/`. */
export function pastaLocal(): string {
  return process.env.CSSO_DIR_ARQUIVOS || path.resolve(process.cwd(), ".dados");
}

export function obterArmazenamento(): Armazenamento {
  if (_armazenamento) return _armazenamento;
  const cfg = obterConfig();
  if (cfg.supabaseUrl) {
    if (!cfg.supabaseChaveServico) {
      throw new Error("SUPABASE_URL definido sem SUPABASE_SERVICE_ROLE_KEY: o Storage precisa da chave de servico.");
    }
    _armazenamento = new ArmazenamentoSupabase(cfg.supabaseUrl, cfg.supabaseChaveServico, cfg.bucketArquivos);
  } else {
    _armazenamento = new ArmazenamentoLocal(pastaLocal());
  }
  return _armazenamento;
}

/** Só para os testes: troca (ou esquece) a instância. */
export function definirArmazenamento(a: Armazenamento | null): void {
  _armazenamento = a;
}
