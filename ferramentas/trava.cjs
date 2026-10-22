// trava.cjs — trava de execução única por arquivo, com DONO, para o cliente de convergência e a gravação do settings.json.
//   pegar(arquivo, relogio?, ganchos?) → { token, pid } | null (outra execução viva está com ela)
//   sigoDono(arquivo, dono) · renovar(arquivo) · soltar(arquivo, dono)
// Por que não é "trava velha = passou X minutos": processo SUSPENSO (notebook dormindo, pausa) continua vivo e volta a agir; roubar a trava dele só cria
// duas execuções ao mesmo tempo. Aqui a trava só é dada como velha quando o dono MORREU (pid inexistente) há pelo menos 2 minutos, ou quando passou de 6 horas
// (teto contra pid reaproveitado por outro programa). Mesmo assim cada ato de quem usa a trava confere a posse antes (sigoDono) e o estado da convergência é
// cercado por serial (ver converge.cjs): o que escapar de uma conferência é refeito pela convergência seguinte.
// A tomada de uma trava velha é atômica: só UMA execução consegue MOVER o arquivo velho; quem mover um arquivo que não é o velho que leu (era a trava fresca de
// outro dono) devolve-o ao lugar. Nunca há `unlink` direto de uma trava que outra execução pode ter acabado de criar.
const fs = require('fs'), crypto = require('crypto')
const VELHA_MIN_MS = 2 * 60 * 1000, VELHA_MAX_MS = 6 * 3600 * 1000

const vivo = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } } // EPERM = existe, só não é nosso
function lerRegistro(arq) { // undefined = não existe; { token: null } = vazio ou ilegível (execução que morreu entre criar e escrever: sem dono conhecido)
  try { const r = JSON.parse(fs.readFileSync(arq, 'utf8')); return r && typeof r.token === 'string' ? r : { token: null } } catch (e) { if (e.code === 'ENOENT') return undefined; return { token: null } }
}
function velha(arq, reg, agora) {
  const idade = agora - fs.statSync(arq).mtimeMs
  return idade >= VELHA_MAX_MS || (idade >= VELHA_MIN_MS && !(Number.isInteger(reg.pid) && vivo(reg.pid)))
}

function pegar(arq, relogio = Date.now, ganchos = {}) {
  const dono = { token: `${process.pid}-${crypto.randomBytes(8).toString('hex')}`, pid: process.pid }
  for (let tentativa = 0; tentativa < 4; tentativa++) {
    try {
      const fd = fs.openSync(arq, 'wx'); try { fs.writeSync(fd, JSON.stringify(dono)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      return dono
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      let reg
      try { reg = lerRegistro(arq); if (reg === undefined) continue; if (!velha(arq, reg, relogio())) return null } catch (e2) { if (e2.code === 'ENOENT') continue; throw e2 }
      if (ganchos.depoisDeLer) ganchos.depoisDeLer() // só o teste usa: provoca a corrida entre ler a trava velha e tomá-la
      const movida = `${arq}.velha-${dono.token}`
      try { fs.renameSync(arq, movida) } catch (e3) { if (e3.code === 'ENOENT') continue; throw e3 } // outra execução tomou primeiro
      const lida = lerRegistro(movida)
      if (lida && lida.token === reg.token) { fs.rmSync(movida, { force: true }); continue } // era a velha: tomada feita, a nossa é criada na volta
      try { fs.linkSync(movida, arq) } catch (e4) { if (e4.code !== 'EEXIST') throw e4 } // era a trava fresca de outro dono: volta ao lugar (se já há outra, a cópia some)
      fs.rmSync(movida, { force: true }); return null
    }
  }
  return null
}
const sigoDono = (arq, dono) => { try { const r = lerRegistro(arq); return !!r && r.token === dono.token } catch (e) { return false } }
const renovar = arq => { const d = new Date(); fs.utimesSync(arq, d, d) }
function soltar(arq, dono) { if (sigoDono(arq, dono)) fs.rmSync(arq, { force: true }) } // só o dono solta

module.exports = { pegar, sigoDono, renovar, soltar }
