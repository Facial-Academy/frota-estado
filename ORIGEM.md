# De onde vem `ferramentas/`

Cópia exata (sem edição) de `quiosque/converge/` do repositório `Facial-Academy/MCP-grupofacial`, no commit `be2c35dfd383f09eb9fcebdee2a8cdf1ead113c4` (PR #284, 16/11/2026, a versão da extensão do Claude Code no cliente de convergência: campo de topo `versoes`), depois do Gate autônomo.
São 6 arquivos: `assinar-manifesto.cjs`, `converge.cjs`, `extensao-vscode.cjs`, `jsonc-config.cjs`, `pacote-mcp.cjs` e `trava.cjs` (o `converge.cjs` carrega o `pacote-mcp.cjs` e o `extensao-vscode.cjs`, e este carrega o `pacote-mcp.cjs`: copiar só os cinco de antes derruba o `renovar.cjs`).
O sha256 de cada arquivo está em `ferramentas.sha256`; `chave-publica.json` (na raiz) também é a mesma do repositório de origem (com a chave `pacote-2026-11`, `uso: "pacote"`). Mudou o código lá → copie de novo e atualize o commit e os sha256 aqui; nunca edite estes arquivos neste repositório.

Conferir: `cd ferramentas && sha256sum -c ../ferramentas.sha256`
