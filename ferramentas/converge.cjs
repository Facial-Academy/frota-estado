// converge.cjs — cliente de convergência da frota do Grupo Facial: busca o ESTADO DESEJADO (um manifesto assinado) e faz esta máquina convergir
// para ele. Roda como a pessoa (tarefa agendada da usuária / LaunchAgent), ao ligar e de tempos em tempos. Só a ÚLTIMA versão vale: máquina que
// ficou semanas desligada lê um manifesto só e aplica o resultado final, sem fila de passos intermediários.
//   node converge.cjs --manifesto <https://… | arquivo> [--chave <chave-publica.json>] [--estado <pasta>] [--settings <settings.json>] [--jitter <s>]
// Segurança (o que o cliente exige antes de tocar em qualquer coisa):
//   • assinatura Ed25519 do manifesto por uma chave publicada em chave-publica.json (a hospedagem do arquivo não precisa ser confiável);
//   • `serial` nunca diminui (rollback do manifesto é recusado) e `expira` no futuro (manifesto congelado é recusado);
//   • módulos só dos tipos e chaves que ESTE cliente conhece (lista fixa abaixo): o manifesto não manda executar comando nenhum.
//   • `pacotes` (campo de topo, opcional; ver pacote-mcp.cjs): o ÚNICO jeito de o manifesto entregar código, e só o pacote de MCPs do frota-estado, preso ao sha256 assinado.
//     Fica FORA de `modulos` de propósito: um tipo novo dentro de `modulos` faria todo cliente já instalado recusar o manifesto inteiro (tipo desconhecido) e parar de aplicar até receber o cliente novo.
//   • `versoes` (campo de topo, opcional; ver extensao-vscode.cjs): a versão da extensão `anthropic.claude-code` do VS Code (que embute o Claude Code), com a mesma assinatura da chave dos pacotes, a faixa testada e os hashes; só age com o VS Code fechado.
//     Mesmo motivo para ficar fora de `modulos`: o cliente já instalado ignora o campo.
// Falha de rede, manifesto inválido ou expirado = a máquina fica como está (exit 0, registrado no log). Só erro ao aplicar sai com código ≠ 0.
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto')
const { aplicarChave } = require('./jsonc-config.cjs')
const Trava = require('./trava.cjs')
const Pacote = require('./pacote-mcp.cjs')
const Versao = require('./extensao-vscode.cjs')

const LIMITE_BYTES = 256 * 1024, TIMEOUT_MS = 20000, VALIDADE_MAX_DIAS = 400, LOG_MAX = 256 * 1024, JITTER_MAX_S = 300
const TIPOS = { 'vscode-setting': { chave: /^claudeCode\.[A-Za-z0-9.]{1,80}$/ } }
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/

