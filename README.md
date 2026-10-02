# bita

Registro de tiempo local, en SQLite, pensado para que los agentes de código lo
lean y lo escriban. Mide el trabajo mientras ocurre y después lo vuelca a Jira:
un issue por título y proyecto, un worklog por cada bloque medido, con estimación
y cierre.

El nombre viene de bitácora.

## Por qué existe

Este proyecto registra el tiempo localmente y deja el volcado a Jira para después,
sin depender de un servicio externo durante el trabajo. Así el registro de tiempo
no queda separado de los cambios cuando una sincronización falla a mitad de una
escritura.

Con una base local desaparecen el throttle, los reintentos, la paginación, el
caché de 24 horas, el espejo del cronómetro en curso y los tags usados como
estado porque no había dónde guardarlo.

Quedan dos ventajas que no se buscaban:

- **Varios cronómetros a la vez.** Un cronómetro corriendo es una fila con
  `stopped_at` nulo, y puede haber las que hagan falta.
- **El estado es una clave foránea.** Una entrada está pendiente mientras no
  tenga fila en `jira_links`. No hay tag que pueda diverger ni retaggeo a medias.

## Requisitos

**Node 24 o superior.** No es negociable: bita usa `node:sqlite` y el borrado de
tipos nativo, así que desde un clon corre los `.ts` sin compilar. No hay
dependencias de runtime ni bundler.

El paquete de npm sí lleva JavaScript compilado, y no por gusto: node **se
niega** a borrar tipos en archivos bajo `node_modules`, sin bandera que lo
levante. El build es un `tsc` que sólo borra los tipos —`erasableSyntaxOnly`
está activo— y reescribe las extensiones de los imports.

```sh
node -v    # debe decir v24 o más
```

## Instalación

### Desde npm

```sh
npm install -g @kikedealba/bita
bita setup
bita app install
```

`bita setup` instala la integración de Claude por defecto. Para instalar otra
superficie:

```sh
bita setup --target opencode
bita setup --target codex
bita setup --target all
```

OpenCode recibe la skill y los comandos en `~/.config/opencode`, además de un
plugin que conecta los hooks de bita con sus sesiones y herramientas. También
se añade el MCP oficial de Atlassian a la configuración global de OpenCode.
Después de abrir OpenCode, autentícalo desde `/mcps`.

Codex recibe la skill en `~/.agents/skills/bita`, sus hooks en `~/.codex/hooks.json`
y el MCP oficial de Atlassian en `~/.codex/config.toml`. La autenticación queda
fuera de la instalación: ejecútala con `codex mcp login atlassian`. Codex puede
pedir revisar y confiar los hooks desde `/hooks` antes de ejecutarlos.

El MCP usa OAuth y `bita` no guarda credenciales. Para omitir su configuración:

```sh
bita setup --target opencode --no-atlassian
bita setup --target codex --no-atlassian
```

La instalación de Claude enlaza la skill y los comandos de barra en `~/.claude`
apuntando al paquete instalado, y mete los permisos y el hook `SessionStart` en
tu `settings.json`. Al actualizar el paquete se actualizan con él, porque son
symlinks. También deja listo draw.io para los diagramas elaborados:
- agrega el MCP de draw.io a Claude Code (`claude mcp add --scope user drawio -- npx -y @drawio/mcp`) si no está;
- instala draw.io Desktop con `brew install --cask drawio` si falta, porque es lo que exporta los `.drawio` a PNG.

`--no-drawio` se salta las dos cosas. `bita app install` descarga la última
release del escritorio y la deja en `/Applications`.

Node 24 o más nuevo, por `node:sqlite`.

### Cómo se publica

Nadie publica a mano. Al publicar una release en GitHub, el workflow
`.github/workflows/publish.yml` corre el typecheck y las pruebas, comprueba que
el tag y la versión de `package.json` coinciden —si no, falla antes de subir
nada—, **instala el tarball como lo haría una persona y lo ejecuta**, y hace
`npm publish --provenance`.

Ese último paso no es ceremonia: el paquete se instala en `node_modules`, que es
un entorno en el que no corre lo mismo que en el clon. Comprobar el contenido
del tarball no lo detecta; ejecutarlo sí.

La procedencia ata el paquete de npm al commit y al workflow que lo construyó,
así que cualquiera puede comprobar de dónde salió. Hace falta el secreto
`NPM_TOKEN` en el repositorio, un token de automatización con permiso de
escritura sobre `@kikedealba`.

