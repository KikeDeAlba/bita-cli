---
description: Registra en bita un bloque de trabajo que ya pasó
argument-hint: <título> [de HH:MM a HH:MM, o duración]
allowed-tools: Bash(bita log:*), Bash(bita entries:*), Bash(bita repo show:*)
---

Lo de hoy, para situar el bloque:

!`bita entries today`

Registra un bloque que ya ocurrió, para cuando se trabajó sin arrancar el
cronómetro.

De `$ARGUMENTS` saca el título y el horario. Entiende formas sueltas: "de 14:00 a
15:30", "una hora desde las 9", "45m esta mañana". **Si falta la hora de inicio o
no se puede saber cuánto duró, pregunta** — no inventes un horario, porque esto
va a acabar como un worklog con hora real en Jira.

```
bita log "<título>" --from HH:MM --to HH:MM
bita log "<título>" --from HH:MM --for 1h30m
```

Antes de correrlo, **enséñame en una línea lo que vas a registrar** (título,
horario, duración y proyecto) y espera un sí. Un bloque mal puesto es más molesto
de arreglar que de confirmar.

Mira la tabla de arriba: si el bloque pisa horas que ya están registradas, dilo.
El solape está permitido, pero casi siempre aquí significa que la hora está mal.

Si tienes contexto real de lo que se hizo y inkwell está instalado, déjalo en la
nota de la entrada (`inkwell note save <id> --section "Qué se hizo" --md -`). Si
no lo tienes, **no lo inventes**: es mejor una entrada sin nota que una con una
nota falsa.
