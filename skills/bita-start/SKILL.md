---
name: bita-start
description: Arranca un cronómetro de bita, en blanco o con título
argument-hint: [título corto, o vacío para arrancar en blanco]
allowed-tools: Bash(bita start:*), Bash(bita ls:*), Bash(bita repo show:*)
disable-model-invocation: true
---

Corriendo ahora mismo:

!`bita ls`

Arranca un cronómetro.

**Si `$ARGUMENTS` viene vacío, arranca en blanco y ya**: `bita start`. No
preguntes ni explores para inventar un título; el reloj debe correr antes de que
se sepa nada. Queda como borrador y se rellena en cuanto un mensaje diga en qué
se trabaja (el hook de bita lo recuerda en cada prompt):

```
bita amend --draft --title "<titulo corto>" --project <nombre o id>
```

**Si `$ARGUMENTS` trae texto**, úsalo literal como título: `bita start "<título>"`.

**Si es una reunión**, márcala para que recap la grabe: `--kind remote-meeting`
(Meet, Zoom, Teams, llamada) o `--kind in-person-meeting` (presencial). Si no
queda claro cuál, pregunta solo eso.

Si en la lista de arriba ya hay uno con el mismo título y proyecto, no arranques
otro: dímelo. Si hay otros de otra cosa, arranca igual y menciónalo.

Responde en una línea: el id y el título, o que quedó en blanco.
