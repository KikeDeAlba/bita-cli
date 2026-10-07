---
description: Crea el proyecto de bita para un repositorio y lo deja mapeado
argument-hint: [ruta del repositorio, vacío para el actual]
allowed-tools: Bash(bita repo init:*), Bash(bita repo show:*), Bash(bita repo list:*), Bash(bita projects:*), Bash(bita map set:*)
---

Estado actual del repositorio:

!`bita repo show`

Deja un repositorio listo para que yo te ofrezca el cronómetro: crea su proyecto
en bita y lo mapea, en un solo paso.

**Qué repositorio.** `$ARGUMENTS` es la ruta. Si viene vacío, el actual.

```
bita repo init <ruta>
```

**El nombre del proyecto** sale de la carpeta del repositorio. Míralo antes de
correrlo: si el nombre de la carpeta es feo o abreviado (`vb_solemti`,
`ra-apps-v2`), propón uno legible y pásalo con `--name "<nombre>"`. Este nombre
va a aparecer en los reportes y al lado de cada issue de Jira, así que vale la
pena. Enséñame el que propones y espera un sí.

Si ya existe un proyecto con ese nombre, `repo init` **lo reutiliza** en vez de
crear uno duplicado, y te lo dice. Eso es lo correcto cuando varios repositorios
son partes del mismo proyecto: el front y el back de lo mismo deben compartirlo,
porque el agrupado a Jira es por proyecto más título.

Si el repositorio ya estaba mapeado, el comando no toca nada y te lo dice. No lo
fuerces sin preguntarme: remapear cambia a qué tablero van las horas siguientes.

**Después de mapear**, mira si el proyecto tiene tablero de Jira en
`bita projects`. Si la columna JIRA está vacía, dilo y ofrece resolverlo:

```
bita map set <projectId> <JIRAKEY> --parent <JIRAKEY-123>
```

No inventes la clave del tablero ni la épica: pregúntamelas, o búscalas con el
conector de Atlassian y enséñame los candidatos. Si `bita project show <proyecto>
--json` dice `atlassian.via: "cli"`, búscalas con `bita jira project ls` y
`bita jira issue search --jql …` en vez del conector.

Cierra diciéndome en una línea que a partir de la próxima sesión en ese
repositorio te ofrecerás a arrancar el cronómetro.
