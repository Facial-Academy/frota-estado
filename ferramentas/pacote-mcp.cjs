// pacote-mcp.cjs — o "pacote de MCPs" do cliente de convergência: faz ESTA máquina ficar na versão dos MCPs locais (helper do Nexo e Google Drive) que o manifesto assinado
// manda, sem campanha manual. Roda como a pessoa, dentro do converge.cjs (mesma trava, mesmo relógio), depois dos módulos de configuração.
//
// ⛔ O QUE ESTE MÓDULO MUDA NO PACTO DO CLIENTE: até aqui "o manifesto não manda executar nada". O pacote traz código que roda como a pessoa (o atualizar-mcps.mjs e os próprios
// MCPs). Por isso o pacote tem assinatura PRÓPRIA, de uma chave que NÃO é a do manifesto (a do manifesto está no CI do repositório público frota-estado; a dos pacotes só no cofre
// de quem publica): sem a assinatura dos pacotes, nem quem controla o frota-estado consegue mandar código. A assinatura cobre id, seq, url, sha256, bytes e manifestoSha256; o sha256
// prende o ARQUIVO (a hospedagem não precisa ser confiável) e `seq` só cresce (pacote antigo reapresentado é recusado). Só valem os nomes da lista abaixo. Ver README ("Pacote de MCPs").
//
// Passos (cada um confere a posse da trava e a validade do manifesto antes de agir; qualquer falha deixa a máquina como está):
//   1. religa as abas ociosas de uma atualização anterior que ficou com aba ocupada (local, sem rede);
//   2. baixa o pacote (https do frota-estado, timeout, teto de bytes, sem redirecionamento, sem HTML), confere tamanho e sha256 do ARQUIVO contra o manifesto;
//   3. extrai numa pasta nova do estado (só os nomes da lista, base64 estrito, tetos de tamanho), confere o sha256 do pacote/manifesto.json contra o manifesto;
//   4. `atualizar-mcps.mjs sondar` (só lê): tudo igual → JA-INSTALADO, sem tocar em nada; senão `atualizar` (ensaio ao lado, backup, troca, prova, volta automática);
//   5. atualizou algo → religa só as abas OCIOSAS (reconnect-mcp.cjs do kit, --expect: quem já está na versão é pulada); aba ocupada fica pendente para o próximo ciclo.
// Falha de rede = a máquina fica como está. Falha ao instalar ou pacote recusado = nova tentativa só depois de uma espera crescente (1 h, 4 h, 16 h, 24 h) para o MESMO pacote.
// Idempotente. Pausar numa máquina: criar o arquivo `mcp-pacote.pausado` na pasta de estado (ou GF_MCP_PACOTE_OFF=1); voltar a andar: apagá-lo.
'use strict'
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), zlib = require('zlib'), cp = require('child_process')

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/, HEX64 = /^[0-9a-f]{64}$/, MIB = 1024 * 1024
const LIM = { comprimido: 8 * MIB, descomprimido: 24 * MIB, arquivos: 40, arquivo: 4 * MIB }
// os únicos nomes que o pacote pode trazer (sem pasta além das duas dos produtos, sem `..`): é o que o montar-pacote-mcps.mjs gera, menos o que não é das máquinas
const NOME = /^(?:atualizar-mcps\.mjs|pacote\/manifesto\.json|pacote\/(?:leadhero|gdrive)\/[A-Za-z0-9][A-Za-z0-9._-]{0,80})$/
const TEMPO = { rede: 60_000, sondar: 60_000, atualizar: 15 * 60_000, religar: 150_000, orcamento: 20 * 60_000, minimo: 90_000 }
const ESPERAS_H = [1, 4, 16, 24], RELIGAR_TENTATIVAS = 48, RELIGAR_PASSO_ERRO = 8
const ARQ_ESTADO = 'pacote-estado.json', PAUSA = 'mcp-pacote.pausado'
const OCUPADO_MAX = 6, SEM_PACOTE_MAX = 24 // ciclos seguidos com o atualizador ocupado / com o endereço assinado sem baixar antes de virar defeito
const PALAVRAS_RUINS = new Set(['PACOTE-RECUSADO', 'FALHOU', 'ADIADO', 'ERRO']) // o resto (inclusive SEM-PACOTE, OCUPADO) não é defeito: a máquina fica como está e tenta no ciclo seguinte
const CHAVES_MCP = { leadhero: ['nexo-local', 'leadhero-local'], gdrive: ['gdrive'] }

