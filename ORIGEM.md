# De onde vem `ferramentas/`

Cópia exata (sem edição) de `quiosque/converge/` do repositório `Facial-Academy/MCP-grupofacial`, no commit `89b02e1b7da8db97fdc9347377e94c1eec24479a` (PR #248, 13/11/2026, o pacote de MCPs no cliente de convergência), depois do Gate autônomo.
São 5 arquivos: `assinar-manifesto.cjs`, `converge.cjs`, `jsonc-config.cjs`, `pacote-mcp.cjs` e `trava.cjs` (o `converge.cjs` carrega o `pacote-mcp.cjs`: copiar só os quatro de antes derruba o `renovar.cjs`).
O sha256 de cada arquivo está em `ferramentas.sha256`; `chave-publica.json` (na raiz) também é a mesma do repositório de origem (com a chave `pacote-2026-11`, `uso: "pacote"`). Mudou o código lá → copie de novo e atualize o commit e os sha256 aqui; nunca edite estes arquivos neste repositório.

Conferir: `cd ferramentas && sha256sum -c ../ferramentas.sha256`
