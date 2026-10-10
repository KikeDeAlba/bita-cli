---
name: bita
description: >-
  Lleva el cronómetro de trabajo con bita: arranca, para, registra bloques que
  ya pasaron, corrige título, proyecto o tipo, une y borra entradas, y mapea
  repositorios a proyectos. Úsala cuando el usuario quiera arrancar o parar el
  conteo de tiempo, saber cuánto lleva o qué tiene corriendo, registrar un
  bloque que se le olvidó, o ver en qué trabajó. Frases que la disparan:
  "arranca el tiempo", "para el cronómetro", "cuánto llevo", "qué tengo
  corriendo", "registra una hora de esta mañana", "une estos contadores", "qué
  trabajé hoy". bita solo lleva el tiempo: documentar el trabajo es de inkwell,
  volcar las horas a Jira es de tally, Jira y Confluence directos son de atl, y
  grabar reuniones es de recap.
---

# bita

bita es el cronómetro y nada más. El registro local es la fuente de la verdad
de las horas: nada de estimarlas desde commits.

Lo demás vive en su herramienta, cada una con su skill:

| Para | Herramienta |
|---|---|
| Documentar lo que se hizo (la nota de la entrada, páginas, backlog, diagramas) | **inkwell** |
| Agrupar el tiempo y volcarlo a Jira (épica, historia, subtarea, worklogs) | **tally** |
| Leer o escribir Jira y Confluence directamente | **atl** |
| Grabar reuniones y sacar la minuta | **recap** |

`bita doctor` dice cuáles están instaladas. Si falta una, no improvises su
trabajo con bita: dilo y da el comando de instalación que muestra `doctor`.

Todo en bita es local: no hay red, ni token, ni cuota. Un comando de lectura no
cuesta nada, así que consulta las veces que haga falta.

## El contador arranca antes de saber nada

El flujo normal es: abrir el agente de código sobre `~/dev`, **arrancar el
contador en blanco** con `/bita-start`, y solo entonces escribir el encargo.
Planear es trabajo y el reloj ya está corriendo mientras se planea.

Eso significa que **el contador nace sin título y sin proyecto**, y que
rellenarlo es tarea tuya:

1. El hook `prompt-submit` te avisa en cada turno mientras siga sin título.
2. **En cuanto un mensaje diga en qué se va a trabajar, rellénalo — antes de
   explorar y antes de planear.** No esperes al final.

   ```
   bita amend --draft --title "<titulo corto>" --project <nombre o id>
   ```

El título es lo que identifica la entrada después, y tally lo usa para agrupar
las horas: corto, reconocible y en el idioma en que se buscaría.

## Un repo no es un proyecto

Los proyectos son **grupos con varios repos dentro**, y el grupo no tiene `.git`:
lo tienen los repos.

```
gitlab.com/vivaaerobus/vb_solemti/apartados/api      ─┐
gitlab.com/vivaaerobus/vb_solemti/apartados/front    ─┤  todos son "Apartados"
gitlab.com/vivaaerobus/vb_solemti/apartados/workers  ─┘
```

El mapeo va por **prefijo de ruta**, y gana el más largo que empate:

```
bita repo show                       qué prefijo empató aquí y a qué proyecto
bita scope list                      todos los prefijos
bita scope set <prefijo|.> <id>      mapear
bita scope unset <prefijo|.>         desmapear
bita repo init [ruta] [--name "…"]   crear el proyecto de un repo y mapearlo
```

Si no hay prefijo, se propone por nombre de segmento. **Enseña siempre el prefijo
que se va a guardar antes de confirmarlo**: empatar un segmento ancho como
`vivaaerobus` guardaría un prefijo que se traga toda la organización.

Los proyectos se administran con `bita projects` y `bita project
add|show|rename|archive|delete`. A qué tablero de Jira van las horas de un
proyecto ya no es cosa de bita: es `tally map`.

## Cuándo proponerlo

El criterio es **la forma del resultado, no la del prompt**. Propón cronómetro
cuando la sesión vaya a dejar un **artefacto**: un commit, un archivo, un recurso
desplegado, una migración, una MR, una causa raíz diagnosticada. No lo propongas
cuando solo vaya a producir una respuesta: explicar, leer, buscar, comparar.