const limpo = s => String(s).replace(/[^\x20-\x7E\u00C0-\u00FF]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100)
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex')
const obj = x => x && typeof x === 'object' && !Array.isArray(x)

function urlValida(s) { // a hospedagem não precisa ser confiável (o sha e a assinatura mandam), mas o endereço fica preso ao padrão exato do publicador
  let u; try { u = new URL(s) } catch (e) { return false }
  return u.href === s && u.protocol === 'https:' && u.hostname === 'raw.githubusercontent.com' && !u.username && !u.password && !u.port && !u.search && !u.hash &&
    /^\/Facial-Academy\/frota-estado\/main\/pacotes\/pacote-frota-[0-9a-f]{8}\.json\.gz$/.test(u.pathname) // só o que o publicador grava, na main
}
function validar(p, rotulo) { // lista de problemas (vazia = válido); a mensagem nunca repete o valor recebido
  if (!obj(p)) return [`${rotulo}: não é um objeto`]
  const r = []
  if (typeof p.id !== 'string' || !ID.test(p.id)) r.push(`${rotulo}: id inválido`)
  if (!Array.isArray(p.alvos) || !p.alvos.length || p.alvos.length > 20 || p.alvos.some(a => a !== '*' && !(typeof a === 'string' && ID.test(a)))) r.push(`${rotulo}: alvos inválidos`) // igual ao dos módulos (converge.cjs)
  if (typeof p.url !== 'string' || !urlValida(p.url)) r.push(`${rotulo}: url fora do repositório do estado desejado`)
  if (typeof p.sha256 !== 'string' || !HEX64.test(p.sha256)) r.push(`${rotulo}: sha256 inválido`)
  if (!Number.isSafeInteger(p.bytes) || p.bytes < 1 || p.bytes > LIM.comprimido) r.push(`${rotulo}: bytes fora de 1..${LIM.comprimido}`)
  if (typeof p.manifestoSha256 !== 'string' || !HEX64.test(p.manifestoSha256)) r.push(`${rotulo}: manifestoSha256 inválido`)
  if (typeof p.versao !== 'string' || !/^[^\x00-\x1F\x7F]{1,120}$/u.test(p.versao)) r.push(`${rotulo}: versão inválida`)
  if (!Number.isSafeInteger(p.seq) || p.seq < 1) r.push(`${rotulo}: seq inválido`)
  if (typeof p.chave !== 'string' || !ID.test(p.chave)) r.push(`${rotulo}: chave inválida`)
  if (typeof p.assinatura !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(p.assinatura)) r.push(`${rotulo}: assinatura inválida`) // Ed25519 = 64 bytes = 88 caracteres base64
  return r
}

// O texto que a chave dos pacotes assina: 8 linhas fixas, cada uma terminada em quebra de linha (o publicador monta o MESMO texto). Só `versao` fica de fora (é texto de log). `alvos` ENTRA: sem isso quem controla só o manifesto alargaria de ["piloto"] para ["*"] e mandaria o código a máquinas que a chave dos pacotes não autorizou.
const payloadPacote = p => Buffer.from(['grupofacial-frota-pacote-v1', `id=${p.id}`, `alvos=${Array.isArray(p.alvos) ? p.alvos.join(',') : ''}`, `seq=${p.seq}`, `url=${p.url}`, `sha256=${p.sha256}`, `bytes=${p.bytes}`, `manifestoSha256=${p.manifestoSha256}`].join('\n') + '\n', 'utf8')
function conferirAssinatura(p, chaves) { // null = confere; senão o motivo (sem repetir o valor recebido)
  const k = chaves && Array.isArray(chaves.chaves) ? chaves.chaves.find(x => x && x.id === p.chave && x.uso === 'pacote') : null
  if (!k) return 'chave dos pacotes desconhecida'
  try { return crypto.verify(null, payloadPacote(p), crypto.createPublicKey({ key: Buffer.from(k.publica, 'base64'), format: 'der', type: 'spki' }), Buffer.from(p.assinatura, 'base64')) ? null : 'assinatura do pacote não confere' } catch (e) { return `chave dos pacotes inválida (${limpo(e.code || e.name)})` }
}

