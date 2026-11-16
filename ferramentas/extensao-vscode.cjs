// extensao-vscode.cjs — a "versão da extensão" do cliente de convergência: faz ESTA máquina ficar na versão da extensão `anthropic.claude-code` do VS Code (ela embute o Claude Code:
// o número da extensão é o número do Claude Code) que o manifesto assinado manda, pelo MESMO trilho do pacote de MCPs (campo de topo `versoes`, assinatura da chave dos pacotes,
// mesma trava, mesmo relógio e mesma espera crescente), sem uma segunda tarefa agendada. Roda como a pessoa, dentro do converge.cjs, depois do pacote de MCPs.
//
// ⛔ Decisões do ensaio da VM (16/11/2026; docs/FLUXO-GITHUB-MAQUINAS.md, seção 5) que este módulo segue:
//   • Instala por `code --install-extension anthropic.claude-code@X` (o VS Code baixa e verifica a assinatura do Marketplace), NUNCA por arquivo .vsix (reinstala sempre e apaga o remendo).
//     O Marketplace não publica hash: o manifesto assinado traz o sha256 de `extension.js` e do binário `claude`, medidos uma vez pelo operador, e a pasta instalada é conferida contra eles ANTES do remendo.
//   • Só age com o VS Code da pessoa FECHADO (nenhum `Code.exe --type=renderer` dela). Nunca fecha nem recarrega janela, nunca interrompe turno: com o VS Code aberto é ADIADO-VSCODE-ABERTO (não é erro; o estado guarda desde quando).
//   • Nada se remenda sozinho: depois de instalar o cliente roda o remendo do kit (compact-inject-patch.cjs) e CONFERE (`--status`); a prova é o `extensions.json` (pasta ativa) + o `claude.exe --version`.
//   • "Já está na versão" (JA-NA-VERSAO) também é CONFERIDO a cada ciclo, só de leitura: sha256 do extension.js e do binário contra o manifesto, `claude.exe --version` e o --status do kit. Versão certa com arquivo divergente = FALHOU (nada que o
//     cliente conserte sozinho); versão certa sem o remendo = remenda (só com o VS Code fechado). Nunca "já está" sem ter olhado.
//   • Conferência falhou (ou a execução morreu no meio, marcador `trocando`) → VOLTA para a versão que a máquina tinha (`@Y`, sem --force, sem .vsix) e confere de novo; a mesma versão só é tentada de novo depois de 1 h, 4 h, 16 h, 24 h.
//   • Só o Windows x64 foi ensaiado. Mac e Windows ARM64 respondem SISTEMA-NAO-ENSAIADO e não tocam em nada, até alguém ensaiar e escrever o caminho de lá.
//   • A faixa testada [min, max] é assinada junto com a versão desejada: o cliente nunca instala versão fora dela (entrada incoerente = FORA-DA-FAIXA).
//   • O que o hash prova, e o que não prova. Prova que o que ENTROU PELA REDE (Marketplace, CDN, manifesto) é a versão testada: `extension.js` limpo e binário, medidos pelo operador e assinados. Numa pasta já remendada o `extension.js`
//     ativo é, por construção, diferente do limpo: vale a cópia limpa `.orig-<versão>` que o kit guarda (ela passa nos hashes) e o `--status` do kit diz que o remendo está aplicado. O conteúdo do `extension.js` remendado em si é do kit:
//     alteração LOCAL dele por quem já escreve na pasta do perfil da pessoa está fora do modelo de ameaça (esse alguém já executa código como a pessoa; o cliente roda como ela e confia no disco dela).
//   • Risco residual ACEITO e medido: entre a consulta "o VS Code está fechado?" e o início do processo que escreve passam milissegundos, e o Windows não tem trava para isso. O ensaio mediu o efeito de instalar com o VS Code
//     aberto: o extension host NÃO reinicia (mesmos pids) e a janela segue com o código antigo na memória (sem corte de turno). Por isso a consulta se repete antes de CADA etapa que escreve (instalar, remendar, voltar) e,
//     depois da troca, uma pós-checagem registra `abriuDuranteTroca` (estado e texto) para quem for reabrir.
//   • Uma troca que caiu no meio (marcador `trocando` no estado local) é desfeita por `recuperar()` ANTES das entradas e MESMO sem entrada no manifesto: o marcador e a versão de volta nunca vêm do manifesto.
// Idempotente. Pausar numa máquina: criar `extensao.pausada` na pasta de estado (ou GF_EXTENSAO_OFF=1); voltar a andar: apagá-lo.
'use strict'
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto')
const Pacote = require('./pacote-mcp.cjs')
const { limpo, ESPERAS_H } = Pacote

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/, HEX64 = /^[0-9a-f]{64}$/, VERSAO = /^\d{1,4}\.\d{1,4}\.\d{1,5}$/, MIB = 1024 * 1024
const EXTENSAO = 'anthropic.claude-code', EXTENSOES = [EXTENSAO] // lista fechada: o manifesto não escolhe a extensão
const PLATAFORMA = /^[a-z0-9]{3,8}-[a-z0-9]{2,8}$/, PASTA = /^anthropic\.claude-code-\d{1,4}\.\d{1,4}\.\d{1,5}(?:-[a-z0-9_]{2,16}-[a-z0-9_]{2,16})?$/
const ARQ_HASH = { 'extension.js': 'extension.js', 'claude.exe': 'resources/native-binary/claude.exe' } // o que se confere na pasta instalada (relativo a ela); o binário do Mac (`claude`) entra quando alguém ensaiar o Mac
const ARQ_ESTADO = 'extensao-estado.json', PAUSA = 'extensao.pausada'
const TEMPO = { instalar: 240_000, remendo: 60_000, versao: 20_000, powershell: 30_000, hash: 60_000, orcamento: 38 * 60_000, troca: 16 * 60_000, volta: 8 * 60_000, conferencia: 5 * 60_000 }
// O Agendador mata o cliente em 40 min e o pacote de MCPs pode gastar 20. `orcamento` é contado desde o INÍCIO do ciclo (converge.cjs passa `inicio`), então só começa o que cabe: a troca com 16 min livres (pior caso, todos os tetos estourando:
// consulta 30 s × 2 + instalar 240 s + hashes 2 × 60 s + --version 20 s + remendo 60 s + --status 20 s = ~8,5 min; a volta: consulta 30 s + instalar 240 s + --version 20 s + remendo 60 s + --status 20 s = ~6,2 min; pós-checagem 30 s),
// a volta de uma troca caída com 8 min e a conferência do "já está" com 5.
const PALAVRAS_RUINS = new Set(['VERSAO-RECUSADA', 'FORA-DA-FAIXA', 'FALHOU', 'VOLTOU', 'VOLTA-FALHOU', 'ADIADO', 'ERRO']) // o resto (ADIADO-VSCODE-ABERTO, SEM-EXTENSAO, SISTEMA-NAO-ENSAIADO…) não é defeito: a máquina fica como está
const CAMINHO_SEGURO = /^[A-Za-z]:\\[\p{L}\p{N}._\\ ()-]+$/u // vai entre aspas na linha do cmd.exe: sem aspa, &, %, ^, | nem < >

