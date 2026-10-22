// jsonc-config.cjs — define UMA chave de nível 1 num arquivo JSONC (settings.json do VS Code) sem mexer no resto.
// Generalização do ligar-focusview.cjs (que continua como está até o waiter dele terminar): o mesmo desenho de gravação, com chave e valor por parâmetro.
//   aplicarChave(arquivo, chave, valor, ganchos?) → [PALAVRA, código]
//   PALAVRA: APLICADO | JA-OK | SEM-ARQUIVO | FORMATO-INESPERADO | ALTERADO-DURANTE | OCUPADO | CANCELADO | ERRO <motivo>
// `ganchos.aindaValido` (opcional): função de quem chama, conferida logo antes de cada captura; devolveu falso = CANCELADO, nada é tocado.
// `valor` é um escalar JSON (booleano, número, texto). O texto inteiro tem de ser JSONC válido antes e depois (comentário e vírgula final passam;
// falta de vírgula não): arquivo que o VS Code recusaria nunca vira APLICADO nem JA-OK, porque a opção não valeria.
// Gravação: trava ao lado → temporário na mesma pasta com as permissões do original (chmod no POSIX; no Windows copia a DACL: nunca alarga o
// acesso) + fsync → CAPTURA: o arquivo vivo é movido para o backup (rename atômico: leva a versão que estiver lá, gravada no lugar ou trocada
// por rename por outro editor) → se não era a esperada, a pessoa salvou: a versão dela volta ao lugar e a mudança é refeita em cima (até 3
// rodadas) → INSTALA o temporário por hard link (falha em vez de sobrescrever; sem hard link, cópia exclusiva) → fsync da pasta (POSIX) → relê o
// backup: quem já tinha o arquivo aberto e gravou no inode capturado também é refeito; na última rodada a troca é desfeita (a versão dela volta)
// e a saída é ALTERADO-DURANTE. Nenhum caminho usa rename por cima de um arquivo existente.
// Queda (processo morto, falta de energia) em qualquer ponto da troca ou da verificação: um marcador `<arquivo>.converge.recuperar` (JSON atômico com fsync, ANTES da captura e até o fim da
// verificação) diz o que conferir; a próxima execução (dentro da trava) devolve o arquivo da pessoa ou a gravação tardia dela antes de qualquer coisa. Até lá o arquivo pode faltar, por no máximo a distância entre duas convergências.
// Limites declarados: (1) entre a captura e a instalação o arquivo some por microssegundos (o VS Code vê remover e recriar). (2) Um editor que
// mantivesse o arquivo ABERTO e gravasse depois da última releitura do backup não seria visto; o VS Code abre, grava e fecha a cada
// salvamento, e mesmo nesse caso a gravação fica no backup ao lado. (3) Sem hard link um leitor pode ver o arquivo parcial durante a cópia.
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto')
const Trava = require('./trava.cjs')
const RODADAS = 3
const ws = c => c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '﻿'
const SEM_LINK = ['EPERM', 'ENOSYS', 'ENOTSUP', 'EXDEV', 'EMLINK', 'EACCES']

// Percorre o texto uma vez: onde o objeto abre, onde a chave está no nível 1 (e seu valor escalar), e o 1º item significativo depois do `{`.
function varrer(t, chave) {
  let i = 0, prof = 0, abre = -1, achou = null, primeiro = null
  const pular = () => { // pula espaço e comentários a partir de i
    for (;;) {
      while (i < t.length && ws(t[i])) i++
      if (t[i] === '/' && t[i + 1] === '/') { while (i < t.length && t[i] !== '\n') i++; continue }
      if (t[i] === '/' && t[i + 1] === '*') { const f = t.indexOf('*/', i + 2); if (f < 0) throw new Error('comentário sem fim'); i = f + 2; continue }
      return
    }
  }
  while (i < t.length) {
    pular(); if (i >= t.length) break
    const c = t[i]
    if (c === '"') {
      const ini = i; i++
      while (i < t.length && t[i] !== '"') i += t[i] === '\\' ? 2 : 1
      const lit = t.slice(ini + 1, i); i++
      const nome = lit.includes('\\') ? JSON.parse(`"${lit}"`) : lit // a chave escrita com escape é a mesma para o JSON.parse e para o VS Code
      if (prof === 1 && primeiro === null) primeiro = 'chave'
      if (prof === 1) {
        const salvo = i; pular()
        if (t[i] === ':') {
          if (nome === chave) {
            i++; pular()
            const ini2 = i, m = /^(?:"(?:[^"\\\n]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(t.slice(i, i + 4096))
            achou = m ? { ini: ini2, fim: ini2 + m[0].length, valor: JSON.parse(m[0]) } : { ini: ini2, fim: ini2, valor: undefined }
          }
        } else i = salvo
      }
      continue
    }
    if (c === '{' || c === '[') { prof++; if (prof === 1) { if (c !== '{') throw new Error('o arquivo não começa por objeto'); abre = i } else if (prof === 2 && primeiro === null) primeiro = 'valor' }
    else if (c === '}' || c === ']') { if (prof === 1 && primeiro === null) primeiro = 'fim'; prof-- }
    else if (prof === 1 && primeiro === null) primeiro = 'valor'
    i++
  }
  if (prof !== 0 || abre < 0) throw new Error('chaves desbalanceadas')
  return { abre, achou, vazio: primeiro === 'fim' }
}

