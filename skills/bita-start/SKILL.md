---
name: bita-start
description: Arranca un cronómetro de bita, en blanco o con título
argument-hint: [título corto, o vacío para arrancar en blanco]
allowed-tools: Bash(bita start:*), Bash(bita ls:*), Bash(bita repo show:*), Bash(tally issue open:*), AskUserQuestion
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

**Tarjeta de Jira.** Si `tally` está instalado y no se pidió sin tarjeta
(`--no-jira`), tras arrancar: `tally issue open <id> --json`.
`NOT_A_JIRA_PROJECT`: nada. Con `NEEDS_PROJECT`, pregunta con
AskUserQuestion entre `data.options` (máx. 4, `jiraProjectKey` y sus
`projectNames`) más «No crear tarjeta», y reintenta con `--jira-project <KEY>`.
Con `NEEDS_STORY`, igual con `data.options` y `--story <KEY>`. Otro error: una
línea y sigue.

Responde en una línea: el id y el título (o que quedó en blanco) y la key de la
tarjeta si se abrió.