const obj = x => x && typeof x === 'object' && !Array.isArray(x)
class Parou extends Error { constructor(ab, motivo) { super('troca interrompida antes de uma etapa que escreve'); this.ab = ab; this.motivo = motivo } } // antes de uma etapa que ESCREVE (instalar, remendar): o VS Code abriu (`ab`) ou a trava/o manifesto se perdeu (`motivo`); a etapa nem começa
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex')
const partes = s => s.split('.').map(Number)
const comparar = (a, b) => { const x = partes(a), y = partes(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0 }
const dentroDaFaixa = (versao, faixa) => comparar(faixa[0], versao) <= 0 && comparar(versao, faixa[1]) <= 0

function validar(v, rotulo, estrito = false) { // lista de problemas (vazia = válido); a mensagem nunca repete o valor recebido. `estrito` (assinador do operador): confere também a coerência versão × faixa
  if (!obj(v)) return [`${rotulo}: não é um objeto`]
  const r = []
  if (typeof v.id !== 'string' || !ID.test(v.id)) r.push(`${rotulo}: id inválido`)
  if (!EXTENSOES.includes(v.extensao)) r.push(`${rotulo}: extensão fora da lista permitida`)
  if (typeof v.versao !== 'string' || !VERSAO.test(v.versao)) r.push(`${rotulo}: versão inválida`)
  const faixaOk = Array.isArray(v.faixa) && v.faixa.length === 2 && v.faixa.every(x => typeof x === 'string' && VERSAO.test(x))
  if (!faixaOk) r.push(`${rotulo}: faixa inválida`); else if (comparar(v.faixa[0], v.faixa[1]) > 0) r.push(`${rotulo}: faixa invertida`)
  if (!Array.isArray(v.alvos) || !v.alvos.length || v.alvos.length > 20 || v.alvos.some(a => a !== '*' && !(typeof a === 'string' && ID.test(a)))) r.push(`${rotulo}: alvos inválidos`) // igual ao dos módulos (converge.cjs)
  if (!obj(v.hashes) || !Object.keys(v.hashes).length || Object.keys(v.hashes).length > 8) r.push(`${rotulo}: hashes inválidos`)
  else for (const [plat, h] of Object.entries(v.hashes)) {
    const nomes = obj(h) ? Object.keys(h) : [], binario = plat.startsWith('win32-') ? 'claude.exe' : 'claude'
    if (!PLATAFORMA.test(plat) || nomes.length !== 2 || !nomes.includes('extension.js') || !nomes.includes(binario) || nomes.some(n => !HEX64.test(h[n]))) r.push(`${rotulo}: hashes da plataforma inválidos`) // uma plataforma por chave; cada uma com `extension.js` e o binário daquele sistema, sha256 em hexadecimal
  }
  if (!Number.isSafeInteger(v.seq) || v.seq < 1) r.push(`${rotulo}: seq inválido`)
  if (typeof v.chave !== 'string' || !ID.test(v.chave)) r.push(`${rotulo}: chave inválida`)
  if (typeof v.assinatura !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(v.assinatura)) r.push(`${rotulo}: assinatura inválida`) // Ed25519 = 64 bytes = 88 caracteres base64
  if (estrito && !r.length && !dentroDaFaixa(v.versao, v.faixa)) r.push(`${rotulo}: versão desejada fora da faixa testada`)
  return r
}

// O texto que a chave dos pacotes assina: uma linha por campo, cada uma terminada em quebra de linha, com os hashes em ordem (plataforma, arquivo). Primeira linha própria: a assinatura de um pacote nunca vale como versão
// (nem o contrário). Tudo entra: sem `faixa`, `alvos` e `hashes` quem controla só o manifesto alargaria o alcance ou trocaria a prova de que a pasta instalada é a testada.
const payloadVersao = v => Buffer.from(['grupofacial-frota-versao-v1', `id=${v.id}`, `extensao=${v.extensao}`, `versao=${v.versao}`, `faixa=${Array.isArray(v.faixa) ? v.faixa.join(',') : ''}`, `alvos=${Array.isArray(v.alvos) ? v.alvos.join(',') : ''}`, `seq=${v.seq}`,
  ...Object.keys(obj(v.hashes) ? v.hashes : {}).sort().flatMap(p => Object.keys(v.hashes[p]).sort().map(a => `hash.${p}.${a}=${v.hashes[p][a]}`))].join('\n') + '\n', 'utf8')
const conferirAssinatura = (v, chaves) => { const m = Pacote.conferirAssinatura(v, chaves, payloadVersao); return m && m.replace('assinatura do pacote', 'assinatura da versão') }

function sha256Arquivo(arq, limiteMs = TEMPO.hash) { // o binário tem ~370 MB: leitura em blocos (nunca o arquivo inteiro na memória) e com teto de tempo (disco lento não segura o ciclo)
  const h = crypto.createHash('sha256'), fd = fs.openSync(arq, 'r'), buf = Buffer.allocUnsafe(MIB), prazo = Date.now() + limiteMs
  try { let n; while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) { if (Date.now() > prazo) throw Object.assign(new Error('hash estourou o tempo'), { code: 'TEMPO' }); h.update(buf.subarray(0, n)) } } finally { fs.closeSync(fd) }
  return h.digest('hex')
}