// JSONC → JSON (sem comentários e sem vírgula antes de } ou ]) só para o JSON.parse validar a sintaxe; o texto gravado nunca passa por aqui.
// A mensagem do JSON.parse cita trechos do arquivo: não sai daqui.
function validarJsonc(t) {
  let o = '', i = 0
  while (i < t.length) {
    const c = t[i]
    if (c === '"') { let j = i + 1; while (j < t.length && t[j] !== '"') j += t[j] === '\\' ? 2 : 1; if (j >= t.length) throw new Error('texto sem aspas de fechamento'); o += t.slice(i, j + 1); i = j + 1 }
    else if (c === '/' && t[i + 1] === '/') { while (i < t.length && t[i] !== '\n') i++ }
    else if (c === '/' && t[i + 1] === '*') { const f = t.indexOf('*/', i + 2); if (f < 0) throw new Error('comentário sem fim'); i = f + 2; o += ' ' }
    else { o += c; i++ }
  }
  let v
  try { v = JSON.parse(o.replace(/^﻿/, '').replace(/,(\s*[}\]])/g, '$1')) } catch (e) { throw new Error('sintaxe inválida (JSONC)') }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('o arquivo não é um objeto')
}

const escalar = v => v === null || ['boolean', 'number', 'string'].includes(typeof v)

// Texto novo a partir de `base`: { fim } quando não há o que gravar, { novo } quando há.
function montar(base, chave, valor) {
  let r; try { validarJsonc(base); r = varrer(base, chave) } catch (e) { return { fim: [`FORMATO-INESPERADO (${e.message})`, 4] } }
  if (r.achou && r.achou.valor === valor) return { fim: ['JA-OK', 0] }
  const literal = JSON.stringify(valor)
  let novo
  if (r.achou) {
    if (!escalar(r.achou.valor) || r.achou.fim === r.achou.ini) return { fim: ['FORMATO-INESPERADO (o valor atual da chave não é um escalar)', 4] }
    novo = base.slice(0, r.achou.ini) + literal + base.slice(r.achou.fim)
  } else {
    const nl = base.includes('\r\n') ? '\r\n' : '\n'
    novo = base.slice(0, r.abre + 1) + `${nl}  ${JSON.stringify(chave)}: ${literal}${r.vazio ? '' : ','}` + base.slice(r.abre + 1)
  }
  try { validarJsonc(novo) } catch (e) { return { fim: [`ERRO o texto novo não é JSONC válido (${e.message}); nada foi gravado`, 5] } }
  const conf = varrer(novo, chave)
  if (!(conf.achou && conf.achou.valor === valor)) return { fim: ['ERRO a conferência do texto novo falhou; nada foi gravado', 5] }
  return { novo }
}

const fsyncPasta = dir => { if (process.platform === 'win32') return; const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) } }