### Desde el repositorio

Para trabajar sobre el código. El instalador enlaza contra tu clon, así que un
`git pull` actualiza el binario, la skill y los comandos a la vez.

### 1. Clonar e instalar

```sh
git clone git@github.com:KikeDeAlba/bita-cli.git
cd bita-cli
pnpm install
```

Las únicas dependencias son TypeScript y `@types/node`, y solo para el
`typecheck`.

### 2. Correr el instalador

```sh
./scripts/install.sh --target all
```

Instala el binario y la integración seleccionada de forma idempotente: puedes volver a correrlo cuando
quieras.

| Paso | Qué hace |
|---|---|
| Binario | Enlaza `bita` en tu directorio de binarios (`$PNPM_HOME/bin`, o `~/.local/bin`) |
| Claude | `~/.claude/skills/bita`, `~/.claude/commands` y `settings.json` |
| OpenCode | `~/.config/opencode/skills/bita` con su skill específica, `commands`, `plugins/bita.*` y MCP de Atlassian |
| Codex | `~/.agents/skills/bita` con su skill específica, `~/.codex/hooks.json`, `~/.codex/config.toml` y MCP de Atlassian |

Las skills, comandos y plugins son **symlinks al repo**, a propósito: cuando
actualizas el repo se actualizan contigo. Los archivos de configuración se
fusionan sin duplicar hooks y conservan el resto de sus entradas.

Antes de tocar `settings.json` deja una copia en `settings.json.backup`, y si no
lo puede parsear no lo escribe: imprime el bloque para que lo pegues a mano.

Para instalar una sola superficie:

```sh
./scripts/install.sh --target opencode
./scripts/install.sh --target codex
```

Si tu directorio de binarios está en otro sitio:

```sh
BITA_BIN_DIR=~/bin ./scripts/install.sh
```

### 3. Comprobar

```sh
bita --version
bita projects
```

La base se crea sola en `~/.local/share/bita/bita.db` al primer uso. `BITA_DB_PATH`
la mueve a otro sitio, que es también la forma de probar cosas sin tocar la real.
`BITA_CONFIG_PATH` hace lo mismo con la configuración (`~/.config/bita/config.json`).

### 4. Dar de alta un repositorio

Esto es lo que enciende la integración con el agente. Un solo comando crea el
proyecto y lo mapea:

```sh
bita repo init                     # el repositorio actual
bita repo init ~/dev/otro/repo     # o el que le pases
```

El nombre del proyecto sale de la carpeta; `--name "Otro nombre"` lo cambia. Si
ya existe un proyecto con ese nombre **lo reutiliza**, que es lo que quieres
cuando el front y el back de lo mismo deben compartir proyecto.

Si prefieres separarlo en dos pasos, o mapear varios repositorios a un proyecto
que ya existe:

```sh
bita project add "Mi proyecto"     # devuelve un id
bita scope set . <projectId>
```

**Mientras un repositorio no esté mapeado, el hook no dice nada.** En cuanto lo
está, al abrir una sesión del agente se inyecta la regla que le pide
ofrecer el cronómetro cuando el trabajo vaya a dejar un artefacto —un commit, un
archivo, un despliegue— y callarse cuando solo vayas a leer o preguntar.

El mapeo se guarda por el **slug** del repositorio, que sale del remoto de git
(`github.com/kikedealba/bita-cli`), así que sobrevive a que muevas la carpeta.

Reabre la sesión para que cargue el hook, la skill y los comandos.

### 5. Conectar Jira

Jira no se toca desde el CLI: lo escribe el agente mediante el MCP oficial de
Atlassian. `bita setup --target opencode`, `bita setup --target codex` y
`bita setup --target all` lo configuran automáticamente, pero la autenticación
siempre queda a cargo de la persona:

- OpenCode: `/mcps`
- Codex: `codex mcp login atlassian`

OpenCode muestra las herramientas del servidor con el prefijo `atlassian_` cuando
están fuera de Code Mode. El servidor permite Jira y Confluence, y respeta los
permisos de la cuenta autenticada.

Lo único que se guarda aquí es a qué tablero va cada proyecto, y se pregunta solo
la primera vez:

```sh
bita map set <projectId> <JIRAKEY> --parent <JIRAKEY-123>   # siempre a esa épica
bita map set <projectId> <JIRAKEY> --no-epic                # al tablero: la épica se elige en cada corrida
bita map list
```