async function baixar(p, ganchos) { // devolve os bytes ou lança com .code; o teto é o tamanho DECLARADO (e assinado) do arquivo
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ganchos.tempoRede || TEMPO.rede)
  try {
    const r = await (ganchos.fetch || fetch)(p.url, { signal: ctl.signal, redirect: 'error', headers: { 'User-Agent': 'grupofacial-converge', Accept: 'application/octet-stream' } })
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { code: `HTTP-${r.status}` })
    if (/html/i.test(String(r.headers.get('content-type') || ''))) throw Object.assign(new Error('resposta HTML (portal de rede?)'), { code: 'HTML' })
    const partes = []; let total = 0
    for await (const parte of r.body) { total += parte.length; if (total > p.bytes) throw Object.assign(new Error('resposta maior que o declarado'), { code: 'GRANDE' }); partes.push(parte) }
    return Buffer.concat(partes)
  } finally { clearTimeout(t) }
}

// gzip(JSON { "<caminho>": "<base64>" }) → arquivos em `destino`. Recusa (Error com .code = 'FORMATO') nome fora da lista, base64 frouxo, tamanho acima do teto e pacote sem o essencial.
function extrair(bytes, destino) {
  const recusa = m => Object.assign(new Error(m), { code: 'FORMATO' })
  let j
  try { j = JSON.parse(zlib.gunzipSync(bytes, { maxOutputLength: LIM.descomprimido }).toString('utf8')) } catch (e) { throw recusa(`pacote ilegível (${limpo(e.code || e.name)})`) }
  if (!obj(j)) throw recusa('pacote não é um objeto de arquivos')
  const nomes = Object.keys(j)
  if (nomes.length < 2 || nomes.length > LIM.arquivos) throw recusa('quantidade de arquivos fora do limite')
  if (!nomes.includes('atualizar-mcps.mjs') || !nomes.includes('pacote/manifesto.json')) throw recusa('o pacote não traz o atualizador e o manifesto')
  const dados = {}, vistos = new Set()
  for (const n of nomes) {
    if (!NOME.test(n)) throw recusa('nome de arquivo fora da lista permitida')
    if (vistos.has(n.toLowerCase())) throw recusa('dois nomes que só diferem em maiúscula/minúscula') // o Windows e o Mac gravariam os dois no mesmo arquivo
    vistos.add(n.toLowerCase())
    const b64 = j[n]
    if (typeof b64 !== 'string' || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length > LIM.arquivo * 2) throw recusa(`conteúdo de ${n} não é base64 válido ou passa do teto`)
    const b = Buffer.from(b64, 'base64')
    if (b.length > LIM.arquivo) throw recusa(`${n} passa do teto de tamanho`)
    dados[n] = b
  }
  const raiz = path.resolve(destino)
  fs.mkdirSync(raiz, { recursive: true, mode: 0o700 })
  for (const [n, b] of Object.entries(dados)) {
    const alvo = path.join(raiz, ...n.split('/'))
    if (!alvo.startsWith(raiz + path.sep)) throw recusa('caminho saiu da pasta do pacote')
    fs.mkdirSync(path.dirname(alvo), { recursive: true, mode: 0o700 })
    fs.writeFileSync(alvo, b, { flag: 'wx', mode: 0o600 }) // 'wx': nunca sobrescreve
  }
  return { pasta: raiz, arquivos: nomes.length }
}

function executarPadrao(exe, args, { timeout, env, cwd }) {
  const r = cp.spawnSync(exe, args, { env, cwd, timeout, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * MIB, stdio: ['ignore', 'pipe', 'pipe'] })
  return { codigo: r.status, saida: r.stdout || '', erro: (r.stderr || '').slice(-300), estourou: !!(r.error && r.error.code === 'ETIMEDOUT'), spawnFalhou: r.error && r.error.code !== 'ETIMEDOUT' ? limpo(r.error.code || r.error.message) : null }
}
const ultimoJson = txt => { for (const l of String(txt).split('\n').map(x => x.trim()).reverse()) if (l.startsWith('{')) { try { return JSON.parse(l) } catch (e) { return null } } return null }

