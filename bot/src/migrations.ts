// Migrations como modulos TS, nao como arquivos .sql soltos: o Dockerfile de
// producao copia apenas ./dist, e o tsc nao carrega .sql junto. Embutir o SQL
// aqui evita ter que sincronizar Dockerfile e bind mount so por causa disso.
//
// Regra: nunca editar uma migration ja aplicada - sempre acrescentar outra.

export interface Migration {
  readonly name: string;
  readonly sql: string;
}

export const migrations: readonly Migration[] = [
  {
    name: '001_init',
    sql: `
      create table if not exists partida (
        id              serial primary key,
        data_jogo       date        not null unique,
        abre_fixos      timestamptz not null,
        abre_convidados timestamptz not null,
        fecha_em        timestamptz not null,
        vagas_total     int         not null default 20,
        vagas_goleiro   int         not null default 2,
        status          text        not null default 'aberta',
        constraint partida_status_valido
          check (status in ('aberta', 'cheia', 'fechada'))
      );

      -- Identidade do fixo e o LID. O pushName e volatil (a pessoa troca quando
      -- quer), serve so para exibicao e e atualizado a cada mensagem.
      create table if not exists jogador (
        lid       text primary key,
        nome      text not null,
        criado_em timestamptz not null default now()
      );

      -- Uma linha por vaga ocupada, cobrindo fixo e convidado.
      create table if not exists inscricao (
        id             serial primary key,
        partida_id     int  not null references partida(id) on delete cascade,
        tipo           text not null,
        posicao        text not null,
        jogador_lid    text references jogador(lid),
        convidado_nome text,
        convidado_de   text references jogador(lid),
        criado_em      timestamptz not null default now(),
        removido_em    timestamptz,
        constraint inscricao_tipo_valido  check (tipo    in ('fixo', 'convidado')),
        constraint inscricao_posicao_valida check (posicao in ('linha', 'gol')),
        constraint inscricao_tipo_coerente check (
          (tipo = 'fixo'
            and jogador_lid    is not null
            and convidado_nome is null
            and convidado_de   is null)
          or
          (tipo = 'convidado'
            and convidado_nome is not null
            and convidado_de   is not null
            and jogador_lid    is null)
        )
      );

      -- Um fixo nao pode ocupar duas vagas na mesma partida. Indice parcial:
      -- so vale para inscricoes ativas, entao sair e voltar continua possivel.
      create unique index if not exists inscricao_fixo_unica
        on inscricao (partida_id, jogador_lid)
        where removido_em is null and tipo = 'fixo';

      create index if not exists inscricao_partida_ativa
        on inscricao (partida_id)
        where removido_em is null;

      -- Estado do dialogo no privado. Expira para nao deixar pergunta pendurada:
      -- um "3" solto tres dias depois nao pode virar convidado fantasma.
      create table if not exists conversa (
        lid        text primary key,
        partida_id int  references partida(id) on delete cascade,
        estado     text not null,
        dados      jsonb not null default '{}'::jsonb,
        expira_em  timestamptz not null
      );
    `,
  },
  {
    // A mesma pessoa chega com DOIS identificadores diferentes:
    //   grupo   -> key.participant     = 103440025919502@lid
    //   privado -> key.remoteJid       = 553491705227@s.whatsapp.net
    // O webhook manda os dois juntos (participantAlt / remoteJidAlt), entao da
    // para ligar. Mas com o LID como chave primaria, quem respondia no privado
    // virava outro jogador: o dialogo nunca era encontrado e um "vou" no
    // privado criaria uma segunda inscricao da mesma pessoa.
    //
    // Aqui o jogador passa a ter identidade propria (id), com lid e telefone
    // como apelidos.
    name: '002_identidade_do_jogador',
    sql: `
      create table jogador_novo (
        id        serial primary key,
        lid       text unique,
        telefone  text unique,
        nome      text not null,
        criado_em timestamptz not null default now(),
        constraint jogador_tem_identidade
          check (lid is not null or telefone is not null)
      );

      insert into jogador_novo (lid, telefone, nome, criado_em)
      select case when lid like '%@lid' then lid end,
             case when lid like '%@lid' then null else lid end,
             nome,
             criado_em
        from jogador;

      alter table inscricao add column jogador_id    int references jogador_novo(id);
      alter table inscricao add column convidado_de_id int references jogador_novo(id);

      update inscricao i set jogador_id = j.id
        from jogador_novo j
       where j.lid = i.jogador_lid or j.telefone = i.jogador_lid;

      update inscricao i set convidado_de_id = j.id
        from jogador_novo j
       where j.lid = i.convidado_de or j.telefone = i.convidado_de;

      alter table inscricao drop constraint inscricao_tipo_coerente;
      drop index if exists inscricao_fixo_unica;
      alter table inscricao drop column jogador_lid;
      alter table inscricao drop column convidado_de;

      alter table inscricao add constraint inscricao_tipo_coerente check (
        (tipo = 'fixo'
          and jogador_id      is not null
          and convidado_nome  is null
          and convidado_de_id is null)
        or
        (tipo = 'convidado'
          and convidado_nome  is not null
          and convidado_de_id is not null
          and jogador_id      is null)
      );

      create unique index inscricao_fixo_unica
        on inscricao (partida_id, jogador_id)
        where removido_em is null and tipo = 'fixo';

      drop table jogador;
      alter table jogador_novo rename to jogador;

      -- Estado efemero: nao vale migrar, e o TTL e de minutos.
      drop table conversa;
      create table conversa (
        jogador_id int primary key references jogador(id) on delete cascade,
        partida_id int references partida(id) on delete cascade,
        estado     text not null,
        dados      jsonb not null default '{}'::jsonb,
        expira_em  timestamptz not null
      );
    `,
  },
  {
    // `nome` guarda o pushName do WhatsApp, que a pessoa muda quando quer e
    // muitas vezes e so o primeiro nome ou um apelido que ninguem reconhece na
    // lista. `nome_escolhido` e o que ELA disse que quer aparecer, e tem
    // prioridade. Uma vez confirmado, o pushName nunca mais sobrescreve.
    name: '003_nome_escolhido',
    sql: `
      alter table jogador add column nome_escolhido  text;
      alter table jogador add column nome_confirmado boolean not null default false;
    `,
  },
  {
    // Com a confirmacao por reacao, uma pessoa pode entrar na lista sem nunca
    // ter aberto conversa com o bot. O bot NAO pode escrever para ela: puxar
    // conversa com quem nao falou primeiro e o padrao classico de banimento.
    //
    // Esta coluna e a permissao social: so quem ja escreveu no privado pode
    // receber mensagem privada.
    name: '004_falou_no_privado',
    sql: `
      alter table jogador
        add column falou_no_privado boolean not null default false;

      -- Quem ja tem nome confirmado so pode ter chegado la pelo dialogo
      -- privado, entao a permissao ja existe de fato.
      update jogador set falou_no_privado = true where nome_confirmado;
    `,
  },
  {
    // A partir da confirmacao por reacao, o bot passa a INICIAR conversa no
    // privado - inclusive toda semana, para perguntar sobre convidados.
    //
    // Quem recebe mensagem que nao quer e nao consegue desligar e exatamente
    // quem bloqueia ou denuncia, e e bloqueio/denuncia que derruba o numero.
    // Esta coluna e a valvula de escape.
    name: '005_nao_perturbe',
    sql: `
      alter table jogador
        add column nao_perturbe boolean not null default false;
    `,
  },
  {
    // Para decifrar um voto e preciso do id da mensagem da enquete e do
    // messageSecret que a Evolution devolve na criacao. Sem guardar os dois, o
    // voto chega e nao ha como abrir - e o segredo so aparece UMA vez, na
    // resposta do envio.
    name: '006_enquete_da_partida',
    sql: `
      alter table partida add column enquete_id      text;
      alter table partida add column enquete_segredo text;
      alter table partida add column enquete_criador text;

      create index if not exists partida_por_enquete on partida (enquete_id);
    `,
  },
  {
    // Guarda a ULTIMA opcao votada por pessoa em cada partida.
    //
    // Sem isso o bot so enxerga o efeito do voto na lista, e perde mudanca que
    // nao muda o estado: quem troca "Vou" por "Vou com convidado" continua
    // sendo linha, o dominio responde "ja estava" e o grupo nao fica sabendo
    // de nada - embora o voto tenha mudado de verdade.
    //
    // Serve tambem de idempotencia: o WhatsApp reentrega voto, e reentrega nao
    // pode virar anuncio repetido.
    name: '007_voto_registrado',
    sql: `
      create table voto (
        partida_id    int  not null references partida(id) on delete cascade,
        jogador_id    int  not null references jogador(id) on delete cascade,
        opcao         text not null,
        atualizado_em timestamptz not null default now(),
        primary key (partida_id, jogador_id)
      );
    `,
  },
  {
    // O anuncio de encerramento (sabado 12:00, depois do jogo) precisa ser
    // idempotente: o cron pode disparar duas vezes num restart, e o grupo nao
    // pode receber "acabou" duas vezes.
    name: '008_encerramento',
    sql: `
      alter table partida add column encerrada_em timestamptz;
    `,
  },
  {
    // Goleiro saiu do dominio: os 2 sao contratados por fora, nao ocupam vaga
    // e nao aparecem na lista. A coluna fica como vestigio historico das
    // partidas antigas, mas nao significa mais nada - por isso o default zero.
    name: '009_sem_vaga_de_goleiro',
    sql: `
      alter table partida alter column vagas_goleiro set default 0;
      update partida set vagas_goleiro = 0 where fecha_em > now();
    `,
  },
  {
    // Marca quando a lista bateu o total de vagas pela 1a vez nesta partida.
    // Substituida em 13/08/2026 por uma regra mais simples (avisar saida so
    // sexta/sabado, ver `diaDeAvisarSaida` em domain/partida.ts) - a coluna
    // fica como vestigio historico, sem leitor no codigo.
    name: '010_lista_lotou_marcador',
    sql: `
      alter table partida add column lista_lotou_em timestamptz;
    `,
  },
  {
    // Goleiro volta ao dominio (13/08/2026), agora como lista PROPRIA e
    // SEPARADA da lista de linha - nunca ocupa vaga dos 18, more em
    // handlers.ts/inscricao.ts. `goleiro_contratado` distingue quem foi
    // contratado por fora de quem veio como convidado de um fixo; so faz
    // sentido em posicao='gol', dai a constraint.
    name: '011_goleiro_lista_propria',
    sql: `
      alter table partida alter column vagas_goleiro set default 2;
      update partida set vagas_goleiro = 2 where fecha_em > now();

      alter table inscricao
        add column goleiro_contratado boolean not null default false;
      alter table inscricao
        add constraint inscricao_contratado_so_gol
        check (goleiro_contratado = false or posicao = 'gol');
    `,
  },
  {
    // Avaliacao pos-jogo ("Departamento de Qualidade", 14-15/08/2026): uma
    // segunda enquete por partida, publicada depois que o jogo acaba. Precisa
    // do proprio par id/segredo (enquete_id ja e da enquete de confirmacao) e
    // de um horario proprio para disparar (`encerra_em`, sabado 12:00) -
    // `fecha_em` e 2h ANTES do jogo, nao serve para isso.
    //
    // `avaliacao` guarda uma nota por jogador por partida - so quem tem
    // jogador_id numa inscricao 'fixo' de linha confirmada entra na media
    // (convidado e goleiro nao tem vinculo de identidade rastreavel hoje).
    name: '012_avaliacao_do_racha',
    sql: `
      alter table partida add column encerra_em timestamptz;
      alter table partida add column avaliacao_enquete_id      text;
      alter table partida add column avaliacao_enquete_segredo text;
      alter table partida add column avaliacao_enquete_criador text;

      create index if not exists partida_por_enquete_avaliacao
        on partida (avaliacao_enquete_id);

      create table avaliacao (
        id         serial primary key,
        partida_id int  not null references partida(id) on delete cascade,
        jogador_id int  not null references jogador(id) on delete cascade,
        nota       int  not null check (nota between 0 and 5),
        criado_em  timestamptz not null default now(),
        unique (partida_id, jogador_id)
      );
    `,
  },
  {
    // Pivot (15/08/2026): a avaliacao deixou de ser UMA enquete publica no
    // grupo (por partida) e passou a ser uma enquete INDIVIDUAL no privado,
    // uma por jogador que efetivamente jogou. Cada convite tem seu proprio
    // par id/segredo, entao nao da mais para guardar isso em `partida` (uma
    // coluna so serviria para uma pessoa). As 3 colunas avaliacao_enquete_*
    // de `partida` (migration 012) ficam sem leitor a partir daqui - vestigio
    // historico, mesmo caso de `lista_lotou_em` (migration 010).
    //
    // A linha em `avaliacao` agora nasce no ENVIO do convite (nota nula) e e
    // completada quando o voto chega - por isso `nota` vira opcional.
    name: '013_avaliacao_convite_individual',
    sql: `
      alter table avaliacao add column enquete_id      text;
      alter table avaliacao add column enquete_segredo text;
      alter table avaliacao add column enquete_criador text;

      alter table avaliacao alter column nota drop not null;
      alter table avaliacao drop constraint avaliacao_nota_check;
      alter table avaliacao add constraint avaliacao_nota_check
        check (nota is null or nota between 0 and 5);

      create index if not exists avaliacao_por_enquete on avaliacao (enquete_id);
    `,
  },
  {
    // Enquete duplicada em 19/08/2026: o cron de quarta 12:00 e a faxina
    // horaria de recuperacao dispararam no mesmo minuto, as duas leram
    // enquete_id nulo (o UPDATE que o grava so acontece segundos depois, apos
    // o round-trip com a Evolution API) e as duas anunciaram a abertura.
    //
    // Esta coluna vira reserva atomica (ver reservarAbertura em partida.ts):
    // so quem consegue marca-la primeiro segue em frente.
    name: '014_reserva_abertura',
    sql: `
      alter table partida add column abrindo_em timestamptz;
    `,
  },
];
