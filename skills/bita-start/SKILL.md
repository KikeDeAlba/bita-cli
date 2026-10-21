---
name: bita-start
description: Arranca a mano un cronómetro de bita, en blanco o con título
argument-hint: [título corto, o vacío para arrancar en blanco]
allowed-tools: Bash(bita start:*), Bash(bita ls:*)
disable-model-invocation: true
---

Corriendo ahora mismo:

!`bita ls`

Corre `bita start` con lo que trae `$ARGUMENTS`, sin explorar ni inventar nada:

- Vacío: `bita start`.
- Con texto: `bita start "<título>"`, con el texto literal.
- Si el texto pide flags de forma explícita (`--kind remote-meeting`,
  `--kind in-person-meeting`, `--project X`, `--at HH:MM`, `--jira`), pásalos
  tal cual.

Si falla, enseña el error en una línea. Responde en una línea con el id y el
título (o que quedó en blanco).