const ehEscalar = v => v === null || ['boolean', 'number', 'string'].includes(typeof v)
function validar(m, estrito = false) { // devolve a lista de problemas (vazia = válido); a mensagem nunca repete o valor recebido. `estrito` (assinador do operador): confere também cada entrada de `pacotes` e de `versoes`
  const p = [], obj = x => x && typeof x === 'object' && !Array.isArray(x)
  if (!obj(m)) return ['o manifesto não é um objeto']
  if (m.formato !== 1) p.push('formato desconhecido')
  if (!Number.isSafeInteger(m.serial) || m.serial < 1) p.push('serial inválido')
  for (const campo of ['emitido', 'expira']) if (typeof m[campo] !== 'string' || Number.isNaN(Date.parse(m[campo]))) p.push(`${campo} inválido`)
  if (!p.some(x => x.startsWith('emitido') || x.startsWith('expira'))) { const dias = (Date.parse(m.expira) - Date.parse(m.emitido)) / 86400000; if (!(dias > 0 && dias <= VALIDADE_MAX_DIAS)) p.push(`validade fora de 0..${VALIDADE_MAX_DIAS} dias`) } // emitido absurdo ou validade desproporcional é erro do assinante
  if (!Array.isArray(m.modulos) || m.modulos.length > 50) { p.push('módulos inválidos'); return p }
  const vistos = new Set()
  m.modulos.forEach((mod, i) => {
    const r = `módulo ${i + 1}`
    if (!obj(mod)) return p.push(`${r}: não é um objeto`)
    if (typeof mod.id !== 'string' || !ID.test(mod.id)) p.push(`${r}: id inválido`)
    else if (vistos.has(mod.id)) p.push(`${r}: id repetido`); else vistos.add(mod.id)
    if (!Array.isArray(mod.alvos) || !mod.alvos.length || mod.alvos.length > 20 || mod.alvos.some(a => a !== '*' && !(typeof a === 'string' && ID.test(a)))) p.push(`${r}: alvos inválidos`)
    const tipo = TIPOS[mod.tipo]
    if (!tipo) return p.push(`${r}: tipo desconhecido`)
    if (typeof mod.chave !== 'string' || !tipo.chave.test(mod.chave)) p.push(`${r}: chave fora da lista permitida`)
    if (!ehEscalar(mod.valor) || (typeof mod.valor === 'string' && mod.valor.length > 200) || (typeof mod.valor === 'number' && !Number.isFinite(mod.valor))) p.push(`${r}: valor inválido`)
  })
  if (m.pacotes !== undefined) {
    if (!Array.isArray(m.pacotes) || m.pacotes.length > 5) p.push('pacotes inválidos')
    else if (estrito) { const ids = new Set(); m.pacotes.forEach((x, i) => { p.push(...Pacote.validar(x, `pacote ${i + 1}`)); if (x && typeof x.id === 'string') { if (ids.has(x.id)) p.push(`pacote ${i + 1}: id repetido`); ids.add(x.id) } }) } // o cliente confere cada entrada na hora de aplicar: uma entrada ruim recusa só ela, nunca os `modulos`
  }
  if (m.versoes !== undefined) { // igual a `pacotes`: só a estrutura quebrada recusa o manifesto; entrada ruim recusa só ela
    if (!Array.isArray(m.versoes) || m.versoes.length > 3) p.push('versões inválidas')
    else if (estrito) { const ids = new Set(), exts = new Set(); m.versoes.forEach((x, i) => { p.push(...Versao.validar(x, `versão ${i + 1}`, true)); if (x && typeof x.id === 'string') { if (ids.has(x.id)) p.push(`versão ${i + 1}: id repetido`); ids.add(x.id) } if (x && typeof x.extensao === 'string') { if (exts.has(x.extensao)) p.push(`versão ${i + 1}: duas entradas para a mesma extensão (a máquina trocaria de versão duas vezes por ciclo)`); exts.add(x.extensao) } }) }
  }
  return p
}

// Envelope: { chave: "<id>", manifesto: "<base64 do JSON>", assinatura: "<base64 Ed25519 sobre esses bytes>" }. Os bytes assinados são os que chegam: nada de canonicalização.
function abrirEnvelope(texto, chaves) {
  let env; try { env = JSON.parse(texto) } catch (e) { return { erro: 'ENVELOPE-INVALIDO não é JSON' } }
  if (!env || typeof env.chave !== 'string' || typeof env.manifesto !== 'string' || typeof env.assinatura !== 'string') return { erro: 'ENVELOPE-INVALIDO campos ausentes' }
  const k = (chaves.chaves || []).find(x => x && x.id === env.chave && x.uso !== 'pacote') // a chave dos pacotes (`uso: "pacote"`) só assina pacote, nunca o manifesto
  if (!k) return { erro: 'CHAVE-DESCONHECIDA' }
  const bytes = Buffer.from(env.manifesto, 'base64'), sig = Buffer.from(env.assinatura, 'base64')
  let ok = false
  try { ok = crypto.verify(null, bytes, crypto.createPublicKey({ key: Buffer.from(k.publica, 'base64'), format: 'der', type: 'spki' }), sig) } catch (e) { return { erro: `CHAVE-INVALIDA ${String(e.code || e.message).slice(0, 60)}` } }
  if (!ok) return { erro: 'ASSINATURA-INVALIDA' }
  let m; try { m = JSON.parse(bytes.toString('utf8')) } catch (e) { return { erro: 'ENVELOPE-INVALIDO manifesto assinado não é JSON' } }
  const probs = validar(m)
  return probs.length ? { erro: `MANIFESTO-INVALIDO ${probs.slice(0, 3).join('; ')}` } : { manifesto: m }
}

