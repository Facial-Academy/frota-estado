// renovar.cjs — monta o manifesto a partir de fonte/modulos.json, assina com a chave de produção e grava estado.json.
// Roda no GitHub Actions (renovar.yml): a chave privada vem do segredo FROTA_CHAVE_PRIVADA, passa por um arquivo 600 que existe só durante a assinatura,
// e nunca é impressa. A validade é renovada toda semana; o `serial` é a data e hora UTC (AAAAMMDDHHMM) e só cresce. Para voltar atrás, edite fonte/modulos.json.
//   node renovar.cjs [--saida estado.json] [--fonte fonte/modulos.json] [--pacotes fonte/pacotes.json] [--versoes fonte/versoes.json] [--chave-publica chave-publica.json]   (variável de ambiente: FROTA_CHAVE_PRIVADA)
// `fonte/pacotes.json` (opcional) traz { "pacotes": [...] } já ASSINADOS por quem publica (chave dos pacotes, `uso: "pacote"`, fora do CI): este script só copia a lista para o manifesto, não assina pacote.
// `fonte/versoes.json` (opcional) traz { "versoes": [...] } (a versão desejada da extensão do Claude Code, também já ASSINADA com a chave dos pacotes): idem, este script só copia a lista para o campo de topo `versoes`, não assina versão.
const fs = require('fs'), path = require('path'), os = require('os')
const { assinar } = require('./ferramentas/assinar-manifesto.cjs')
const { abrirEnvelope } = require('./ferramentas/converge.cjs')
const VALIDADE_DIAS = 120

function argumentos(argv) {
  const op = { saida: 'estado.json', fonte: path.join('fonte', 'modulos.json'), pacotes: path.join('fonte', 'pacotes.json'), versoes: path.join('fonte', 'versoes.json'), chave: 'chave-publica.json' }, mapa = { '--saida': 'saida', '--fonte': 'fonte', '--pacotes': 'pacotes', '--versoes': 'versoes', '--chave-publica': 'chave' }
  for (let i = 0; i < argv.length; i += 2) { const k = mapa[argv[i]]; if (!k || argv[i + 1] === undefined) throw new Error(`argumento inesperado: ${String(argv[i]).slice(0, 40)}`); op[k] = argv[i + 1] }
  return op
}
const carimbo = agora => agora.toISOString().replace(/[-:T]/g, '').slice(0, 12)

function renovar(op, agora = new Date(), privadaPem = process.env.FROTA_CHAVE_PRIVADA) {
  if (!privadaPem || !privadaPem.includes('BEGIN PRIVATE KEY')) throw new Error('FROTA_CHAVE_PRIVADA ausente ou sem formato PEM')
  const fonte = JSON.parse(fs.readFileSync(op.fonte, 'utf8')), chaves = JSON.parse(fs.readFileSync(op.chave, 'utf8'))
  if (!fonte || !Array.isArray(fonte.modulos)) throw new Error('fonte/modulos.json precisa ter { "modulos": [...] }')
  let pacotes = []
  if (op.pacotes) try { const p = JSON.parse(fs.readFileSync(op.pacotes, 'utf8')); if (!p || !Array.isArray(p.pacotes)) throw new Error('fonte/pacotes.json precisa ter { "pacotes": [...] }'); pacotes = p.pacotes } catch (e) { if (e.code !== 'ENOENT') throw e } // ausente = sem pacotes
  let versoes = []
  if (op.versoes) try { const v = JSON.parse(fs.readFileSync(op.versoes, 'utf8')); if (!v || !Array.isArray(v.versoes)) throw new Error('fonte/versoes.json precisa ter { "versoes": [...] }'); versoes = v.versoes } catch (e) { if (e.code !== 'ENOENT') throw e } // ausente = nenhuma versão desejada: nenhuma máquina muda de extensão
  const serial = Number(carimbo(agora)), manifesto = { formato: 1, serial, emitido: agora.toISOString(), expira: new Date(agora.getTime() + VALIDADE_DIAS * 86400000).toISOString(), modulos: fonte.modulos, ...(pacotes.length ? { pacotes } : {}), ...(versoes.length ? { versoes } : {}) }
  let atual = 0
  try { const e = abrirEnvelope(fs.readFileSync(op.saida, 'utf8'), chaves); atual = e.manifesto ? e.manifesto.serial : 0 } catch (e) { if (e.code !== 'ENOENT') throw e }
  if (serial <= atual) throw new Error(`o serial novo (${serial}) não é maior que o publicado (${atual}): relógio do runner atrasado?`)
  const dir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'frota-')), arqChave = path.join(dir, 'privada.pem'), arqMan = path.join(dir, 'manifesto.json')
  try {
    fs.writeFileSync(arqChave, privadaPem.endsWith('\n') ? privadaPem : privadaPem + '\n', { mode: 0o600, flag: 'wx' }); fs.writeFileSync(arqMan, JSON.stringify(manifesto))
    const doManifesto = chaves.chaves.filter(k => k && (k.uso === undefined || k.uso === 'manifesto')) // a chave dos pacotes (`uso: "pacote"`) nunca assina manifesto
    if (!doManifesto.length) throw new Error('chave-publica.json não tem chave de manifesto')
    const id = doManifesto[doManifesto.length - 1].id, env = assinar(arqMan, arqChave, id)
    const conferido = abrirEnvelope(JSON.stringify(env), chaves) // o que vai ser publicado tem de abrir com a chave pública publicada
    if (conferido.erro) throw new Error(`o envelope recém-assinado não confere: ${conferido.erro}`)
    const tmp = `${op.saida}.novo`; fs.writeFileSync(tmp, JSON.stringify(env) + '\n'); fs.renameSync(tmp, op.saida)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  return { serial, expira: manifesto.expira, modulos: manifesto.modulos.length, pacotes: pacotes.length, versoes: versoes.length }
}

if (require.main === module) {
  try { const r = renovar(argumentos(process.argv.slice(2))); console.log(`publicado: serial ${r.serial}, ${r.modulos} módulo(s), ${r.pacotes} pacote(s), ${r.versoes} versão(ões), expira ${r.expira}`) } catch (e) { console.error(`ERRO ${String(e.message).split('\n')[0]}`); process.exitCode = 1 }
}
module.exports = { renovar, carimbo }
