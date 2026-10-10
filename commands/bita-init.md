---
description: Crea el proyecto de bita para un repositorio y lo deja mapeado
argument-hint: [ruta del repositorio, vacío para el actual]
allowed-tools: Bash(bita repo init:*), Bash(bita repo show:*), Bash(bita projects:*), Bash(bita scope list:*)
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
va a aparecer en los reportes, así que vale la pena. Enséñame el que propones y
espera un sí.

Si ya existe un proyecto con ese nombre, `repo init` **lo reutiliza** en vez de
crear uno duplicado, y te lo dice. Eso es lo correcto cuando varios repositorios
son partes del mismo proyecto: el front y el back de lo mismo deben compartirlo.

Si el repositorio ya estaba mapeado, el comando no toca nada y te lo dice. No lo
fuerces sin preguntarme: remapear cambia a qué proyecto van las horas siguientes.

**A qué tablero de Jira van sus horas** ya no es cosa de bita: lo mapea tally
(`tally map set <projectId> <JIRAKEY>`). Si tally está instalado y el proyecto
no tiene tablero, ofrécelo y sigue su skill; si no, menciónalo en una línea.

Cierra diciéndome en una línea que a partir de la próxima sesión en ese
repositorio te ofrecerás a arrancar el cronómetro.
