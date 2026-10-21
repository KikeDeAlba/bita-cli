---
name: bita-stop
description: Para a mano un cronómetro de bita
argument-hint: [id, vacío si solo hay uno, o "all"]
allowed-tools: Bash(bita stop:*), Bash(bita ls:*)
disable-model-invocation: true
---

Corriendo ahora mismo:

!`bita ls`

Corre `bita stop` con lo que trae `$ARGUMENTS`:

- Un id: `bita stop <id>`.
- `all`: `bita stop --all`.
- Vacío: `bita stop`. Si hay varios corriendo y falla con
  `AMBIGUOUS_TIMER`, lístalos con id y tiempo y pregúntame cuál.
- Si el texto trae `--at HH:MM`, pásalo tal cual.

Responde en una línea con el id, el título, el tiempo registrado y los que sigan
corriendo.