async function buscar(fonte, ganchos) {
  if (!/^https:\/\//.test(fonte)) { // arquivo local (testes e instalação por pendrive): um descritor só, com o teto na própria leitura (um stat antes poderia ser enganado por troca do arquivo)
    const fd = fs.openSync(fonte, 'r')
    try {
      const buf = Buffer.alloc(LIMITE_BYTES + 1); let lidos = 0, n
      while (lidos < buf.length && (n = fs.readSync(fd, buf, lidos, buf.length - lidos, null)) > 0) lidos += n
      if (lidos > LIMITE_BYTES) throw Object.assign(new Error('arquivo grande demais'), { code: 'GRANDE' })
      return buf.subarray(0, lidos).toString('utf8')
    } finally { fs.closeSync(fd) }
  }
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const r = await (ganchos.fetch || fetch)(fonte, { signal: ctl.signal, redirect: 'error', headers: { 'User-Agent': 'grupofacial-converge', Accept: 'application/json' } })
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { code: `HTTP-${r.status}` })
    const tipo = String(r.headers.get('content-type') || '')
    if (/html/i.test(tipo)) throw Object.assign(new Error('resposta HTML (portal de rede?)'), { code: 'HTML' })
    const partes = []; let total = 0
    for await (const parte of r.body) { total += parte.length; if (total > LIMITE_BYTES) throw Object.assign(new Error('resposta grande demais'), { code: 'GRANDE' }); partes.push(parte) }
    return Buffer.concat(partes).toString('utf8')
  } finally { clearTimeout(t) }
}

// O estado são REGISTROS por serial (`estado.<serial com 16 dígitos>.json`) e o estado vigente é o de MAIOR serial: uma execução atrasada (máquina que dormiu, trava dada como
// velha) que grave por último um serial menor cria outro arquivo e nunca faz o estado recuar (cerca contra escritor atrasado). O que ela mexer no settings.json é refeito pela
// próxima convergência (toda execução reconfere todos os módulos contra o manifesto vigente), então o erro dura no máximo até a execução seguinte.
const REGISTRO = /^estado\.(\d{16})\.json$/, ESTADO_PADRAO = { serial: 0, modulos: {}, emitido: 0 }, REGISTROS_QUE_FICAM = 3
const registros = dir => { try { return fs.readdirSync(dir).filter(n => REGISTRO.test(n)).sort().reverse() } catch (e) { if (e.code === 'ENOENT') return []; throw e } }
function lerEstado(dir, aviso) { // o mais novo que abre; se todos estiverem ilegíveis o erro sobe (nunca vira "estado vazio" em silêncio)
  const nomes = registros(dir), piso = nomes.length ? Number(REGISTRO.exec(nomes[0])[1]) : 0 // o serial está no NOME: vale como piso mesmo que o conteúdo do mais novo esteja ilegível
  let erro = null
  for (const n of nomes) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))
      if (Number.isSafeInteger(r.serial) && r.serial >= 1) return r.serial >= piso ? r : { ...r, serial: piso, degradado: true } // registro mais novo corrompido: o piso impede o rollback
      erro = new Error('registro de estado sem serial válido')
    } catch (e) { erro = e; if (aviso) aviso(`registro ${n} ilegível`) }
  }
  if (erro) throw erro
  return ESTADO_PADRAO
}
function gravarEstado(dir, rec) { // arquivo NOSSO e com o nome do próprio serial: tmp + fsync + rename não pisa em nenhum outro serial
  const arq = path.join(dir, `estado.${String(rec.serial).padStart(16, '0')}.json`), tmp = `${arq}.${process.pid}.tmp`, fd = fs.openSync(tmp, 'w')
  try { fs.writeSync(fd, JSON.stringify(rec, null, 2)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  fs.renameSync(tmp, arq)
  if (process.platform !== 'win32') { const d = fs.openSync(dir, 'r'); try { fs.fsyncSync(d) } finally { fs.closeSync(d) } } // a entrada do diretório também: sem isto uma queda de energia desfaz o registro
  for (const n of registros(dir).slice(REGISTROS_QUE_FICAM)) fs.rmSync(path.join(dir, n), { force: true })
}

function caminhoSettings() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Code', 'User', 'settings.json')
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'settings.json')
  return path.join(os.homedir(), '.config', 'Code', 'User', 'settings.json')
}
const estadoPadrao = () => process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'GrupoFacial', 'converge')
  : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'GrupoFacial', 'converge') : path.join(os.homedir(), '.local', 'share', 'grupofacial', 'converge')