// A extensão ATIVA é a do `extensions.json` (a pasta de número maior pode ser sobra). null = não registrada; registro ilegível ou fora do formato sobe como erro (nunca vira "sem extensão" em silêncio).
function lerExtensao(extDir) {
  const falha = m => Object.assign(new Error(m), { code: 'EXTENSIONS-JSON' })
  let lista; try { lista = JSON.parse(fs.readFileSync(path.join(extDir, 'extensions.json'), 'utf8')) } catch (e) { if (e.code === 'ENOENT') return null; throw falha('extensions.json ilegível') }
  if (!Array.isArray(lista)) throw falha('extensions.json fora do formato')
  const dela = lista.filter(x => obj(x) && obj(x.identifier) && String(x.identifier.id).toLowerCase() === EXTENSAO)
  if (!dela.length) return null
  const boas = dela.filter(x => typeof x.version === 'string' && VERSAO.test(x.version) && typeof x.relativeLocation === 'string' && PASTA.test(x.relativeLocation))
    .map(x => ({ versao: x.version, pasta: x.relativeLocation, ts: obj(x.metadata) && Number.isFinite(x.metadata.installedTimestamp) ? x.metadata.installedTimestamp : 0 }))
  if (!boas.length) throw falha('registro da extensão fora do formato')
  return boas.sort((a, b) => b.ts - a.ts)[0]
}