function lerEstado(dir, aviso) { // arquivo ausente = vazio; ilegível = recomeça do zero, mas dizendo (não vira silêncio)
  try { const r = JSON.parse(fs.readFileSync(path.join(dir, ARQ_ESTADO), 'utf8')); return obj(r) ? r : {} } catch (e) {
    if (e.code === 'ENOENT') return {}
    aviso(`${ARQ_ESTADO} ilegível (${limpo(e.code || e.name)}); recomeçando do zero`); return {}
  }
}
function gravarEstado(dir, rec) { // temporário na mesma pasta + fsync + rename: nunca um arquivo pela metade
  const arq = path.join(dir, ARQ_ESTADO), tmp = `${arq}.${process.pid}.tmp`, fd = fs.openSync(tmp, 'w')
  try { fs.writeSync(fd, JSON.stringify(rec, null, 2)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  fs.renameSync(tmp, arq)
  if (process.platform !== 'win32') { const d = fs.openSync(dir, 'r'); try { fs.fsyncSync(d) } finally { fs.closeSync(d) } }
}

const lerClaudeJson = home => { try { return JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8').replace(/^\uFEFF/u, '')) } catch (e) { return null } }
const chaveMcp = (cfg, prod) => (CHAVES_MCP[prod] || []).find(k => cfg && obj(cfg.mcpServers) && cfg.mcpServers[k]) || null
const kitCandidatos = home => process.platform === 'win32'
  ? ['C:/ProgramData/claude-code-vscode-kit/scripts/reconnect-mcp.cjs', path.join(home, 'claude-code-vscode-kit', 'scripts', 'reconnect-mcp.cjs')]
  : [path.join(home, 'claude-code-vscode-kit', 'scripts', 'reconnect-mcp.cjs')]

// Aplica UM pacote. ctx = { dir, agora(), log(palavra, detalhe), parar() → motivo | null, chaves, inicio?, ganchos }. Devolve { palavra, detalhe? }; nunca lança.
// `inicio` = quando começou a fase dos pacotes do ciclo (o orçamento de 20 min é um só para todos os pacotes); sem ele vale o início deste.
async function aplicar(p, ctx) {
  const { dir, log, ganchos = {} } = ctx, agora = ctx.agora, home = ganchos.home || os.homedir(), node = ganchos.node || process.execPath
  const exec = ganchos.executar || executarPadrao, env = { ...process.env, ...(ganchos.env || {}) }
  const inicio = ctx.inicio !== undefined ? ctx.inicio : agora(), restante = () => TEMPO.orcamento - (agora() - inicio), inicioReal = Date.now()
  const rodar = (exe, args, teto) => exec(exe, args, { timeout: teto, env, cwd: dir }) // quem chama confere o orçamento ANTES: nenhum processo é morto por falta de tempo do ciclo
  const fim = (palavra, detalhe) => { log(`PACOTE ${p.id} ${palavra}`, detalhe); return { palavra, detalhe } }
  const iso = ms => new Date(ms).toISOString()
  let pasta = null
  try {
    if (process.env.GF_MCP_PACOTE_OFF === '1' || fs.existsSync(path.join(dir, PAUSA))) return fim('PAUSADO', `apague ${PAUSA} para voltar`)
    const todos = lerEstado(dir, a => log(`AVISO ${a}`)), meu = obj(todos[p.id]) ? todos[p.id] : {}
    const guardar = campos => { todos[p.id] = { ...meu, ...campos }; gravarEstado(dir, todos); Object.assign(meu, todos[p.id]) }
    const cfg0 = lerClaudeJson(home)
    if (!cfg0) return fim('SEM-CLAUDE', 'sem ~/.claude.json legível: nada a atualizar')
    await religarPendentes(p.id, meu, guardar, { ...ctx, home, node, rodar, restante })
    if (meu.contaSha !== p.sha256) guardar({ ocupado: 0, semPacote: 0, contaSha: p.sha256 }) // os contadores de ocupado/sem-pacote são deste pacote: o pacote novo começa do zero (a espera crescente já é por sha256)
    const bloqueio = () => ctx.parar() || (restante() < TEMPO.minimo ? 'SEM-TEMPO' : null), parada = m => (m === 'SEM-TEMPO' ? 'SEM-TEMPO' : 'INTERROMPIDO') // INTERROMPIDO = perdi a trava ou o manifesto venceu no meio: o converge.cjs trata
    // espera crescente depois de falha com ESTE pacote (outro pacote = outra chance na hora)
    const falhar = (resultado, detalhe, extra = {}) => {
      const falhas = (meu.sha256 === p.sha256 ? meu.falhas || 0 : 0) + 1
      guardar({ sha256: p.sha256, resultado, quando: iso(agora()), falhas, ocupado: 0, semPacote: 0, proxima: iso(agora() + ESPERAS_H[Math.min(falhas, ESPERAS_H.length) - 1] * 3600e3), ...extra })
      return fim(resultado, detalhe)
    }
    const deu = (resultado, extra = {}) => guardar({ sha256: p.sha256, seq: p.seq, seqSha256: p.sha256, resultado, quando: iso(agora()), falhas: 0, proxima: null, ocupado: 0, semPacote: 0, ...extra })
    if (meu.sha256 === p.sha256 && meu.proxima && Date.parse(meu.proxima) > agora()) return fim('ADIADO', `${meu.resultado || 'falha'} ${meu.falhas || 1}x; nova tentativa depois de ${meu.proxima}`)
    // a assinatura e o seq valem ANTES de qualquer download: pacote que a chave dos pacotes não assinou, ou mais velho que o já aplicado, nem é baixado
    const motivo = conferirAssinatura(p, ctx.chaves)
    if (motivo) return falhar('PACOTE-RECUSADO', motivo)
    if (Number.isSafeInteger(meu.seq) && p.seq < meu.seq) return falhar('PACOTE-RECUSADO', 'seq menor que o já aplicado (pacote antigo reapresentado)')
    if (Number.isSafeInteger(meu.seq) && p.seq === meu.seq && meu.seqSha256 && p.sha256 !== meu.seqSha256) return falhar('PACOTE-RECUSADO', 'o mesmo seq com outro conteúdo (o seq tem de avançar a cada pacote)')
    let m = bloqueio(); if (m) return fim(parada(m), m)
    let bytes
    try { bytes = await baixar(p, ganchos) } catch (e) {
      const semPacote = (meu.semPacote || 0) + 1; guardar({ semPacote }) // rede ruim passa; o endereço assinado que não responde há dias (erro de quem publicou) vira defeito
      return semPacote >= SEM_PACOTE_MAX ? falhar('FALHOU', `o pacote não baixa há ${semPacote} ciclos seguidos (${limpo(e.code || (e.cause && e.cause.code) || e.name)})`, { semPacote }) : fim('SEM-PACOTE', limpo(e.code || (e.cause && e.cause.code) || e.name))
    }
    if (bytes.length !== p.bytes) return falhar('PACOTE-RECUSADO', 'tamanho diferente do declarado')
    if (sha256(bytes) !== p.sha256) return falhar('PACOTE-RECUSADO', 'sha256 diferente do declarado')
    if ((m = bloqueio())) return fim(parada(m), m)
    fs.mkdirSync(path.join(dir, 'pacote-tmp'), { recursive: true, mode: 0o700 })
    pasta = path.join(dir, 'pacote-tmp', `${p.id}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`)
    try { extrair(bytes, pasta) } catch (e) { if (e.code === 'FORMATO') return falhar('PACOTE-RECUSADO', limpo(e.message)); throw e }
    const manifesto = path.join(pasta, 'pacote', 'manifesto.json')
    if (sha256(fs.readFileSync(manifesto)) !== p.manifestoSha256) return falhar('PACOTE-RECUSADO', 'manifesto do pacote diferente do declarado')
    let man; try { man = JSON.parse(fs.readFileSync(manifesto, 'utf8')) } catch (e) { return falhar('PACOTE-RECUSADO', 'manifesto do pacote ilegível') }
    const atualizador = path.join(pasta, 'atualizar-mcps.mjs'), pacoteDir = path.join(pasta, 'pacote')
    if ((m = bloqueio())) return fim(parada(m), m)

    const so = rodar(node, [atualizador, 'sondar', pacoteDir], TEMPO.sondar), sonda = ultimoJson(so.saida)
    if (so.codigo !== 0 || !sonda || !obj(sonda.produtos)) return falhar('ERRO', `sondar falhou (${so.estourou ? 'estourou o tempo' : so.spawnFalhou || `código ${so.codigo}`})`)
    const configurados = Object.entries(sonda.produtos).filter(([prod, v]) => obj(v) && v.configurado && CHAVES_MCP[prod])
    if (!configurados.length) { deu('NAO-CONFIGURADO', { religar: [] }); return fim('NAO-CONFIGURADO', 'nenhum MCP do pacote está configurado nesta máquina') }
    if (configurados.every(([, v]) => v.iguais === true)) { deu('JA-INSTALADO'); return fim('JA-INSTALADO', configurados.map(([k]) => k).join(' ')) } // só `iguais: true` prova; ausente ou outra coisa vai para o atualizador, que decide
    m = bloqueio(); if (!m && restante() < TEMPO.atualizar + 60_000) m = 'SEM-TEMPO' // atualizador morto no meio da troca não volta sozinho: só começa com o prazo inteiro dele
    if (m) return fim(parada(m), m)

    const at = rodar(node, [atualizador, 'atualizar', pacoteDir, p.manifestoSha256], TEMPO.atualizar), rel = ultimoJson(at.saida)
    if (at.codigo === 3) {
      const ocupado = (meu.ocupado || 0) + 1; guardar({ ocupado })
      return ocupado >= OCUPADO_MAX ? falhar('FALHOU', `atualizador ocupado há ${ocupado} ciclos seguidos (trava velha de uma atualização que morreu?)`, { ocupado }) : fim('OCUPADO', 'outra atualização de MCP está rodando neste perfil')
    }
    const estados = rel && obj(rel.produtos) ? Object.entries(rel.produtos).map(([prod, v]) => [prod, obj(v) ? String(v.estado || '?') : '?', obj(v) ? limpo(v.motivo || '') : '']) : []
    const resumo = estados.map(([k, s]) => `${k}=${s}`).join(' '), bons = ['OK', 'JA_INSTALADO', 'NAO_CONFIGURADO']
    const mudou = estados.filter(([, s]) => s === 'OK').map(([k]) => k)
    const religar = () => { const cfgDepois = lerClaudeJson(home), mp = prod => (obj(man.produtos) && obj(man.produtos[prod]) ? man.produtos[prod] : null); return mudou.map(prod => ({ prod, mcp: chaveMcp(cfgDepois, prod), expect: mp(prod) ? `${mp(prod).versao}+${mp(prod).build}` : null, tentativas: 0 })).filter(x => x.mcp && x.expect) }
    if (at.estourou) { // o atualizador foi morto: pode ter parado no meio da troca; devolve os backups feitos nesta execução (a volta que ele mesmo sabe fazer)
      return falhar('FALHOU', `o atualizador estourou o tempo; ${reverterDesde(home, inicioReal, atualizador, node, rodar)}`)
    }
    if (!rel || at.codigo !== 0 || !estados.length || estados.some(([, s]) => !bons.includes(s))) {
      const ruim = estados.find(([, s]) => !bons.includes(s))
      return falhar('FALHOU', `${resumo || at.spawnFalhou || `código ${at.codigo}`}${ruim && ruim[2] ? ` — ${ruim[2]}` : ''}`, { religar: juntarReligar(meu.religar, religar()) }) // o que trocou (OK) e ficou provado ainda precisa religar as abas
    }
    deu(mudou.length ? 'ATUALIZADO' : 'JA-INSTALADO', mudou.length ? { religar: juntarReligar(meu.religar, religar()) } : {})
    if (mudou.length) await religarPendentes(p.id, meu, guardar, { ...ctx, home, node, rodar, restante })
    return fim(mudou.length ? 'ATUALIZADO' : 'JA-INSTALADO', resumo)
  } catch (e) {
    return fim('ERRO', limpo(e.code || e.message))
  } finally {
    if (pasta) { try { fs.rmSync(pasta, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch (e) { log(`AVISO não apaguei ${path.basename(pasta)} (${limpo(e.code || e.name)})`) } }
  }
}

const juntarReligar = (antigos, novos) => { // por MCP: a pendência nova (versão esperada nova) vale; a de outro MCP continua
  const porMcp = new Map((Array.isArray(antigos) ? antigos : []).filter(x => obj(x) && typeof x.mcp === 'string').map(x => [x.mcp, x]))
  for (const n of novos) porMcp.set(n.mcp, n)
  return [...porMcp.values()]
}

// Devolve os backups que o atualizador fez DEPOIS de `desde` (relógio real do disco), por `atualizar-mcps.mjs voltar` (restaura só dentro de ~/.mcp-grupofacial-backups, conferindo sha256).
function reverterDesde(home, desde, atualizador, node, rodar) {
  const raiz = path.join(home, '.mcp-grupofacial-backups'), voltas = []
  try {
    for (const d of fs.readdirSync(raiz)) {
      const dd = path.join(raiz, d)
      if (d.startsWith('.') || !fs.statSync(dd).isDirectory() || fs.statSync(dd).mtimeMs < desde - 2000) continue
      for (const prod of Object.keys(CHAVES_MCP)) if (fs.existsSync(path.join(dd, prod, 'backup.json'))) voltas.push(path.join(dd, prod))
    }
  } catch (e) { return `não consegui listar os backups (${limpo(e.code || e.name)}); conferir à mão` }
  if (!voltas.length) return 'nenhum backup novo a devolver'
  const falhas = voltas.filter(b => rodar(node, [atualizador, 'voltar', b], TEMPO.religar).codigo !== 0)
  return falhas.length ? `${falhas.length} de ${voltas.length} voltas FALHARAM (conferir à mão)` : `${voltas.length} backup(s) devolvido(s)`
}

// Como o resultado do kit vira decisão: ocupada (tenta de novo), erro (conta mais) ou pronto. Sessão que não tem o MCP não é erro: não há o que religar nela.
function classificarReligar(r, expect) {
  const j = ultimoJson(r.saida), itens = j && Array.isArray(j.resultado) ? j.resultado.filter(obj) : null
  if (!itens) return { ocupada: false, erro: true, feitas: 0 }
  const ocupada = itens.some(x => /não ociosa|deixou de estar ociosa/.test(String(x.pulado || '')))
  const certa = x => x.religado === true && x.versaoDepois === expect && x.status === 'connected'
  const erro = itens.some(x => (x.erro && !/não registrado nesta sessão/.test(String(x.erro))) || (x.religado === true && !certa(x)))
  return { ocupada, erro, feitas: itens.filter(certa).length }
}

// Religa SÓ as abas ociosas (reconnect-mcp.cjs do kit; ele nunca mata processo de MCP e pula quem já está na versão esperada). Aba ocupada = pendência para o próximo ciclo.
async function religarPendentes(id, meu, guardar, ctx) {
  const lista = Array.isArray(meu.religar) ? meu.religar : []
  if (!lista.length) return
  const kit = ((ctx.ganchos && ctx.ganchos.kits) || kitCandidatos(ctx.home)).find(k => fs.existsSync(k)) // `kits` só o teste usa (lista que troca a padrão)
  if (!kit) { ctx.log(`PACOTE ${id} RELIGAR-SEM-KIT as abas abertas pegam a versão nova na próxima conversa`); guardar({ religar: [] }); return }
  const restantes = []
  for (const it of lista) {
    if (!obj(it) || !/^[a-z0-9_-]{1,40}$/.test(String(it.mcp)) || !/^[0-9a-z.+-]{1,60}$/.test(String(it.expect))) continue
    if (ctx.parar() || ctx.restante() < TEMPO.religar + 30_000) { restantes.push(it); continue } // sem tempo para o pior caso do kit: fica para o próximo ciclo, nunca é morto no meio
    const r = ctx.rodar(ctx.node, [kit, '--mcp', it.mcp, '--expect', it.expect], TEMPO.religar), { ocupada, erro, feitas } = classificarReligar(r, it.expect)
    const tentativas = (Number(it.tentativas) || 0) + (erro ? RELIGAR_PASSO_ERRO : 1)
    if (!ocupada && !erro) { ctx.log(`PACOTE ${id} RELIGADO ${it.mcp} ${feitas} aba(s)`); continue }
    if (tentativas >= RELIGAR_TENTATIVAS) { ctx.log(`PACOTE ${id} RELIGAR-DESISTIU ${it.mcp} (${erro ? 'erro do kit' : 'aba sempre ocupada'}); a aba pega a versão na próxima conversa`); continue }
    ctx.log(`PACOTE ${id} RELIGAR-PENDENTE ${it.mcp} ${erro ? 'erro do kit' : 'aba ocupada'}`); restantes.push({ ...it, tentativas })
  }
  guardar({ religar: restantes })
}

module.exports = { validar, aplicar, extrair, urlValida, payloadPacote, conferirAssinatura, PALAVRAS_RUINS, LIM, NOME, ARQ_ESTADO, PAUSA }