// O temporário nasce com as permissões da PASTA; o original pode ter sido endurecido por arquivo. Falha aqui = não grava.
function copiarPermissoes(origem, destino) {
  if (process.platform !== 'win32') { fs.chmodSync(destino, fs.statSync(origem).mode & 0o7777); return }
  const ps = '$a=Get-Acl -LiteralPath $env:FV_ORIGEM; $n=Get-Acl -LiteralPath $env:FV_DESTINO; $n.SetSecurityDescriptorSddlForm($a.GetSecurityDescriptorSddlForm("Access"),"Access"); Set-Acl -LiteralPath $env:FV_DESTINO -AclObject $n'
  cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { env: { ...process.env, FV_ORIGEM: origem, FV_DESTINO: destino }, windowsHide: true, timeout: 30000, stdio: 'pipe' })
}

// Coloca `origem` em `destino` SEM substituir nada que já esteja lá (EEXIST sobe). Sem hard link: cópia exclusiva (O_EXCL).
function instalar(origem, destino, ganchos) {
  try { (ganchos.link || fs.linkSync)(origem, destino) } catch (e) {
    if (!SEM_LINK.includes(e.code)) throw e
    fs.copyFileSync(origem, destino, fs.constants.COPYFILE_EXCL)
  }
  fs.unlinkSync(origem)
}
// Devolve o arquivo capturado ao lugar. Se alguém já pôs outra versão lá, ela fica e o capturado permanece como backup.
function devolver(bak, arq, ganchos) {
  try { instalar(bak, arq, ganchos) } catch (e) {
    if (e.code === 'EEXIST') return
    try { fs.copyFileSync(bak, arq, fs.constants.COPYFILE_EXCL) } catch (c) { if (c.code !== 'EEXIST') throw c } // última tentativa: a pessoa não pode ficar sem arquivo
  }
}
// Última rodada: tira a nossa versão e devolve a dele (a do backup), sem pisar em nada que tenha aparecido no vão.
function desfazer(arq, bak, novo, ganchos) {
  const nosso = `${bak}.nosso`
  fs.renameSync(arq, nosso)
  if (fs.readFileSync(nosso, 'utf8') !== novo) { devolver(nosso, arq, ganchos); return }
  devolver(bak, arq, ganchos); fs.rmSync(nosso, { force: true })
}

// Troca o arquivo vivo pelo temporário sem nunca deixar a pessoa sem arquivo. { instalado, capturado, recriado }.
function trocar(arq, tmp, bak, noDisco, rodada, ganchos) {
  if (fs.existsSync(bak)) throw Object.assign(new Error('o backup já existe'), { code: 'EEXIST' }) // nunca captura por cima de outro backup (o inode dele seria perdido)
  fs.renameSync(arq, bak) // captura o que estiver vivo agora
  try {
    if (ganchos.noVao) ganchos.noVao(rodada)
    const capturado = fs.readFileSync(bak, 'utf8')
    if (capturado !== noDisco) { devolver(bak, arq, ganchos); return { instalado: false, capturado } } // salvou depois da leitura: a versão dele volta ao lugar
    try { instalar(tmp, arq, ganchos) } catch (e) { if (e.code === 'EEXIST') return { instalado: false, capturado, recriado: true }; throw e } // recriaram o arquivo no vão: a versão mais nova fica
    return { instalado: true, capturado }
  } catch (e) {
    if (!fs.existsSync(arq)) devolver(bak, arq, ganchos) // qualquer falha: o original volta
    throw e
  }
}