Un proyecto apunta a una épica cuando todo su trabajo cae siempre en la misma, o
al tablero cuando se reparte entre varias. Cambiar de uno a otro conserva el
resto del mapeo: la transición de cierre, los tipos y las Historias ya creadas,
que se guardan por épica.

## Uso

```sh
bita start "Despliegue de infraestructura"   # arranca; puede haber varios
bita ls                                      # qué está corriendo ahora
bita note path 12 --create                   # el documento de la entrada
bita note save 12                            # regístralo tras editarlo
bita stop 12                                 # para uno y cierra su documento
bita log "Sesión con QA" --from 14:00 --for 1h
bita summary --pending --json                # agrupado y listo para Jira
bita link 12 13 --issue DD-1896              # marca como registradas
bita delete 12 --dry-run                     # qué se llevaría por delante
bita repo init ~/dev/otro/repo               # da de alta otro repositorio
```

`bita --help` lista todo.

### Borrar

`bita delete <ids...>` quita entradas que nunca debieron registrarse: el
contador que arrancó solo, el bloque de tres segundos, la prueba. Se lleva
consigo el enlace a Jira, los archivos tocados, la fila del documento y el
**archivo del documento en disco**, salvo con `--keep-doc`.

Hay tres guardas, y todas paran la corrida entera antes de tocar nada:

| Situación | Qué pasa |
|---|---|
| La entrada sigue corriendo | Se niega y remite a `bita cancel`, que es el comando de descartar un cronómetro vivo |
| La entrada ya llegó a Jira | Se niega: el worklog sigue allá y el conector no puede borrarlo. `--force` borra la entrada local de todos modos |
| El id no existe | Se niega antes de borrar ninguno de los otros |

Sin terminal —o con `--json`— exige `--yes`, porque no hay a quién preguntarle.
`--dry-run` describe lo que pasaría, incluido que se negaría, y no escribe nada.

`bita project delete <id|nombre>` hace lo propio con un proyecto: borra su mapeo
de Jira, sus Historias cacheadas y los prefijos de `scope` que apuntaban a él.
Se niega si el proyecto tiene entradas, porque borrarlo las deja sin proyecto en
vez de borrarlas; `--force` acepta ese resultado y `bita project archive` es la
alternativa cuando el histórico importa.

### Unificar contadores

Un mismo trabajo acaba a veces repartido en varios contadores: la sesión que se
partió, el contador que se arrancó con otro título. `bita merge` los junta en
una sola entrada.

```sh
bita merge 774 776 --dry-run
bita merge 774 776 [--into 774] [--title "…"] [--project X]
```

Sobrevive la más antigua, o la de `--into`, con su título y su proyecto salvo
que se pasen otros. Hereda las páginas de todas, los `--did` de cada página en
orden, los archivos tocados, los enlaces y los documentos heredados como
apéndices. **Cada contador original queda como segmento** con su inicio y su fin
reales, así que `summary` da una sola tarea con un worklog por bloque y ninguna
hora se inventa.

Solo se unifican entradas paradas y pendientes: una que ya llegó a Jira dejaría
de cuadrar con sus worklogs. Después se opera sobre la entrada que quedó: `amend`,
`delete` y `docs page link` rechazan un segmento con `ENTRY_MERGED`, `link` ata
la entrada con todos sus segmentos, y borrar la entrada se lleva sus segmentos.
Desde esta versión una entrada puede estar en varias páginas, y
`docs page link --entry` añade en vez de mover.

### Diagramas

Una página lleva diagramas de dos tipos: bloques ```` ```mermaid ```` para
flowcharts y secuencias, y bloques ```` ```drawio ```` que nombran un archivo
`.drawio` guardado junto a ella, para arquitectura e infraestructura. Los
archivos de una página viven en `<página>.assets/`, y se mueven con ella.

```sh
bita docs page asset path <pageId> red.drawio --create   # dónde escribir el .drawio
bita docs diagrams ls <pageId>                         # qué diagramas hay y si están renderizados
bita docs diagrams render <pageId> [--force]           # PNG 2x, fondo blanco, en los assets
```

Mermaid se renderiza con `@mermaid-js/mermaid-cli` vía `npx`, usando Google
Chrome si está instalado para no descargar otro navegador; draw.io, con el CLI de
draw.io Desktop. El nombre de cada render de mermaid lleva el hash de su fuente,
así que solo se vuelve a dibujar lo que cambió, y los renders viejos se borran.

### Los documentos