**La regla puente:** si el trabajo va a entrar en un worktree, propón el
cronómetro. El `CLAUDE.md` del usuario ya define que toda tarea que modifique el
repo va en su propio worktree y que leer no lo necesita. Ese límite ya existe.

Propón **cuando el trabajo empieza**, justo antes de la primera edición, no
cuando se menciona el tema: si no, el reloj corre durante la deliberación. Una
sola vez por tema, en una línea. Si dice que no, no vuelvas a preguntar en esa
sesión. **Nunca arranques sin un sí explícito.**

## Arrancar

```
bita start                    # en blanco, al principio de la sesión
bita start "<título corto>"   # o con título, si ya se sabe
bita start "<título>" --at 09:30   # si empezó hace un rato
```

El proyecto sale del repo mapeado; si no lo está, el CLI falla con
`REPO_NOT_MAPPED` y el comando exacto para arreglarlo. `--project` lo fuerza.

**Pueden correr varios cronómetros a la vez** y `start` nunca se niega. Eso es
deliberado: mide dos trabajos en paralelo en vez de forzar una elección falsa.

## Reuniones

Una reunión lleva tipo, para que recap la grabe por los eventos de bita:

```
bita start "<título>" --kind remote-meeting      # Meet, Zoom, Teams, llamada, videollamada
bita start "<título>" --kind in-person-meeting   # presencial, en sala, en oficina
bita amend <id> --kind remote-meeting            # a un contador que ya corre
bita amend <id> --kind none                      # deja de ser reunión
```

Elige el tipo por el contexto; si no queda claro si es remota o presencial,
pregunta solo eso. `start`, `stop`, `cancel` y `amend` disparan los eventos que
escucha recap: arrancar graba, parar procesa la grabación y cancelar la
descarta. `meta.hooksFired` dice cuántos suscriptores se lanzaron; si es 0 en
una reunión, nadie está grabando, así que dilo. `bita hooks` lista los
suscriptores; si recap no aparece, sugiere instalarlo
(`npm i -g @kikedealba/recap && recap setup`) antes de prometer que se grabará.

Al **parar** una reunión no documentes nada: `bita stop <id> --json` y después
`recap wait --bita-entry <id> --json`. Lo demás —título, proyecto, minuta,
pendientes— lo hace recap, y su skill explica cómo reportarlo.

## Varios a la vez, y cuándo partir

1. **Cambia el proyecto → arranca otro cronómetro.** El proyecto decide a qué
   tablero van las horas; equivocarse manda horas al equipo de al lado.
2. Mismo proyecto, tema distinto, y lo nuevo dura ≥20 min → arranca otro.
3. Mismo proyecto, mismo tema → déjalo correr.
4. Interrupciones de menos de ~10 min → déjalo correr. Partir en bloques de
   cuatro minutos hace las horas ilegibles.

**Solo cuenta el tiempo atendido.** Un despliegue que tarda 40 minutos solo con
el usuario encima cuenta; si se fue, no. Ante la duda, pregunta antes de parar.

Con varios corriendo, `bita ls` los enseña con su id. Para saber qué hay abierto
antes de proponer nada, míralo: es gratis.

## Mientras el reloj corre: documentar es de inkwell

bita no guarda notas. Lo que se hizo, por qué y cómo se verifica se escribe en
la **nota de la entrada** con inkwell, mientras el trabajo pasa y no al final:

```
inkwell note save <entryId> --section "Qué se hizo" --md -
```

El cuerpo entra por `--md <archivo>` o por stdin con `--md -`, nunca por `argv`.
Cómo se escribe, qué secciones lleva y qué va a una página o al backlog lo dice
la skill de inkwell; síguela.

El hook `checkpoint` de bita avisa cuando un cronómetro lleva tres archivos
tocados o cuarenta y cinco minutos desde el último aviso. Es un recordatorio: si
no hay nada que valga la pena contar, sigue.

## Parar

```
bita stop <id>
bita stop --last          # el último que arrancó
bita stop --all           # todos
bita stop <id> --at 18:15 # si terminó hace un rato
```

**Pasa siempre el id cuando haya más de uno corriendo.** Sin id y con varios
abiertos, `stop` falla con `AMBIGUOUS_TIMER` en vez de adivinar.

Antes de parar, deja la nota al día con inkwell (si está instalado). Parar es el
último paso, no el primero.

