---
name: bita-timers
description: Muestra los cronómetros que corren y lo de hoy
allowed-tools: Bash(bita ls:*), Bash(bita entries:*)
disable-model-invocation: true
---

Corriendo ahora:

!`bita ls`

Hoy:

!`bita entries today`

Resume en dos o tres líneas qué corre y desde cuándo, y cuánto llevo hoy. Si
apareció el aviso de solapes, dilo con las horas exactas. Si hay un borrador sin
título, dilo con su id y ofrece rellenarlo con `/bita-amend`.
