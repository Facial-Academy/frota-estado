// converge.cjs — cliente de convergência da frota do Grupo Facial: busca o ESTADO DESEJADO (um manifesto assinado) e faz esta máquina convergir
// para ele. Roda como a pessoa (tarefa agendada da usuária / LaunchAgent), ao ligar e de tempos em tempos. Só a ÚLTIMA versão vale: máquina que
// ficou semanas desligada lê um manifesto só e aplica o resultado final, sem fila de passos intermediários.
//   node converge.cjs --manifesto <https://… | arquivo> [--chave <chave-publica.json>] [--estado <pasta>] [--settings <settings.json>] [--jitter <s>]
// Segurança (o que o cliente exige antes de tocar em qualquer coisa):
//   • assinatura Ed25519 do manifesto por uma chave publicada em chave-publica.json (a hospedagem do arquivo não precisa ser confiável);
//   • `serial` nunca diminui (rollback do manifesto é recusado) e `expira` no futuro (manifesto congelado é recusado);
//   • módulos só dos tipos e chaves que ESTE cliente conhece (lista fixa abaixo): o manifesto não manda executar nada.
// Falha de rede, manifesto inválido ou expirado = a máquina fica como está (exit 0, registrado no log). Só erro ao aplicar sai com código ≠ 0.
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto')
const { aplicarChave } = require('./jsonc-config.cjs')
const Trava = require('./trava.cjs')

const LIMITE_BYTES = 256 * 1024, TIMEOUT_MS = 20000, VALIDADE_MAX_DIAS = 400, LOG_MAX = 256 * 1024, JITTER_MAX_S = 300
const TIPOS = { 'vscode-setting': { chave: /^claudeCode\.[A-Za-z0-9.]{1,80}$/ } }
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/

const ehEscalar = v => v === null || ['boolean', 'number', 'string'].includes(typeof v)
function validar(m) { // devolve a lista de problemas (vazia = válido); a mensagem nunca repete o valor recebido
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
  return p
}

// Envelope: { chave: "<id>", manifesto: "<base64 do JSON>", assinatura: "<base64 Ed25519 sobre esses bytes>" }. Os bytes assinados são os que chegam: nada de canonicalização.
function abrirEnvelope(texto, chaves) {
  let env; try { env = JSON.parse(texto) } catch (e) { return { erro: 'ENVELOPE-INVALIDO não é JSON' } }
  if (!env || typeof env.chave !== 'string' || typeof env.manifesto !== 'string' || typeof env.assinatura !== 'string') return { erro: 'ENVELOPE-INVALIDO campos ausentes' }
  const k = (chaves.chaves || []).find(x => x && x.id === env.chave)
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
  const dir = op.estado || estadoPadrao(), relogio = () => (ganchos.agora || Date.now)()
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
    gravarEstado(dir, { serial: m.serial, emitido: new Date(Math.max(Date.parse(m.emitido), Date.parse(estado.emitido || 0))).toISOString(), ultimoCiclo: new Date(relogio()).toISOString(), modulos: resultados })
    const resumo = Object.entries(resultados).map(([k, v]) => `${k}=${v}`).join(' ')
    log(`${falhou ? 'COM-ERRO' : 'OK'} serial ${m.serial} ${resumo}`)
    return { resultado: falhou ? 'COM-ERRO' : 'OK', serial: m.serial, modulos: resultados, codigo: falhou ? 1 : 0 }
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