**Antes de parar, los repos del proyecto.** Si no es una reunión, corre
`bita project repo suggest <id> --json`: da las raíces git de los archivos que
tocó el bloque, cuántos archivos en cada una (`files`) y si ya pertenecen al
proyecto (`mapped`). Por cada una sin mapear que de verdad sea del proyecto:

```
bita project repo add <path> --project <X> --source stop
```

Solo esas: si trabajando en CoDi tocaste bita-cli de paso, bita-cli no se mapea
a CoDi. Ante la duda, déjalo fuera. `bita stop --json` repite en
`meta.repoSuggestions` las que siguen sin mapear.

## Bloques que ya pasaron

```
bita log "<título>" --from HH:MM --to HH:MM
bita log "<título>" --from HH:MM --for 1h30m
```

**Si falta la hora de inicio o no se sabe cuánto duró, pregunta**: no inventes un
horario, porque esto acaba como un worklog con hora real en Jira. Enseña en una
línea lo que vas a registrar y espera un sí. Si el bloque pisa horas ya
registradas, dilo: el solape está permitido, pero casi siempre significa que la
hora está mal.

## Corregir, unir y borrar

```
bita amend <id|--draft> --title "…" --project X --kind K|none
bita merge <ids...> --dry-run                      enseña cómo quedaría
bita merge <ids...> [--into <id>] [--title "…"] [--project X]
bita delete <ids...> --dry-run
bita delete <ids...> --yes
bita cancel <id>                                   descarta un cronómetro que corre
```

- `amend` cambia los metadatos. Cualquier cambio de título, proyecto o tipo
  dispara el evento `amend`, que es lo que usa inkwell para renombrar o mover la
  nota.
- `merge` une varios contadores que eran un mismo trabajo —la misma sesión
  partida, o títulos distintos para la misma tarea—. Queda **una entrada** con
  cada bloque original como segmento, así que tally manda una sola tarea con un
  worklog por bloque. Solo entradas paradas. Los ids de los segmentos responden
  `ENTRY_MERGED`: después se opera sobre la que queda. **Pide confirmación**
  enseñando el `--dry-run`.
- `delete` borra entradas que nunca debieron existir y no se puede deshacer:
  enseña el `--dry-run` y espera un sí. bita ya no sabe qué llegó a Jira; si la
  entrada ya se volcó, el worklog sigue allá y tally es quien lo sabe
  (`tally summary`).
- `cancel` es para un cronómetro que sigue corriendo y no debió arrancar.

## Consultar

```
bita ls                         lo que corre ahora
bita entries today|yesterday|week|last-week|month|last-month
bita entries --from YYYY-MM-DD --to YYYY-MM-DD
bita entries get <id>           una entrada con sus bloques
```

Todos aceptan `--json`. El reporte de horas listo para Jira es `tally summary`.

## Pasar las horas a Jira

No es de bita. La skill de tally tiene el procedimiento completo (épica,
historia, subtarea, estimación, un worklog por bloque, cierre y `tally link`).
bita solo le da las entradas con `bita entries --json`.

::: agent codex
## Los avisos de bita en Codex

`bita setup` instala en `~/.codex/hooks.json` un solo hook, `bita hook codex`,
para `SessionStart`, `UserPromptSubmit` y `PostToolUse`. Al empezar la sesión
dice si el repo está mapeado y qué corre; en cada prompt recuerda rellenar un
borrador sin título; y después de cada herramienta registra los archivos que se
tocaron y, si toca, el recordatorio de `checkpoint`.
:::

::: agent opencode
## Los avisos de bita en OpenCode

`bita setup` enlaza el plugin `bita` en la carpeta de plugins de OpenCode. El
plugin llama a `bita hook session-start`, `prompt-submit` y `checkpoint` para el
contexto de la sesión, y a `bita hook touched` después de cada herramienta que
escribe un archivo.
:::

::: agent gemini
## Los avisos de bita en Gemini CLI

`bita setup` escribe la extensión `bita` en `~/.gemini/extensions/bita`, con un
hook `bita hook gemini` para `SessionStart`, `BeforeAgent` y `AfterTool`. Hace
lo mismo que en los otros agentes: contexto al empezar, recordatorio de
borrador en cada prompt y registro de archivos tocados.
:::
