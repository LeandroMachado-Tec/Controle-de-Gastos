/**
 * js/charts.js — gráficos SVG sem dependências (3.2)
 * =============================================================================
 * • Recebem a largura real do contêiner (opcoes.largura) para nascer legíveis.
 * • Dimensões numéricas + viewBox; nenhum atributo SVG inválido.
 * • <title> e <desc> em cada gráfico; legendas em HTML separado do desenho.
 * • Nenhum dado é inventado: listas vazias devolvem null.
 * =============================================================================
 */

const PADRAO = {
  corPago: '#147a57',
  corPendente: '#c98a2e',
  corPrimaria: '#0f6b54',
  corSecundaria: '#5d8f80',
  corTexto: '#5d6c65',
  corTextoForte: '#13221d',
  corLinha: '#e5e2d9',
  corFundoBarra: '#eef1ec',
  altura: 250
};

let sequencia = 0;

/* -----------------------------------------------------------------------------
 * Utilidades
 * --------------------------------------------------------------------------- */
export function escapar(texto) {
  return String(texto ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatarMoedaCompacta(valor) {
  const numero = Number(valor) || 0;
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    notation: Math.abs(numero) >= 10000 ? 'compact' : 'standard',
    maximumFractionDigits: Math.abs(numero) >= 10000 ? 1 : 2
  }).format(numero);
}

export function formatarMoeda(valor) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  }).format(Number(valor) || 0);
}

function abreviar(texto, maximo = 16) {
  const t = String(texto ?? '').trim();
  return t.length > maximo ? t.slice(0, maximo - 1) + '…' : t;
}

/**
 * Largura aproximada de um texto na fonte do sistema. O objetivo é evitar
 * que nomes com letras largas invadam a área da barra dentro do SVG.
 */