// Detecção do VS Code aberto (Windows): um `Code.exe --type=renderer` DO DONO desta sessão. Qualquer outro critério dá falso "aberto" (sobram o crashpad-handler e o agente do Swap SSO com a janela fechada) ou
// conta o `Code.exe` de outra conta (sessão 0). O `wmic` não existe no Windows 11 25H2: CIM + GetOwner. Texto fixo (nada do manifesto entra), em -EncodedCommand para não depender de aspas.
const PS_ABERTO = [`$eu = [Security.Principal.WindowsIdentity]::GetCurrent().Name`, `$n = 0`,
  `Get-CimInstance Win32_Process -Filter "Name='Code.exe'" | ForEach-Object { if ($_.CommandLine -and $_.CommandLine -match '--type=renderer') { $o = Invoke-CimMethod -InputObject $_ -MethodName GetOwner; if ("$($o.Domain)\\$($o.User)" -ieq $eu) { $n++ } } }`,
  `"RENDERERS=$n"`].join('\n')
const raizesKit = home => Pacote.kitCandidatos(home).map(k => path.dirname(path.dirname(k))) // o kit mora ao lado do reconnect-mcp.cjs (scripts/ → raiz); o remendo está em hooks/

// Aplica UMA entrada de `versoes`. ctx = { dir, agora(), log(palavra, detalhe), parar() → motivo | null, chaves, inicio?, ganchos }. Devolve { palavra, detalhe? }; nunca lança.
async function aplicar(v, ctx, opc = {}) {
  const { dir, log, ganchos = {} } = ctx, agora = ctx.agora, home = ganchos.home || os.homedir(), node = ganchos.node || process.execPath
  const exec = ganchos.executar || Pacote.executarPadrao, env = {}
  for (const [k, x] of [...Object.entries(process.env), ...Object.entries(ganchos.env || {})]) { for (const antigo of Object.keys(env)) if (antigo.toLowerCase() === k.toLowerCase()) delete env[antigo]; env[k] = x } // no Windows o nome da variável não diferencia maiúscula (ProgramFiles, PROGRAMFILES): o que o gancho define vale sobre o do processo
  const ev = nome => env[Object.keys(env).find(k => k.toLowerCase() === nome.toLowerCase())]
  const inicio = ctx.inicio !== undefined ? ctx.inicio : agora(), restante = () => TEMPO.orcamento - (agora() - inicio)
  const rodar = (exe, args, teto, extra = {}) => exec(exe, args, { timeout: teto, env, cwd: dir, ...extra })
  const sistema = ganchos.sistema || { so: process.platform, arq: process.arch }, plataforma = `${sistema.so}-${sistema.arq}`
  const extDir = ganchos.extensoes || ev('VSCODE_EXTENSIONS') || path.join(home, '.vscode', 'extensions')
  const sistemaRoot = ev('SystemRoot') || 'C:\\Windows'
  const iso = ms => new Date(ms).toISOString()
  const fim = (palavra, detalhe) => { log(`VERSAO ${v.id} ${palavra}`, detalhe); return { palavra, detalhe } }
  try {
    const estrutura = opc.soRecuperar ? [] : validar(v, 'versão'); if (estrutura.length) return fim('VERSAO-RECUSADA', estrutura[0]) // o converge.cjs já confere; quem chamar direto também passa por aqui antes de qualquer arquivo ou processo
    if (ev('GF_EXTENSAO_OFF') === '1' || fs.existsSync(path.join(dir, PAUSA))) return fim('PAUSADO', `apague ${PAUSA} para voltar`)
    if (plataforma !== 'win32-x64') return fim('SISTEMA-NAO-ENSAIADO', `só o Windows x64 foi ensaiado; ${plataforma} não é tocado`)
    const todos = Pacote.lerEstado(dir, a => log(`AVISO ${a}`), ARQ_ESTADO), meu = obj(todos[v.id]) ? todos[v.id] : {}
    const guardar = campos => { todos[v.id] = { ...meu, ...campos }; Pacote.gravarEstado(dir, todos, ARQ_ESTADO); Object.assign(meu, todos[v.id]) }
    const conteudo = sha256(payloadVersao(v))
    const limpar = { trocando: null, adiadoDesde: null, adiadoCiclos: 0, abriuDuranteTroca: null }
    // espera crescente depois de falha com ESTA entrada (entrada nova = chance na hora); o mesmo escalonamento do pacote de MCPs
    const falhar = (resultado, detalhe, extra = {}) => {
      const falhas = (meu.conteudo === conteudo ? meu.falhas || 0 : 0) + 1
      guardar({ conteudo, resultado, quando: iso(agora()), falhas, proxima: iso(agora() + ESPERAS_H[Math.min(falhas, ESPERAS_H.length) - 1] * 3600e3), desejada: v.versao, ...limpar, ...extra })
      return fim(resultado, detalhe)
    }
    const deu = (resultado, extra = {}) => guardar({ conteudo, seq: v.seq, resultado, quando: iso(agora()), falhas: 0, proxima: null, desejada: v.versao, ...limpar, ...extra })
    const aberto = () => {
      const r = rodar(path.join(sistemaRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(PS_ABERTO, 'utf16le').toString('base64')], TEMPO.powershell), m = /RENDERERS=(\d+)/.exec(r.saida || '')
      return r.codigo === 0 && m ? { n: Number(m[1]) } : { erro: `não consegui verificar se o VS Code está aberto (${r.estourou ? 'estourou o tempo' : r.spawnFalhou || `código ${r.codigo}`})` }
    }
    const abriuDepois = () => { const ab = aberto(); return !ab.erro && ab.n > 0 } // depois da troca: a janela que abriu no meio (a consulta e o processo que escreve não são atômicos) fica registrada
    const AVISO_ABRIU = ' (o VS Code abriu durante a troca: janela aberta desde então pode seguir na versão antiga na memória até reabrir)'
    const fechado = () => { // a conferência do início vale por segundos e a troca dura minutos: cada etapa que escreve confere de novo que ainda somos o dono da trava, que o manifesto não venceu e que o VS Code segue fechado
      const motivo = ctx.parar(); if (motivo) throw new Parou(null, motivo)
      const ab = aberto(); if (ab.erro || ab.n) throw new Parou(ab, null)
    }
    const deixa = (e, ext, foraDaFaixa, porque) => (e.motivo ? fim('INTERROMPIDO', e.motivo) : adiar(e.ab, ext, foraDaFaixa, porque)) // o que sobrou fica para a próxima execução (marcador `trocando`, estado)
    const adiar = (ab, ext, foraDaFaixa, porque = '') => { // com o VS Code aberto (ou sem como saber) nada é tocado; o estado guarda desde quando, para o inventário mostrar
      guardar({ adiadoDesde: meu.adiadoDesde || iso(agora()), adiadoCiclos: (meu.adiadoCiclos || 0) + 1, instalada: ext.versao, foraDaFaixa, desejada: v.versao })
      return fim('ADIADO-VSCODE-ABERTO', `${ab.erro || `${ab.n} janela(s) do VS Code aberta(s)`}; instalada ${ext.versao}${foraDaFaixa ? ' (fora da faixa testada)' : ''}, desejada ${v.versao}${porque}; adiado desde ${meu.adiadoDesde}, ${meu.adiadoCiclos} ciclo(s)`)
    }
    const acharCode = () => { // null = sem o `code` instalável (Windows: o code.cmd do VS Code por usuário ou por máquina)
      if (ganchos.codeCmd) return fs.existsSync(ganchos.codeCmd) ? ganchos.codeCmd : null
      return [ev('LOCALAPPDATA') && path.join(ev('LOCALAPPDATA'), 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'), ev('ProgramFiles') && path.join(ev('ProgramFiles'), 'Microsoft VS Code', 'bin', 'code.cmd')].find(c => c && CAMINHO_SEGURO.test(c) && fs.existsSync(c)) || null
    }
    const instalar = (cli, versao) => { // a versão vai à linha do cmd.exe: só dígitos e pontos (validada no manifesto; a da volta vem do registro do VS Code ou do estado em disco, então confere de novo aqui)
      if (!VERSAO.test(versao)) return 'versão fora do formato N.N.N'
      fechado()
      const r = rodar(path.join(sistemaRoot, 'System32', 'cmd.exe'), ['/d', '/s', '/c', `""${cli}" --install-extension ${EXTENSAO}@${versao}"`], TEMPO.instalar, { verbatim: true })
      return r.codigo === 0 && !r.estourou && !r.spawnFalhou ? null : `o code saiu com ${r.estourou ? 'estouro de tempo' : r.spawnFalhou || `código ${r.codigo}`}${r.erro ? `: ${limpo(r.erro)}` : ''}`
    }
    const kitScript = () => { // o remendo do kit é o que deixa o reconnect-mcp religar as abas; sem o kit na máquina nunca houve remendo
      const kit = (ganchos.kitsRaiz || raizesKit(home)).find(k => fs.existsSync(path.join(k, 'hooks', 'compact-inject-patch.cjs')))
      return kit ? path.join(kit, 'hooks', 'compact-inject-patch.cjs') : null
    }
    const remendado = script => { const s = rodar(node, [script, '--status'], TEMPO.versao); return s.codigo === 0 && /^STATUS: patcheado \(v\d+ /m.test(s.saida || '') } // só leitura: a pasta ativa está no remendo ATUAL do kit (patcheado de versão antiga não vale)
    const remendar = () => { // null = remendada e conferida (ou sem kit: nunca houve remendo e nada se perde, mas o log e o estado dizem); senão o motivo
      const script = kitScript()
      if (!script) { log(`VERSAO ${v.id} SEM-KIT sem o kit do Claude Code nesta máquina: a extensão fica sem o remendo`); guardar({ semKit: true }); return null }
      fechado()
      const a = rodar(node, [script], TEMPO.remendo)
      if (a.codigo !== 0 || a.estourou) return `o remendo do kit ${a.estourou ? 'estourou o tempo' : `saiu com código ${a.codigo}`}`
      guardar({ semKit: false })
      return remendado(script) ? null : 'o --status do kit não mostra o remendo aplicado'
    }
    const conferirArquivos = (versao, hashes) => { // SÓ LEITURA. null = a pasta ativa É essa versão, inteira; senão o motivo. `hashes` = a prova de que é a testada (o manifesto assinou)
      const e = lerExtensao(extDir)
      if (!e || e.versao !== versao) return `o VS Code registra ${e ? e.versao : 'nenhuma versão'} em vez de ${versao}`
      const pasta = path.join(extDir, e.pasta); if (!fs.existsSync(pasta)) return 'a pasta da versão não existe no disco'
      const binario = 'claude.exe', arq = n => path.join(pasta, ...ARQ_HASH[n].split('/'))
      if (hashes) for (const n of ['extension.js', binario]) {
        const f = n === 'extension.js' && fs.existsSync(`${arq(n)}.orig-${versao}`) ? `${arq(n)}.orig-${versao}` : arq(n) // pasta remendada (pela troca ou deixada no disco por uma tentativa antiga): o original limpo é a cópia `.orig-<versão>` do kit; ver "O que o hash prova" no cabeçalho
        let h; try { h = sha256Arquivo(f) } catch (x) { return `não consegui ler ${n} (${limpo(x.code || x.name)})` }
        if (h !== hashes[n]) return `${n} diferente do que o manifesto assinou (não é a versão testada)`
      }
      const s = rodar(arq(binario), ['--version'], TEMPO.versao)
      if (s.codigo !== 0 || !new RegExp(`^${versao.replace(/\./g, '\\.')}(\\s|$)`).test(String(s.saida || '').trim())) return `o ${binario} --version não responde ${versao}`
      return null
    }
    const conferir = (versao, hashes) => conferirArquivos(versao, hashes) || remendar() // depois de uma troca: arquivos E remendo
    const conferirSeguro = (versao, hashes) => { try { return conferir(versao, hashes) } catch (e) { if (e instanceof Parou) throw e; return `exceção: ${limpo(e.code || e.message)}` } }
    const trocar = (cli, versao, hashes, aposInstalar) => { try { const f = instalar(cli, versao); if (f) return f; if (aposInstalar) aposInstalar(); return conferirSeguro(versao, hashes) } catch (e) { if (e instanceof Parou) throw e; return `exceção: ${limpo(e.code || e.message)}` } }
    const versaoNoDisco = () => { try { const e = lerExtensao(extDir); return e ? e.versao : null } catch (e) { log(`AVISO VERSAO ${v.id} não li o extensions.json (${limpo(e.code || e.name)})`); return null } }
    const voltar = (cli, de) => { // a extensão que a máquina tinha: se a pasta ativa já é ela, só confere; senão `@Y` (a pasta some na 2ª abertura do VS Code: aí baixa de novo)
      try { const e = lerExtensao(extDir); return e && e.versao === de && fs.existsSync(path.join(extDir, e.pasta)) ? conferirSeguro(de, null) : trocar(cli, de, null) } catch (e) { if (e instanceof Parou) throw e; return `exceção: ${limpo(e.code || e.message)}` }
    }

    // Execução anterior morreu no meio de uma troca (o marcador só sai no fim): volta ao que a máquina tinha, nunca fica numa versão sem conferência. Roda por aqui (depois de a entrada ser autêntica)
    // e por `recuperar()` (sem entrada nenhuma: o marcador é do estado local, não do manifesto).
    const recuperarTroca = () => {
      if (restante() < TEMPO.volta) return fim('SEM-TEMPO', 'sem tempo neste ciclo para desfazer a troca que caiu; o marcador espera')
      const e = lerExtensao(extDir), de = String(meu.trocando.de), para = limpo(meu.trocando.para) // o marcador vem do disco: só o `de` vai à linha de comando (e só depois de conferido); o resto é texto de log
      if (!VERSAO.test(de)) return falhar('FALHOU', 'o marcador de troca do estado está fora do formato; apaguei-o (a máquina não foi tocada)')
      if (e && e.versao === de) return falhar('FALHOU', `a execução anterior caiu no meio da troca para ${para}; a máquina segue em ${de}`)
      const ab = aberto(); if (ab.erro || ab.n) return adiar(ab, e || { versao: '?' }, false)
      const cli = acharCode(); if (!cli) return falhar('VOLTA-FALHOU', `a execução anterior caiu no meio da troca para ${para} e não achei o code para voltar a ${de}`)
      let m; try { m = voltar(cli, de) } catch (x) { if (!(x instanceof Parou)) throw x; return deixa(x, { versao: versaoNoDisco() || '?' }, false, ' (o VS Code abriu durante a volta; retomo quando fechar)') } // o marcador segue no estado
      return m ? falhar('VOLTA-FALHOU', `caiu no meio da troca para ${para}; a volta para ${de} não conferiu: ${m}`) : falhar('VOLTOU', `a execução anterior caiu no meio da troca para ${para}; voltei para ${de}`)
    }
    if (opc.soRecuperar) return obj(meu.trocando) ? recuperarTroca() : null

    // 1. AUTENTICIDADE antes de qualquer outra coisa (inclusive da recuperação de uma troca que caiu): entrada que a chave dos pacotes não assinou, ou mais velha que a mais nova JÁ VISTA, não mexe em estado nem em disco.
    // O `seq` é uma marca d'água do que foi visto e assinado (não só do que deu certo): troca que falhou não deixa uma ordem velha voltar a valer. Recusa de entrada falsa não grava nada (ela não pode zerar a espera da verdadeira).
    const motivo = conferirAssinatura(v, ctx.chaves)
    if (motivo) return fim('VERSAO-RECUSADA', motivo)
    const visto = Number.isSafeInteger(meu.seqVisto) ? meu.seqVisto : 0
    if (v.seq < visto) return fim('VERSAO-RECUSADA', 'seq menor que o já visto (entrada antiga reapresentada)')
    if (v.seq === visto && meu.seqVistoConteudo && conteudo !== meu.seqVistoConteudo) return fim('VERSAO-RECUSADA', 'o mesmo seq com outro conteúdo (o seq tem de avançar a cada entrada)')
    if (v.seq !== visto || !meu.seqVistoConteudo) guardar({ seqVisto: v.seq, seqVistoConteudo: conteudo })

    if (obj(meu.trocando)) return recuperarTroca() // a troca caída é desfeita antes de qualquer outra coisa (só depois de a entrada ser autêntica)
    if (meu.conteudo === conteudo && meu.proxima && Date.parse(meu.proxima) > agora()) return fim('ADIADO', `${meu.resultado || 'falha'} ${meu.falhas || 1}x; nova tentativa depois de ${meu.proxima}`)

    // 2. a faixa testada e os hashes desta plataforma
    if (!dentroDaFaixa(v.versao, v.faixa)) return falhar('FORA-DA-FAIXA', `a versão desejada ${v.versao} está fora da faixa testada ${v.faixa[0]} a ${v.faixa[1]}`)
    const hashes = v.hashes[plataforma]; if (!hashes) return falhar('VERSAO-RECUSADA', `a entrada não traz os hashes de ${plataforma}`)

    // 3. a máquina
    const ext = lerExtensao(extDir); if (!ext) return fim('SEM-EXTENSAO', `a extensão ${EXTENSAO} não está registrada neste VS Code: nada a atualizar`)
    const foraDaFaixa = !dentroDaFaixa(ext.versao, v.faixa)
    if (ext.versao === v.versao && restante() < TEMPO.conferencia) return fim('SEM-TEMPO', 'sem tempo neste ciclo para conferir a versão instalada')
    if (ext.versao === v.versao) { // "já está" só depois de olhar: arquivo divergente (ou a volta que falhou e deixou a máquina aqui) não é convergência
      let m; try { m = conferirArquivos(v.versao, hashes) } catch (e) { m = `exceção: ${limpo(e.code || e.message)}` }
      if (m) return falhar('FALHOU', `a ${v.versao} registrada no VS Code não passa na conferência: ${m}`, { instalada: ext.versao, foraDaFaixa: false })
      const script = kitScript()
      if (script && !remendado(script)) { // a versão certa sem o remendo: remenda, mas só com o VS Code fechado
        const ab = aberto(); if (ab.erro || ab.n) return adiar(ab, ext, false, ' (falta o remendo do kit; corrijo quando o VS Code fechar)')
        let r; try { r = remendar() } catch (x) { if (!(x instanceof Parou)) throw x; return deixa(x, ext, false, ' (o VS Code abriu antes do remendo; corrijo quando fechar)') }
        if (r) return falhar('FALHOU', `a ${v.versao} está instalada mas sem o remendo: ${r}`, { instalada: ext.versao, foraDaFaixa: false })
        const abriu = abriuDepois(); deu('ATUALIZADO', { instalada: ext.versao, foraDaFaixa: false, abriuDuranteTroca: abriu ? iso(agora()) : null }); return fim('ATUALIZADO', `${ext.versao} remendada${abriu ? AVISO_ABRIU : ''}`)
      }
      deu('JA-NA-VERSAO', { instalada: ext.versao, foraDaFaixa: false }); return fim('JA-NA-VERSAO', ext.versao)
    }
    if (!kitScript() && fs.existsSync(path.join(extDir, ext.pasta, `extension.js.orig-${ext.versao}`))) return falhar('FALHOU', `a ${ext.versao} está remendada e não achei o kit para remendar a ${v.versao}: trocar deixaria a máquina sem o remendo (e sem como religar as abas); nada foi tocado`, { instalada: ext.versao, foraDaFaixa })
    const ab = aberto(); if (ab.erro || ab.n) return adiar(ab, ext, foraDaFaixa)
    const cli = acharCode(); if (!cli) return falhar('FALHOU', 'não achei o code.cmd do VS Code (nem por usuário nem por máquina)', { instalada: ext.versao, foraDaFaixa })
    const b = ctx.parar() || (restante() < TEMPO.troca ? 'SEM-TEMPO' : null); if (b) return fim(b === 'SEM-TEMPO' ? 'SEM-TEMPO' : 'INTERROMPIDO', b)

    // 4. a troca: o marcador vai ao disco ANTES (queda no meio é desfeita na próxima execução) e dali em diante vai até o fim, conferindo ou voltando
    guardar({ trocando: { de: ext.versao, para: v.versao, desde: iso(agora()) }, anterior: { versao: ext.versao, pasta: ext.pasta, quando: iso(agora()) }, instalada: ext.versao, foraDaFaixa })
    let etapa = 'instalar', falhaTroca
    try { falhaTroca = trocar(cli, v.versao, hashes, () => { etapa = 'instalada' }) } catch (e) {
      if (!(e instanceof Parou)) throw e
      guardar({ trocando: null }) // ou nada foi instalado, ou a instalação já passou na conferência dos arquivos: não há o que desfazer, só falta o remendo, que o "já está" da próxima rodada faz com o VS Code fechado
      return deixa(e, { versao: etapa === 'instalar' ? ext.versao : v.versao }, etapa === 'instalar' ? foraDaFaixa : false, etapa === 'instalar' ? ' (o VS Code abriu antes da troca; nada foi instalado)' : ` (a ${v.versao} foi instalada e conferida, mas o VS Code abriu antes do remendo; remendo quando fechar)`)
    }
    if (!falhaTroca) { const abriu = abriuDepois(); deu('ATUALIZADO', { instalada: v.versao, foraDaFaixa: false, abriuDuranteTroca: abriu ? iso(agora()) : null }); return fim('ATUALIZADO', `${ext.versao} -> ${v.versao}${meu.semKit ? ' (sem o kit nesta máquina: sem remendo)' : ''}${abriu ? AVISO_ABRIU : ''}`) }
    let falhaVolta
    try { falhaVolta = voltar(cli, ext.versao) } catch (e) {
      if (!(e instanceof Parou)) throw e
      guardar({ trocando: { ...meu.trocando, falha: limpo(falhaTroca) } }) // o marcador segue: a próxima rodada, com o VS Code fechado, volta para a versão que a máquina tinha
      return deixa(e, { versao: versaoNoDisco() || v.versao }, false, ` (a troca para ${v.versao} falhou: ${limpo(falhaTroca)}; volto para ${ext.versao} quando o VS Code fechar)`)
    }
    return falhaVolta ? falhar('VOLTA-FALHOU', `${falhaTroca}; e a volta para ${ext.versao} também não conferiu: ${falhaVolta}`) : falhar('VOLTOU', `${falhaTroca}; voltei para ${ext.versao}`, { instalada: ext.versao })
  } catch (e) {
    return fim('ERRO', limpo(e.code || e.message))
  }
}

// Desfaz as trocas que caíram no meio, para todo id que tem marcador `trocando` no estado, MESMO sem entrada no manifesto (entrada removida, máquina fora dos alvos, `versoes` tirado do frota-estado):
// o marcador e a versão de volta vêm do estado local, nunca do manifesto, então quem controla só o manifesto não dispara nada por aqui. Devolve { id: palavra } só dos que tinham marcador.
async function recuperar(ctx) {
  const resultados = {}, todos = Pacote.lerEstado(ctx.dir, a => ctx.log(`AVISO ${a}`), ARQ_ESTADO)
  for (const [id, est] of Object.entries(todos)) {
    if (!ID.test(id) || !obj(est) || !obj(est.trocando)) continue
    const r = await aplicar({ id, versao: typeof est.trocando.para === 'string' && VERSAO.test(est.trocando.para) ? est.trocando.para : '0.0.0' }, ctx, { soRecuperar: true })
    if (r) resultados[id] = r.palavra
  }
  return resultados
}

module.exports = { validar, aplicar, recuperar, sha256Arquivo, payloadVersao, conferirAssinatura, dentroDaFaixa, comparar, lerExtensao, PALAVRAS_RUINS, EXTENSOES, ARQ_ESTADO, PAUSA }
