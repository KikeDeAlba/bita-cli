---
name: bita
description: >-
  Referencia de bita, el cronómetro de trabajo: qué corre, bloques olvidados,
  correcciones y consultas. Las sesiones las cronometra `bita session`, no el
  agente.
disable-model-invocation: true
---

# bita

bita es el cronómetro y nada más; su registro local es la fuente de la verdad de
las horas (nunca las estimes desde commits). Todo es local: consultar no cuesta.

Quién hace qué: inkwell documenta (notas y páginas), tally vuelca las horas a
Jira, atl habla con Jira y Confluence, recap graba reuniones. Si falta una,
`bita doctor` dice cuáles están y cómo instalarlas.

## Las sesiones se cronometran solas

El agente no arranca, parte ni para cronómetros. Lo hace `bita session`, que
envuelve al harness (la función de shell `claude` que instala
`bita setup --shell zsh`):

1. Pregunta el harness y el proyecto, y arranca una entrada en blanco.
2. Lanza la sesión. Con `/clear` o `/resume` cierra la entrada y abre otra del
   mismo proyecto.
3. Al cerrar la sesión, el mismo harness rellena el título, el tipo y la nota de
   inkwell a partir del transcript, y la entrada se para con la hora exacta.

Los archivos que se editan durante la sesión quedan ligados a su entrada. Nunca
crean, parten ni paran entradas.

## Un repo no es un proyecto

Un proyecto es un grupo con varios repos dentro. El mapeo va por prefijo de
ruta y gana el más largo:

```
bita repo show                       qué prefijo empató aquí y a qué proyecto
bita scope list | set <prefijo|.> <id> | unset <prefijo|.>
bita repo init [ruta] [--name "…"]   crear el proyecto de un repo y mapearlo
```

Un prefijo ancho (`vivaaerobus`) se traga toda la organización. A qué tablero de
Jira van las horas es `tally map`, no bita.

## Cronómetros a mano

Para lo que no pasa por una sesión (reuniones, trabajo fuera del agente):

```
bita start ["<título>"] [--at 09:30] [--project X]
bita ls                              lo que corre, con ids
bita stop <id> | --last | --all [--at 18:15]
bita cancel <id>                     descarta uno que no debió arrancar
```

El proyecto sale del repo mapeado; si no lo está, el CLI falla con
`REPO_NOT_MAPPED` y dice cómo arreglarlo. Con más de uno corriendo, `stop` pide
el id (sin id falla con `AMBIGUOUS_TIMER`). `/bita-start` y `/bita-stop` envuelven
estos comandos.

## Reuniones

```
bita start "<título>" --kind remote-meeting      # Meet, Zoom, Teams, llamada
bita start "<título>" --kind in-person-meeting   # presencial
bita amend <id> --kind remote-meeting|in-person-meeting|none
```

Los eventos de bita hacen que recap grabe; si `meta.hooksFired` es 0, nadie
graba. Al parar una reunión, `recap wait --bita-entry <id> --json` espera la
minuta.

## Bloques que ya pasaron

```
bita log "<título>" --from HH:MM --to HH:MM
bita log "<título>" --from HH:MM --for 1h30m
```

El bloque acaba como worklog con hora real en Jira: la hora de inicio y la
duración tienen que ser las reales. `/bita-log` lo registra.

## Corregir, unir y borrar

```
bita amend <id|--draft> --title "…" --project X --kind K|none
bita merge <ids...> --dry-run        luego sin --dry-run, con [--into <id>] [--title "…"]
bita delete <ids...> --dry-run       luego --yes
```

- `amend` dispara el evento que inkwell usa para renombrar o mover la nota.
- `merge` une entradas paradas que eran un mismo trabajo en una sola, con cada
  bloque como segmento.
- `delete` no se deshace. Si ya se volcó a Jira, el worklog sigue allá (eso lo
  sabe tally).

## Consultar

```
bita ls --json
bita entries today|yesterday|week|last-week|month|last-month --brief --json
bita entries --from YYYY-MM-DD --to YYYY-MM-DD --brief --json
bita entries get <id> --json         una entrada con sus bloques
bita report week --json              horas por proyecto, día y semana [--project X] [--entries]
```

`--brief` deja solo id, título, proyecto, inicio, fin y segundos. Volcar a Jira
no es de bita: es de tally.
