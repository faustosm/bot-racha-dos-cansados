// GERADO - nao edite neste repo.
//
// Fonte: faustosm/bot-racha-dos-cansados, em site/. Chega aqui por
// `make publicar-site`; editar direto aqui e sobrescrito na proxima.
//
// Pagina estatica (fora do bundle React, ver CLAUDE.md desta pasta se
// existir): fica de fora de propósito, pra nao depender do app shell nem do
// build do Vite. So le /estatisticas.json - o arquivo que o bot publica via
// commit direto no repo (ver bot-racha-dos-cansados/src/estatisticas.ts).
//
// CSP do site e script-src 'self': por isso este arquivo e externo, nunca
// inline.
//
// Regra de rotulo usada aqui: grafico COM eixo (composicao, nota media) recebe
// rotulo seletivo - so o ultimo/extremo, o resto se le na grade e no tooltip.
// Grafico compacto SEM eixo (padrinhos, distribuicao) leva o valor na ponta de
// cada marca, porque ali o rotulo E a escala.
(function () {
  'use strict';

  var JANELA_PRESENCA_MAX = 10; // acima disso, so os ultimos N jogos
  var TRACK_PX = 190;
  var SVG_W = 400, SVG_H = 168;
  var M = { top: 18, right: 12, bottom: 22, left: 30 };

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    for (var key in attrs || {}) {
      if (key === 'class') node.className = attrs[key];
      else if (key === 'text') node.textContent = attrs[key];
      else node.setAttribute(key, attrs[key]);
    }
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  function svgEl(tag, attrs) {
    var node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (var key in attrs || {}) {
      if (key === 'text') node.textContent = attrs[key];
      else node.setAttribute(key, attrs[key]);
    }
    return node;
  }

  function fmtData(iso) {
    var p = iso.split('-');
    return p[2] + '/' + p[1];
  }
  function fmtNota(n) { return n == null ? '—' : n.toFixed(2).replace('.', ','); }
  function fmtNota1(n) { return n.toFixed(1).replace('.', ','); }
  function fmtPct(f) { return f == null ? '—' : Math.round(f * 100) + '%'; }
  function plural(n, um, muitos) { return n === 1 ? um : muitos; }

  /** Passo "redondo" pra grade: 1, 2, 5, 10, 20, 50... */
  function passoNice(bruto) {
    var pot = Math.pow(10, Math.floor(Math.log(bruto) / Math.LN10));
    var norm = bruto / pot;
    var passo = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    return passo * pot;
  }
  function escala(maxValor, alvoLinhas) {
    if (maxValor <= 0) return { topo: 1, passo: 1 };
    var passo = passoNice(maxValor / (alvoLinhas || 4));
    return { topo: Math.ceil(maxValor / passo) * passo, passo: passo };
  }

  // ── Tooltip (delegado - as marcas nascem depois do load) ────────────────

  var tip = document.getElementById('tip');
  function mostrarTip(mark, x, y) {
    var texto = mark.getAttribute('data-tip');
    if (!texto) return;
    tip.textContent = '';
    var partes = texto.split(' — ');
    if (partes.length === 2) {
      tip.appendChild(document.createTextNode(partes[0] + ' — '));
      var forte = document.createElement('b');
      forte.textContent = partes[1];
      tip.appendChild(forte);
    } else {
      tip.appendChild(document.createTextNode(texto));
    }
    tip.style.left = x + 'px';
    tip.style.top = (y - 10) + 'px';
    tip.classList.add('show');
  }
  function esconderTip() { tip.classList.remove('show'); }
  function acharMark(e) {
    var alvo = e.target;
    if (!alvo || !alvo.closest) return null;
    return alvo.closest('.mark');
  }

  document.addEventListener('pointerover', function (e) {
    var mark = acharMark(e);
    if (mark) mostrarTip(mark, e.clientX, mark.getBoundingClientRect().top);
  });
  document.addEventListener('pointermove', function (e) {
    var mark = acharMark(e);
    if (mark) mostrarTip(mark, e.clientX, mark.getBoundingClientRect().top);
  });
  document.addEventListener('pointerout', function (e) {
    if (acharMark(e)) esconderTip();
  });
  document.addEventListener('focusin', function (e) {
    var mark = acharMark(e);
    if (mark) {
      var r = mark.getBoundingClientRect();
      mostrarTip(mark, r.left + r.width / 2, r.top);
    }
  });
  document.addEventListener('focusout', function (e) {
    if (acharMark(e)) esconderTip();
  });

  // ── KPIs ─────────────────────────────────────────────────────────────

  function montarKpis(dados) {
    var r = dados.resumo;
    var periodo = dados.porRacha.length > 0
      ? fmtData(dados.porRacha[0].data) + ' – ' + fmtData(dados.porRacha[dados.porRacha.length - 1].data)
      : '';
    var itens = [
      [String(r.rachasRealizados), 'Rachas realizados', periodo],
      [fmtPct(r.taxaLotacaoLinha), 'Linha lotada',
        r.taxaLotacaoLinha != null
          ? Math.round(r.taxaLotacaoLinha * r.rachasRealizados) + '/' + r.rachasRealizados + ' semanas'
          : ''],
      [String(r.jogadoresCadastrados), 'Jogadores cadastrados', r.jogadoresQueJaJogaram + ' já entraram em campo'],
      [fmtNota(r.notaMediaGeral), 'Nota média geral',
        r.totalAvaliacoes > 0 ? 'de ' + r.totalAvaliacoes + ' avaliações' : 'sem avaliações ainda'],
    ];
    var grid = el('section', { class: 'kpis' });
    itens.forEach(function (it) {
      grid.appendChild(el('div', { class: 'kpi' }, [
        el('div', { class: 'kpi-value', text: it[0] }),
        el('div', { class: 'kpi-label', text: it[1] }),
        el('div', { class: 'kpi-note', text: it[2] }),
      ]));
    });
    return grid;
  }

  // ── Confirmados por racha (colunas empilhadas, com eixo) ──────────────

  function montarComposicao(porRacha) {
    if (porRacha.length === 0) return null;

    var maxStack = Math.max.apply(null, porRacha.map(function (r) {
      return r.fixos + r.convidados + r.goleiros;
    }));
    var esc = escala(maxStack, 4);
    var unidade = TRACK_PX / esc.topo;

    var chart = el('div', { class: 'comp-chart' });
    porRacha.forEach(function (r, i) {
      var total = r.fixos + r.convidados + r.goleiros;
      var track = el('div', { class: 'bar-track' });
      track.style.height = TRACK_PX + 'px';
      // De cima pra baixo no DOM = de cima pra baixo na pilha: goleiro no topo,
      // fixo na base (o fixo e a fundacao do time, fica ancorado no eixo).
      var segmentos = [
        ['Goleiros', r.goleiros, 'var(--s-goleiro)'],
        ['Convidados', r.convidados, 'var(--s-convidado)'],
        ['Fixos', r.fixos, 'var(--s-fixo)'],
      ];
      segmentos.forEach(function (s) {
        if (s[1] <= 0) return;
        var seg = el('div', {
          class: 'segment mark', tabindex: '0',
          'data-tip': fmtData(r.data) + ' · ' + s[0] + ' — ' + s[1],
        });
        seg.style.height = Math.max(3, s[1] * unidade) + 'px';
        seg.style.background = s[2];
        track.appendChild(seg);
      });
      // Rotulo seletivo: so a semana mais recente leva o total na cabeca.
      var ultimo = i === porRacha.length - 1;
      chart.appendChild(el('div', { class: 'comp-col' }, [
        el('div', { class: 'comp-cap', text: ultimo ? String(total) : '' }),
        track,
        el('div', { class: 'comp-date', text: fmtData(r.data) }),
      ]));
    });

    var plot = el('div', { class: 'plot' });
    // Grade atras das colunas: 0 ate o topo da escala.
    for (var v = 0; v <= esc.topo; v += esc.passo) {
      var y = 19 + (TRACK_PX - v * unidade); // 19 = altura da faixa do rotulo
      var linha = el('div', { class: 'gridline' + (v === 0 ? ' base' : '') });
      linha.style.top = y + 'px';
      plot.appendChild(linha);
      var tick = el('div', { class: 'gridtick', text: String(v) });
      tick.style.top = y + 'px';
      plot.appendChild(tick);
    }
    plot.appendChild(el('div', { class: 'scroll-x' }, [chart]));

    var tabela = el('table', {}, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: 'Data' }),
        el('th', { class: 'num', text: 'Fixos' }),
        el('th', { class: 'num', text: 'Convidados' }),
        el('th', { class: 'num', text: 'Goleiros' }),
        el('th', { class: 'num', text: 'Total' }),
      ])]),
      el('tbody', {}, porRacha.map(function (r) {
        return el('tr', {}, [
          el('td', { text: fmtData(r.data) }),
          el('td', { class: 'num', text: String(r.fixos) }),
          el('td', { class: 'num', text: String(r.convidados) }),
          el('td', { class: 'num', text: String(r.goleiros) }),
          el('td', { class: 'num', text: String(r.fixos + r.convidados + r.goleiros) }),
        ]);
      })),
    ]);

    return el('section', { class: 'card' }, [
      el('div', { class: 'card-head' }, [
        el('h2', { text: 'Confirmados por racha' }),
        el('p', { class: 'sub', text: 'Quem entrou em campo a cada semana — goleiro conta fora das vagas de linha' }),
      ]),
      el('div', { class: 'legend' }, [
        el('span', {}, [el('i', { class: 'swatch', style: 'background:var(--s-fixo)' }), document.createTextNode('Fixo')]),
        el('span', {}, [el('i', { class: 'swatch', style: 'background:var(--s-convidado)' }), document.createTextNode('Convidado')]),
        el('span', {}, [el('i', { class: 'swatch', style: 'background:var(--s-goleiro)' }), document.createTextNode('Goleiro')]),
      ]),
      plot,
      el('details', {}, [
        el('summary', { text: 'Ver tabela' }),
        el('div', { class: 'tbl-wrap' }, [tabela]),
      ]),
    ]);
  }

  // ── Avaliação: linha (tendência) + distribuição ───────────────────────

  function montarLinhaNotas(porRacha) {
    var pontos = porRacha.filter(function (r) { return r.notaMedia != null; });
    if (pontos.length === 0) return null;

    var valores = pontos.map(function (r) { return r.notaMedia; });
    var min = Math.min.apply(null, valores);
    var max = Math.max.apply(null, valores);
    // Escala ampliada (não ancorada no zero): e uma linha, nao uma barra - o que
    // importa aqui e a variacao semana a semana, e 0-5 achataria tudo no topo.
    var lo = Math.max(0, Math.floor((min - 0.2) * 2) / 2);
    var hi = Math.min(5, Math.ceil((max + 0.2) * 2) / 2);
    if (hi - lo < 0.5) { hi = Math.min(5, lo + 0.5); }

    var plotW = SVG_W - M.left - M.right;
    var plotH = SVG_H - M.top - M.bottom;
    var x = function (i) {
      return pontos.length === 1 ? M.left + plotW / 2 : M.left + (i * plotW) / (pontos.length - 1);
    };
    var y = function (v) { return M.top + ((hi - v) / (hi - lo)) * plotH; };

    var svg = svgEl('svg', {
      class: 'linechart', viewBox: '0 0 ' + SVG_W + ' ' + SVG_H,
      role: 'img', 'aria-label': 'Nota média por racha',
    });

    // Grade + ticks do eixo Y
    var linhas = [lo, (lo + hi) / 2, hi];
    linhas.forEach(function (v) {
      svg.appendChild(svgEl('line', {
        x1: M.left, x2: SVG_W - M.right, y1: y(v), y2: y(v),
        stroke: v === lo ? 'var(--axis)' : 'var(--grid)', 'stroke-width': 1, fill: 'none',
      }));
      svg.appendChild(svgEl('text', {
        x: M.left - 7, y: y(v), 'text-anchor': 'end', 'dominant-baseline': 'middle',
        'font-size': 10.5, fill: 'var(--ink-faint)', text: fmtNota1(v),
      }));
    });

    var d = pontos.map(function (r, i) { return (i === 0 ? 'M' : 'L') + x(i) + ',' + y(r.notaMedia); }).join(' ');

    if (pontos.length > 1) {
      svg.appendChild(svgEl('path', {
        d: d + ' L' + x(pontos.length - 1) + ',' + y(lo) + ' L' + x(0) + ',' + y(lo) + ' Z',
        fill: 'var(--s-goleiro)', 'fill-opacity': 0.1, stroke: 'none',
      }));
      svg.appendChild(svgEl('path', {
        d: d, fill: 'none', stroke: 'var(--s-goleiro)', 'stroke-width': 2,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      }));
    }

    pontos.forEach(function (r, i) {
      var ultimo = i === pontos.length - 1;
      // Marcador: ultimo ponto cheio com anel na cor da superficie; os demais menores.
      svg.appendChild(svgEl('circle', {
        cx: x(i), cy: y(r.notaMedia), r: ultimo ? 4.5 : 3.5,
        fill: 'var(--s-goleiro)', stroke: 'var(--surface)', 'stroke-width': 2,
      }));
      // Alvo de hover generoso (invisivel), bem maior que o marcador.
      svg.appendChild(svgEl('circle', {
        class: 'mark', tabindex: '0', cx: x(i), cy: y(r.notaMedia), r: 13,
        fill: 'transparent', stroke: 'none',
        'data-tip': fmtData(r.data) + ' · nota ' + fmtNota(r.notaMedia) + ' — ' +
          r.totalNotas + ' ' + plural(r.totalNotas, 'voto', 'votos'),
      }));
      // Rotulo direto so no ultimo ponto (o resto fica na grade e no tooltip).
      if (ultimo) {
        var acimaDoPonto = y(r.notaMedia) - 11 > M.top;
        svg.appendChild(svgEl('text', {
          x: x(i), y: acimaDoPonto ? y(r.notaMedia) - 11 : y(r.notaMedia) + 17,
          'text-anchor': 'end', 'font-size': 12, 'font-weight': 700,
          fill: 'var(--ink)', text: fmtNota(r.notaMedia),
        }));
      }
      // Datas: com poucos pontos rotula todos; com muitos, so as pontas.
      var mostrarData = pontos.length <= 5 || i === 0 || ultimo;
      if (mostrarData) {
        svg.appendChild(svgEl('text', {
          x: x(i), y: SVG_H - 6,
          'text-anchor': i === 0 ? 'start' : ultimo ? 'end' : 'middle',
          'font-size': 10.5, fill: 'var(--ink-muted)', text: fmtData(r.data),
        }));
      }
    });

    return svg;
  }

  function montarDistribuicao(distribuicaoNotas) {
    if (distribuicaoNotas.length === 0) return null;

    var porNota = {};
    distribuicaoNotas.forEach(function (d) { porNota[d.nota] = d.quantidade; });
    var maxQtd = Math.max.apply(null, distribuicaoNotas.map(function (d) { return d.quantidade; }));

    var row = el('div', { class: 'dist' });
    for (var nota = 0; nota <= 5; nota += 1) {
      var qtd = porNota[nota] || 0;
      var barra = el('div', {
        class: 'dist-bar mark', tabindex: '0',
        'data-tip': 'Nota ' + nota + ' — ' + qtd + ' ' + plural(qtd, 'voto', 'votos'),
      });
      barra.style.height = Math.max(3, (qtd / maxQtd) * 72) + 'px';
      if (qtd === 0) barra.style.background = 'var(--dot-off)';
      row.appendChild(el('div', { class: 'dist-col' }, [
        el('div', { class: 'dist-cap', text: String(qtd) }),
        barra,
        el('div', { class: 'dist-label', text: String(nota) }),
      ]));
    }
    return row;
  }

  function montarAvaliacao(dados) {
    var linha = montarLinhaNotas(dados.porRacha);
    var dist = montarDistribuicao(dados.distribuicaoNotas);
    if (!linha && !dist) return null;

    var total = dados.distribuicaoNotas.reduce(function (s, d) { return s + d.quantidade; }, 0);
    var card = el('section', { class: 'card' }, [
      el('div', { class: 'card-head' }, [
        el('h2', { text: 'Avaliação pós-jogo' }),
        el('p', { class: 'sub', text: 'Nota do "Departamento de Qualidade", de 0 a 5, votada na enquete do grupo' }),
      ]),
    ]);
    if (linha) card.appendChild(linha);
    if (dist) {
      card.appendChild(el('p', { class: 'bloco-titulo', text: 'Distribuição das ' + total + ' notas' }));
      card.appendChild(el('p', { class: 'bloco-sub', text: 'Quantos votos cada nota recebeu no total' }));
      card.appendChild(dist);
    }
    return card;
  }

  // ── Padrinhos: barras horizontais (nome longo cabe inteiro) ───────────

  function montarPadrinhos(padrinhos) {
    if (padrinhos.length === 0) return null;

    var max = Math.max.apply(null, padrinhos.map(function (p) { return p.convidados; }));
    var lista = el('div', { class: 'pad-list' });
    padrinhos.forEach(function (p) {
      var barra = el('div', {
        class: 'pad-bar mark', tabindex: '0',
        'data-tip': p.nome + ' — ' + p.convidados + ' ' + plural(p.convidados, 'convidado', 'convidados'),
      });
      barra.style.width = Math.max(3, (p.convidados / max) * 100) + '%';
      lista.appendChild(el('div', { class: 'pad-row' }, [
        el('span', { class: 'pad-name', text: p.nome, title: p.nome }),
        el('span', { class: 'pad-lane' }, [barra]),
        el('span', { class: 'pad-val', text: String(p.convidados) }),
      ]));
    });

    return el('section', { class: 'card' }, [
      el('div', { class: 'card-head' }, [
        el('h2', { text: 'Padrinhos' }),
        el('p', { class: 'sub', text: 'Quem mais trouxe convidado pro racha' }),
      ]),
      lista,
    ]);
  }

  // ── Presença dos fixos (form guide) ───────────────────────────────────

  function montarPresenca(presenca, totalRachas, todasAsDatas) {
    if (presenca.length === 0) return null;

    var janela = todasAsDatas.slice(-JANELA_PRESENCA_MAX);
    var recorte = janela.length < totalRachas;

    var cols = el('div', { class: 'form-cols' });
    presenca.forEach(function (p) {
      var semanasSet = {};
      p.semanas.forEach(function (s) { semanasSet[s] = true; });
      var dots = el('span', { class: 'form-dots' });
      janela.forEach(function (data) {
        var presente = !!semanasSet[data];
        dots.appendChild(el('i', {
          class: 'form-dot mark' + (presente ? ' on' : ''), tabindex: '0',
          'data-tip': fmtData(data) + ' — ' + (presente ? 'presente' : 'faltou'),
        }));
      });
      cols.appendChild(el('div', { class: 'form-row' }, [
        el('span', { class: 'form-name', text: p.nome, title: p.nome }),
        dots,
        el('span', { class: 'form-count', text: p.presencas + '/' + totalRachas }),
      ]));
    });

    return el('section', { class: 'card' }, [
      el('div', { class: 'card-head' }, [
        el('h2', { text: 'Presença dos fixos' }),
        el('p', {
          class: 'sub',
          text: recorte
            ? 'Cada bola é um dos últimos ' + janela.length + ' rachas · o número é o total em ' + totalRachas
            : 'Cada bola é um racha — cheia quando o cara apareceu',
        }),
      ]),
      cols,
    ]);
  }

  // ── Ainda não estrearam ───────────────────────────────────────────────
  //
  // O complemento de "Presença dos fixos": quem esta cadastrado e nunca foi
  // convocado nao aparece la (a tabela so lista quem jogou), entao sumia da
  // pagina inteira. O KPI dizia "29 de 38 ja jogaram" sem dizer quem sao os
  // outros 9.
  //
  // So nome - o JSON e servido publicamente, e telefone nao acrescenta nada
  // a quem quer saber quem falta estrear.

  function montarNuncaJogaram(nuncaJogaram, totalRachas) {
    if (!nuncaJogaram || nuncaJogaram.length === 0) return null;

    var lista = el('div', { class: 'espera' });
    nuncaJogaram.forEach(function (j) {
      lista.appendChild(el('span', {
        class: 'espera-nome' + (j.inscritoAgora ? ' vem' : ''),
        text: j.nome,
        title: j.inscritoAgora
          ? j.nome + ' esta na lista desta semana'
          : j.nome + ' ainda nao jogou nenhum racha',
      }));
    });

    var naLista = nuncaJogaram.filter(function (j) { return j.inscritoAgora; }).length;

    return el('section', { class: 'card' }, [
      el('div', { class: 'card-head' }, [
        el('h2', { text: 'Ainda não estrearam' }),
        el('p', {
          class: 'sub',
          text: nuncaJogaram.length + ' cadastrado' + (nuncaJogaram.length > 1 ? 's' : '') +
            ' que não jogou nenhum dos ' + totalRachas + ' rachas' +
            (naLista ? ' · ' + naLista + ' na lista desta semana' : ''),
        }),
      ]),
      lista,
    ]);
  }

  // ── Convidados por padrinho ───────────────────────────────────────────

  function montarVolumeConvidados(volumeConvidados) {
    if (!volumeConvidados || volumeConvidados.length === 0) return null;

    var tabela = el('table', {}, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: 'Convidado' }),
        el('th', { text: 'Trazido por' }),
        el('th', { class: 'num', text: 'Vezes' }),
        el('th', { text: 'Pra virar fixo' }),
      ])]),
      el('tbody', {}, volumeConvidados.map(function (v) {
        var falta;
        if (v.faltamParaFixo === 0) {
          falta = el('span', { class: 'td-muted', text: 'já bateu as 3' });
        } else if (v.faltamParaFixo === 1) {
          falta = el('span', { class: 'chip', text: 'falta 1' });
        } else {
          falta = el('span', { class: 'td-muted', text: 'faltam ' + v.faltamParaFixo });
        }
        return el('tr', {}, [
          el('td', { text: v.nome }),
          el('td', { class: 'td-muted', text: v.anfitriao }),
          el('td', { class: 'num', text: String(v.vezes) }),
          el('td', {}, [falta]),
        ]);
      })),
    ]);

    return el('section', { class: 'card' }, [
      el('div', { class: 'card-head' }, [
        el('h2', { text: 'Convidados por padrinho' }),
        el('p', {
          class: 'sub',
          text: 'Convidado não tem cadastro — só o nome digitado na hora. Por isso a conta é por par (convidado + quem trouxe): dois "Vinicius" de padrinhos diferentes são, quase sempre, duas pessoas.',
        }),
      ]),
      el('div', { class: 'tbl-wrap' }, [tabela]),
    ]);
  }

  // ── Montagem ─────────────────────────────────────────────────────────

  function montar(dados) {
    var frag = document.createDocumentFragment();

    frag.appendChild(montarKpis(dados));

    var composicao = montarComposicao(dados.porRacha);
    if (composicao) frag.appendChild(composicao);

    var avaliacao = montarAvaliacao(dados);
    var padrinhos = montarPadrinhos(dados.padrinhos);
    if (avaliacao || padrinhos) {
      var grid = el('div', { class: 'grid-2' });
      if (avaliacao) grid.appendChild(avaliacao);
      if (padrinhos) grid.appendChild(padrinhos);
      frag.appendChild(grid);
    }

    var todasAsDatas = dados.porRacha.map(function (r) { return r.data; });
    var presenca = montarPresenca(dados.presenca, dados.totalRachas, todasAsDatas);
    if (presenca) frag.appendChild(presenca);

    // Logo depois da presenca: e a mesma pergunta ("quem vem?") vista pelo
    // lado de quem ainda nao apareceu.
    var estreia = montarNuncaJogaram(dados.nuncaJogaram, dados.totalRachas);
    if (estreia) frag.appendChild(estreia);

    var volume = montarVolumeConvidados(dados.volumeConvidados);
    if (volume) frag.appendChild(volume);

    return frag;
  }

  function mostrarEstado(id) {
    ['carregando', 'erro', 'conteudo'].forEach(function (nome) {
      document.getElementById(nome).hidden = nome !== id;
    });
  }

  function renderizar(dados) {
    var subtitulo = document.getElementById('subtitulo');
    var rodapeData = document.getElementById('rodape-data');

    if (dados.totalRachas === 0) {
      subtitulo.textContent = 'Ainda não temos racha fechado pra mostrar número nenhum.';
      mostrarEstado('conteudo');
      document.getElementById('conteudo').appendChild(
        el('div', { class: 'card', text: 'Assim que o primeiro racha fechar, o boletim aparece aqui.' }),
      );
      return;
    }

    subtitulo.textContent = 'Números apurados direto do banco do bot do WhatsApp, ' + dados.totalRachas +
      ' ' + plural(dados.totalRachas, 'racha', 'rachas') + ' no histórico.';
    if (dados.geradoEm) {
      var d = new Date(dados.geradoEm);
      rodapeData.textContent = 'atualizado em ' + d.toLocaleDateString('pt-BR') + ' às ' +
        d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    }
    document.getElementById('conteudo').appendChild(montar(dados));
    mostrarEstado('conteudo');
  }

  // No site os dados vem de /estatisticas.json. Num preview offline (Artifact,
  // arquivo local) eles podem vir embutidos na propria pagina - e o caminho que
  // permite revisar mudanca de layout sem deploy. Mesmo render nos dois casos.
  var embutido = document.getElementById('dados-embutidos');
  if (embutido) {
    renderizar(JSON.parse(embutido.textContent));
  } else {
    fetch('/estatisticas.json', { cache: 'no-store' })
      .then(function (resp) {
        if (!resp.ok) throw new Error('status ' + resp.status);
        return resp.json();
      })
      .then(renderizar)
      .catch(function () { mostrarEstado('erro'); });
  }
})();