Cada entrada tiene un documento en markdown que se escribe **mientras el
cronómetro corre**, no al pararlo. Viven en espejo del proyecto:

```
~/.local/share/bita/
├── bita.db
└── docs/
    └── apartados/2026/09/20-128-migracion-del-worker.md
```

La raíz sale de `--docs-dir`, de `BITA_DOCS_DIR`, o del directorio de la base de
datos, en ese orden. Como se deriva de la base, apuntar `--db-path` a un archivo
de pruebas arrastra los documentos con él.

**La base guarda la ruta, no el texto.** El archivo es el original: se puede
abrir en un editor, indexar o respaldar sin pasar por el CLI, y el árbol entero
se puede mover sin reescribir nada. Lo que sí guarda la base es el checksum, con
lo que se nota si un documento cambió por fuera.

Los documentos por entrada heredados conservan sus secciones fijas —Contexto,
Qué se hizo, Decisiones, Hallazgos, Verificación, Pendiente, Tocado—. Las
páginas, que son la unidad de documentación desde la 0.4, no tienen secciones
obligatorias: describen el estado actual de algo, como documento formal, y de
ellas salen el requerimiento del issue de Jira, el comentario con los
resultados y lo que se publica en Confluence.

### Pendientes y hallazgos

Lo que queda por hacer y lo que se descubrió de paso **no va en las páginas**:
va al backlog de bita —no a Jira—, una fila por ítem, atada a su proyecto y, si la hay, a su página.
Así la página sigue describiendo lo que existe y la lista de lo que falta se lee
de un vistazo entre todos los proyectos, que es lo que enseña la app de
escritorio.

```sh
bita backlog add --kind pending --title "Rotar el secreto de dev" [--md detalle.md]
bita backlog add --kind finding --title "El NAT vive en una sola AZ"
bita backlog ls [--project X] [--page <id>] [--kind pending|finding] [--status open|resolved|all]
bita backlog resolve STI-14 --resolution "Rotado en dev y test"
bita backlog reopen STI-14
bita project key "Pharma STI" PSTI     # cambia el prefijo de las claves del proyecto
bita backlog extract --dry-run         # las secciones Pendiente/Hallazgos de las páginas, a ítems
```

Cada ítem se nombra con una clave corta al estilo Jira: la clave del proyecto
—derivada de su nombre al crearlo, y editable con `bita project key`— y un
correlativo por proyecto (`STI-14`). `resolve`, `reopen`, `edit` y `rm` la
aceptan, igual que el id numérico. Los ítems sin proyecto usan el prefijo `BL`.
Sin `--project`, `--page` ni `--entry`, `add` cuelga el ítem del cronómetro que
corre. `extract` convierte cada viñeta de esas secciones en un ítem —las
casillas marcadas, en resueltos— y las quita de la página. `docs page write`
avisa con `BACKLOG_SECTION_IN_PAGE` si una página vuelve a traerlas, y con
`PAGE_SHOULD_SPLIT` cuando pasa de seis secciones o 12 KB y conviene partirla en
páginas hijas.

### Enlaces de una página

Cada página guarda los enlaces con los que se relaciona: páginas de Confluence,
issues de Jira, hojas de estimación.

```sh
bita docs page ref add <id> --url <URL> --title "Estimación Q4" [--kind confluence|jira|drive|link]
bita docs page ref ls <id>
bita docs page ref rm <id> --url <URL>
```

El hook `bita hook ref`, que `bita setup` instala en `PostToolUse` para los
conectores de Atlassian y Google Drive, registra solo lo que se lee o se escribe
mientras corre un cronómetro: un issue, una página, un archivo. Las búsquedas
no dejan rastro. Si hay varios cronómetros y no se puede saber a cuál pertenece,
no registra nada. Un enlace visto antes de que la entrada tenga página espera en
la entrada y pasa a la página cuando se ata.

Si vienes de las notas en NDJSON, `bita notes migrate --dry-run` enseña qué
documentos se crearían, y sin el flag los crea. El archivo viejo no se toca.

### Navegar lo escrito

`bita note` siempre habla de una entrada concreta. Para moverse por el corpus
—que es lo que necesita un lector, dentro o fuera de la terminal— está
`bita docs`, que solo lee:

```sh
bita docs tree --months                      # proyectos, con sus meses y conteos
bita docs ls --project ARSM                  # entradas y su documento, o «sin nota»
bita docs show 735                           # markdown, front matter y secciones
bita docs search "cognito" --project ARSM    # con fragmentos alrededor de cada acierto
```

