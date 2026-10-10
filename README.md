# bita

Cronómetro de trabajo local, en SQLite, pensado para que los agentes de código
lo lean y lo escriban. Mide el trabajo mientras ocurre: cronómetros, entradas y
proyectos. **Nada más.**

El nombre viene de bitácora.

## Qué es de bita y qué no

Desde la 1.0, bita solo lleva el tiempo. Lo demás vive en su propia herramienta,
y se encuentran entre ellas con [`@kikedealba/kit`](https://github.com/KikeDeAlba/kit):

| Para | Herramienta |
|---|---|
| Cronómetros, entradas, proyectos y repos | **bita** |
| Documentar el trabajo: la nota de cada entrada, páginas, backlog, diagramas, PDF | [inkwell](https://github.com/KikeDeAlba/inkwell) |
| Agrupar el tiempo y volcarlo a Jira | [tally](https://github.com/KikeDeAlba/tally) |
| Jira y Confluence directos | [atl](https://github.com/KikeDeAlba/atl) |
| Grabar reuniones y sacar la minuta | [recap](https://github.com/KikeDeAlba/recap) |

Los comandos que se fueron fallan con `UNKNOWN_COMMAND` (salida 2) y una pista
hacia la herramienta correcta:

| Antes | Ahora |
|---|---|
| `bita note …`, `bita notes …` | `inkwell note …` |
| `bita docs …`, `bita backlog …`, `bita diagrams …` | `inkwell …` |
| `bita summary`, `bita groups`, `bita map …`, `bita link …`, `bita config …` | `tally …` |
| `bita jira …`, `bita confluence …`, `bita atlassian …` | `atl …` (la sincronización de páginas, `inkwell confluence …`) |
| `bita meeting …` | `recap …` |
| `bita project jira\|atlassian\|key` | `tally map`, `atl site`, `inkwell backlog` |
| `bita start/stop/log … --did/--page/--page-new/--note-md` | `inkwell note save <id> --section … --md -` |

### Los datos de antes

Actualizar a la 1.0 **no borra nada**. Las tablas de documentos, páginas,
backlog y enlaces a Jira siguen en `bita.db` (las bases nuevas también las
crean), el repo de documentos sigue en disco y `~/.config/bita/config.json`
conserva las claves que bita ya no usa (`atlassian`, `jira`, `projectMapping`,
historias, temas…): bita las reescribe tal cual cada vez que guarda un prefijo.
De ahí las copian las otras herramientas:

```sh
atl site import --from-bita
inkwell migrate --from-bita
inkwell migrate notes --from-bita
tally migrate --from-bita
```

Si `config.json` no es JSON válido, bita no lo reescribe: falla con un error que
dice por qué.

## Requisitos

**Node 24 o superior.** bita usa `node:sqlite` y el borrado de tipos nativo, así
que desde un clon corre los `.ts` sin compilar.

La única dependencia es `@kikedealba/kit`, y se carga solo cuando hace falta:
`setup`, `doctor` y el disparo de eventos. Los comandos de siempre corren sin
`node_modules`; sin kit, los eventos se reparten solo a los hooks de
`config.json`.

El paquete de npm sí lleva JavaScript compilado: node **se niega** a borrar
tipos en archivos bajo `node_modules`. El build es un `tsc` que solo borra los
tipos (`erasableSyntaxOnly`) y reescribe las extensiones de los imports.

## Instalación

### Desde npm

```sh
npm install -g @kikedealba/bita
bita setup
```

`bita setup` hace dos cosas:

1. **Registra bita** en el registro de kit
   (`~/.config/kikedealba/tools.d/bita.json`, o `KIT_REGISTRY_DIR`), con la
   línea de comando absoluta, sus capacidades (`time.entries.read`,
   `time.entries.write`, `time.events`) y los eventos que emite (`start`,
   `stop`, `cancel`, `amend`, `delete`, `merge`). Así lo encuentran recap,
   inkwell, tally y Den sin depender del `PATH`. `--no-register` se lo salta.
2. **Instala la integración** con los agentes de código que encuentre: Claude
   Code, OpenCode, Codex y Gemini CLI.

```sh
bita setup --target claude
bita setup --target codex,gemini
bita setup --target all
```

| Agente | Qué recibe |
|---|---|
| Claude Code | `~/.claude/skills/bita`, `~/.claude/commands` y los permisos y hooks en `settings.json` |
| OpenCode | `~/.config/opencode/skills/bita`, `commands` y `plugins/bita.*` |
| Codex | `~/.agents/skills/bita`, `~/.codex/prompts` y `~/.codex/hooks.json` |
| Gemini CLI | La extensión `~/.gemini/extensions/bita`: skill, comandos y hooks (`bita hook gemini`) |

Al actualizar desde una versión anterior, `setup` también quita lo que ya no es
de bita: el comando `/bita-check`, el hook `bita hook ref` y los permisos de
Claude de los comandos que se fueron. **No toca** un MCP de Atlassian que ya
esté configurado: bita ya no lo instala, pero tampoco lo quita.

Hay una sola skill (`skill/SKILL.md`); lo que solo aplica a un agente va en
bloques `::: agent <nombre>` y kit genera la copia de cada uno. **Después de
actualizar bita, vuelve a correr `bita setup`** para que los agentes lean la
skill nueva.

`--no-settings` omite los permisos y hooks de Claude. `--no-atlassian`,
`--no-docs-git`, `--no-drawio` y `--no-recap` se aceptan y se ignoran con un
aviso.

### Cómo se publica

Nadie publica a mano. Al publicar una release en GitHub, el workflow
`.github/workflows/publish.yml` corre el typecheck y las pruebas, comprueba que
el tag y la versión de `package.json` coinciden, **instala el tarball como lo
haría una persona y lo ejecuta**, y hace `npm publish --provenance`. Hace falta
el secreto `NPM_TOKEN` en el repositorio.

### Desde el repositorio

```sh
git clone git@github.com:KikeDeAlba/bita-cli.git
cd bita-cli
pnpm install
./scripts/install.sh --target all
```

El instalador instala las dependencias si faltan, enlaza `bita` en tu
directorio de binarios (`$PNPM_HOME/bin` o `~/.local/bin`; `BITA_BIN_DIR` lo
cambia) y corre `bita setup`. Es idempotente.

### Comprobar

```sh
bita --version
bita projects
bita doctor
```

La base se crea sola en `~/.local/share/bita/bita.db` al primer uso.
`BITA_DB_PATH` la mueve a otro sitio, que es también la forma de probar cosas
sin tocar la real. `BITA_CONFIG_PATH` hace lo mismo con la configuración
(`~/.config/bita/config.json`).

`bita doctor` dice qué herramientas hermanas encontró kit y cómo instalar las
que faltan.

### Dar de alta un repositorio

Esto es lo que enciende la integración con el agente:

```sh
bita repo init                     # el repositorio actual
bita repo init ~/dev/otro/repo     # o el que le pases
```

El nombre del proyecto sale de la carpeta; `--name "Otro nombre"` lo cambia. Si
ya existe un proyecto con ese nombre **lo reutiliza**. En dos pasos:

```sh
bita project add "Mi proyecto"     # devuelve un id
bita scope set . <projectId>
```

**Mientras un repositorio no esté mapeado, el hook no dice nada.** En cuanto lo
está, al abrir una sesión del agente se inyecta la regla que le pide ofrecer el
cronómetro cuando el trabajo vaya a dejar un artefacto, y callarse cuando solo
vayas a leer o preguntar.

## Uso

```sh
bita start "Despliegue de infraestructura"   # arranca; puede haber varios
bita ls                                      # qué está corriendo ahora
bita stop 12                                 # para uno
bita log "Sesión con QA" --from 14:00 --for 1h
bita amend 12 --title "Otro título" --project Apartados
bita merge 12 13 --dry-run
bita delete 12 --dry-run
bita entries week
bita entries get 12 --json
```

`bita --help` lista todo.

### Contadores en blanco

El caso normal es arrancar el reloj **antes de saber en qué se trabaja**:

```sh
cd ~/dev && bita start        # sin título y sin proyecto
```

Eso crea un borrador, que se rellena después y en buena parte solo:

| Qué | Quién lo pone |
|---|---|
| Título | El agente, en cuanto un mensaje dice en qué se va a trabajar |
| Proyecto | El agente por el prompt, o el hook por el primer archivo que se cambia |
| Archivos tocados | El hook, en cada edición |

El hook `prompt-submit` recuerda que hay un contador sin nombre y se calla en
cuanto lo tiene. A mano:

```sh
bita amend --draft --title "Lo que sea" --project Apartados
```

### Borrar y cancelar

`bita cancel <id>` descarta un cronómetro que sigue corriendo. `bita delete
<ids...>` quita entradas paradas que nunca debieron registrarse, con sus
archivos tocados. Se niega si una sigue corriendo (remite a `cancel`), si es un
bloque de una entrada unificada, o si un id no existe; en todos los casos antes
de borrar ninguna. Sin terminal —o con `--json`— exige `--yes`, y `--dry-run`
describe lo que pasaría sin escribir nada.

bita ya no sabe qué entradas llegaron a Jira: eso lo lleva tally. Borrar una
entrada que ya se volcó no toca el worklog que quedó en Jira.

`bita project delete <id|nombre>` borra un proyecto y los prefijos de `scope`
que apuntaban a él. Se niega si tiene entradas, porque borrarlo las deja sin
proyecto; `--force` acepta ese resultado y `bita project archive` es la
alternativa cuando el histórico importa.

### Unificar contadores

Un mismo trabajo acaba a veces repartido en varios contadores. `bita merge` los
junta en una sola entrada:

```sh
bita merge 774 776 --dry-run
bita merge 774 776 [--into 774] [--title "…"] [--project X]
```

Sobrevive la más antigua, o la de `--into`, con su título y su proyecto salvo
que se pasen otros, y hereda los archivos tocados de todas. **Cada contador
original queda como segmento** con su inicio y su fin reales. Solo se unifican
entradas paradas. Después se opera sobre la entrada que quedó: `amend` y
`delete` rechazan un segmento con `ENTRY_MERGED`, y borrar la entrada se lleva
sus segmentos.

### Formato de salida

Todos los comandos aceptan `--json` y emiten un solo documento en stdout:

```json
{ "schemaVersion": 3, "ok": true, "command": "entries", "data": [], "meta": {} }
```

Los errores salen con `ok: false` y un `error.code` estable (`USAGE_ERROR`,
`UNKNOWN_COMMAND`, `ENTRY_NOT_FOUND`, `AMBIGUOUS_TIMER`, …), con `error.hint`
cuando hay algo concreto que hacer. Los avisos van a stderr.

## Reuniones

Una entrada puede llevar un **tipo** (`kind`), texto libre en minúsculas con
guiones. bita no le da significado; sirve para que otras herramientas reaccionen.
[recap](https://github.com/KikeDeAlba/recap) graba la reunión mientras corre el
contador:

```sh
bita start "Planeación sprint 42" --kind remote-meeting
bita start "1:1 con Ana" --kind in-person-meeting
bita amend 812 --kind remote-meeting     # a uno que ya corre
bita amend 812 --kind none               # quitarlo
```

## Eventos y hooks

bita emite un evento cuando un contador arranca (`start`), se para (`stop`), se
cancela (`cancel`), cambia de título, proyecto o tipo (`amend`), se borra
(`delete`) o absorbe a otros (`merge`). Lo escuchan:

- **Herramientas instaladas**, que se suscriben desde su propio manifiesto en el
  registro de kit. recap escucha las reuniones; inkwell crea, renombra, mueve y
  borra la nota de cada entrada.
- **Hooks manuales** en `~/.config/bita/config.json`:

```sh
bita hooks add --on start,stop --kind remote-meeting -- /ruta/absoluta/comando
bita hooks             # los manuales y los suscriptores del registro
bita hooks remove 1
```

- El comando recibe por stdin un JSON con `schemaVersion`, `event`, `source`
  (`"bita"`), `entry` (la entrada enriquecida, con `kind`), `previousKind`,
  `docPath` (siempre `null`), `pageIds` (siempre `[]`), `databasePath`,
  `docsRoot`, `firedAt`; en `amend`, además `previousTitle` y
  `previousProjectId`; en `merge`, `mergedIds` (las entradas absorbidas;
  `entry` es la que queda). También recibe `KIT_EVENT`, `KIT_EVENT_SOURCE`,
  `BITA_HOOK_EVENT`, `BITA_ENTRY_ID`, `BITA_ENTRY_KIND`, `BITA_DB_PATH` y
  `BITA_DOCS_DIR`.
- `amend` solo se dispara si algo cambió de verdad.
- Corre desacoplado: bita espera solo a entregarle el JSON, nunca a que termine,
  y un oyente que falla no hace fallar el comando. Su salida va a `hooks.log`,
  junto a la base de datos.
- **Usa rutas absolutas**: Den lanza el CLI con un `PATH` mínimo.
- `BITA_NO_HOOKS=1` o `KIT_NO_EVENTS=1` los apagan todos; `meta.hooksFired` dice
  cuántos se lanzaron.

### Para otras herramientas

```sh
bita capabilities --json       # nombre, versión, sobre, capacidades y eventos
bita entries --json            # entradas de un rango, con sus segmentos
bita entries get <id> --json   # { id, description, kind, projectId, projectName, startedAt, stoppedAt, durationSeconds, mergedInto, segments }
```

Las entradas ya no traen `registered`, `issueKey` ni `jira`, ni `entries get`
trae `note`: eso es de tally y de inkwell.

## Proyectos y repositorios

**Un repo no es un proyecto.** Los proyectos suelen ser grupos con varios repos
dentro, y el grupo no tiene `.git`: lo tienen los repos. El mapeo va por
**prefijo de ruta**, y gana el más largo que empate:

```sh
bita scope set gitlab.com/vivaaerobus/vb_solemti/apartados 42
bita scope which .        # qué prefijo empata aquí
bita scope list
```

El empate es por segmentos, así que `.../apartados` nunca cubre
`.../apartados-legacy`. Si no hay prefijo, `bita repo init` propone uno
comparando los segmentos de la ruta con los nombres de proyecto que ya existen.

### Los repos locales de cada proyecto

Aparte, bita guarda **en qué rutas locales vive el código de cada proyecto**,
para que otras herramientas sepan en qué repos buscar:

```sh
bita project repo ls [--project CoDi] [--json]
bita project repo add ~/dev/codi/api --project CoDi
bita project repo rm ~/dev/codi/api
bita project repo suggest 412 --json                 # raíces git de lo que tocó la entrada 412
bita project repo suggest --project CoDi --history   # lo mismo sobre todas sus entradas
```

`bita stop --json` repite en `meta.repoSuggestions` las raíces sin mapear de lo
que tocó el bloque.

## Solapes

Los cronómetros simultáneos están permitidos, así que un día puede sumar más
tiempo del que marca el reloj. `entries` lo avisa:

```
Warning: 2026-09-19: 4h 8m tracked over 3h 7m of clock time (1h overlapping)
```

## Los comandos del agente

| Comando | Qué hace |
|---|---|
| `/bita-start [título]` | Arranca un cronómetro, en blanco o con título |
| `/bita-stop [id]` | Deja la nota al día con inkwell y para. Con varios abiertos, pregunta cuál |
| `/bita-timers` | Qué está corriendo y cuánto llevas hoy |
| `/bita-log <texto>` | Registra un bloque que ya pasó |
| `/bita-init [ruta]` | Da de alta un repositorio: crea su proyecto y lo mapea |
| `/bita-amend [id]` | Rellena a mano el título, el proyecto o el tipo de un cronómetro |

## Desarrollo

```sh
pnpm typecheck
pnpm test
```

Los tests corren con `node --test` sobre los `.ts` directamente.
`test/helpers/isolate.ts` apunta `KIT_REGISTRY_DIR` a un directorio temporal, y
`test/kit.test.ts` corre las pruebas de conformidad de kit.

## Estructura

```
src/db/        el almacén: esquema, migraciones y consultas
src/domain/    lógica pura: duraciones, zonas horarias, rangos, solapes
src/cli/       comandos y formato de salida
src/state/     configuración y repos de git
src/hooks/     los eventos: suscriptores del registro de kit y hooks de config.json
src/kit/       el manifiesto de bita, sus capacidades y la integración con los agentes
src/integrations/ el plugin de OpenCode
skill/         la skill, con bloques por agente
commands/      los slash commands
scripts/       el instalador
```