function lerJson(arq, padrao) { // arquivo ausente = padrão; arquivo corrompido NÃO vira padrão em silêncio: sobe o erro (o chamador registra)
  try { return JSON.parse(fs.readFileSync(arq, 'utf8')) } catch (e) { if (e.code === 'ENOENT') return padrao; throw e }
}

// Uma convergência. Devolve { resultado, serial?, modulos?, detalhe?, codigo }. Nunca lança: o que der errado vira resultado registrado.
async function executar(op, ganchos = {}) {
  const dir = op.estado || estadoPadrao(), relogio = () => (ganchos.agora || Date.now)(), inicioCiclo = relogio() // o Agendador mata o cliente 40 min depois do início: a versão da extensão conta o orçamento a partir daqui, não do fim do pacote
  const log = (palavra, detalhe) => {
    const linha = `${new Date(relogio()).toISOString()} ${palavra}${detalhe ? ' ' + detalhe : ''}\n`, arq = path.join(dir, 'converge.log')
    try { if (fs.existsSync(arq) && fs.statSync(arq).size > LOG_MAX) fs.renameSync(arq, `${arq}.1`); fs.appendFileSync(arq, linha) } catch (e) { process.stderr.write(`FALHA-AO-GRAVAR-LOG ${String(e.code || e.message).slice(0, 80)}\n`) }
    return linha
  }
  let dono = null
  const trava = path.join(dir, 'converge.lock')
  try {
    fs.mkdirSync(dir, { recursive: true })
    dono = Trava.pegar(trava, Date.now, ganchos.travaGanchos) // a idade da trava é medida no relógio real (o ganchos.agora dos testes só mexe no relógio do manifesto)
    if (dono === null) { log('OCUPADO outra execução em andamento'); return { resultado: 'OCUPADO', codigo: 0 } }
    const config = lerJson(path.join(dir, 'config.json'), {}), quem = typeof config.quem === 'string' && ID.test(config.quem) ? config.quem : null
    const renovarTrava = () => Trava.renovar(trava)
    const sigoDono = () => Trava.sigoDono(trava, dono) // a trava só é tomada de quem morreu (ver trava.cjs), mas cada ato confere a posse antes
    if (op.jitter > 0 && ganchos.dormir) await ganchos.dormir(Math.floor(Math.random() * op.jitter * 1000))
    renovarTrava()
    let texto
    try { texto = await buscar(op.manifesto, ganchos) } catch (e) { log(`SEM-MANIFESTO ${String(e.code || e.name || 'ERRO').slice(0, 40)}: a máquina fica como está`); return { resultado: 'SEM-MANIFESTO', codigo: 0 } }
    renovarTrava()
    const estado = lerEstado(dir, aviso => log(`AVISO ${aviso}`)) // lido DEPOIS da busca: o que outra execução gravou enquanto esta esperava vale
    const chaves = lerJson(op.chave, null)
    if (!chaves) { log('SEM-CHAVE-PUBLICA arquivo ausente'); return { resultado: 'SEM-CHAVE-PUBLICA', codigo: 1 } }
    const ab = abrirEnvelope(texto, chaves)
    if (ab.erro) { log(`RECUSADO ${ab.erro}`); return { resultado: 'RECUSADO', detalhe: ab.erro, codigo: 0 } }
    const m = ab.manifesto
    if (relogio() < Date.parse(estado.emitido || 0) - 24 * 3600 * 1000) { log('RECUSADO RELOGIO-ATRASADO o relógio da máquina está mais de 1 dia antes da emissão do último manifesto aceito'); return { resultado: 'RECUSADO', detalhe: 'RELOGIO-ATRASADO', codigo: 0 } } // âncora = data que o ASSINANTE pôs no manifesto: um relógio local adiantado uma vez não trava a máquina para sempre
    if (Date.parse(m.emitido) > relogio() + 24 * 3600 * 1000) { log(`RECUSADO EMITIDO-NO-FUTURO serial ${m.serial}: emitido mais de 1 dia depois do relógio desta máquina`); return { resultado: 'RECUSADO', detalhe: 'EMITIDO-NO-FUTURO', codigo: 0 } } // relógio atrasado OU manifesto com data absurda; sem isto a âncora do relógio podia ser envenenada
    if (Date.parse(m.expira) <= relogio()) { log(`RECUSADO EXPIRADO serial ${m.serial}`); return { resultado: 'RECUSADO', detalhe: 'EXPIRADO', codigo: 0 } }
    if (m.serial < estado.serial) { log(`RECUSADO SERIAL-MENOR ${m.serial} < ${estado.serial}`); return { resultado: 'RECUSADO', detalhe: 'SERIAL-MENOR', codigo: 0 } }
    // última conferência ANTES de aplicar: se a máquina dormiu entre o estado lido e aqui, outra execução pode ter dado esta trava como velha e tomado o lugar (ela já leu o estado mais novo)
    if (!sigoDono()) { log('RECUSADO TRAVA-PERDIDA outra execução tomou o lugar desta; nada foi aplicado'); dono = null; return { resultado: 'RECUSADO', detalhe: 'TRAVA-PERDIDA', codigo: 0 } }
    renovarTrava()
    const alvo = op.settings || caminhoSettings(), resultados = {}; let falhou = false
    const vencido = () => Date.parse(m.expira) <= relogio() // a máquina pode ter ficado suspensa ou lenta depois da primeira conferência: a validade vale a cada módulo
    for (const mod of m.modulos) {
      if (!(mod.alvos.includes('*') || (quem && mod.alvos.includes(quem)))) { resultados[mod.id] = 'NAO-SE-APLICA'; continue }
      if (vencido()) { log(`RECUSADO EXPIRADO antes do módulo ${mod.id} (venceu durante a aplicação); os módulos restantes não foram aplicados e o serial ${m.serial} não foi registrado`); return { resultado: 'RECUSADO', detalhe: 'EXPIRADO', modulos: resultados, codigo: 0 } }
      if (!sigoDono()) { log(`RECUSADO TRAVA-PERDIDA antes do módulo ${mod.id}; os módulos restantes não foram aplicados`); dono = null; return { resultado: 'RECUSADO', detalhe: 'TRAVA-PERDIDA', modulos: resultados, codigo: 0 } }
      renovarTrava()
      const [palavra] = aplicarChave(alvo, mod.chave, mod.valor, { ...(ganchos.jsonc || {}), aindaValido: () => sigoDono() && !vencido() })
      if (palavra.startsWith('CANCELADO')) { const exp = vencido(); log(`RECUSADO ${exp ? 'EXPIRADO' : 'TRAVA-PERDIDA'} no módulo ${mod.id}; os módulos restantes não foram aplicados${exp ? ` e o serial ${m.serial} não foi registrado` : ''}`); if (!exp) dono = null; return { resultado: 'RECUSADO', detalhe: exp ? 'EXPIRADO' : 'TRAVA-PERDIDA', modulos: resultados, codigo: 0 } }
      resultados[mod.id] = palavra.split(' ')[0]
      if (!/^(APLICADO|JA-OK)$/.test(resultados[mod.id])) falhou = true
      log(`MODULO ${mod.id} ${palavra.slice(0, 160)}`)
    }
    if (vencido()) { log(`RECUSADO EXPIRADO ao terminar (venceu durante a aplicação); o serial ${m.serial} não foi registrado`); return { resultado: 'RECUSADO', detalhe: 'EXPIRADO', modulos: resultados, codigo: 0 } }
    if (!sigoDono()) { log('ERRO TRAVA-PERDIDA durante a aplicação; o estado não foi gravado (a próxima execução reconverge)'); dono = null; return { resultado: 'ERRO', detalhe: 'TRAVA-PERDIDA', codigo: 1 } }
    const registro = { serial: m.serial, emitido: new Date(Math.max(Date.parse(m.emitido), Date.parse(estado.emitido || 0))).toISOString(), ultimoCiclo: new Date(relogio()).toISOString(), modulos: resultados }
    gravarEstado(dir, registro) // a configuração fica registrada ANTES do pacote (que pode levar minutos): pacote lento ou com defeito nunca atrasa nem derruba o resto
    const pacotes = {}, inicioPacotes = relogio() // o orçamento de tempo é UM por ciclo, de todos os pacotes juntos
    const parar = () => (!sigoDono() ? 'TRAVA-PERDIDA' : vencido() ? 'EXPIRADO' : null)
    const interrompido = motivo => { // mesmo tratamento dos módulos: a configuração já foi registrada, o resto não é aplicado e o motivo fica à vista
      log(`RECUSADO ${motivo} durante o pacote; o que faltava não foi aplicado (a próxima execução reconverge)`)
      if (motivo === 'TRAVA-PERDIDA') dono = null
      else if (Object.keys(pacotes).length && sigoDono()) gravarEstado(dir, { ...registro, pacotes })
      return { resultado: 'RECUSADO', detalhe: motivo, modulos: resultados, pacotes, codigo: 0 }
    }
    for (const pac of m.pacotes || []) {
      const rotulo = pac && typeof pac.id === 'string' && ID.test(pac.id) ? pac.id : `entrada-${Object.keys(pacotes).length + 1}`
      const problemas = Pacote.validar(pac, 'pacote')
      if (problemas.length) { pacotes[rotulo] = 'PACOTE-RECUSADO'; falhou = true; log(`PACOTE ${rotulo} PACOTE-RECUSADO ${problemas.slice(0, 3).join('; ')}`); continue }
      if (!(pac.alvos.includes('*') || (quem && pac.alvos.includes(quem)))) { pacotes[pac.id] = 'NAO-SE-APLICA'; continue }
      if (pacotes[pac.id] !== undefined) { pacotes[`${pac.id}-repetido`] = 'PACOTE-RECUSADO'; falhou = true; log(`PACOTE ${pac.id} PACOTE-RECUSADO id repetido`); continue }
      const antes = parar(); if (antes) return interrompido(antes)
      renovarTrava()
      const r = await Pacote.aplicar(pac, { dir, agora: relogio, log, parar, chaves, inicio: inicioPacotes, ganchos })
      pacotes[pac.id] = r.palavra
      if (Pacote.PALAVRAS_RUINS.has(r.palavra)) falhou = true
      const depois = parar(); if (depois) return interrompido(depois)
      renovarTrava()
    }
    if (Object.keys(pacotes).length && sigoDono()) gravarEstado(dir, { ...registro, pacotes }) // mesmo serial, mesmo nome de arquivo: a troca é atômica
    // a versão da extensão vem depois do pacote de MCPs e com o orçamento de tempo PRÓPRIO (a troca leva minutos e só age com o VS Code fechado); a configuração e os pacotes já estão registrados
    const versoes = {}, extensoesVistas = new Set(), comPacotes = Object.keys(pacotes).length ? { pacotes } : {}
    const interrompidoV = motivo => {
      log(`RECUSADO ${motivo} durante a versão da extensão; o que faltava não foi aplicado (a próxima execução reconverge)`)
      if (motivo === 'TRAVA-PERDIDA') dono = null
      else if (Object.keys(versoes).length && sigoDono()) gravarEstado(dir, { ...registro, ...comPacotes, versoes })
      return { resultado: 'RECUSADO', detalhe: motivo, modulos: resultados, ...comPacotes, versoes, codigo: 0 }
    }
    const antesRecuperar = parar(); if (antesRecuperar) return interrompidoV(antesRecuperar)
    // troca que caiu no meio (marcador no estado local) é desfeita ANTES de qualquer entrada e MESMO sem entrada: removida do manifesto, fora dos alvos, `versoes` tirado do frota-estado ou forjada não deixam a máquina numa versão sem conferência
    const recuperadas = await Versao.recuperar({ dir, agora: relogio, log, parar, chaves, inicio: inicioCiclo, ganchos })
    for (const [id, palavra] of Object.entries(recuperadas)) { versoes[id] = palavra; if (Versao.PALAVRAS_RUINS.has(palavra)) falhou = true }
    for (const ver of m.versoes || []) {
      if (ver && typeof ver.id === 'string' && recuperadas[ver.id] !== undefined) continue // já tratado acima: neste ciclo a máquina só se recupera, a troca nova espera o próximo
      const rotulo = ver && typeof ver.id === 'string' && ID.test(ver.id) ? ver.id : `entrada-${Object.keys(versoes).length + 1}`
      const problemas = Versao.validar(ver, 'versão')
      if (problemas.length) { versoes[rotulo] = 'VERSAO-RECUSADA'; falhou = true; log(`VERSAO ${rotulo} VERSAO-RECUSADA ${problemas.slice(0, 3).join('; ')}`); continue }
      if (!(ver.alvos.includes('*') || (quem && ver.alvos.includes(quem)))) { versoes[ver.id] = 'NAO-SE-APLICA'; continue }
      if (versoes[ver.id] !== undefined) { versoes[`${ver.id}-repetido`] = 'VERSAO-RECUSADA'; falhou = true; log(`VERSAO ${ver.id} VERSAO-RECUSADA id repetido`); continue }
      if (extensoesVistas.has(ver.extensao)) { versoes[`${ver.id}-extensao-repetida`] = 'VERSAO-RECUSADA'; falhou = true; log(`VERSAO ${ver.id} VERSAO-RECUSADA já há outra entrada para a mesma extensão neste manifesto (valeria só a primeira)`); continue } // duas versões desejadas para a mesma extensão trocariam a máquina duas vezes a cada ciclo
      extensoesVistas.add(ver.extensao)
      const antes = parar(); if (antes) return interrompidoV(antes)
      renovarTrava()
      const r = await Versao.aplicar(ver, { dir, agora: relogio, log, parar, chaves, inicio: inicioCiclo, ganchos })
      versoes[ver.id] = r.palavra
      if (Versao.PALAVRAS_RUINS.has(r.palavra)) falhou = true
      const depois = parar(); if (depois) return interrompidoV(depois)
      renovarTrava()
    }
    if (Object.keys(versoes).length && sigoDono()) gravarEstado(dir, { ...registro, ...comPacotes, versoes })
    const resumo = [...Object.entries(resultados), ...Object.entries(pacotes).map(([k, v]) => [`pacote-${k}`, v]), ...Object.entries(versoes).map(([k, v]) => [`versao-${k}`, v])].map(([k, v]) => `${k}=${v}`).join(' ')
    log(`${falhou ? 'COM-ERRO' : 'OK'} serial ${m.serial} ${resumo}`)
    return { resultado: falhou ? 'COM-ERRO' : 'OK', serial: m.serial, modulos: resultados, ...comPacotes, ...(Object.keys(versoes).length ? { versoes } : {}), codigo: falhou ? 1 : 0 }
  } catch (e) {
    try { log(`ERRO ${String(e.code || '')} ${String(e.message).split('\n')[0].slice(0, 160)}`) } catch (l) { process.stderr.write('ERRO e log indisponível\n') }
    return { resultado: 'ERRO', detalhe: String(e.code || e.message).slice(0, 80), codigo: 1 }
  } finally {
    if (dono !== null) { try { Trava.soltar(trava, dono) } catch (e) { process.stderr.write(`FALHA-AO-SOLTAR-TRAVA ${String(e.code).slice(0, 20)}\n`) } } // só o dono solta: não apaga a trava de quem tomou o lugar
  }
}

