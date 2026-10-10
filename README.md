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
tipos nativo, así que desde un clon corre los `.ts` sin compilar.

La única dependencia que importa para encontrarse con las demás herramientas es
[`@kikedealba/kit`](https://github.com/KikeDeAlba/kit), y se carga solo cuando
hace falta: `setup`, el almacén de credenciales y el disparo de eventos. El
camino de arranque y los comandos de siempre corren sin `node_modules` (la copia
que lleva la app de escritorio depende de eso); sin kit, los eventos se reparten
solo a los hooks de `config.json`.

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
```

`bita setup` hace dos cosas:

1. **Registra bita** en el registro de kit
   (`~/.config/kikedealba/tools.d/bita.json`, o `KIT_REGISTRY_DIR`), con la
   línea de comando absoluta (node + script), sus capacidades
   (`time.entries.read`, `time.entries.write`, `time.notes`, `time.events`) y
   los eventos que emite (`start`, `stop`, `cancel`, `amend`, `delete`,
   `merge`). Así lo encuentran recap, inkwell, Den y las demás, sin depender
   del `PATH`. `--no-register` se lo salta.
2. **Instala la integración** con los agentes de código que encuentre: Claude
   Code, OpenCode, Codex y Gemini CLI. Para elegir:

```sh
bita setup --target claude
bita setup --target codex,gemini
bita setup --target all
```

| Agente | Qué recibe |
|---|---|
| Claude Code | `~/.claude/skills/bita`, `~/.claude/commands` y los permisos y hooks en `settings.json` |
| OpenCode | `~/.config/opencode/skills/bita`, `commands`, `plugins/bita.*` y el MCP de Atlassian en `opencode.json` |
| Codex | `~/.agents/skills/bita`, `~/.codex/prompts`, `~/.codex/hooks.json` y el MCP de Atlassian en `~/.codex/config.toml` |
| Gemini CLI | La extensión `~/.gemini/extensions/bita`: skill, comandos, hooks (`bita hook gemini`) y el MCP de Atlassian |

Hay una sola skill (`skill/SKILL.md`); lo que solo aplica a un agente va en
bloques `::: agent <nombre>` y kit genera la copia de cada uno. Esas copias no
siguen al paquete solas: **después de actualizar bita, vuelve a correr
`bita setup`** para que los agentes lean la skill nueva. Los comandos y el
plugin de OpenCode sí son symlinks al paquete.

Si OpenCode o Codex ya tienen un MCP llamado `atlassian`, se respeta tal cual.

El MCP de Atlassian usa OAuth y `bita` no guarda esas credenciales: en OpenCode
se autentica desde `/mcps`, en Codex con `codex mcp login atlassian` y en
Gemini con `/mcp auth atlassian`. Codex puede pedir revisar y confiar los hooks
desde `/hooks`. `--no-atlassian` omite el MCP; `--no-settings`, los permisos y
hooks de Claude.

Lo que antes instalaba bita ahora se instala aparte, cada uno con su propio
`setup`:

- **recap**: `npm i -g @kikedealba/recap && recap setup`. Se suscribe solo a
  los eventos de bita desde su manifiesto.
- **draw.io**: el MCP (`claude mcp add --scope user drawio -- npx -y @drawio/mcp`)
  y draw.io Desktop, que es lo que exporta los `.drawio` a PNG.
- **Den**, la app de escritorio: desde
  [sus releases](https://github.com/KikeDeAlba/bita-desktop/releases/latest).
  `bita app install` solo lo recuerda.

`--no-drawio` y `--no-recap` se aceptan y se ignoran con un aviso.

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

### 2. Correr el instalador

```sh
./scripts/install.sh --target all
```

Instala las dependencias si faltan, enlaza el binario y corre `bita setup` con
el target elegido, de forma idempotente: puedes volver a correrlo cuando
quieras.

| Paso | Qué hace |
|---|---|
| Dependencias | `pnpm install --prod` (o `npm install --omit=dev`) si no está `@kikedealba/kit` |
| Binario | Enlaza `bita` en tu directorio de binarios (`$PNPM_HOME/bin`, o `~/.local/bin`) |
| Setup | El registro en kit y la integración con los agentes (ver «Desde npm») |

Los comandos y plugins son **symlinks al repo**, a propósito: cuando actualizas
el repo se actualizan contigo. La skill se genera por agente, así que tras
editar `skill/SKILL.md` hay que volver a correr `bita setup`. Los archivos de configuración se
fusionan sin duplicar hooks y conservan el resto de sus entradas, con una copia
`.backup` antes de escribir; si no los puede parsear, no los tocan.

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

Por defecto Jira no se toca desde el CLI: lo escribe el agente mediante el MCP
oficial de Atlassian. `bita setup --target opencode`, `bita setup --target codex` y
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

Un proyecto también puede trabajar con Jira y Confluence **por el CLI** en vez
del MCP, con un token de API guardado en el almacén de credenciales del sistema. Ver
[Atlassian: sitios, MCP o CLI](#atlassian-sitios-mcp-o-cli).

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

### Historial de los documentos

La raíz de documentos es un repositorio git local, sin remoto. `bita setup` lo
inicia, y si no, lo inicia la primera escritura: `git init -b main`, un
`.gitignore` con `*.bkp` y `.DS_Store`, y un commit `chore: import existing
bita docs` con lo que ya hubiera. El autor sale de la configuración global de
git (`bita` si no hay).

**Cada escritura de bita es un commit** que lleva solo los archivos que tocó:
`docs page write|new|rename|move|restore`, `note save`, el cierre de un
cronómetro, el borrado de una entrada y el pull de Confluence. El mensaje es
Conventional (`docs(codi): update reglas de negocio`) con los trailers
`Bita-Source` (`manual`, `meeting`, `confluence-pull`, `restore`, `note`,
`import`), `Bita-Page`, `Bita-Entry` y `Bita-Reason`. Varias sesiones pueden
escribir a la vez: el commit toma un candado en `.git/bita.lock` y espera hasta
5 s. Sin git instalado la escritura se hace igual y solo avisa.

El working tree siempre está en `main`. Las propuestas se construyen en ramas
con plumbing (un índice temporal, `commit-tree` y `update-ref`), sin checkout,
y se mezclan con `git merge-tree --write-tree`; nada cambia bajo los pies de
otra sesión ni de la app.

```sh
bita docs git init                          # idempotente
bita docs status                            # lo editado por fuera y sin commit
bita docs commit [<ruta>...] [--message M]  # lo guarda; sin rutas, todo
bita docs page history <id> [--limit N]     # versiones, con su origen
bita docs page show <id> --rev <sha>        # la página en esa versión (campo markdown)
bita docs page diff <id> [<sha>]            # sin sha: lo no commiteado; con sha: lo que cambió ahí
bita docs page restore <id> <sha>           # la reescribe como estaba, con origen restore

bita docs propose --branch proposal/meeting-42 <id> --section "Límites" \
  --md cambio.md --reason "Se subió el tope" --source meeting:42
bita docs branch ls
bita docs branch diff proposal/meeting-42 [--commit <sha>]
bita docs branch apply proposal/meeting-42 --commit <sha>
bita docs branch drop proposal/meeting-42
```

`propose` no toca los archivos: cada propuesta es un commit en la rama (que
nace de `main` si no existe) y devuelve su `sha`. `branch apply` mezcla ese
commit contra `main` tomando a su padre como base y escribe el resultado con el
mismo camino que `docs page write`, así que la base y el commit en `main` quedan
al día. Si la página cambió en las mismas líneas después de la propuesta, falla
con `MERGE_CONFLICT` (salida 9 y `error.paths`) sin escribir nada.

**Texto en Unicode NFC.** macOS entrega los argumentos de otros procesos con los
acentos descompuestos (`ó` como `o` + tilde combinada), así que bita normaliza a
NFC todo argumento de texto y compara los encabezados normalizados. Un
`--section "Ejecución…"` que llegue descompuesto reemplaza la sección y no crea
una segunda. `bita docs normalize [--dry-run]` reescribe en NFC los documentos y
el texto de la base que se hayan guardado descompuestos antes, en un solo
commit; las rutas y los slugs no se tocan.

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
bita docs search "waf" --pages --json        # por página: su texto y las notas de sus entradas
```

`docs search --pages` agrupa por página en vez de por entrada: busca en el
markdown de cada página y en las notas de las entradas atadas a ella (las
unificadas incluidas), y devuelve una fila por página con `ancestors`,
`matchCount`, `sources: {page, entries}` y los fragmentos, cada uno con su
`source` (`page` o `entry`, con `entryId`). Ordena por aciertos y luego por lo
más reciente. Sin `--pages`, la búsqueda es la de siempre.

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

## Atlassian: sitios, MCP o CLI

bita guarda uno o varios **sitios** de Atlassian, cada uno con su correo; el
token de API vive en el almacén de credenciales del sistema vía kit (servicio
`bita-atlassian`, cuenta `<sitio>|<correo>`): el Llavero en macOS, el
Administrador de credenciales en Windows y Secret Service en Linux, con un
archivo `0600` de respaldo (`KIT_CREDENTIALS=file` lo fuerza). Los tokens que ya
estaban en el Llavero se siguen leyendo igual. Una configuración de la 0.14 con `jira.siteUrl` y
`jira.email` se lee como el primer sitio, y su token se sigue encontrando bajo la
cuenta vieja (solo el correo).

```sh
bita atlassian site add --site https://acme.atlassian.net --email yo@acme.com   # pide el token
pbpaste | bita atlassian site add --site acme.atlassian.net --email yo@acme.com --token-stdin
bita atlassian site ls [--check] --json      # sitios, token guardado, proyectos que lo usan
bita atlassian site test <sitio>             # comprueba Jira y Confluence con el token
bita atlassian site rm <sitio> [--force]     # borra token y sitio; --force si un proyecto lo usa
```

`site add` verifica el token contra Jira (`/rest/api/3/myself`) y Confluence
antes de guardarlo. Sin terminal, el token solo entra por `--token-stdin`.
`site ls` no toca la red: `status` sale `unknown` y `jira`/`confluence` repiten
lo último que se comprobó; con `--check` se consultan de verdad y `status` es
`ok`, `auth_failed` o `unreachable`. `bita confluence login` sigue existiendo como
alias de `site add`.

Cada proyecto dice con qué sitio trabaja, si el agente habla con Atlassian por el
**MCP** (por defecto) o por el **CLI**, cuál es su documentación oficial en
Confluence y si se sincroniza:

```sh
bita project atlassian Zipp --site acme.atlassian.net --via cli
bita project atlassian Zipp --confluence https://acme.atlassian.net/wiki/spaces/ZDE/pages/1010794497/Motor
bita project atlassian Zipp --confluence ZDE          # un espacio entero, por su clave
bita project atlassian Zipp --pull on --push off      # direcciones de la sincronización
bita project show Zipp --json                         # data.atlassian
```

`--confluence` acepta la URL de una página (`kind: page`), la URL de un espacio o
su clave (`kind: space`), o `none`. Si el proyecto no tenía sitio y la URL es de
un sitio dado de alta, lo toma. `project show`, `projects` y cada `spaces[]` de
`docs tree --pages` llevan el mismo objeto:

```json
{ "site": "https://acme.atlassian.net", "via": "cli",
  "confluence": { "kind": "page", "url": "…", "spaceKey": "ZDE", "pageId": "1010794497", "title": "Motor" },
  "sync": { "pull": true, "push": false, "lastSyncAt": null } }
```

Con `via: cli` la skill usa estos comandos en vez del MCP. Todos aceptan
`--site`; sin él, usan el sitio del proyecto (por `--project`, o por el prefijo
de la clave del issue a través de `bita map`) y si no, el primero:

```sh
bita jira myself
bita jira project ls [--query Q]
bita jira issue get DPP-12
bita jira issue create --project DPP --type Subtarea --summary "…" --description-file req.md --parent DPP-10 \
  --field timetracking='{"originalEstimate":"2h"}'
bita jira issue edit DPP-12 --description-file req.md
bita jira issue transitions DPP-12
bita jira issue transition DPP-12 --to Listo
bita jira issue search --jql "project = DPP AND statusCategory != Done" --limit 20
bita jira issue createmeta --project DPP [--type Subtarea]
bita jira worklog add DPP-12 --started 2026-10-06T09:30:00-06:00 --seconds 5400 --comment "…"
bita jira comment add DPP-12 --body-file resultado.md
bita jira comment ls DPP-12                                  # id, autor, fecha y cuerpo en markdown
bita jira comment rm DPP-12 10234
bita jira attach DPP-12 minuta.pdf [otro.png ...]            # adjuntos (el MCP no los sube)
bita jira link --from DPP-12 --to DPP-13 --type Blocks      # DPP-12 blocks DPP-13

bita confluence page get 1010794497 --markdown
bita confluence page create --parent 1010794497 --title "Red" --file red.md
bita confluence page update 1010794497 --file motor.md --message "estado de octubre"
bita confluence page search --cql 'space = ZDE AND title ~ "WAF"'
bita confluence page children 1010794497
```

Descripciones, comentarios y páginas se escriben en markdown. A Jira van como
ADF; a Confluence, como storage: los bloques de código se vuelven la macro
`code` con su lenguaje, y al leer, las macros que no tienen equivalente quedan
como `[Confluence macro: nombre]`. `--field nombre=valor` toma el valor como JSON
cuando lo es, y como texto si no.

## Sincronizar con Confluence

Un proyecto con página o espacio de Confluence y `--pull on` o `--push on` se
sincroniza página a página con su árbol de bita:

```sh
bita confluence sync Zipp --dry-run --json   # qué haría, sin escribir nada
bita confluence sync --all                   # todos los proyectos con sync encendido
bita confluence sync status Zipp --json      # cada página atada y hacia dónde va
bita confluence conflict ls [Zipp]
bita confluence conflict resolve 142 --keep local|remote|both
```

- La raíz es la página del proyecto o, para un espacio, su página de inicio. Sus
  hijas son las páginas de primer nivel del proyecto en bita, hasta cinco niveles.
- Una página atada cambió **en Confluence** si su versión no es la guardada, y
  **en bita** si el cuerpo de su markdown no es el guardado. Lo que cambió de un
  solo lado viaja si esa dirección está encendida; lo que cambió de los dos se
  marca como **conflicto** y no se sobrescribe nunca, hasta resolverlo.
- Con `pull`, las páginas de Confluence sin pareja se crean en bita respetando
  el árbol; con `push`, las de bita sin pareja se crean bajo su padre en
  Confluence. Si ya hay una página con el mismo título en el mismo lugar, se
  atan en vez de duplicarse (en conflicto si el contenido difiere).
- La salida es una fila por proyecto: `{project, pulled, pushed, created,
  conflicts, skipped}`, cada elemento `{pageId?, confluenceId?, title, reason?}`.
  `last_sync_at` se actualiza al terminar, salvo en `--dry-run`.

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

### La minuta en PDF

```sh
bita meeting export 853 [--out minuta.pdf] [--json]
```

Toma la reunión que recap grabó para la entrada (`recap show --bita-entry 853`),
quita el encabezado de `summary.md` y la imprime con Chrome headless con la misma
hoja que el export de bita-desktop: portada con título, fecha y hora, duración,
modalidad y proyecto, y después «Minuta de la reunión». Los bloques mermaid se
dibujan como SVG (si fallan, queda el código) y las imágenes relativas se buscan
en la carpeta de la reunión. El título es el que dejó el cierre de recap o el de
la entrada, nunca el genérico «Remote meeting». Por defecto se guarda en
`~/Downloads/minuta-<día>-<título>.pdf`; con `--json` devuelve
`{path, title, entryId}`. Sin Chrome falla con `CHROME_MISSING`. recap se busca en
`RECAP_CLI`, `~/.local/bin`, `~/Applications/Recap.app`, Homebrew y
`/Applications`. Las fuentes (Instrument Sans e IBM Plex Mono, OFL) van en
`assets/export/fonts`.

### Eventos y hooks

bita emite un evento cuando un contador arranca (`start`), se para (`stop`), se
cancela (`cancel`), cambia de tipo (`amend`), se borra (`delete`) o absorbe a
otros (`merge`). Lo escuchan dos tipos de oyente:

- **Herramientas instaladas**, que se suscriben desde **su propio** manifiesto
  en el registro de kit, sin tocar la configuración de bita. recap, por
  ejemplo, declara `start`, `stop`, `cancel` y `amend` con el filtro
  `kind: [remote-meeting, in-person-meeting]`; inkwell, `delete` y `merge`.
- **Hooks manuales** en `~/.config/bita/config.json`, que siguen funcionando
  igual:

```sh
bita hooks add --on start,stop --kind remote-meeting -- /ruta/absoluta/comando
bita hooks             # los manuales y los suscriptores del registro
bita hooks remove 1
```

```json
"hooks": [
  {
    "on": ["start", "stop"],
    "when": { "kind": ["remote-meeting"] },
    "command": ["/ruta/absoluta/comando"]
  }
]
```

- El comando recibe por stdin un JSON con `schemaVersion`, `event`, `source`
  (`"bita"`), `entry` (la entrada enriquecida, con `kind`), `previousKind` (en
  `amend`), `docPath`, `pageIds`, `databasePath`, `docsRoot`, `firedAt` y, en
  `merge`, `mergedIds` (las entradas absorbidas; `entry` es la que queda).
  También recibe `KIT_EVENT`, `KIT_EVENT_SOURCE`, `BITA_HOOK_EVENT`,
  `BITA_ENTRY_ID`, `BITA_ENTRY_KIND`, `BITA_DB_PATH` y `BITA_DOCS_DIR`.
- Corre desacoplado, desde la raíz del disco: bita espera solo a entregarle el
  JSON, nunca a que termine, y un oyente que falla no hace fallar el comando.
  Su salida va a `hooks.log`, junto a la base de datos.
- En `amend`, el filtro por tipo coincide con el tipo nuevo **o** con el
  anterior, para que quitar `--kind` también avise.
- **Usa rutas absolutas**: Den lanza el CLI con un `PATH` mínimo.
- `BITA_NO_HOOKS=1` o `KIT_NO_EVENTS=1` los apagan todos.
- `meta.hooksFired` en el JSON dice cuántos se lanzaron.
- Si kit no se puede cargar (la copia sin `node_modules`), solo se lanzan los
  hooks de `config.json`.

### Para otras herramientas

```sh
bita capabilities --json       # nombre, versión, sobre, capacidades y eventos
bita entries get <id> --json   # { id, description, kind, projectId, projectName, startedAt, stoppedAt, note }
```

`note` es el markdown del documento de la entrada, o `null` si no tiene.

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

### Los repos locales de cada proyecto

El prefijo dice a qué proyecto va el tiempo; aparte, bita guarda **en qué rutas
locales vive el código de cada proyecto**, para que otras herramientas —el
asistente de reuniones de recap, por ejemplo— sepan en qué repos buscar cuando
se pregunta por él:

```sh
bita project repo ls [--project CoDi] [--json]       # marca los que ya no están en disco
bita project repo add ~/dev/codi/api --project CoDi  # guarda la raíz git y su slug
bita project repo rm ~/dev/codi/api
bita project repo suggest 412 --json                 # raíces git de lo que tocó la entrada 412
bita project repo suggest --project CoDi --history   # lo mismo sobre todas sus entradas
```

`add` guarda la raíz del repo (`git rev-parse --show-toplevel`), no la carpeta
que se le pase, y desde un worktree guarda el clon principal. Sin `--project`,
toma el proyecto al que resuelve el repo por su prefijo. Volver a agregar uno
solo refresca cuándo se vio por última vez.

`suggest` agrupa por raíz git los archivos que tocó la entrada, cuenta cuántos
cayeron en cada una y marca `mapped` las que ya son del proyecto; los documentos
de bita quedan fuera. Al parar, `/bita-stop` revisa esas sugerencias y mapea con
`--source stop` solo las que de verdad pertenecen al proyecto, y `bita stop
--json` las repite en `meta.repoSuggestions`: una lista con un solo cronómetro,
un objeto por id de entrada con varios. `--history` sirve para sembrar el mapa
la primera vez.

## Cómo se agrupa

Un grupo es **proyecto + título + tipo**, a lo largo de todo el rango, y se
convierte en un issue de Jira. Cada entrada del grupo es un worklog con su hora
real. Una reunión y un trabajo con el mismo título quedan en grupos distintos.
En `bita summary --json` cada grupo trae su `kind`, y las reuniones
(`remote-meeting`, `in-person-meeting`) traen además
`meeting: {entryId, startedAt, durationSeconds, mode}` y la lista `meetings`
cuando son varias.

La estimación original se redondea **hacia arriba** al siguiente medio punto: 3h
43m medidas se registran como 4h de estimación con worklogs que suman 3h 43m. Un
issue admite como máximo 8 horas; lo que se pasa se parte en `(1/n)`, `(2/n)`.

El issue se escribe como **requerimiento** —Objetivo, Alcance, Criterios de
aceptación— y los **resultados** van en un comentario —Resultado, Verificación,
Referencias—. Ni uno ni otro reparte el trabajo entre quien lo hizo y quien
tiene que terminarlo: todo es de quien tiene asignada la tarea, y lo que falte
va al backlog de bita, no a Jira.

Las reuniones no: su subtarea va bajo la historia «Sesiones y reuniones», con
una descripción de reunión —fecha, duración, modalidad, resumen, temas y
acuerdos—, la minuta en PDF adjunta (`bita meeting export` y `bita jira attach`)
y sin comentario de resultado.

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

`skill/SKILL.md` es la única skill, para los cuatro agentes. Lo que aplica solo
a uno (el conector de Atlassian en Codex, OpenCode o Gemini CLI) va en bloques
`::: agent <nombre>`; al instalar, kit genera una copia por agente sin los
bloques de los demás, para que ningún cliente cargue las instrucciones de otro.

## Desarrollo

```sh
pnpm typecheck
pnpm test
```

Los tests corren con `node --test` sobre los `.ts` directamente. No hay bundler.
`test/helpers/isolate.ts` apunta `KIT_REGISTRY_DIR` a un directorio temporal
para que ninguna prueba lance las herramientas registradas de verdad, y
`test/kit.test.ts` corre las pruebas de conformidad de kit.

## Estructura

```
src/db/        el almacén: esquema, migraciones y consultas
src/domain/    lógica pura: agrupación, duraciones, zonas horarias, solapes
src/cli/       comandos y formato de salida
src/docs/      los documentos de cada entrada: rutas, markdown y escritura
src/atlassian/ sitios, tokens y la configuración Atlassian de cada proyecto
src/jira/      cliente REST de Jira y markdown a ADF
src/confluence/ cliente REST de Confluence, conversión a storage y sincronización
src/export/    la minuta de una reunión a HTML y a PDF con Chrome
assets/export/ la hoja de impresión y las fuentes de la minuta
src/state/     configuración, credenciales y notas heredadas en disco
src/hooks/     los eventos: suscriptores del registro de kit y hooks de config.json
src/kit/       el manifiesto de bita, sus capacidades y la integración con los agentes
src/integrations/ el plugin de OpenCode
skill/         la skill, con bloques por agente
commands/      los slash commands
scripts/       el instalador
```

El punto de corte es `EnrichedTimeEntry` (`src/domain/types.ts`): todo lo que
está aguas abajo no sabe de dónde salieron los datos.
