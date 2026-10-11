---
name: bita-amend
description: Rellena el título, el proyecto o el tipo de un cronómetro
argument-hint: [id, o vacío para el borrador en curso]
allowed-tools: Bash(bita amend:*), Bash(bita ls:*), Bash(bita projects:*), Bash(bita repo show:*), Bash(bita scope list:*)
disable-model-invocation: true
---

Corriendo ahora:

!`bita ls`

**Cuál.** `$ARGUMENTS` manda. Vacío: `--draft` apunta al único borrador; si hay
varios, el comando falla con los ids: pregúntame cuál.

**El título** sale de lo que se hace en esta sesión: corto y reconocible.

**El proyecto**: un repo no es un proyecto. Resuélvelo con `bita repo show` y no
lo fuerces si ya resuelve solo.

```
bita amend --draft --title "<titulo>" --project <nombre o id>
bita amend <id> --title "<titulo>"
bita amend <id> --kind remote-meeting|in-person-meeting|none
```

La descripción no va aquí: va en la nota de la entrada con inkwell.

Responde en una línea con lo que quedó.
