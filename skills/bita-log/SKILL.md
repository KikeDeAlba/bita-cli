---
name: bita-log
description: Registra en bita un bloque de trabajo que ya pasó
argument-hint: <título> [de HH:MM a HH:MM, o duración]
allowed-tools: Bash(bita log:*), Bash(bita entries:*), Bash(bita repo show:*)
disable-model-invocation: true
---

Lo de hoy, para situar el bloque:

!`bita entries today`

De `$ARGUMENTS` saca el título y el horario ("de 14:00 a 15:30", "una hora desde
las 9", "45m esta mañana"). **Si falta la hora de inicio o la duración,
pregunta**: no inventes un horario, porque acaba como worklog con hora real en
Jira.

```
bita log "<título>" --from HH:MM --to HH:MM
bita log "<título>" --from HH:MM --for 1h30m
```

Antes de correrlo, enséñame en una línea título, horario, duración y proyecto, y
espera un sí. Si el bloque pisa horas de la tabla de arriba, dilo.

Si tienes contexto real de lo que se hizo y inkwell está instalado, déjalo en la
nota (`inkwell note save <id> --section "Qué se hizo" --md -`). Si no, no lo
inventes.