function argumentos(argv) {
  const op = { jitter: 0 }, mapa = { '--manifesto': 'manifesto', '--chave': 'chave', '--estado': 'estado', '--settings': 'settings', '--jitter': 'jitter' }
  for (let i = 0; i < argv.length; i += 2) { const k = mapa[argv[i]]; if (!k || argv[i + 1] === undefined) return { erro: `argumento inesperado: ${String(argv[i]).slice(0, 40)}` }; op[k] = k === 'jitter' ? Number(argv[i + 1]) : argv[i + 1] }
  if (!op.manifesto) return { erro: 'falta --manifesto <https://… | arquivo>' }
  if (!Number.isFinite(op.jitter) || op.jitter < 0 || op.jitter > JITTER_MAX_S) return { erro: `--jitter fora de 0..${JITTER_MAX_S} segundos` }
  op.chave = op.chave || path.join(__dirname, 'chave-publica.json')
  return { op }
}

if (require.main === module) {
  const a = argumentos(process.argv.slice(2))
  if (a.erro) { console.error(a.erro); process.exitCode = 2 } else {
    executar(a.op, { dormir: ms => new Promise(r => setTimeout(r, ms)) }).then(r => { console.log(JSON.stringify(r)); process.exitCode = r.codigo })
  }
}
module.exports = { executar, validar, abrirEnvelope, argumentos, gravarEstado, lerEstado }