`docs ls` devuelve **siempre las siete secciones** con su estado —`written`,
`empty` o `absent`— para que quien pinte un índice no tenga que llevar su propia
copia de la lista. Las entradas sin documento salen como filas con `doc: null`,
porque no tener nota escrita también es información.

Un archivo que falta o que cambió por fuera **no es un error**: sale en
`meta.files` y en `meta.warnings` con `ok: true`. Que el documento vaya por
delante de la base entre `note path --create` y `note save` es el flujo normal,
no una avería.

La búsqueda lee de disco, acotando antes por la base: el catálogo dice qué
archivos existen y el archivo dice qué contiene. No hay índice que invalidar, y
buscar dentro de un proyecto solo toca los documentos de ese proyecto.

### Formato de salida

Todos los comandos aceptan `--json` y emiten un solo documento en stdout:

```json
{ "schemaVersion": 3, "ok": true, "command": "summary", "data": {}, "meta": {} }
```

Los errores salen con `ok: false` y un `error.code` estable. Los avisos van a
stderr, nunca a stdout, para que el JSON se pueda parsear tal cual.

## Contadores en blanco

El caso normal es arrancar el reloj **antes de saber en qué se trabaja**:

```sh
cd ~/dev && bita start        # sin título y sin proyecto
```

Eso crea un borrador. Mientras siga sin título queda fuera de `summary`, así que
no puede llegar a Jira por accidente. Se rellena después, y en buena parte solo:

| Qué | Quién lo pone |
|---|---|
| Título y descripción | El agente, en cuanto un mensaje dice en qué se va a trabajar |
| Proyecto | El agente por el prompt, o el hook por el primer archivo que se cambia |
| Archivos tocados | El hook, en cada edición |

El hook `UserPromptSubmit` recuerda que hay un contador sin nombre y se calla
solo en cuanto lo tiene. A mano:

```sh
bita amend --draft --title "Lo que sea" --project Apartados
```

## Reuniones y hooks

