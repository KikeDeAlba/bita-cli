---
name: bita-stop
description: Deja la nota al día y después para el cronómetro
argument-hint: [id, vacío si solo hay uno, o "all"]
allowed-tools: Bash(bita stop:*), Bash(bita ls:*), Bash(bita amend:*), Bash(bita project:*), Bash(inkwell note:*), Bash(inkwell guide:*), Bash(recap wait:*), Bash(recap status:*), Read, Write, Edit
disable-model-invocation: true
---

Corriendo ahora mismo:

!`bita ls`

**Parar es el último paso, no el primero.**

**Cuál.** `$ARGUMENTS` manda. Vacío: si hay uno solo, ese; si hay varios,
pregúntame cuál listándolos con id y tiempo. `all` → `bita stop --all`.

## Si es una reunión, no documentes

Si su `kind` es `remote-meeting` o `in-person-meeting` (`bita ls --json`),
sáltate los pasos 1 y 2:

```
bita stop <id> --json
recap wait --bita-entry <id> --json
```

`recap wait` tarda de uno a cinco minutos por hora de reunión: dale un timeout
amplio (15 min). Si `meta.hooksFired` es 0, no hubo grabación: dilo y para ahí.
Reporta lo que indique la skill de recap; si pregunta el proyecto,
`bita amend <id> --project <X>`.

## 1. La nota, con inkwell

Deja la nota de la entrada al día con lo que pasó en el bloque. Cómo se escribe:
`inkwell guide entry-notes`. Se guarda con
`inkwell note save <id> --section "Qué se hizo" --md -`. Si inkwell no está,
dilo en una línea y sigue.

## 2. Los repos del proyecto

```
bita project repo suggest <id> --json
```

Por cada sugerencia con `mapped: false` que **de verdad sea del proyecto**:
`bita project repo add <path> --project <X> --source stop`. Lo que se tocó de
paso no se mapea; ante la duda, fuera. Sin proyecto, no mapees nada.

## 3. Parar

`bita stop <id>`. Responde con el id, el título, el tiempo registrado y los que
sigan corriendo.
