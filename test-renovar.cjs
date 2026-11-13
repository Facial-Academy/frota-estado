// Teste do renovar.cjs com uma chave descartável (a de produção nunca aparece aqui). Uso: node test-renovar.cjs
const assert = require('node:assert/strict'), fs = require('fs'), os = require('os'), path = require('path')
const { gerarChave } = require('./ferramentas/assinar-manifesto.cjs'), { abrirEnvelope } = require('./ferramentas/converge.cjs'), { renovar, carimbo } = require('./renovar.cjs')
const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-')), ler = f => fs.readFileSync(f, 'utf8')
try {
  gerarChave(path.join(raiz, 'k'), '2026-10'); const pem = ler(path.join(raiz, 'k', 'privada.pem')), pub = path.join(raiz, 'k', 'chave-publica.json')
  const fonte = path.join(raiz, 'modulos.json'), saida = path.join(raiz, 'estado.json'), modulosReais = ler(path.join(__dirname, 'fonte', 'modulos.json')); fs.writeFileSync(fonte, modulosReais)
  const op = { fonte, saida, chave: pub }, t1 = new Date('2026-10-22T17:30:00Z')
  const r = renovar(op, t1, pem); assert.deepEqual([r.serial, r.modulos], [202610221730, JSON.parse(modulosReais).modulos.length])
  const aberto = abrirEnvelope(ler(saida), JSON.parse(ler(pub))); assert.equal(aberto.manifesto.serial, 202610221730); assert.equal(aberto.manifesto.expira, '2027-02-19T17:30:00.000Z')
  assert.throws(() => renovar(op, t1, pem), /não é maior/); assert.throws(() => renovar(op, new Date('2026-10-22T17:29:00Z'), pem), /não é maior/)
  assert.equal(renovar(op, new Date('2026-10-29T09:17:00Z'), pem).serial, 202610290917)
  assert.throws(() => renovar(op, new Date('2027-01-01T00:00:00Z'), ''), /FROTA_CHAVE_PRIVADA/); assert.throws(() => renovar(op, new Date('2027-01-01T00:00:00Z'), 'texto'), /FROTA_CHAVE_PRIVADA/)
  fs.writeFileSync(fonte, JSON.stringify({ modulos: [{ id: 'x', tipo: 'comando', alvos: ['*'], chave: 'claudeCode.a', valor: 1 }] }))
  assert.throws(() => renovar(op, new Date('2027-01-01T00:00:00Z'), pem), /inválido/); assert.equal(abrirEnvelope(ler(saida), JSON.parse(ler(pub))).manifesto.serial, 202610290917) // o publicado não foi tocado
  gerarChave(path.join(raiz, 'k2'), '2026-10'); fs.writeFileSync(fonte, modulosReais)
  assert.throws(() => renovar(op, new Date('2027-01-02T00:00:00Z'), ler(path.join(raiz, 'k2', 'privada.pem'))), /não confere|ASSINATURA/) // chave que não é a da publicada não publica
  assert.equal(carimbo(new Date('2026-01-02T03:04:05Z')), '202601020304'); assert.ok(!fs.readdirSync(os.tmpdir()).some(d => d.startsWith('frota-') && fs.existsSync(path.join(os.tmpdir(), d, 'privada.pem'))))
  // pacotes: copiados de fonte/pacotes.json para o manifesto (sem o arquivo, o manifesto é o de sempre); a chave dos pacotes nunca assina o manifesto
  const entrada = { id: 'mcps', alvos: ['*'], url: 'https://raw.githubusercontent.com/Facial-Academy/frota-estado/main/pacotes/pacote-frota-12345678.json.gz', sha256: 'a'.repeat(64), bytes: 1000, manifestoSha256: 'b'.repeat(64), versao: 'nexo 1.0.0+abcd1234', seq: 202611131500, chave: 'pacote-teste', assinatura: 'A'.repeat(86) + '==' }
  const arqPacotes = path.join(raiz, 'pacotes.json'), saida2 = path.join(raiz, 'estado2.json'), op2 = { fonte, saida: saida2, chave: pub, pacotes: arqPacotes }
  assert.equal(renovar(op2, new Date('2027-02-01T00:00:00Z'), pem).pacotes, 0); assert.equal(abrirEnvelope(ler(saida2), JSON.parse(ler(pub))).manifesto.pacotes, undefined)
  fs.writeFileSync(arqPacotes, JSON.stringify({ pacotes: [entrada] })); const rp = renovar(op2, new Date('2027-02-02T00:00:00Z'), pem)
  assert.equal(rp.pacotes, 1); assert.deepEqual(abrirEnvelope(ler(saida2), JSON.parse(ler(pub))).manifesto.pacotes, [entrada])
  fs.writeFileSync(arqPacotes, JSON.stringify({ pacotes: [{ ...entrada, url: 'https://evil.example/a.gz' }] })); assert.throws(() => renovar(op2, new Date('2027-02-03T00:00:00Z'), pem), /inválido/) // o publicado não é tocado por pacote inválido
  fs.writeFileSync(arqPacotes, '{"x":1}'); assert.throws(() => renovar(op2, new Date('2027-02-03T00:00:00Z'), pem), /precisa ter/)
  const chavesDuas = JSON.parse(ler(pub)); chavesDuas.chaves.push({ id: 'pacote-teste', publica: chavesDuas.chaves[0].publica, uso: 'pacote' }); const pubDuas = path.join(raiz, 'duas.json'); fs.writeFileSync(pubDuas, JSON.stringify(chavesDuas)); fs.writeFileSync(arqPacotes, JSON.stringify({ pacotes: [] }))
  renovar({ ...op2, chave: pubDuas }, new Date('2027-02-04T00:00:00Z'), pem); assert.equal(JSON.parse(Buffer.from(JSON.parse(ler(saida2)).manifesto, 'base64')).serial, 202702040000); assert.equal(JSON.parse(ler(saida2)).chave, '2026-10') // assinou com a chave do manifesto, não com a última da lista (a dos pacotes)
  console.log('ok - renovar: serial por data, validade de 120 dias, nunca recua, recusa chave errada e fonte inválida sem tocar no publicado, e não deixa a privada em disco')
} finally { fs.rmSync(raiz, { recursive: true, force: true }) }
