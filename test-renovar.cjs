// Teste do renovar.cjs com uma chave descartável (a de produção nunca aparece aqui). Uso: node test-renovar.cjs
const assert = require('node:assert/strict'), fs = require('fs'), os = require('os'), path = require('path')
const { gerarChave } = require('./ferramentas/assinar-manifesto.cjs'), { abrirEnvelope } = require('./ferramentas/converge.cjs'), { renovar, carimbo } = require('./renovar.cjs')
const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-')), ler = f => fs.readFileSync(f, 'utf8')
try {
  gerarChave(path.join(raiz, 'k'), '2026-10'); const pem = ler(path.join(raiz, 'k', 'privada.pem')), pub = path.join(raiz, 'k', 'chave-publica.json')
  const fonte = path.join(raiz, 'modulos.json'), saida = path.join(raiz, 'estado.json'), modulosReais = ler(path.join(__dirname, 'fonte', 'modulos.json')); fs.writeFileSync(fonte, modulosReais)
  const op = { fonte, saida, chave: pub }, t1 = new Date('2026-10-22T17:30:00Z')
  const r = renovar(op, t1, pem); assert.deepEqual([r.serial, r.modulos], [202610221730, 1])
  const aberto = abrirEnvelope(ler(saida), JSON.parse(ler(pub))); assert.equal(aberto.manifesto.serial, 202610221730); assert.equal(aberto.manifesto.expira, '2027-02-19T17:30:00.000Z')
  assert.throws(() => renovar(op, t1, pem), /não é maior/); assert.throws(() => renovar(op, new Date('2026-10-22T17:29:00Z'), pem), /não é maior/)
  assert.equal(renovar(op, new Date('2026-10-29T09:17:00Z'), pem).serial, 202610290917)
  assert.throws(() => renovar(op, new Date('2027-01-01T00:00:00Z'), ''), /FROTA_CHAVE_PRIVADA/); assert.throws(() => renovar(op, new Date('2027-01-01T00:00:00Z'), 'texto'), /FROTA_CHAVE_PRIVADA/)
  fs.writeFileSync(fonte, JSON.stringify({ modulos: [{ id: 'x', tipo: 'comando', alvos: ['*'], chave: 'claudeCode.a', valor: 1 }] }))
  assert.throws(() => renovar(op, new Date('2027-01-01T00:00:00Z'), pem), /inválido/); assert.equal(abrirEnvelope(ler(saida), JSON.parse(ler(pub))).manifesto.serial, 202610290917) // o publicado não foi tocado
  gerarChave(path.join(raiz, 'k2'), '2026-10'); fs.writeFileSync(fonte, modulosReais)
  assert.throws(() => renovar(op, new Date('2027-01-02T00:00:00Z'), ler(path.join(raiz, 'k2', 'privada.pem'))), /não confere|ASSINATURA/) // chave que não é a da publicada não publica
  assert.equal(carimbo(new Date('2026-01-02T03:04:05Z')), '202601020304'); assert.ok(!fs.readdirSync(os.tmpdir()).some(d => d.startsWith('frota-') && fs.existsSync(path.join(os.tmpdir(), d, 'privada.pem'))))
  console.log('ok - renovar: serial por data, validade de 120 dias, nunca recua, recusa chave errada e fonte inválida sem tocar no publicado, e não deixa a privada em disco')
} finally { fs.rmSync(raiz, { recursive: true, force: true }) }
