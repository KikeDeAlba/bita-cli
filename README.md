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
   `time.entries.write`, `time.events`, `time.report.read`) y los eventos que emite (`start`,
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
| Claude Code | El plugin `bita` del marketplace `bita` (este repositorio): skill, skills de usuario y hooks. En `settings.json` solo quedan los permisos de `bita` |
| OpenCode | `~/.config/opencode/skills/bita`, `commands` y `plugins/bita.*` |
| Codex | `~/.agents/skills/bita`, `~/.codex/prompts` y `~/.codex/hooks.json` (el `PostToolUse` solo para las herramientas que editan) |
| Gemini CLI | La extensión `~/.gemini/extensions/bita`: skill, comandos y hooks (`bita hook gemini`) |

### El plugin de Claude Code

En Claude Code, `bita setup` corre `claude plugin marketplace add
KikeDeAlba/bita-cli`, `claude plugin marketplace update bita` y `claude plugin
install bita@bita` (o `update` si ya estaba). A mano, dentro de Claude Code:

```
/plugin marketplace add KikeDeAlba/bita-cli
/plugin install bita@bita
```

El plugin trae:

- **La skill `bita`**, de referencia (`disable-model-invocation: true`): el
  modelo no la invoca. Las sesiones las cronometra `bita work`, no el agente.
- **Skills de usuario** `/bita-start`, `/bita-stop`, `/bita-log`, `/bita-amend`,
  `/bita-timers` y `/bita-init`, con `disable-model-invocation: true`: no
  ocupan contexto hasta que las escribes. Reemplazan a los comandos sueltos de
  `~/.claude/commands`.
- **Hooks** (`hooks/hooks.json`), que no inyectan nada al agente:
  - `SessionStart` → `bita hook session-start` y `SessionEnd` → `bita hook
    session-end`: ligan la sesión del agente con la entrada que abrió `bita
    work` y rotan la entrada con `/clear` o `/resume`. Sin `bita work` de por
    medio, no hacen nada.
  - `PostToolUse` en `Edit|Write|MultiEdit` → `bita hook touched`, asíncrono:
    lee la ruta del JSON del hook y registra el archivo sin bloquear al agente.

`bita setup --mod` instala además el plugin `bita-timer` (la banda con los
cronómetros sobre el prompt). Al pasar al plugin, `setup` quita lo que versiones
anteriores dejaron sueltas en `~/.claude`: la skill y los comandos enlazados y
los hooks de `settings.json` (incluido el de `jq`). Si `claude` no está en el
`PATH`, no quita nada y dice qué correr. `bita hook prompt`, `bita hook
prompt-submit` y `bita hook checkpoint` ya no hacen nada; siguen respondiendo
(sin salida) para que las instalaciones viejas no fallen.

En OpenCode, si `claude-compat` todavía reejecuta los hooks y comandos viejos de
`~/.claude`, kit no instala los de bita para que no corran dos veces.

### La línea de estado de Claude Code

`bita statusline` imprime una línea con los cronómetros que corren (`#12 Título ·
Proyecto · 1h 5m`, separados por `|`) o nada. No usa red ni gasta tokens: solo
lee la base. Para verla en Claude Code, en `~/.claude/settings.json`:

```json
{ "statusLine": { "type": "command", "command": "bita statusline" } }
```

Al actualizar desde una versión anterior, `setup` también quita lo que ya no es
de bita: el comando `/bita-check`, el hook `bita hook ref` y los permisos de
Claude de los comandos que se fueron. **No toca** un MCP de Atlassian que ya
esté configurado: bita ya no lo instala, pero tampoco lo quita.

Las skills viven en `skills/`: `skills/bita` es la del modelo y las demás son
las de usuario. Para OpenCode, Codex y Gemini CLI, kit convierte las de usuario
en sus comandos y prompts. **Después de actualizar bita, vuelve a correr `bita
setup`** para que los agentes lean lo nuevo.

`--no-settings` omite los permisos de Claude y no toca su `settings.json`.
`--no-atlassian`, `--no-docs-git`, `--no-drawio` y `--no-recap` se aceptan y se
ignoran con un aviso.

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

Con el repositorio mapeado, `bita work` preselecciona su proyecto en el
selector (ver [Sesiones](#sesiones)). bita ya no le pide nada al agente.

## Uso

```sh
bita start "Despliegue de infraestructura"   # arranca; puede haber varios
bita start "Ajustar pipeline" --jira         # y pide a tally la tarjeta de Jira (--no-jira: nunca)
bita ls                                      # qué está corriendo ahora
bita stop 12                                 # para uno
bita log "Sesión con QA" --from 14:00 --for 1h
bita amend 12 --title "Otro título" --project Apartados
bita merge 12 13 --dry-run
bita delete 12 --dry-run
bita entries week
bita entries get 12 --json
bita report week                             # horas por proyecto, día y semana
```

`bita --help` lista todo.

### Contadores en blanco

El caso normal es arrancar el reloj **antes de saber en qué se trabaja**:

```sh
cd ~/dev && bita start        # sin título y sin proyecto
```

Eso crea un borrador, que se rellena después:

| Qué | Quién lo pone |
|---|---|
| Título | Tú, con `bita amend --draft` (o `/bita-amend`) |
| Proyecto | Tú, con `bita amend --draft --project` |
| Archivos tocados | El hook `touched`, en cada edición |

```sh
bita amend --draft --title "Lo que sea" --project Apartados
```

Si prefieres que el título, el tipo y la nota salgan solos, arranca el agente
con `bita work` (ver [Sesiones](#sesiones)).

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

## Sesiones

`bita work` envuelve al agente: pregunta con qué agente y en qué proyecto
trabajas, arranca el cronómetro, lanza el agente y, al cerrarlo, rellena la
entrada y la para. El agente no sabe que existe: no se le inyecta nada.
`bita session` es un alias de `bita work`.

`claude` (y los demás agentes) siguen siendo el binario normal: tecleados a
secas no abren selectores ni arrancan cronómetro.

> **Si vienes de 1.4.0.** Esa versión instalaba con `bita setup --shell` una
> función `claude` en `~/.zshrc` o `~/.bashrc`. Ya no existe: `bita setup`
> borra ese bloque (`# >>> bita session >>>` … `# <<< bita session <<<`) de
> `~/.zshrc`, de `$ZDOTDIR/.zshrc` si está definido y de `~/.bashrc`, y lo dice
> solo si borró algo. Si un archivo no se puede escribir, avisa y sigue con los
> demás. Abre una terminal nueva para que `claude` vuelva a ser el binario.

### El flujo

```sh
bita work                            # selector de agente, selector de proyecto, y a trabajar
bita work -- "arregla el pipeline"   # lo que va tras -- es para el agente
bita work --harness codex --project Apartados -- "arregla el pipeline"
bita work --resume                   # selector de sesiones terminadas en este directorio
bita work --resume 123 -- "sigue con los tests"   # reanuda la sesión de la entrada #123
```

1. **Agente.** Si hay más de uno instalado (Claude, OpenCode, Codex, Gemini),
   pregunta con Claude por defecto (Enter). Con uno solo, no pregunta.
   `--harness claude|opencode|codex|gemini` se salta el selector.
2. **Proyecto.** Lista los proyectos y preselecciona el que corresponde al
   directorio actual (el prefijo de `bita scope` o un repo de `bita project
   repo`). `0` es **sin cronómetro**: lanza el agente y no registra nada.
   `--project <id|nombre|0>` se salta el selector.
3. **Cronómetro.** Arranca una entrada en ese proyecto, sin título.
4. **Agente.** Corre con la terminal tal cual; las señales se le reenvían.
5. **Cierre.** Al salir, un proceso desacoplado resume la sesión (ver abajo).

Si la base no se abre o el cronómetro no arranca, bita avisa y lanza el agente
sin cronómetro.

### Reanudar una sesión

`bita work --resume [ENTRY_ID]` (también `bita session --resume`) reanuda una
sesión terminada. Sin id abre un selector con las sesiones lanzadas en el
directorio actual, las más recientes primero y una por sesión del agente. Con
`--resume 123` reanuda directamente la sesión de la entrada #123; es lo que hay
que usar sin terminal.

- El agente sale de la sesión; un `--harness` distinto al de la sesión es un
  error.
- El proyecto es el de la entrada original; `--project` lo cambia
  (`--project 0` reanuda sin cronómetro).
- Siempre crea una entrada **nueva**: la original, aunque ya esté subida a
  Jira, no se toca. Al salir se resume como cualquier sesión.
- El agente se lanza en el directorio original de la sesión, porque Claude y
  Gemini solo encuentran sus sesiones ahí.
- Lo que va tras `--` es para el agente (por ejemplo, un prompt). Pasar tú
  `--resume` o `--continue` ahí es un error.

### Flags por agente

Los argumentos tras `--` son los de Claude. Con otro agente, bita los traduce;
lo que no tiene equivalente se descarta con un aviso
(`bita: <Agente> has no equivalent for <flag>; dropped.`).

| Agente | Flag por defecto | `-c` / `--continue` | `-r` / `--resume [id]` | Prompt |
|---|---|---|---|---|
| Claude | `--allow-dangerously-skip-permissions` | sin cambios | sin cambios | sin cambios |
| OpenCode | `--auto` | `--continue` | `--session <id>` (sin id, se descarta) | `--prompt <texto>` |
| Codex | `--dangerously-bypass-approvals-and-sandbox` | `resume --last` | `resume [id]` | posicional |
| Gemini | `--approval-mode=yolo` | `--resume latest` | `--resume <id>` (sin id, `latest`) | `-i <texto>` |

Claude recibe tus argumentos sin tocar y solo antepone el flag por defecto si no
pasaste `--allow-dangerously-skip-permissions` ni
`--dangerously-skip-permissions`. En Gemini, un `-y`, `--yolo` o
`--approval-mode` tuyo reemplaza al por defecto.

### Terminal y sesiones anidadas

`bita work` siempre muestra los selectores; para usar el agente sin cronómetro,
llámalo directo (`claude -p …`, `claude mcp …`).

- Sin terminal (pipes, scripts, CI), los selectores no pueden preguntar: pasa
  `--harness` y `--project`, o bita avisa y sale con 130.
- Dentro de una sesión de bita (`BITA_WRAPPER_ID`) o en un proceso que lanzó el
  propio bita (`BITA_CHILD`), avisa en una línea y lanza el agente (Claude, o el
  de `--harness`) sin abrir otro cronómetro, para no anidar entradas.

### `/clear`, `/resume` y entradas

Cada conversación del agente es una entrada. Los hooks de `SessionStart`
(Claude, Codex, Gemini) y el plugin de OpenCode ven cuándo la sesión cambia:

- La primera sesión se liga a la entrada que abrió el wrapper.
- `/clear`, `/resume` o una conversación nueva **rotan**: cierran la entrada
  anterior (que se resume por separado) y abren otra en el mismo proyecto.
- `compact` y las subsesiones de OpenCode no rotan.

### Al cerrar: título, tipo y nota

Cuando termina una entrada, `bita session finalize <id>` corre desacoplado (su
salida va a `hooks.log`, junto a la base):

1. Lee la transcripción de la sesión.
2. **El mismo agente** la resume en modo no interactivo y devuelve título,
   `kind` (uno de los que ya existen) y la nota. El modelo del resumen es barato
   por agente y se cambia en `~/.config/bita/config.json`:

   | Agente | Modelo por defecto | Clave en config |
   |---|---|---|
   | Claude | `haiku` | `summary.claude.model` |
   | OpenCode | `openai/gpt-5.6-luna` | `summary.opencode.model` |
   | Codex | `gpt-5.6-luna` | `summary.codex.model` |
   | Gemini | `flash-lite` | `summary.gemini.model` |

   ```json
   { "summary": { "claude": { "model": "sonnet" } } }
   ```
3. Guarda el título y el `kind` en la entrada (no pisa los que ya tenga).
4. Escribe la nota con `inkwell note save` (contexto, qué se hizo, decisiones,
   hallazgos, verificación y pendientes) si inkwell está instalado.
5. **Para** la entrada con la hora exacta en que terminó la sesión, no la del
   resumen, y emite `stop` para tally y los demás.

El resumen tiene un plazo de 3 minutos más 15 s de gracia.

**Respaldo.** Si no hay transcripción, el resumen falla o se agota, la entrada
igual se para y recibe el título `Sesión <Agente> · <repo> · <rama>` (sin repo o
rama, lo que haya). Nunca se queda corriendo.

**Sesiones cortas.** Una sesión de menos de 60 s, sin ningún mensaje tuyo y sin
título, se **cancela**: se borra la entrada y sale `cancel` en vez de `stop`.

**Huérfanos.** Si el wrapper muere sin cerrar (terminal cerrada, `kill -9`), el
siguiente `bita work` lo detecta, termina la entrada en la última actividad
conocida (la transcripción o el último archivo tocado) y la finaliza. Los
huérfanos nunca se cancelan. Un cierre atascado se reintenta pasados 15 minutos.

### Finalizar a mano

```sh
bita session finalize 812          # cierra, resume y para la entrada 812
bita session finalize 812 --json
```

Sirve para reintentar un cierre que no corrió. Es idempotente: el estado dice
`summarized`, `fallback`, `cancelled`, `skipped` (la entrada se unificó con
otra), `busy` (otro proceso la tiene), `already-finalized` o `not-found`.

### Variables

| Variable | Qué hace |
|---|---|
| `BITA_HARNESS_BIN_CLAUDE`, `_OPENCODE`, `_CODEX`, `_GEMINI` | Ruta absoluta del ejecutable de ese agente en vez de buscarlo en el `PATH`. Si no es ejecutable, ese agente cuenta como no instalado |
| `BITA_WRAPPER_ID`, `BITA_HARNESS`, `BITA_SESSION_PROJECT` | Las pone `bita work` al agente para ligar sus hooks; no las definas tú |
| `BITA_NO_HOOKS=1`, `KIT_NO_EVENTS=1` | Apagan los eventos (`start`, `stop`, …) |

### Cómo se verifica

```sh
bita session finalize <id> --json   # status: summarized, o fallback con el motivo en error
tail hooks.log                      # junto a la base de datos: una línea por paso del cierre
pnpm test
```

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
- `entry.jiraIssue` es `true` si se arrancó con `--jira`, `false` con
  `--no-jira` y `null` si no se dijo nada; tally lo usa para abrir (o no) la
  tarjeta de Jira del cronómetro.
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
bita entries get <id> --json   # { id, description, kind, projectId, projectName, startedAt, stoppedAt, durationSeconds, mergedInto, jiraIssue, segments, touched }
bita repo which --json         # { slug, projectId, projectName } del repo actual, o null si no tiene proyecto
bita entries today --brief --json   # [{ id, title, project, start, stop, seconds }]: lo justo para un agente
```

### Reportes

`bita report` suma el tiempo de un rango por proyecto, por día y por semana. Es
lo que dibuja la ventana de reportes de Den. Acepta el rango igual que
`entries` (`[preset] | --from/--to | --last-days N`, `--timezone`), más
`--project <id|nombre>` y `--entries`:

```sh
bita report --last-days 7 --json
bita report month --project Apartados --entries --json
```

`data` trae:
- `range { fromDay, toDay, timezone, weekStartsOn }`, `totalSeconds`,
  `entryCount` y `activeDays`.
- `projects[{ projectId, name, clientName, totalSeconds, entryCount }]`, de mayor
  a menor. El tiempo sin proyecto sale con `projectId: null` y
  `name: "(no project)"`.
- `days[{ day, totalSeconds, projects[{ projectId, seconds }] }]`: todos los
  días del rango, también los de cero. Cada bloque de una entrada unificada
  cuenta en su propio día.
- `weeks[{ fromDay, toDay, totalSeconds, projects }]`: las semanas empiezan en
  `beginningOfWeek` (0 domingo, 1 lunes) y se recortan a los bordes del rango.
- `overlaps[{ localDay, trackedSeconds, clockSeconds, overlapSeconds }]`, de
  todo el día aunque se filtre con `--project`.
- Con `--entries`: `entries[{ id, title, projectId, start, stop, localDay,
  seconds, kind, overlapping, blockIds }]`, una fila por entrada y día. Una
  entrada unificada entre dos días sale dos veces con el mismo `id`;
  `blockIds` dice qué bloques caen en ese día. `overlapping` sale de los mismos
  solapes de `overlaps` y marca solo el día que se pisa.

Como en `entries`, cada bloque cuenta completo en el día en que empezó, aunque
cruce la medianoche.

Los cronómetros que siguen corriendo cuentan hasta ahora.

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

En Claude Code son skills de usuario del plugin; en los demás agentes, comandos.

| Comando | Qué hace |
|---|---|
| `/bita-start [título]` | Arranca un cronómetro, en blanco o con título; con tally, abre su tarjeta de Jira |
| `/bita-stop [id]` | Deja la nota al día con inkwell, describe la tarjeta de Jira si la hay y para. Con varios abiertos, pregunta cuál |
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
src/harness/   un adaptador por agente: argumentos, transcripción y resumen
src/integrations/ el plugin de OpenCode y la nota de inkwell
skills/        la skill del modelo (bita) y las skills de usuario (bita-*)
hooks/         los hooks del plugin de Claude Code
.claude-plugin/ el manifiesto del plugin y el marketplace
plugins/       bita-timer, el mod de la banda
scripts/       el instalador
```
