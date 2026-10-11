---
name: bita-init
description: Crea y mapea el proyecto de bita de un repositorio
argument-hint: [ruta del repositorio, vacío para el actual]
allowed-tools: Bash(bita repo init:*), Bash(bita repo show:*), Bash(bita projects:*), Bash(bita scope list:*)
disable-model-invocation: true
---

Estado actual del repositorio:

!`bita repo show`

Crea el proyecto de un repositorio en bita y lo mapea en un paso. `$ARGUMENTS`
es la ruta; vacío, el actual.

```
bita repo init <ruta> [--name "<nombre>"]
```

El nombre sale de la carpeta. Si es feo o abreviado (`vb_solemti`,
`ra-apps-v2`), propón uno legible con `--name`, enséñamelo y espera un sí.

Si ya existe un proyecto con ese nombre, `repo init` lo reutiliza (correcto para
el front y el back de lo mismo). Si el repo ya estaba mapeado, no lo fuerces sin
preguntarme: remapear cambia a dónde van las horas.

El tablero de Jira lo mapea tally (`tally map set <projectId> <JIRAKEY>`): si
está instalado y el proyecto no tiene tablero, ofrécelo.

Cierra en una línea: desde la próxima sesión en ese repo ofrecerás el cronómetro.
