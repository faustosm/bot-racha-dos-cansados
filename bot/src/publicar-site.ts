/**
 * Publica no repo do SITE as paginas que sao do bot: /regras e /estatistica.
 *
 *   make publicar-site
 *
 * Por que elas moram aqui e nao la: o conteudo das duas e deste projeto. A
 * /regras descreve o que `domain/lista.ts` e `domain/inscricao.ts` fazem, e a
 * /estatistica desenha o que `domain/estatisticas.ts` calcula - mudou a regra,
 * as duas mudam junto, no mesmo commit. Ficando no outro repo, a pagina
 * envelhecia sozinha (foi o que aconteceu com "convidado so entra havendo
 * vaga", que sobreviveu dias a regra que a desmentia).
 *
 * Por que o SITE continua servindo: rachadoscansados.com.br e um Worker so,
 * ligado ao repo do site, e as duas paginas usam assets da raiz dele
 * (`/theme-init.js`, `/icon-192.png`) e linkam pro app. Separar o deploy
 * custaria um segundo Worker e uma copia desses assets - muito preco para o
 * problema que existia, que era so de autoria.
 *
 * Entao o fluxo e o mesmo do `estatisticas.json` (ver `estatisticas.ts`): o
 * bot empurra o arquivo via API do GitHub, o push dispara o build no
 * Cloudflare. La essas pastas sao GERADAS - quem edita, edita aqui.
 *
 * So texto: `readFile` com utf8 nao serve pra fonte nem imagem. Os binarios
 * compartilhados (icone, Oswald) continuam sendo do repo do site, que e quem
 * os serve pro resto das paginas.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { config } from './config.js';
import { escreverArquivo, lerArquivo } from './github/client.js';

/** Onde as paginas moram no repo do site (o Vite copia `public/` pra `dist/`). */
const PREFIXO_DESTINO = 'public';

async function arquivosDe(raiz: string): Promise<string[]> {
  const entradas = await readdir(raiz, { withFileTypes: true, recursive: true });
  return entradas
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath ?? raiz, e.name))
    .sort();
}

async function main(): Promise<void> {
  const raiz = process.argv[2];
  if (!raiz) {
    console.error('uso: publicar-site.ts <diretorio>   (use `make publicar-site`)');
    process.exit(1);
  }
  if (!config.GITHUB_TOKEN) {
    console.error('GITHUB_TOKEN vazio - sem ele nao da pra publicar no repo do site.');
    process.exit(1);
  }

  const arquivos = await arquivosDe(raiz);
  if (!arquivos.length) {
    console.error(`nada em ${raiz} - diretorio errado?`);
    process.exit(1);
  }

  let publicados = 0;
  for (const caminho of arquivos) {
    const rel = relative(raiz, caminho).split('\\').join('/');
    const destino = `${PREFIXO_DESTINO}/${rel}`;
    const conteudo = await readFile(caminho, 'utf8');
    const atual = await lerArquivo(destino);

    // Mesmo cuidado do estatisticas.json: publicar identico gera commit e
    // build no Cloudflare a toa.
    if (atual?.conteudo === conteudo) {
      console.log(`  =  ${destino}`);
      continue;
    }

    await escreverArquivo(
      destino,
      conteudo,
      `site: ${rel} publicado pelo bot`,
      atual?.sha,
    );
    console.log(`  ${atual ? '~' : '+'}  ${destino}`);
    publicados += 1;
  }

  console.log(
    publicados
      ? `\n${publicados} arquivo(s) publicado(s) em ${config.GITHUB_REPO}. O build do Cloudflare sai em seguida.`
      : '\nNada mudou - nenhum commit gerado.',
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
