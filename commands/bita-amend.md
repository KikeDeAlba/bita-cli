---
description: Rellena el título, el proyecto o el tipo de un cronómetro
argument-hint: [id, o vacío para el borrador en curso]
allowed-tools: Bash(bita amend:*), Bash(bita ls:*), Bash(bita projects:*), Bash(bita repo show:*), Bash(bita scope list:*)
---

Corriendo ahora:

!`bita ls`

Rellena lo que le falte a un cronómetro. Normalmente esto pasa solo, pero sirve
para forzarlo o para corregir algo.

**Cuál.** `$ARGUMENTS` manda. Si viene vacío, `--draft` apunta al único borrador
en curso; si hay varios, el comando falla y te dice los ids, así que pregúntame
cuál en vez de adivinar.

**El título** sale de lo que se esté haciendo en esta sesión: corto, reconocible
y en el idioma en que se buscaría después. tally lo usa para agrupar las horas.

**El proyecto.** Cuidado aquí: un repo no es un proyecto. Los proyectos son
grupos con varios repos dentro. Resuélvelo con `bita repo show`, que dice qué
prefijo empató, y no lo fuerces a mano si ya resuelve solo.

```
bita amend --draft --title "<titulo>" --project <nombre o id>
bita amend <id> --title "<titulo>"
bita amend <id> --kind remote-meeting|in-person-meeting|none
```

Cualquier cambio dispara el evento `amend`: inkwell renombra o mueve la nota de
la entrada, y recap empieza o deja de grabar si cambió el tipo.

**La descripción no va aquí.** bita no guarda notas: lo que se hizo se escribe
en la nota de la entrada con inkwell (`inkwell note save <id> --section "…" --md -`).

Responde en una línea con lo que quedó.
