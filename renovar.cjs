// renovar.cjs — monta o manifesto a partir de fonte/modulos.json, assina com a chave de produção e grava estado.json.
// Roda no GitHub Actions (renovar.yml): a chave privada vem do segredo FROTA_CHAVE_PRIVADA, passa por um arquivo 600 que existe só durante a assinatura,
// e nunca é impressa. A validade é renovada toda semana; o `serial` é a data e hora UTC (AAAAMMDDHHMM) e só cresce. Para voltar atrás, edite fonte/modulos.json.
//   node renovar.cjs [--saida estado.json] [--fonte fonte/modulos.json] [--chave-publica chave-publica.json]   (variável de ambiente: FROTA_CHAVE_PRIVADA)
const fs = require('fs'), path = require('path'), os = require('os')
const { assinar } = require('./ferramentas/assinar-manifesto.cjs')
const { abrirEnvelope } = require('./ferramentas/converge.cjs')
const VALIDADE_DIAS = 120

function argumentos(argv) {
  const op = { saida: 'estado.json', fonte: path.join('fonte', 'modulos.json'), chave: 'chave-publica.json' }, mapa = { '--saida': 'saida', '--fonte': 'fonte', '--chave-publica': 'chave' }
  for (let i = 0; i < argv.length; i += 2) { const k = mapa[argv[i]]; if (!k || argv[i + 1] === undefined) throw new Error(`argumento inesperado: ${String(argv[i]).slice(0, 40)}`); op[k] = argv[i + 1] }
  return op
}
const carimbo = agora => agora.toISOString().replace(/[-:T]/g, '').slice(0, 12)

function renovar(op, agora = new Date(), privadaPem = process.env.FROTA_CHAVE_PRIVADA) {
  if (!privadaPem || !privadaPem.includes('BEGIN PRIVATE KEY')) throw new Error('FROTA_CHAVE_PRIVADA ausente ou sem formato PEM')
  const fonte = JSON.parse(fs.readFileSync(op.fonte, 'utf8')), chaves = JSON.parse(fs.readFileSync(op.chave, 'utf8'))
  if (!fonte || !Array.isArray(fonte.modulos)) throw new Error('fonte/modulos.json precisa ter { "modulos": [...] }')
  const serial = Number(carimbo(agora)), manifesto = { formato: 1, serial, emitido: agora.toISOString(), expira: new Date(agora.getTime() + VALIDADE_DIAS * 86400000).toISOString(), modulos: fonte.modulos }
  let atual = 0
  try { const e = abrirEnvelope(fs.readFileSync(op.saida, 'utf8'), chaves); atual = e.manifesto ? e.manifesto.serial : 0 } catch (e) { if (e.code !== 'ENOENT') throw e }
  if (serial <= atual) throw new Error(`o serial novo (${serial}) não é maior que o publicado (${atual}): relógio do runner atrasado?`)
  const dir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'frota-')), arqChave = path.join(dir, 'privada.pem'), arqMan = path.join(dir, 'manifesto.json')
  try {
    fs.writeFileSync(arqChave, privadaPem.endsWith('\n') ? privadaPem : privadaPem + '\n', { mode: 0o600, flag: 'wx' }); fs.writeFileSync(arqMan, JSON.stringify(manifesto))
    const id = chaves.chaves[chaves.chaves.length - 1].id, env = assinar(arqMan, arqChave, id)
    const conferido = abrirEnvelope(JSON.stringify(env), chaves) // o que vai ser publicado tem de abrir com a chave pública publicada
    if (conferido.erro) throw new Error(`o envelope recém-assinado não confere: ${conferido.erro}`)
    const tmp = `${op.saida}.novo`; fs.writeFileSync(tmp, JSON.stringify(env) + '\n'); fs.renameSync(tmp, op.saida)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  return { serial, expira: manifesto.expira, modulos: manifesto.modulos.length }
}

if (require.main === module) {
  try { const r = renovar(argumentos(process.argv.slice(2))); console.log(`publicado: serial ${r.serial}, ${r.modulos} módulo(s), expira ${r.expira}`) } catch (e) { console.error(`ERRO ${String(e.message).split('\n')[0]}`); process.exitCode = 1 }
}
module.exports = { renovar, carimbo }
