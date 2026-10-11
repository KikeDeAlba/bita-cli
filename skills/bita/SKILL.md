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

bita es el cronómetro y nada más; su registro local es la fuente de la verdad de
las horas (nunca las estimes desde commits). Todo es local: consultar no cuesta.

Quién hace qué: inkwell documenta (notas y páginas), tally vuelca las horas a Jira, atl habla con Jira y Confluence, recap graba reuniones.

Si falta una de esas herramientas, no improvises su trabajo con bita: `bita doctor`
dice cuáles están y cómo instalarlas.

## El contador nace en blanco

Lo normal es arrancar con `/bita-start` antes del encargo: planear también es
trabajo. El contador queda sin título ni proyecto, y rellenarlo es tarea tuya
**en cuanto un mensaje diga en qué se trabaja, antes de explorar o planear**:

```
bita amend --draft --title "<titulo corto>" --project <nombre o id>
```

El hook de bita lo recuerda en cada prompt mientras siga sin título. El título
identifica la entrada y tally lo usa para agrupar: corto y reconocible.

## Un repo no es un proyecto

Un proyecto es un grupo con varios repos dentro. El mapeo va por prefijo de
ruta y gana el más largo:

```
bita repo show                       qué prefijo empató aquí y a qué proyecto
bita scope list | set <prefijo|.> <id> | unset <prefijo|.>
bita repo init [ruta] [--name "…"]   crear el proyecto de un repo y mapearlo
```

Enseña el prefijo antes de guardarlo: uno ancho (`vivaaerobus`) se traga toda la
organización. A qué tablero de Jira van las horas es `tally map`, no bita.

## Cuándo proponerlo

Por la forma del resultado: propón cronómetro si la sesión va a dejar un
artefacto (commit, archivo, despliegue, migración, MR, causa raíz). No para
explicar, leer, buscar o comparar. Si el trabajo entra en un worktree, propónlo.
Hazlo justo antes de la primera edición, una vez por tema y en una línea. Si
dice que no, no insistas. **Nunca arranques sin un sí explícito.**

## Arrancar y parar

```
bita start ["<título>"] [--at 09:30] [--project X]
bita ls                              lo que corre, con ids
bita stop <id> | --last | --all [--at 18:15]
bita cancel <id>                     descarta uno que no debió arrancar
```

El proyecto sale del repo mapeado; si no lo está, el CLI falla con
`REPO_NOT_MAPPED` y dice cómo arreglarlo. Pueden correr varios a la vez:

1. Cambia el proyecto → otro cronómetro (equivocarse manda horas a otro tablero).
2. Mismo proyecto, tema distinto de ≥20 min → otro.
3. Mismo tema, o interrupción de menos de ~10 min → déjalo correr.

Solo cuenta el tiempo atendido. Con más de uno corriendo, pasa siempre el id a
`stop` (sin id falla con `AMBIGUOUS_TIMER`).

**Antes de parar** (si no es reunión):

1. Deja la nota de la entrada al día con inkwell. Cómo se escribe:
   `inkwell guide entry-notes`.
2. `bita project repo suggest <id> --json` y, por cada raíz sin mapear que de
   verdad sea del proyecto, `bita project repo add <path> --project <X> --source stop`.
   Lo que se tocó de paso no se mapea. Ante la duda, fuera.

## Reuniones

```
bita start "<título>" --kind remote-meeting      # Meet, Zoom, Teams, llamada
bita start "<título>" --kind in-person-meeting   # presencial
bita amend <id> --kind remote-meeting|in-person-meeting|none
```

Si no se sabe si es remota o presencial, pregunta solo eso. Los eventos de bita
hacen que recap grabe; si `meta.hooksFired` es 0, nadie graba: dilo. Al parar
una reunión no documentes: `bita stop <id> --json` y luego
`recap wait --bita-entry <id> --json`; lo demás es de recap y su skill.

## Bloques que ya pasaron

```
bita log "<título>" --from HH:MM --to HH:MM
bita log "<título>" --from HH:MM --for 1h30m
```

Si falta la hora de inicio o la duración, pregunta: acaba como worklog con hora
real en Jira. Enseña en una línea lo que vas a registrar y espera un sí. Si pisa
horas registradas, dilo.

## Corregir, unir y borrar

```
bita amend <id|--draft> --title "…" --project X --kind K|none
bita merge <ids...> --dry-run        luego sin --dry-run, con [--into <id>] [--title "…"]
bita delete <ids...> --dry-run       luego --yes
```

- `amend` dispara el evento que inkwell usa para renombrar o mover la nota.
- `merge` une entradas paradas que eran un mismo trabajo en una sola, con cada
  bloque como segmento. Enseña el `--dry-run` y pide confirmación.
- `delete` no se deshace: enseña el `--dry-run` y espera un sí. Si ya se volcó a
  Jira, el worklog sigue allá (eso lo sabe tally).

## Consultar

```
bita ls --json
bita entries today|yesterday|week|last-week|month|last-month --brief --json
bita entries --from YYYY-MM-DD --to YYYY-MM-DD --brief --json
bita entries get <id> --json         una entrada con sus bloques
```

Usa siempre `--brief` (id, título, proyecto, inicio, fin, segundos). Volcar a
Jira no es de bita: es la skill de tally.
