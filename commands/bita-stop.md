---
description: Deja la nota al día y después para el cronómetro
argument-hint: [id, vacío si solo hay uno, o "all"]
allowed-tools: Bash(bita stop:*), Bash(bita ls:*), Bash(bita amend:*), Bash(bita project:*), Bash(inkwell note:*), Bash(recap wait:*), Bash(recap status:*), Read, Write, Edit
---

Corriendo ahora mismo:

!`bita ls`

**Parar es el último paso, no el primero.**

**Cuál parar.** `$ARGUMENTS` manda. Si viene vacío:

- Un solo cronómetro corriendo → ese.
- Varios → **pregúntame cuál**, listándolos con su id y su tiempo. No adivines.
- Si viene `all`, para todos con `bita stop --all`.

## 0. Si es una reunión, no documentes: para y espera

Si el cronómetro tiene `kind` `remote-meeting` o `in-person-meeting` (míralo con
`bita ls --json`), **sáltate los pasos 1 y 2**: recap ya graba la reunión y, al
parar, hace lo demás.

```
bita stop <id> --json
recap wait --bita-entry <id> --json
```

`recap wait` tarda de uno a cinco minutos en una reunión de una hora: córrelo
con un timeout amplio (15 min). Si `meta.hooksFired` del stop es 0, recap no se
enteró y no hay grabación: dilo y para ahí. Con el resultado, reporta lo que
indique la skill de recap. Si recap pregunta por el proyecto, corrígelo con
`bita amend <id> --project <X>`.

## 1. La nota, con inkwell

bita no guarda notas. Si inkwell está instalado, deja la nota de la entrada al
día con lo que pasó en este bloque, siguiendo su skill:

```
inkwell note save <id> --section "Qué se hizo" --md -
```

Si inkwell no está, dilo en una línea y sigue.

## 2. Los repos del proyecto

Mira en qué repos locales cayeron los archivos que tocó el bloque:

```
bita project repo suggest <id> --json
```

Por cada sugerencia sin mapear (`mapped: false`) que **de verdad sea del
proyecto**:

```
bita project repo add <path> --project <X> --source stop
```

Solo esas. Si trabajando en CoDi tocaste bita-cli de paso, bita-cli no se mapea
a CoDi. Ante la duda, déjalo fuera. Si la entrada no tiene proyecto, no mapees
nada.

## 3. Parar

```
bita stop <id>
```

Responde con el id, el título, el tiempo que quedó registrado y, si siguen
corriendo otros, cuáles.
