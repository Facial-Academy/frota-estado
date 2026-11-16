// assinar-manifesto.cjs — ferramenta do operador (roda na máquina do Lucas, nunca nas máquinas da frota).
//   node assinar-manifesto.cjs gerar-chave <pasta-nova>                         cria <pasta>/privada.pem (modo 600) e <pasta>/chave-publica.json
//   node assinar-manifesto.cjs assinar <manifesto.json> <privada.pem> <id-da-chave> <saida.json>
//   node assinar-manifesto.cjs verificar <envelope.json> <chave-publica.json>
//   node assinar-manifesto.cjs assinar-versao <entrada.json> <privada.pem> <id-da-chave-dos-pacotes> <saida.json>   assina UMA entrada de `versoes` (fonte/versoes.json do frota-estado) com a chave dos pacotes
//   node assinar-manifesto.cjs verificar-versoes <fonte/versoes.json> <chave-publica.json>                         confere a assinatura de cada entrada
// A chave privada nunca é impressa nem aceita por argumento de texto: só por caminho de arquivo. Depois de gerar, guarde-a no cofre
// (`python scripts\salva-no-cofre.py --nome … --arquivo <privada.pem>`, que destrói o arquivo) e não deixe cópia em disco.
const fs = require('fs'), path = require('path'), crypto = require('crypto')
const { validar, abrirEnvelope } = require('./converge.cjs')
const Versao = require('./extensao-vscode.cjs')

function gerarChave(pasta, id) {
  if (fs.existsSync(pasta) && fs.readdirSync(pasta).length) throw new Error('a pasta de saída já existe e não está vazia')
  fs.mkdirSync(pasta, { recursive: true })
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  fs.writeFileSync(path.join(pasta, 'privada.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' })
  const publica = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  fs.writeFileSync(path.join(pasta, 'chave-publica.json'), JSON.stringify({ chaves: [{ id, publica }] }, null, 2) + '\n', { flag: 'wx' })
  return { id, publica }
}

function assinar(arqManifesto, arqPrivada, id) {
  const bytes = Buffer.from(JSON.stringify(JSON.parse(fs.readFileSync(arqManifesto, 'utf8'))), 'utf8') // reserializa: o que se assina é exatamente o que vai no envelope
  const problemas = validar(JSON.parse(bytes.toString('utf8')), true) // estrito: o operador nunca assina um pacote mal formado
  if (problemas.length) throw new Error(`manifesto inválido: ${problemas.slice(0, 5).join('; ')}`)
  const chave = crypto.createPrivateKey(fs.readFileSync(arqPrivada, 'utf8'))
  return { chave: id, manifesto: bytes.toString('base64'), assinatura: crypto.sign(null, bytes, chave).toString('base64') }
}

function assinarVersao(arqEntrada, arqPrivada, id) { // a entrada traz id, extensao, versao, faixa, alvos, hashes e seq; a chave e a assinatura saem daqui. Estrito: nunca assina entrada mal formada ou com a versão fora da faixa
  const entrada = { ...JSON.parse(fs.readFileSync(arqEntrada, 'utf8')), chave: id }; delete entrada.assinatura
  entrada.assinatura = crypto.sign(null, Versao.payloadVersao(entrada), crypto.createPrivateKey(fs.readFileSync(arqPrivada, 'utf8'))).toString('base64')
  const problemas = Versao.validar(entrada, 'versão', true)
  if (problemas.length) throw new Error(`entrada inválida: ${problemas.slice(0, 5).join('; ')}`)
  return { versoes: [entrada] }
}

function principal(argv) {
  const [cmd, ...a] = argv
  if (cmd === 'gerar-chave' && a.length === 1) { const r = gerarChave(a[0], new Date().toISOString().slice(0, 7)); return `chave ${r.id} gerada; pública em ${path.join(a[0], 'chave-publica.json')}; privada em ${path.join(a[0], 'privada.pem')} (guarde no cofre e apague)` }
  if (cmd === 'assinar' && a.length === 4) { const env = assinar(a[0], a[1], a[2]); fs.writeFileSync(a[3], JSON.stringify(env) + '\n'); return `assinado: ${a[3]} (${JSON.parse(Buffer.from(env.manifesto, 'base64')).modulos.length} módulos)` }
  if (cmd === 'verificar' && a.length === 2) { const r = abrirEnvelope(fs.readFileSync(a[0], 'utf8'), JSON.parse(fs.readFileSync(a[1], 'utf8'))); if (r.erro) throw new Error(r.erro); return `válido: serial ${r.manifesto.serial}, expira ${r.manifesto.expira}` }
  if (cmd === 'assinar-versao' && a.length === 4) { const f = assinarVersao(a[0], a[1], a[2]); fs.writeFileSync(a[3], JSON.stringify(f, null, 2) + '\n'); return `assinado: ${a[3]} (extensão ${f.versoes[0].versao}, faixa ${f.versoes[0].faixa.join(' a ')})` }
  if (cmd === 'verificar-versoes' && a.length === 2) {
    const f = JSON.parse(fs.readFileSync(a[0], 'utf8')), chaves = JSON.parse(fs.readFileSync(a[1], 'utf8'))
    if (!f || !Array.isArray(f.versoes) || !f.versoes.length) throw new Error('o arquivo precisa ter { "versoes": [...] } com ao menos uma entrada')
    for (const [i, e] of f.versoes.entries()) { const p = Versao.validar(e, `versão ${i + 1}`, true), m = p.length ? p[0] : Versao.conferirAssinatura(e, chaves); if (m) throw new Error(m) }
    return `válido: ${f.versoes.length} entrada(s), assinaturas conferidas com a chave dos pacotes`
  }
  throw new Error('uso: gerar-chave <pasta-nova> | assinar <manifesto> <privada.pem> <id> <saida> | verificar <envelope> <chave-publica.json> | assinar-versao <entrada> <privada.pem> <id> <saida> | verificar-versoes <versoes.json> <chave-publica.json>')
}

if (require.main === module) {
  try { console.log(principal(process.argv.slice(2))) } catch (e) { console.error(`ERRO ${String(e.message).split('\n')[0]}`); process.exitCode = 1 }
}
module.exports = { gerarChave, assinar, assinarVersao }