function estimarLarguraTexto(texto, tamanhoFonte) {
  const escala = tamanhoFonte / 11;
  return Array.from(String(texto ?? '')).reduce((largura, caractere) => {
    if (/\s/.test(caractere)) return largura + (3.2 * escala);
    if (/[MW@#%&]/.test(caractere)) return largura + (8 * escala);
    if (/[A-ZÀ-ÖØ-Þ]/.test(caractere)) return largura + (6.6 * escala);
    return largura + (5.5 * escala);
  }, 0);
}

/** Abrevia por largura estimada, preservando o nome completo no tooltip. */
function abreviarPorLargura(texto, larguraMaxima, tamanhoFonte) {
  const original = String(texto ?? '').trim();
  if (!original || estimarLarguraTexto(original, tamanhoFonte) <= larguraMaxima) {
    return original;
  }

  const reticencias = '…';
  const larguraReticencias = estimarLarguraTexto(reticencias, tamanhoFonte);
  let abreviado = '';
  for (const caractere of original) {
    const proximo = abreviado + caractere;
    if (estimarLarguraTexto(proximo + reticencias, tamanhoFonte) > larguraMaxima) break;
    abreviado = proximo;
  }
  return abreviado.trimEnd() + reticencias;
}

function somar(lista, campo) {
  return (lista || []).reduce((total, item) => total + (Number(item && item[campo]) || 0), 0);
}

function limitar(valor, minimo, maximo) {
  return Math.min(Math.max(valor, minimo), maximo);
}

function larguraPedida(opcoes, padrao) {
  const valor = Number(opcoes && opcoes.largura);
  return Number.isFinite(valor) && valor > 0 ? limitar(Math.round(valor), 240, 1400) : padrao;
}

function idUnico() {
  sequencia += 1;
  return 'cg-grafico-' + sequencia;
}

function legendaHtml(itens) {
  return '<div class="legenda-grafico">' + itens.map((item) =>
    '<span class="legenda-item"><span class="legenda-ponto" style="background:' +
    escapar(item.cor) + '"></span>' + escapar(item.texto) + '</span>'
  ).join('') + '</div>';
}

function montarSvg(largura, altura, opcoes, resumo, conteudo) {
  const id = idUnico();
  const titulo = opcoes.ariaLabel || 'Gráfico de valores financeiros';
  const classe = opcoes.classe ? ` class="${escapar(opcoes.classe)}"` : '';
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${largura}" height="${altura}"`,
    ` viewBox="0 0 ${largura} ${altura}" role="img" aria-labelledby="${id}-t ${id}-d"${classe}`,
    ` preserveAspectRatio="xMidYMid meet" font-family="system-ui,-apple-system,'Segoe UI',Roboto,sans-serif">`,
    `<title id="${id}-t">${escapar(titulo)}</title>`,
    `<desc id="${id}-d">${escapar(resumo)}</desc>`,
    conteudo,
    '</svg>'
  ].join('');
}

/* -----------------------------------------------------------------------------
 * 1) BARRAS MENSAIS — pago + pendente empilhados
 * --------------------------------------------------------------------------- */
export function graficoBarrasMensais(dados, opcoes = {}) {
  const cfg = { ...PADRAO, ...opcoes };
  const lista = (dados || []).filter((d) => d && (Number(d.pago) || Number(d.pendente)));
  if (!lista.length) return null;

  const largura = larguraPedida(opcoes, 720);
  const altura = limitar(Number(opcoes.altura) || 250, 210, 300);
  const compacto = largura < 560;
  const margem = {
    topo: 16,
    direita: 10,
    baixo: compacto ? 34 : 30,
    esquerda: compacto ? 48 : 60
  };
  const areaL = largura - margem.esquerda - margem.direita;
  const areaA = altura - margem.topo - margem.baixo;
  const maximo = Math.max(...lista.map((d) => (Number(d.pago) || 0) + (Number(d.pendente) || 0)), 1);

  const linhas = [];
  for (let i = 0; i <= 3; i++) {
    const valor = (maximo / 3) * i;
    const y = margem.topo + areaA - (areaA * i) / 3;
    linhas.push(
      `<line x1="${margem.esquerda}" y1="${y.toFixed(1)}" x2="${largura - margem.direita}" y2="${y.toFixed(1)}"` +
      ` stroke="${cfg.corLinha}" stroke-width="1" stroke-dasharray="${i === 0 ? '0' : '3 4'}"/>`,
      `<text x="${margem.esquerda - 7}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" font-size="${compacto ? 10 : 11}"` +
      ` fill="${cfg.corTexto}">${escapar(formatarMoedaCompacta(valor))}</text>`
    );
  }

  const slot = areaL / lista.length;
  const larguraBarra = Math.max(9, Math.min(34, slot * 0.58));
  const puloRotulo = compacto && lista.length > 6 ? 2 : 1;

  const barras = lista.map((d, i) => {
    const pago = Number(d.pago) || 0;
    const pendente = Number(d.pendente) || 0;
    const hPago = (areaA * pago) / maximo;
    const hPendente = (areaA * pendente) / maximo;
    const x = margem.esquerda + slot * i + (slot - larguraBarra) / 2;
    const yPago = margem.topo + areaA - hPago;
    const yPendente = yPago - hPendente;
    const centroX = x + larguraBarra / 2;
    const rotulo = abreviar(d.rotulo, compacto ? 9 : 12);
    const dica = `${abreviar(d.rotulo, 28)} — pago: ${formatarMoeda(pago)} • pendente: ${formatarMoeda(pendente)}`;

    const barraPaga = pago > 0
      ? `<rect x="${x.toFixed(1)}" y="${yPago.toFixed(1)}" width="${larguraBarra.toFixed(1)}" height="${hPago.toFixed(1)}"` +
        ` rx="${Math.min(4, larguraBarra / 3).toFixed(1)}" fill="${cfg.corPago}"/>`
      : '';
    const barraPendente = pendente > 0
      ? `<rect x="${x.toFixed(1)}" y="${yPendente.toFixed(1)}" width="${larguraBarra.toFixed(1)}" height="${hPendente.toFixed(1)}"` +
        ` rx="${Math.min(4, larguraBarra / 3).toFixed(1)}" fill="${cfg.corPendente}"/>`
      : '';
    const textoRotulo = i % puloRotulo === 0
      ? `<text x="${centroX.toFixed(1)}" y="${altura - 10}" text-anchor="middle" font-size="${compacto ? 10 : 11}"` +
        ` fill="${cfg.corTexto}">${escapar(rotulo)}</text>`
      : '';

    return `<g><title>${escapar(dica)}</title>${barraPaga}${barraPendente}${textoRotulo}</g>`;
  }).join('');

  const resumo = lista.map((d) =>
    `${d.rotulo}: pago ${formatarMoeda(d.pago)}, pendente ${formatarMoeda(d.pendente)}`
  ).join('; ');

  return legendaHtml([
    { cor: cfg.corPago, texto: 'Pago' },
    { cor: cfg.corPendente, texto: 'Pendente' }
  ]) + montarSvg(largura, altura, {
    ...opcoes,
    ariaLabel: opcoes.ariaLabel || 'Gastos pagos e pendentes por mês'
  }, resumo, [
    ...linhas,
    `<line x1="${margem.esquerda}" y1="${margem.topo + areaA}" x2="${largura - margem.direita}" y2="${margem.topo + areaA}" stroke="${cfg.corLinha}" stroke-width="1"/>`,
    barras
  ].join(''));
}

/* -----------------------------------------------------------------------------
 * 2) BARRAS HORIZONTAIS — ranking de categoria/empresa
 * --------------------------------------------------------------------------- */
export function graficoBarrasHorizontais(dados, opcoes = {}) {
  const cfg = { ...PADRAO, ...opcoes };
  const positivos = (dados || []).filter((d) => d && Number(d.valor) > 0);
  const limite = Math.max(1, Number(opcoes.maximoItens) || 8);
  const lista = positivos
    .sort((a, b) => (Number(b.valor) || 0) - (Number(a.valor) || 0))
    .slice(0, limite);
  if (!lista.length) return null;

  const largura = larguraPedida(opcoes, 620);
  const compacto = largura < 430;
  const alturaLinha = compacto ? 38 : 36;
  const altura = 12 + lista.length * alturaLinha;
  /* Colunas laterais simétricas: o trilho fica geometricamente centralizado
     entre o rótulo e o valor, tanto no celular quanto no desktop. */
  const valorLargura = compacto ? 72 : 88;
  const rotuloLargura = valorLargura + 12;
  const areaL = Math.max(40, largura - rotuloLargura - valorLargura - 12);
  const maximo = Math.max(...lista.map((d) => Number(d.valor) || 0), 1);
  const fonteRotulo = 11;
  const areaRotuloUtil = rotuloLargura - 12;

  const linhas = lista.map((d, i) => {
    const y = 6 + i * alturaLinha;
    const valor = Number(d.valor) || 0;
    const larguraBarra = Math.max(3, (areaL * valor) / maximo);
    const rotulo = escapar(abreviarPorLargura(d.rotulo, areaRotuloUtil, fonteRotulo));
    const itens = Number(d.itens) || 0;
    const dica = `${d.rotulo}: ${formatarMoeda(valor)}` + (itens ? ` em ${itens} lançamento(s)` : '');
    return [
      `<g><title>${escapar(dica)}</title>`,
      `<text x="${rotuloLargura - 8}" y="${(y + 9).toFixed(1)}" text-anchor="end" dominant-baseline="middle"` +
      ` font-size="${fonteRotulo}" font-weight="600" fill="${cfg.corTexto}">${rotulo}</text>`,
      `<rect x="${rotuloLargura}" y="${(y + 2).toFixed(1)}" width="${areaL}" height="14" rx="7" fill="${cfg.corFundoBarra}"/>`,
      `<rect x="${rotuloLargura}" y="${(y + 2).toFixed(1)}" width="${larguraBarra.toFixed(1)}" height="14" rx="7" fill="${opcoes.corBarra || cfg.corPrimaria}"/>`,
      `<text x="${largura - 2}" y="${(y + 9).toFixed(1)}" text-anchor="end" dominant-baseline="middle"` +
      ` font-size="${fonteRotulo}" font-weight="700" fill="${cfg.corTextoForte}">${escapar(formatarMoedaCompacta(valor))}</text>`,
      '</g>'
    ].join('');
  }).join('');

  const resumo = lista.map((d) => `${d.rotulo}: ${formatarMoeda(d.valor)}`).join('; ');
  const opcoesRotulo = positivos.length > lista.length
    ? {
        ...opcoes,
        ariaLabel: `${opcoes.ariaLabel || 'Gráfico de ranking'}. Exibindo os ${lista.length} maiores de ${positivos.length} itens.`
      }
    : opcoes;
  return montarSvg(largura, altura, opcoesRotulo, resumo, linhas);
}

/* -----------------------------------------------------------------------------
 * 3) DONUT — pago x pendente (anel e legenda em caixas separadas)
 * --------------------------------------------------------------------------- */
export function graficoDonut(dados, opcoes = {}) {
  const cfg = { ...PADRAO, ...opcoes };
  const segmentos = (dados || []).filter((d) => d && Number(d.valor) > 0);
  if (!segmentos.length) return null;

  const base = larguraPedida(opcoes, 420);
  const tamanho = limitar(Math.round((base || 420) * 0.48), 150, 220);
  const centro = tamanho / 2;
  const raio = tamanho * 0.32;
  const espessura = tamanho * 0.105;
  const circunferencia = 2 * Math.PI * raio;
  const total = somar(segmentos, 'valor');
  const compacto = tamanho < 175;

  let acumulado = 0;
  const arcos = segmentos.map((d, i) => {
    const valor = Number(d.valor) || 0;
    const fracao = total > 0 ? valor / total : 0;
    const comprimento = circunferencia * fracao;
    const cor = d.cor || (i === 0 ? cfg.corPago : cfg.corPendente);
    const dica = `${d.rotulo}: ${formatarMoeda(valor)} (${Math.round(fracao * 100)}%)`;
    const arco =
      `<circle cx="${centro}" cy="${centro}" r="${raio.toFixed(1)}" fill="none" stroke="${cor}"` +
      ` stroke-width="${espessura.toFixed(1)}" stroke-linecap="butt"` +
      ` stroke-dasharray="${Math.max(0, comprimento - 2).toFixed(2)} ${(circunferencia - Math.max(0, comprimento - 2)).toFixed(2)}"` +
      ` stroke-dashoffset="${(-acumulado).toFixed(2)}" transform="rotate(-90 ${centro} ${centro})">` +
      `<title>${escapar(dica)}</title></circle>`;
    acumulado += comprimento;
    return arco;
  }).join('');

  const svg = montarSvg(tamanho, tamanho, {
    ...opcoes,
    ariaLabel: opcoes.ariaLabel || 'Valores pagos e pendentes no período'
  }, segmentos.map((d) => `${d.rotulo}: ${formatarMoeda(d.valor)}`).join('; '), [
    `<circle cx="${centro}" cy="${centro}" r="${raio.toFixed(1)}" fill="none" stroke="${cfg.corFundoBarra}" stroke-width="${espessura.toFixed(1)}"/>`,
    arcos,
    `<text x="${centro}" y="${centro + (compacto ? 2 : 3)}" text-anchor="middle" font-size="${compacto ? 14 : 17}"` +
    ` font-weight="800" letter-spacing="-0.4" fill="${cfg.corTextoForte}">${escapar(formatarMoedaCompacta(total))}</text>`,
    `<text x="${centro}" y="${centro + (compacto ? 15 : 18)}" text-anchor="middle" font-size="${compacto ? 10 : 11}"` +
    ` fill="${cfg.corTexto}">total do período</text>`
  ]);

  const legenda = segmentos.map((d, i) => {
    const valor = Number(d.valor) || 0;
    const fracao = total > 0 ? Math.round((valor / total) * 100) : 0;
    const cor = d.cor || (i === 0 ? cfg.corPago : cfg.corPendente);
    return '<li>' +
      `<span class="ponto" style="--cor:${escapar(cor)}"></span>` +
      `<span class="rotulo">${escapar(d.rotulo)} <span class="percentual">${fracao}%</span></span>` +
      `<span class="valor">${escapar(formatarMoedaCompacta(valor))}</span>` +
      '</li>';
  }).join('');

  return '<div class="donut-layout">' +
    `<div class="donut-anel">${svg}</div>` +
    `<ul class="donut-legenda" aria-label="Legenda do gráfico">${legenda}</ul>` +
    '</div>';
}

export default {
  escapar,
  formatarMoeda,
  formatarMoedaCompacta,
  graficoBarrasMensais,
  graficoBarrasHorizontais,
  graficoDonut
};