Una entrada puede llevar un **tipo** (`kind`), texto libre en minúsculas con
guiones. bita no le da significado; sirve para que otras herramientas reaccionen
a ciertos contadores. El caso de uso es [recap](https://github.com/KikeDeAlba/recap),
que graba la reunión mientras corre el contador:

```sh
bita start "Planeación sprint 42" --kind remote-meeting
bita start "1:1 con Ana" --kind in-person-meeting
bita amend 812 --kind remote-meeting     # a uno que ya corre
bita amend 812 --kind none               # quitarlo
bita log "Retro" --kind remote-meeting --from 16:00 --for 45m
```

El tipo queda en la columna `entries.kind`, en el JSON de `start`, `stop`, `ls` y
compañía, y en el front matter del documento.

### Hooks

Un hook es un comando que bita lanza cuando un contador arranca (`start`), se
para (`stop`), se cancela (`cancel`) o cambia de tipo (`amend`). Opcionalmente
solo para ciertos tipos:

```sh
bita hooks add --on start,stop,cancel,amend --kind remote-meeting,in-person-meeting \
  -- /Users/me/.local/bin/recap bita-hook
bita hooks
bita hooks remove 1
```

Se guardan en `~/.config/bita/config.json`:

```json
"hooks": [
  {
    "on": ["start", "stop", "cancel", "amend"],
    "when": { "kind": ["remote-meeting", "in-person-meeting"] },
    "command": ["/Users/me/.local/bin/recap", "bita-hook"]
  }
]
```

- El comando recibe por stdin un JSON con `event`, `entry` (la entrada
  enriquecida, con `kind`), `previousKind` (en `amend`), `docPath`,
  `databasePath` y `docsRoot`, y además las variables `BITA_HOOK_EVENT`,
  `BITA_ENTRY_ID`, `BITA_ENTRY_KIND`, `BITA_DB_PATH` y `BITA_DOCS_DIR`.
- Corre desacoplado, desde `/`: bita espera solo a entregarle el JSON, nunca a
  que termine, y un hook que falla no hace fallar el comando. Su salida va a
  `hooks.log`, junto a la base de datos.
- En `amend`, el filtro por tipo coincide con el tipo nuevo **o** con el
  anterior, para que quitar `--kind` también avise.
- **Usa rutas absolutas**: bita-desktop lanza el CLI con un `PATH` mínimo.
- `BITA_NO_HOOKS=1` los apaga todos.
- `meta.hooksFired` en el JSON dice cuántos se lanzaron.

## Proyectos y repositorios

**Un repo no es un proyecto.** Los proyectos suelen ser grupos con varios repos
dentro, y el grupo no tiene `.git`: lo tienen los repos.

El mapeo va por **prefijo de ruta**, y gana el más largo que empate:

```sh
bita scope set gitlab.com/vivaaerobus/vb_solemti/apartados 42
bita scope which .        # que prefijo empata aqui
bita scope list
```

Con eso, `apartados/api`, `apartados/front` y `apartados/workers` resuelven los
tres a Apartados sin configurar nada mas. Se puede mapear un grupo y luego
excepcionar un repo dentro, porque el prefijo mas largo manda. El empate es por
segmentos, asi que `.../apartados` nunca cubre `.../apartados-legacy`.

Si no hay prefijo, `bita repo init` propone uno comparando los segmentos de la
ruta con los nombres de proyecto que ya existen, ignorando mayusculas, guiones y
guiones bajos. Solo empata si tras normalizar son identicos.

## Cómo se agrupa

Un grupo es **proyecto + título**, a lo largo de todo el rango, y se convierte en
un issue de Jira. Cada entrada del grupo es un worklog con su hora real.

La estimación original se redondea **hacia arriba** al siguiente medio punto: 3h
43m medidas se registran como 4h de estimación con worklogs que suman 3h 43m. Un
issue admite como máximo 8 horas; lo que se pasa se parte en `(1/n)`, `(2/n)`.

El issue se escribe como **requerimiento** —Objetivo, Alcance, Criterios de
aceptación— y los **resultados** van en un comentario —Resultado, Verificación,
Referencias—. Ni uno ni otro reparte el trabajo entre quien lo hizo y quien
tiene que terminarlo: todo es de quien tiene asignada la tarea, y lo que falte
va al backlog de bita, no a Jira.

## Solapes

Los cronómetros simultáneos están permitidos, así que un día puede sumar más
tiempo del que marca el reloj. `summary` y `entries` lo avisan:

```
Warning: 2026-09-19: 4h 8m tracked over 3h 7m of clock time (1h overlapping)
```

No lo impide. Solo evita que pase inadvertido.

## Los comandos del agente

`commands/` tiene siete slash commands. Claude y OpenCode los enlazan por symlink
desde sus respectivos directorios globales; Codex usa la skill y el CLI:

| Comando | Qué hace |
|---|---|
| `/bita-start [título]` | Arranca un cronómetro. Sin título, lo infiere de la sesión y lo enseña antes |
| `/bita-stop [id]` | Cierra el documento de lo que se hizo y para. Con varios abiertos, pregunta cuál |
| `/bita-timers` | Qué está corriendo y cuánto llevas hoy |
| `/bita-log <texto>` | Registra un bloque que ya pasó, cuando se trabajó sin cronómetro |
| `/bita-init [ruta]` | Da de alta un repositorio: crea su proyecto, lo mapea y revisa el tablero |
| `/bita-check [id]` | Anota un checkpoint en el documento, mientras el cronómetro corre |
| `/bita-amend [id]` | Rellena a mano el título o el proyecto de un cronómetro |

Viven en el repo por la misma razón que la skill: usan los flags del CLI, así que
cambian en el mismo commit.

## La skill

`skill/SKILL.md` es la skill que recibe Claude. Las variantes
`skill-opencode/SKILL.md` y `skill-codex/SKILL.md` conservan el procedimiento
común y añaden únicamente las instrucciones de su cliente. Cada una está
enlazada por symlink desde la integración correspondiente, para que ningún
cliente cargue las instrucciones de otro.

## Desarrollo

```sh
pnpm typecheck
pnpm test
```

Los tests corren con `node --test` sobre los `.ts` directamente. No hay bundler.

## Estructura

```
src/db/        el almacén: esquema, migraciones y consultas
src/domain/    lógica pura: agrupación, duraciones, zonas horarias, solapes
src/cli/       comandos y formato de salida
src/docs/      los documentos de cada entrada: rutas, markdown y escritura
src/state/     configuración y notas heredadas en disco
src/integrations/ adaptadores para OpenCode y otros agentes
skill/         la skill de Claude
skill-opencode/ la skill de OpenCode
skill-codex/   la skill de Codex
commands/      los slash commands
scripts/       el instalador
```

El punto de corte es `EnrichedTimeEntry` (`src/domain/types.ts`): todo lo que
está aguas abajo no sabe de dónde salieron los datos.