// Marcador de recuperação: `<arquivo>.converge.recuperar`, JSON atômico (temporário + fsync + rename) gravado ANTES da captura e mantido até a verificação terminar.
//   { bak: <nome do backup>, sha: <sha256 do que o backup deve conter>, novo: <sha256 da nossa versão>, fase: 'capturando' | 'instalado' | 'desfazendo' }
// A próxima execução (dentro da trava) conserta o que a queda deixou: arquivo ausente → devolve a versão da pessoa (a mais nova entre o backup e `.nosso`); nossa versão no lugar mas o
// backup mudou depois da captura (a pessoa gravou no inode antigo) ou desfazer interrompido → a versão dela volta e a mudança é refeita em cima.
// Vigia: concluída a troca, o backup (o inode antigo) fica sob `<backup>.vigia` por JANELA_VIGIA_MS. Um editor que manteve o inode antigo aberto pode salvar horas depois, e essa gravação cai
// no backup, não no arquivo ativo. UM arquivo de vigia POR backup (nunca sobrescreve o de outra troca, mesmo no mesmo segundo ou dentro das 48 h): a execução seguinte confere todos.
const JANELA_VIGIA_MS = 48 * 3600 * 1000, PADRAO_BACKUP = /^\d{8}T\d{6}-\d+-\d+$/
let SEQ = 0 // nome do backup único por captura, mesmo dentro do mesmo segundo e do mesmo processo
const sha = texto => crypto.createHash('sha256').update(texto).digest('hex')
const marcadorDe = arq => `${arq}.converge.recuperar`
function gravarJson(destino, obj) { // temporário ao lado + fsync + rename: arquivo NOSSO, nunca fica meio escrito
  const tmp = `${destino}.${process.pid}.tmp`, fd = fs.openSync(tmp, 'w')
  try { fs.writeSync(fd, JSON.stringify(obj)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  fs.renameSync(tmp, destino); fsyncPasta(path.dirname(destino))
}
const marcar = (arq, bak, dados) => gravarJson(marcadorDe(arq), { bak: path.basename(bak), ...dados })
const limparMarcador = arq => { if (fs.existsSync(arq)) fs.rmSync(marcadorDe(arq), { force: true }) } // só sai quando o arquivo da pessoa existe
const vigiaDe = bak => `${bak}.vigia`
function listarVigias(arq) { // [{ arquivo, bak }] só de nomes do padrão exato deste arquivo
  const dir = path.dirname(arq), prefixo = `${path.basename(arq)}.bak-converge-`
  return fs.readdirSync(dir).filter(n => n.startsWith(prefixo) && n.endsWith('.vigia') && PADRAO_BACKUP.test(n.slice(prefixo.length, -'.vigia'.length)))
    .map(n => ({ arquivo: path.join(dir, n), bak: path.join(dir, n.slice(0, -'.vigia'.length)) }))
}
function lerVigia(v) { try { const d = JSON.parse(fs.readFileSync(v.arquivo, 'utf8')); return d && typeof d.sha === 'string' && typeof d.novo === 'string' && Number.isFinite(d.ate) ? d : null } catch (e) { if (e.code === 'ENOENT' || e instanceof SyntaxError) return null; throw e } }

// Troca o conteúdo vivo por `conteudo` (a versão da pessoa, vinda do backup) pelo mesmo protocolo da captura; se ela salvar de novo no meio, a dela fica.
function trocarPor(arq, conteudo, bak, ganchos) {
  const tmp = `${arq}.converge.tmp`, atual = fs.readFileSync(arq, 'utf8')
  try {
    const fd = fs.openSync(tmp, 'w'); try { fs.writeSync(fd, conteudo); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    copiarPermissoes(arq, tmp); return trocar(arq, tmp, `${bak}.rec-${process.pid}-${++SEQ}`, atual, 0, ganchos)
  } finally { fs.rmSync(tmp, { force: true }) }
}
// Dentro da trava: conserta o que uma execução anterior que morreu deixou, depois confere as vigias.
function recuperar(arq, ganchos, trava, dono) {
  const ha = f => fs.existsSync(f)
  const vale = () => { if (!Trava.sigoDono(trava, dono) || (ganchos.aindaValido && !ganchos.aindaValido())) throw Object.assign(new Error('a posse da trava mudou durante a recuperação'), { cancelado: true }) } // conferida antes de CADA alteração do arquivo
  let m = null
  try { m = JSON.parse(fs.readFileSync(marcadorDe(arq), 'utf8')) } catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e } // marcador ilegível não é seguido nem apagado
  const nome = m && m.bak
  if (m && typeof nome === 'string' && path.basename(nome) === nome && nome.startsWith(`${path.basename(arq)}.bak-converge-`)) { // só nomes do padrão, na mesma pasta
    const bak = path.join(path.dirname(arq), nome), nosso = `${bak}.nosso`
    if (!ha(arq)) { // queda entre a captura e a instalação, ou no meio do desfazer
      if (ha(nosso) || ha(bak)) vale()
      if (ha(nosso) && m.novo && sha(fs.readFileSync(nosso, 'utf8')) !== m.novo) devolver(nosso, arq, ganchos) // alguém salvou em cima da nossa versão: a mais nova
      else if (ha(bak)) devolver(bak, arq, ganchos)
      else if (ha(nosso)) devolver(nosso, arq, ganchos)
      limparMarcador(arq)
    } else {
      if (!!m.novo && ha(bak) && sha(fs.readFileSync(arq, 'utf8')) === m.novo) { // nossa versão no lugar: o backup é o inode antigo; se mudou depois da captura, a pessoa gravou nele
        const doBackup = fs.readFileSync(bak, 'utf8')
        if (m.fase === 'desfazendo' || sha(doBackup) !== m.sha) { vale(); trocarPor(arq, doBackup, bak, ganchos); limparMarcador(arq); return } // a versão dela volta; a mudança é refeita em cima pelo fluxo normal
      }
      limparMarcador(arq)
    }
  }
  if (!ha(arq)) return
  const vivas = []
  for (const v of listarVigias(arq)) { // gravação TARDIA no inode antigo de qualquer troca ainda dentro da janela
    const d = lerVigia(v)
    if (!d || Date.now() >= d.ate || !ha(v.bak)) { if (d || !ha(v.bak)) fs.rmSync(v.arquivo, { force: true }); continue } // vencida ou sem backup: nada mais a vigiar (vigia ilegível não é seguida nem apagada)
    vivas.push({ ...v, d })
  }
  if (!vivas.length) return
  if (!new Set(vivas.map(x => x.d.novo)).has(sha(fs.readFileSync(arq, 'utf8')))) return // o arquivo já não é uma versão nossa: a pessoa salvou depois e a dela vale
  const mudadas = vivas.filter(x => sha(fs.readFileSync(x.bak, 'utf8')) !== x.d.sha).sort((a, b) => fs.statSync(b.bak).mtimeMs - fs.statSync(a.bak).mtimeMs)
  if (!mudadas.length) return
  vale()
  trocarPor(arq, fs.readFileSync(mudadas[0].bak, 'utf8'), mudadas[0].bak, ganchos) // a gravação tardia MAIS RECENTE volta; a mudança é refeita em cima pelo fluxo normal
  for (const x of vivas) fs.rmSync(x.arquivo, { force: true })
}

const BACKUPS_QUE_FICAM = 5
// Mantém só os BACKUPS_QUE_FICAM backups mais novos deste arquivo (nome com carimbo UTC, então a ordem do nome é a ordem do tempo), exceto os que ainda têm vigia; nada além do padrão exato é tocado.
function podarBackups(arq) {
  const dir = path.dirname(arq), prefixo = `${path.basename(arq)}.bak-converge-`
  const sobVigia = new Set(listarVigias(arq).filter(v => { const d = lerVigia(v); return d && Date.now() < d.ate }).map(v => path.basename(v.bak)))
  const nomes = fs.readdirSync(dir).filter(n => n.startsWith(prefixo) && PADRAO_BACKUP.test(n.slice(prefixo.length))).sort()
  for (const n of nomes.slice(0, Math.max(0, nomes.length - BACKUPS_QUE_FICAM))) if (!sobVigia.has(n)) { fs.rmSync(path.join(dir, n), { force: true }); fs.rmSync(vigiaDe(path.join(dir, n)), { force: true }) }
}

const erro = e => [`ERRO ${String(e.code || '')} ${String(e.message).split('\n')[0]}`.replace(/\s+/g, ' ').trim(), 1]

// Devolve [texto, código de saída]. `ganchos` existe só para o teste provocar a corrida (antesDaCaptura, noVao, depoisDaInstalacao, nomeBackup) e a falta de hard link (link).
function aplicarChave(arq, chave, valor, ganchos = {}) {
  if (!arq) return ['ERRO sem o caminho do arquivo', 2]
  if (typeof chave !== 'string' || !chave || !escalar(valor) || valor === undefined) return ['ERRO chave ou valor inválido', 2]
  if (!fs.existsSync(arq) && !fs.existsSync(marcadorDe(arq))) return ['SEM-ARQUIVO', 3]
  if (fs.existsSync(arq) && !fs.existsSync(marcadorDe(arq)) && !listarVigias(arq).length) { try { const pre = montar(fs.readFileSync(arq, 'utf8'), chave, valor).fim; if (pre && (pre[0] === 'JA-OK' || pre[0].startsWith('FORMATO-INESPERADO'))) return pre } catch (e) { return erro(e) } } // já certo ou ilegível: não precisa nem da trava
  const trava = `${arq}.converge.lock`, tmp = `${arq}.converge.tmp`, dir = path.dirname(arq)
  let dono = null
  try {
    dono = Trava.pegar(trava, ganchos.relogio, ganchos.travaGanchos)
    if (dono === null) return ['OCUPADO outra execução está gravando este arquivo', 7]
    try { recuperar(arq, ganchos, trava, dono) } catch (e) { if (e.cancelado) return ['CANCELADO a trava mudou de dono durante a recuperação; nada foi alterado depois disso', 8]; throw e }
    if (!fs.existsSync(arq)) return ['SEM-ARQUIVO', 3]
    const carimbo = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')
    let base = fs.readFileSync(arq, 'utf8'), noDisco = base // base = de onde se constrói; noDisco = o que o arquivo deve conter agora
    for (let rodada = 1; rodada <= RODADAS; rodada++) {
      const m = montar(base, chave, valor)
      const novo = m.novo !== undefined ? m.novo : (m.fim[0] === 'JA-OK' && noDisco !== base ? base : null) // versão dele já certa, mas o disco tem a nossa velha: devolve a dele
      if (novo === null) return m.fim
      const fd = fs.openSync(tmp, 'w'); try { fs.writeSync(fd, novo); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      copiarPermissoes(arq, tmp)
      const bak = ganchos.nomeBackup ? ganchos.nomeBackup(arq) : `${arq}.bak-converge-${carimbo}-${process.pid}-${++SEQ}`
      if (ganchos.antesDaCaptura) ganchos.antesDaCaptura(rodada)
      if (!Trava.sigoDono(trava, dono) || (ganchos.aindaValido && !ganchos.aindaValido())) return ['CANCELADO a trava mudou de dono antes da troca; o arquivo não foi tocado', 8] // a posse da trava do arquivo e a de quem chama, conferidas logo antes da captura
      marcar(arq, bak, { fase: 'capturando', sha: sha(noDisco), novo: sha(novo) })
      let r; try { r = trocar(arq, tmp, bak, noDisco, rodada, ganchos) } catch (e) { limparMarcador(arq); throw e } // trocar já devolveu o original; sem arquivo no lugar o marcador fica
      fsyncPasta(dir)
      if (!r.instalado) { limparMarcador(arq); base = noDisco = r.recriado ? fs.readFileSync(arq, 'utf8') : r.capturado; continue } // refaz em cima da versão dele
      marcar(arq, bak, { fase: 'instalado', sha: sha(r.capturado), novo: sha(novo) }) // a verificação abaixo também fica coberta: queda nela é consertada pela próxima execução
      if (ganchos.depoisDaInstalacao) ganchos.depoisDaInstalacao(rodada, bak)
      const tardio = fs.readFileSync(bak, 'utf8') // quem já tinha o arquivo aberto pode ter gravado no inode capturado
      if (tardio === r.capturado) {
        const depois = varrer(fs.readFileSync(arq, 'utf8'), chave)
        if (!(depois.achou && depois.achou.valor === valor)) return [`ERRO não conferiu depois de gravar (backup ${path.basename(bak)} ao lado)`, 5]
        gravarJson(vigiaDe(bak), { sha: sha(r.capturado), novo: sha(novo), ate: Date.now() + JANELA_VIGIA_MS }); limparMarcador(arq); podarBackups(arq); return ['APLICADO', 0] // a vigia fica ao lado do backup: gravação tardia no inode antigo ainda é vista pelas próximas execuções
      }
      if (rodada === RODADAS) { marcar(arq, bak, { fase: 'desfazendo', sha: sha(tardio), novo: sha(novo) }); desfazer(arq, bak, novo, ganchos); fsyncPasta(dir); limparMarcador(arq); return ['ALTERADO-DURANTE', 6] } // sem rodada para refazer: a versão dele volta
      base = tardio; noDisco = novo
    }
    return ['ALTERADO-DURANTE', 6]
  } catch (e) {
    return erro(e)
  } finally {
    if (dono !== null) { fs.rmSync(tmp, { force: true }); Trava.soltar(trava, dono) } // o temporário e a trava são desta execução; sem a trava, o temporário é de outra
  }
}

module.exports = { aplicarChave }
