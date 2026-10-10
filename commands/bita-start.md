---
description: Arranca un cronómetro de bita, en blanco o con título
argument-hint: [título corto, o vacío para arrancar en blanco]
allowed-tools: Bash(bita start:*), Bash(bita ls:*), Bash(bita repo show:*)
---

Corriendo ahora mismo:

!`bita ls`

Arranca un cronómetro.

**Si `$ARGUMENTS` viene vacío, arranca en blanco y ya.** No preguntes, no
propongas un título, no explores para inventarlo: el sentido de este caso es que
el reloj empiece a correr antes de que se sepa nada, normalmente antes del primer
prompt de verdad. Cualquier deliberación aquí es tiempo que no se está midiendo.

```
bita start
```

El contador queda como borrador, sin título ni proyecto. **Se rellena después**,
en cuanto un mensaje diga en qué se va a trabajar:

```
bita amend --draft --title "<titulo corto>" --project <nombre o id>
```

El hook `prompt-submit` te lo va a recordar en cada turno hasta que lo hagas.

**Si `$ARGUMENTS` trae texto**, úsalo literal como título, sin reescribirlo, y
arranca con él:

```
bita start "<título>"
```

**Si es una reunión**, márcala con su tipo para que recap la grabe:
`--kind remote-meeting` (Meet, Zoom, Teams, llamada) o `--kind in-person-meeting`
(presencial, en sala, en oficina). Si no queda claro cuál, pregunta solo eso.

```
bita start "<título>" --kind remote-meeting
```

En cualquiera de los dos casos, mira la lista de arriba antes: si ya hay un
cronómetro con ese mismo título y proyecto, no arranques otro, dímelo. Si hay
otros corriendo de otra cosa, arranca igual —bita admite varios a la vez— y
menciónalo en una línea.

Responde en una línea: el id y el título, o que quedó en blanco. Nada más.
