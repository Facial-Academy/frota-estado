# frota-estado

Estado desejado **assinado** dos computadores do time do Grupo Facial. Este repositório é público de propósito: o manifesto não tem segredo, e quem decide se vale é a **assinatura**, não o endereço.

- `estado.json` — o manifesto vigente, dentro de um envelope assinado com Ed25519 (`{ chave, manifesto (base64), assinatura }`). É o único arquivo que as máquinas leem:
  `https://raw.githubusercontent.com/Facial-Academy/frota-estado/main/estado.json`
- `fonte/modulos.json` — o que se quer em cada máquina. Hoje só o tipo `vscode-setting` (uma chave `claudeCode.*` do `settings.json` do VS Code, valor escalar). Editar este arquivo é a única forma de mudar a frota; o `renovar.yml` assina e publica sozinho.
- `chave-publica.json` — a chave pública (id `2026-10`). A privada vive no cofre da empresa e no segredo `FROTA_CHAVE_PRIVADA` deste repositório.
- `renovar.cjs` + `.github/workflows/renovar.yml` — monta o manifesto, assina e grava `estado.json`: toda segunda-feira (renova a validade de 120 dias), a cada mudança em `fonte/` e sob demanda. O `serial` é a data e hora UTC e só cresce.
- `ferramentas/` — cópia exata do cliente e da ferramenta de assinatura de `Facial-Academy/MCP-grupofacial` (`quiosque/converge/`); `ORIGEM.md` guarda os sha256.

**Como as máquinas usam:** o cliente (`converge.cjs`, instalado como tarefa da própria pessoa) lê `estado.json`, confere a assinatura, recusa `serial` menor e manifesto vencido, e converge: máquina desligada por semanas aplica só o estado final, sem fila. O cliente só aceita o que conhece (chaves `claudeCode.*`, valores escalares); o manifesto nunca manda executar nada.

**Voltar atrás:** edite `fonte/modulos.json` para o valor antigo e deixe o workflow publicar (o `serial` novo é maior, então as máquinas aceitam).
**Chave comprometida:** gere outra com `node ferramentas/assinar-manifesto.cjs gerar-chave <pasta>`, publique a pública junto da antiga em `chave-publica.json`, troque o segredo, remova a antiga depois que a frota aceitar a nova.
