---
name: bita
description: >-
  Lleva el tiempo de trabajo registrado en bita a Jira, y maneja el cronómetro en
  vivo. Arranca y para el cronómetro cuando empieza y termina un trabajo,
  escribiendo una descripción real de lo que se hizo; y después agrupa las
  entradas y crea los issues de Jira con su jerarquía (Épica → Historia →
  Subtarea), su estimación, un worklog por cada bloque medido, y el cierre.
  Úsala cuando el usuario quiera arrancar o parar el conteo de tiempo, saber
  cuánto lleva, ver o reportar en qué trabajó, o volcar ese tiempo a Jira.
  Frases que la disparan: "arranca el tiempo", "para el cronómetro", "cuánto
  llevo", "registra mis horas de esta semana en Jira", "pasa mi tiempo a Jira",
  "qué trabajé esta semana", "sube las horas de ayer", "reporta mi tiempo del
  mes", "registra lo que tengo pendiente". No la uses para tareas de Jira que no
  vengan de un registro de tiempo.
---

# bita

El registro local de bita es la fuente de la verdad. Nada de estimar desde
commits: las horas son las medidas.

## El contador arranca antes de saber nada

El flujo normal es: abrir el agente de código sobre `~/dev`, **arrancar el contador en blanco**
con `/bita-start`, y solo entonces escribir el encargo. Planear es trabajo y el
reloj ya está corriendo mientras se planea.

Eso significa que **el contador nace sin título y sin proyecto**, y que rellenarlo
es tarea tuya:

1. El hook `prompt-submit` te avisa en cada turno mientras siga sin título.
2. **En cuanto un mensaje diga en qué se va a trabajar, rellénalo — antes de
   explorar y antes de planear.** No esperes al final.

   ```
   bita amend --draft --title "<titulo corto>" --project <nombre o id>
   ```
3. Al terminar el plan, escribe el primer checkpoint del documento con lo que
   concluyó: `bita docs page write <id> --md <archivo>`, y al parar `--did`.

El título es la clave de agrupación y el summary del issue, así que corto y
reconocible. Un borrador sin título queda fuera de `summary`, o sea que si no lo
rellenas, esas horas no llegan a Jira.

## Un repo no es un proyecto

Los proyectos son **grupos con varios repos dentro**, y el grupo no tiene `.git`:
lo tienen los repos.

```
gitlab.com/vivaaerobus/vb_solemti/apartados/api      ─┐
gitlab.com/vivaaerobus/vb_solemti/apartados/front    ─┤  todos son "Apartados"
gitlab.com/vivaaerobus/vb_solemti/apartados/workers  ─┘
```

El mapeo va por **prefijo de ruta**, y gana el más largo que empate. `bita repo
show` dice qué prefijo empató, que es como se depura esto. `bita scope list` los
lista todos.

Si no hay prefijo, se propone por nombre de segmento. **Enseña siempre el prefijo
que se va a guardar antes de confirmarlo**: empatar un segmento ancho como
`vivaaerobus` guardaría un prefijo que se traga toda la organización.

## Convención del usuario

Cada entrada lleva **título y proyecto**. El estado no es una etiqueta: una
entrada está **pendiente mientras no tenga fila en `jira_links`**, y pasa a
registrada cuando `bita link` la ata a un issue. Es una clave foránea, así que
no existe el estado intermedio que dejaba horas a medio registrar.

El filtro de entrada es `--pending`, no la fecha. El rango es un acotador
opcional.

Todo es local: no hay red, ni token, ni cuota. Un comando de lectura no cuesta
nada, así que consulta las veces que haga falta.

## Reglas duras

1. **No emitas ninguna llamada de escritura antes de una confirmación explícita.**
   Una respuesta ambigua se trata como "ajustar", nunca como "sí".
2. **Resuelve todos los mapeos de proyecto antes de escribir nada.** Si a mitad
   del flujo falta uno, ya habría issues creados y la interrupción dejaría el
   trabajo a medias.
3. **`bita link` es el punto de commit de cada grupo**, y va después de todo lo
   que toca Jira: mientras la entrada no tenga su fila, el trabajo se considera
   no hecho. Perder horas es peor que duplicarlas, y esto es lo que evita
   perderlas. Sólo `bita docs page link` va detrás, porque es local y no puede
   hacer perder nada.
4. **Nunca escribas en la base a mano.** Ni `sqlite3`, ni SQL suelto: el CLI es
   quien mantiene las invariantes (instantes en UTC, claves foráneas, ids).
5. **No encadenes comandos** con `|`, `;` ni `&&`, y no invoques el CLI con
   `pnpm run`: su banner rompería el parseo del JSON.
6. **La Historia y la Épica son contenedores, no tareas.** No se les pone
   estimación, no se les añaden worklogs, **no se les pone persona asignada ni
   fecha de inicio** y **no se cierran nunca**: cerrar la Historia dejaría huérfanas a las subtareas
   que vengan después. Solo el issue de trabajo —Subtarea o Tarea— se estima, se
   registra, **se asigna**, **se fecha** y se transiciona.
7. **Una sola Historia nueva por corrida sin preguntar.** Si el plan crea dos o
   más, para y enséñalas: casi siempre significa que la épica o el tema están
   mal. Jira no fusiona issues, así que una Historia duplicada se limpia moviendo
   subtareas a mano. Lo mismo vale para una **épica nueva**, que solo se propone
   en proyectos que apuntan al tablero (`epicMode: "per-run"`).
8. **Si `createJiraIssue` falla por jerarquía, para ese grupo.** No reintentes
   sin `parent`: una subtarea huérfana es inenrutable.
9. **No calcules fechas ni duraciones.** El CLI ya entrega `startedJira`,
   `timeSpent` y `totalHuman` listos. Cópialos literalmente.
10. **Nada de lo que se publica delata la conversación ni reparte el trabajo.**
    Las páginas, los issues, los comentarios de Jira y las páginas de
    Confluence se escriben como documentación técnica de quien tiene asignada
    la tarea, no como el acta de un chat ni como un reparto entre una persona y
    un asistente. Ver "Cómo se escribe lo que se publica".
11. **Toda pregunta de opción cerrada va por la interfaz de preguntas disponible.** Nunca escribas
    un menú numerado en la respuesta para que el usuario conteste "1", "2" o "3":
    la interfaz ya tiene ese menú y elegir en él es un clic, no teclear un número
    que hay que emparejar a mano con una lista de más arriba. Aplica a la
    confirmación del paso 7, a la elección de transición de cierre y a cualquier
    otra disyuntiva. Lo que sigue en prosa es la lista de candidatos de una
    búsqueda, que puede pasar de cuatro.
12. **Lo que falta nunca va a Jira.** Los pendientes y hallazgos viven en el
    backlog **de bita** (`bita backlog add`). No se crean issues, subtareas ni
    Historias para trabajo que no se hizo, no se dejan criterios de aceptación
    sin cumplir como tarea para nadie y no se listan pendientes en los
    comentarios. En Jira solo entra el trabajo medido.

## Cómo se escribe lo que se publica

La página, el issue, sus comentarios y lo que se publica en Confluence los va a
leer gente que no estuvo aquí, meses después, buscando por qué algo está como
está. Tienen que leerse como el trabajo de quien tiene asignada la tarea.
**Nada en el texto puede delatar que hubo una conversación, ni quién pidió qué,
ni que lo escribió un asistente, ni que el trabajo se repartió entre alguien que
lo hizo y alguien que tiene que terminarlo.**

### Lista negra

Si una de estas aparece en el texto, la frase está mal y hay que reescribirla
entera, no suavizarla:

- **Quién lo pidió**: "por decisión del usuario", "se acordó con el usuario", "a
  petición del usuario", "según lo solicitado", "el usuario pidió / indicó /
  confirmó / prefirió", "como se solicitó".
- **La conversación**: "en esta sesión", "durante la conversación", "en el
  chat", "como se comentó", "se revisó junto con", "se validó con".
- **Primera persona de charla**: "decidimos", "acordamos", "vimos que", "nos
  dimos cuenta", "optamos por", "revisamos".
- **Relleno burocrático**: "se procedió a", "se llevó a cabo la tarea de", "se
  realizó la implementación de", "cabe destacar", "es importante señalar", "como
  se mencionó anteriormente".
- **Hedging**: "creo que", "parece que", "aparentemente", "podría ser que", "en
  principio", "al parecer", "se asume que".
- **El asistente**: "asistente", "Claude", "IA", "generado automáticamente",
  "agente", y cualquier nombre de herramienta del agente.
- **Narración del tanteo**: "se intentó varias veces", "después de varios
  intentos", "tras probar distintas opciones".
- **Reparto del trabajo**: "yo hice", "hice esto", "esto lo ejecutas tú", "te
  toca", "queda de tu lado", "tú debes", "tienes que", "lo corrí por ti", "lo
  dejo listo para que lo apliques", "el asistente ejecutó", y **cualquier
  segunda persona** dirigida al lector o al usuario. Un issue no le habla a
  nadie: dice qué se necesita y qué quedó.

### Así no / así sí

| Así no | Así sí |
|---|---|
| Por decisión del usuario se fijó el tope en 8 horas. | El tope por tarea es de 8 horas: Jira rechaza worklogs mayores en una sola entrada. |
| Se acordó usar colas en lugar de procesar en línea. | El procesamiento pasa a una cola: en línea, un pico de reservas bloqueaba las respuestas de la API. |
| Según lo solicitado, se agregó validación al endpoint. | El endpoint valida el id del apartado antes de encolar; sin validación, un id vacío llegaba hasta el consumidor. |
| Se procedió a la migración de la tabla de pagos. | La tabla de pagos se migró a `payments_v2`. |
| Creo que el problema era el token expirado. | El SDK devuelve 200 con cuerpo vacío cuando el token expiró; ese era el fallo. |
| Después de varios intentos logramos que pasaran las pruebas. | `pnpm test`: 148 pasan, 0 fallan. |
| El usuario prefirió no tocar el front en esta iteración. | El front queda fuera de alcance; sigue esperando 201 y funciona con 202. |
| Se analizó el código y se detectaron varios problemas. | `QUEUE_URL` del entorno de dev apunta a la cola de staging desde marzo. |
| Yo dejé listo el plan; el `terraform apply` lo ejecutas tú. | El plan de `compute` está validado: 0 a crear, 3 a cambiar, 13 a destruir. |
| Hice los cambios en el pipeline, te toca probar en QA. | El pipeline despliega a QA con el tag `qa-1.4.0`. |

### Cómo se escribe entonces

- Voz impersonal en pasado ("se migró", "se añadió") o sujeto técnico ("el
  worker reintenta cinco veces"). Nunca "yo", "nosotros" ni "tú".
- **Una afirmación es un hecho comprobable.** Si no se comprobó, no se atenúa
  ni se escribe: va al backlog (`bita backlog add --kind pending`).
- **Las decisiones se justifican por su razón técnica, no por su origen.** Si la
  razón real es una preferencia de negocio, se escribe como restricción ("el
  reporte exige bloques de 8 h"), no como autoría.
- El resultado, no el camino.
- **Lo que falta no es una instrucción para nadie.** No se escribe «falta que
  alguien aplique X» en una página ni en Jira: es un ítem del backlog de bita
  (`bita backlog add`). Lo que se
  publica describe lo que existe.

### La prueba de olfato

Antes de guardar el documento y otra vez antes de crear el issue, lee cada
párrafo y pregunta:

1. **¿Esto lo escribiría alguien en su bitácora técnica, sin haber estado en la
   conversación?** Si suena a acta de reunión, fuera.
2. **Si borro la primera mitad de la frase, ¿se pierde información técnica?** Si
   no se pierde nada, esa mitad era relleno o era la conversación.
3. **¿Queda alguna palabra de la lista negra?** Si sí, reescribe la frase
   completa: cambiarle el sujeto no la arregla.
4. **¿Alguna frase le habla a alguien o dice quién hizo qué?** Si sí, fuera: el
   issue es de quien lo tiene asignado, y todo lo que dice es suyo.

## La ventana que sigue existiendo

No hay cuota que agotar, pero **Jira sigue siendo remoto**. El hueco entre
escribir el worklog y correr `bita link` es el único punto donde el estado puede
quedar partido, y sigue valiendo la regla: si algo falla ahí, ata igualmente las
entradas que sí llegaron y repórtalo. Los worklogs de Jira no se pueden borrar
con el conector.

## La jerarquía de Jira

Los niveles de este tenant: `Epic` = 1; `Historia`, `Tarea` y `Error` = 0;
`Subtarea` = −1. Un padre tiene que estar en un nivel **superior** al del hijo.

De ahí sale la consecuencia que manda en todo el flujo: **Historia y Tarea están
al mismo nivel, así que una Historia no puede contener Tareas. Solo Subtareas.**

```
Épica     (nivel  1)  el contenedor del proyecto, ya existe
  └─ Historia  (nivel  0)  el tema, inferido, se reusa entre corridas
       └─ Subtarea (nivel −1)  un grupo de bita, con sus worklogs
```

El tiempo se acumula solo hacia arriba: Subtarea → Historia → Épica.

| `hierarchy` | Cuándo | Qué se crea |
|---|---|---|
| `epic-story-subtask` | Por defecto | Historia bajo la épica; Subtareas bajo la Historia |
| `story-subtask` | El proyecto no tiene épica | Historia suelta; Subtareas bajo ella |
| `flat-task` | Solo si el usuario lo pide | Tarea suelta, como en la primera pasada |

### A qué apunta el mapeo

El mapeo de un proyecto apunta **a una épica** o **al tablero**, y el CLI lo
entrega en cada grupo como `epicMode`:

| `epicMode` | Mapeo | Qué pasa en cada corrida |
|---|---|---|
| `fixed` | Tiene `parentKey` | Todo va a esa épica. `jiraEpicKey` viene lleno. Así se ha trabajado siempre y no cambia. |
| `per-run` | Solo el tablero | La épica se **elige en cada corrida** entre las abiertas del tablero, o la Historia queda suelta. `jiraEpicKey` viene `null`. |
| `flat` | `hierarchy: flat-task` | Tarea suelta, sin épica ni Historia. |

Apuntar a una épica tiene sentido cuando el proyecto siempre cae en la misma. Si
el trabajo se reparte entre varias épicas del tablero, se apunta al tablero.

Verificado en vivo: `VD-4961` es una Historia y obligó a crear Subtareas; las
épicas `INN-1213` e `INN-1216` aceptaron Tareas como hijas.

## Temas canónicos

Las Historias **solo** pueden llamarse como uno de los temas de
`meta.storyThemes`. No inventes nombres: es lo único que evita acabar con
«DevOps», «Dev Ops» e «Infraestructura» como tres Historias distintas.

Por defecto: DevOps · Backend · Frontend · Infraestructura · Análisis y
estimación · Seguridad · Soporte · Sesiones y reuniones · Documentación.

Si un trabajo no encaja en ninguno, **pregunta**; no crees un tema nuevo por tu
cuenta. La caché se indexa por el **id** del tema, así que renombrar el nombre
visible no rompe nada ni renombra Historias ya creadas.

## Procedimiento

### 0. Verificar

```
bita projects --json
```

Si el CLI no responde, detente y dile cómo instalarlo. Confirma también con qué
cuenta de Atlassian se van a registrar las horas (`atlassianUserInfo`): el
conector escribe con esa identidad y reasignar un worklog después es incómodo.

**Guarda su `account_id`.** Es el que va en `assignee` de cada issue de trabajo
que crees. Sin él la tarea nace sin dueño: no sale en el tablero de quien hizo
el trabajo ni en los reportes de carga, y las horas quedan colgando de nadie.

**Confirma también el id del campo «Fecha de inicio»** una vez por corrida, con
`getJiraIssueTypeMetaWithFields`. En este tenant es `customfield_10015`, pero es
un campo personalizado y su id puede no ser el mismo en otro sitio; comprobarlo
cuesta una llamada y equivocarse deja la fecha en blanco sin avisar.

### 1. Resolver el alcance

- Sin rango: todas las `pending`, con tope de 90 días hacia atrás. El CLI lo
  avisa; repítelo al usuario.
- Con rango: pásalo como preset (`today`, `yesterday`, `week`, `last-week`,
  `month`, `last-month`) o como `--from`/`--to`. **El cálculo lo hace el CLI.**
- Confirma el alcance en una línea antes de seguir.

### 2. Leer y agrupar

```
bita summary --pending --json
```

Devuelve un envelope con `data.groups`. Cada grupo es **una tarea de Jira**:

- `summary` — el título tal cual lo escribió el usuario.
- `totalSeconds` / `totalHuman` — el tiempo real medido, que es lo que suman los worklogs.
- `estimateSeconds` / `estimateHuman` — **la estimación original**, redondeada hacia
  arriba al siguiente medio punto. Es este el que va a `timetracking`, no el total:
  3h 43m medidas se registran como 4h de estimación con worklogs que suman 3h 43m.
- `worklogs[]` — **un worklog por cada bloque de tiempo**, con su `startedJira`
  y su `timeSpent` ya formateados.
- `entryIds[]` — las entradas que hay que atar con `bita link` al terminar.
- `jiraProjectKey` — `null` si el proyecto aún no está mapeado.
- `partIndex` / `partCount` / `splitReason` — ver el tope de 8 horas.

En `meta` vienen `excluded`, `alreadyRegistered`, `unmappedProjects`,
`overlaps` y `warnings`.

### 3. Triaje

Reporta los cubos aunque no se procesen. Ninguno se escribe en Jira:

| Motivo | Qué hacer |
|---|---|
| `running` | Excluir. Di cuáles son (`bita ls`) y ofrece pararlos. Con varios cronómetros a la vez esto es normal, no un error. |
| `no-description` | No inventes título. Lista y pide uno, o déjalas pendientes. |
| `zero-duration` | Excluir: Jira rechaza worklogs de menos de un minuto. |
| `alreadyRegistered` | Solo se cuenta para el reporte. |

**`meta.overlaps`** no excluye nada: son los días donde el tiempo registrado
supera el tiempo de reloj cubierto, porque hubo cronómetros solapados. Está
permitido y es intencional. **Dilo en la propuesta** con las horas exactas: quien
lea el reporte en Jira verá un día de 10h y merece saber por qué.

### 4. Tope de 8 horas por tarea

Una tarea admite como máximo **8 horas** de worklog y 8 de estimación original.
El CLI ya parte lo que se pasa y numera las partes `(1/n)`, `(2/n)`. Cuando veas
`splitReason: "max-task-hours"`, dilo en la propuesta: son varias tareas de Jira
para un mismo título. Con `--max-task-hours N` se cambia el tope.

### 5. Resolver los mapeos faltantes, en un solo bloque

Para cada proyecto en `meta.unmappedProjects`, pregunta a qué tablero de Jira va.
**No listes todos los proyectos**: pide la clave (`DPF`, `INN`) y valídala con
`getVisibleJiraProjects(searchString)`. Si lo que escribe no parece una clave,
trátalo como búsqueda y muestra un máximo de 8 candidatos numerados.

Persiste cada respuesta en cuanto se confirme:

```
bita map set <projectId> <JIRAKEY> --issue-type "Tarea"
bita map set <projectId> <JIRAKEY> --parent <JIRAKEY-123> --issue-type "Tarea"
```

**Varios proyectos pueden compartir tablero y diferir solo en el padre.**
Ese es el caso normal, no la excepción: el mapeo guarda `jiraProjectKey` y
`parentKey` por separado, y el CLI valida que el padre pertenezca al tablero.

**El padre no siempre es una épica.** Antes de mapearlo, léelo con `getJiraIssue`
y mira su `issuetype.hierarchyLevel`: nivel 1 es una Epic y puede tener Historias
o Tareas dentro; nivel 0 es una Historia o una Tarea y **solo puede tener
Subtareas**.

**La épica se pregunta una sola vez.** Un proyecto con `epicResolved: false` y sin
`jiraEpicKey` todavía no se ha preguntado: hazlo en este mismo bloque.

- Si te da una épica → `bita map set <id> <KEY> --parent <KEY-123>`, y el
  trabajo será `Subtarea` bajo una Historia dentro de esa épica.
- Si dice que **no hay una sola épica** → guárdalo con `--no-epic`, que marca
  `epicResolved: true` y deja el mapeo apuntando al tablero (`epicMode:
  "per-run"`). A partir de ahí la épica se elige en cada corrida (paso 5.5) y,
  si ninguna encaja, la Historia se crea suelta. **No vuelvas a preguntar por
  ese proyecto.**

Sin ese `epicResolved`, los proyectos sin épica se preguntarían en cada corrida
para siempre, que es justo lo que este flujo no debe hacer.

**Cambiar a qué apunta un proyecto** no pierde nada: `map set` fusiona con el
mapeo que ya existe y conserva la transición de cierre, los tipos y la caché de
Historias, que está indexada por épica.

```
bita map set <id> <KEY> --parent <KEY-123>   # de tablero a épica fija
bita map set <id> <KEY> --no-epic            # de épica fija a tablero
```

Hazlo solo cuando el usuario lo pida, o cuando corrija el destino de un proyecto
con épica fija diciendo que su trabajo no siempre va ahí.

Los proyectos ya mapeados se resuelven en silencio: **no vuelvas a preguntar por
ellos nunca**. Si el usuario cancela a mitad del bloque, aborta la corrida entera.

Entradas **sin proyecto**: no les inventes destino. Lístalas aparte y
ofrece asignarles uno solo para esta corrida, o dejarlas pendientes.

### 5.5. Resolver la Historia de cada grupo

Antes de crear nada:

0. **Solo si `epicMode` es `"per-run"`: elige la épica.** Con `fixed` la épica
   es `jiraEpicKey` y este subpaso no existe; con `flat` no hay épica ni
   Historia.

   - Trae las épicas abiertas del tablero, una vez por tablero y corrida:

     ```
     project = <KEY> AND issuetype = Epic AND statusCategory != Done ORDER BY updated DESC
     ```

   - Elige por grupo con las mismas señales que el tema: página, título, repo y
     rama. La épica es el frente de trabajo (un cliente, una iniciativa, una
     auditoría), no el tipo de trabajo, que eso es la Historia.
   - Si ninguna encaja, el grupo va a una **Historia suelta**, con la regla de
     búsqueda sin épica del punto 3. Si lo que falta es claramente un frente
     nuevo, propón crear la épica en la propuesta, con su nombre. Cuenta para la
     regla 7 y se crea sin `assignee`, sin estimación y sin cerrarla nunca.
   - Enseña la épica elegida en la tabla de la propuesta. Es la decisión que el
     usuario más probablemente corrija.
   - A partir de aquí, «la épica» es la que elegiste, y la caché de Historias es
     `jiraStoriesByEpic[<épica>]`, o `jiraStoriesByEpic[""]` si la Historia va
     suelta.

1. Elige el tema de la lista cerrada. La señal más fuerte es el **documento**
   del grupo (`pages[]`, o `docs[]` en el trabajo anterior a las páginas).
   Después el título, el repo y la rama. El proyecto acota, no decide.
2. ¿`jiraStories[themeId]` ya tiene una key? → úsala, sin buscar. Con
   `per-run`, mira en `jiraStoriesByEpic` bajo la épica elegida.
3. Si no, trae las Historias de la épica y **empata por igualdad exacta
   normalizada** (trim, espacios, acentos, minúsculas) contra el nombre canónico:

   ```
   project = <KEY> AND issuetype = Historia AND parent = <épica> ORDER BY created DESC
   ```

   **Nunca decidas con `summary ~`.** Tokeniza: «Infraestructura» empata
   «Infraestructura de pruebas del cliente». Sirve para avisar, no para elegir.

   Sin épica (`hierarchy: story-subtask` con épica fija ausente, o `per-run` sin
   épica que encaje), añade `AND parent IS EMPTY AND reporter = currentUser()`:
   sin épica que acote, el riesgo de reusar la Historia de otro es real.
4. Si no hay empate, propón crearla. Al confirmar, créala **sin `assignee`** —es
   un contenedor, no trabajo de nadie— y **persiste la referencia en el mapeo de
   inmediato**, antes de tocar ninguna subtarea:
   `bita map story <projectId> <themeId> <ISSUE-KEY>`. Con `per-run` di bajo qué
   épica cuelga —`--epic <KEY-123>` o `--no-epic`—: el CLI lo exige, porque la
   misma Historia de tema existe una vez por épica.

Si un grupo mezcla notas de temas distintos, gana el mayoritario y **dilo en la
propuesta**: suele ser un cronómetro que se dejó correr a través de un cambio de
tema.

### 6. Preflight por proyecto

Una vez por combinación de proyecto y tipo de issue:

- `getJiraProjectIssueTypesMetadata` → el id del tipo. **Los tipos están en
  español**: "Tarea", "Historia", "Error", "Subtarea", "Epic". Nunca asumas "Task".
- `getJiraIssueTypeMetaWithFields` → si `timetracking` está en la pantalla, y qué
  campos son obligatorios.

Si el proyecto no expone `timetracking`, **registra el worklog igual** y salta la
estimación. Avísalo una vez por proyecto, no una por issue.

### 7. Propuesta y confirmación

Tabla con una fila por tarea: proyecto → Jira, tipo, resumen, número de
worklogs, rango de fechas y total. Si algún grupo es `per-run`, añade la columna
de épica e Historia elegidas, marcando lo que se va a crear. Debajo, lo excluido
con su motivo.

**Las tareas se cierran al terminar. No lo preguntes.** Solo se dejan abiertas si
el usuario lo pide explícitamente, y entonces dilo en la tabla.

La confirmación se pide con la interfaz de preguntas disponible, con estas cuatro opciones:

| Opción | Qué hace |
|---|---|
| Confirmar y escribir | Crea todo lo de la tabla, de una tacada. |
| Ajustar | Fusionar, partir, renombrar, cambiar proyecto o excluir grupos. |
| Ver el detalle | El payload literal de un grupo, antes de decidir. |
| Cancelar | No se escribe nada. |

La tabla de la propuesta va **antes** de la pregunta, en la respuesta: es lo que
el usuario necesita leer para elegir, y en la pregunta no cabe.

**Esta es la única parada.** Confirmado el menú, se escriben todos los grupos sin
volver a preguntar.

Si la frase del usuario fue de consulta ("qué trabajé esta semana"), **termina
aquí**: eso es el reporte, no hay escritura.

### 8. Escribir, grupo por grupo

Todos los grupos, uno detrás de otro, sin parar a confirmar entre medias. Y dentro
de cada grupo, este orden, sin paralelismo:

0. **La Historia ya está resuelta** en el paso 5.5 y persistida en el mapeo.
   Si tuviste que crearla, no le pongas estimación ni la cierres nunca. Si el
   grupo es `per-run` y llevaba épica nueva, esa épica se crea primero, y la
   Historia con `parent` = esa épica.
1. `createJiraIssue` para el trabajo, como **`jiraWorkIssueTypeName`**
   (`"Subtarea"` por defecto) con `parent` = la key de la Historia.
   `issueTypeName` va por **nombre**, no por id.
   - `summary`: el del grupo, **literal**, sin reescribir. Es la clave de
     agrupación y lo que el usuario reconocerá al buscar.
   - `description`: **el requerimiento**, no el informe. Se escribe como se
     habría escrito la tarea antes de empezar: qué se necesita, por qué y cómo
     se sabe que está hecha. Nada de resultados, bitácora, tablas de archivos
     ni el cuerpo de la página pegado. Tres secciones, cortas:

     ```
     ## Objetivo
     Uno o dos párrafos: qué se necesita y por qué importa.

     ## Alcance
     - Lo que entra, en viñetas concretas (servicio, ambiente, componente).
     - Lo que queda fuera, si evita una confusión probable.

     ## Criterios de aceptación
     1. Condición verificable
     2. Condición verificable
     ```

     Sale del título del grupo, de las páginas (`pages[]`) y de los `--did` de
     sus entradas, **reformulado como necesidad**: «Se migró la búsqueda a la
     L4» es resultado; «Migrar la búsqueda por imagen a la instancia L4 para
     bajar el costo de inferencia» es requerimiento. Los criterios son los que
     el resultado cumple, así que quien lea el comentario de resultados puede
     cotejarlos uno por uno. Van **numerados**, no como casillas: el conector
     escapa `- [ ]` y en Jira se ve el texto literal `[ ]`. La Verificación del
     comentario sigue la misma numeración.
     **Antes de enviarla, pásale la prueba de olfato**: es el texto que verán
     otros.

     El trabajo anterior a las páginas trae `docs[]` en vez de `pages[]`: sirve
     igual de fuente, y si viene con `markdown: null` y `truncated: true` se lee
     de su `path` con Read. Sus secciones «Hallazgos» y «Pendiente» no van a
     Jira: van al backlog con `bita backlog add`. Un grupo sin página y sin
     documento se describe con su título y sus `--did`.
   - `assignee`: **siempre**, con el `accountId` del paso 0. Es la única pieza
     del payload que Jira no deduce de nada y que nadie echa en falta hasta que
     busca su propio trabajo y no lo encuentra.
   - **Fecha de inicio** (`customfield_10015` en este tenant): **siempre**, con
     `days[0]` del grupo, en `YYYY-MM-DD`. Es el día en que empezó el trabajo,
     no el día en que se registró: sin ella, los informes y las vistas de
     cronograma colocan la tarea el día del volcado, que puede ser semanas
     después.
   - `timetracking` con `originalEstimate` = `estimateHuman` y
     `remainingEstimate: "0m"` puede ir ya en la creación; ahorra una llamada.
2. Solo si el proyecto no admitía `timetracking` en la pantalla de creación,
   `editJiraIssue` con los mismos valores. **Siempre antes del worklog**: algunos
   workflows bloquean la edición una vez cerrado el issue, y el tool de worklog
   no expone `adjustEstimate`, así que fijar el cero explícitamente es correcto
   tanto si Jira decrementa solo como si no.
3. `addWorklogToJiraIssue` **una vez por cada entrada de `worklogs[]`**, copiando
   `startedJira` y `timeSpent`. En `commentBody`, el rastro de auditoría:
   `bita · <startLocal> · bita:<entryId>`.
4. `addCommentToJiraIssue` con **los resultados**, un solo comentario por issue
   y por corrida, en markdown:

   ```
   ## Resultado
   Qué existe ahora que no existía, en presente y con nombres concretos
   (recurso, versión, endpoint, rama, MR).

   ## Verificación
   El comando o la comprobación y lo que dio. Un criterio de aceptación por
   viñeta, en el mismo orden que la descripción.

   ## Referencias
   - [Título de la página de Confluence](https://…/wiki/spaces/…) — espacio X.
   - MR: [repo !3](https://…/-/merge_requests/3), [!4](https://…/-/merge_requests/4).
   ```

   **Toda referencia lleva su enlace**, también las MR que se citan en
   Resultado: `[texto](url)`, nunca un título suelto que obliga a buscarlo. Las
   URLs salen de `pages[].refs`. Si una referencia no está ahí, se busca antes de
   escribir —`searchConfluenceUsingCql` por título para Confluence, la API del
   GitLab del repo para una MR (confirmando que existe)— y se registra en la
   página con `bita docs page ref add` para que la próxima corrida ya la tenga.
   Lo que no tiene URL que se pueda confirmar no se cita.

   Sale de las páginas del grupo y de los `--did`. Lo que el requerimiento pedía
   y **no** quedó hecho no se escribe como tarea para nadie: se dice en
   Resultado qué alcance quedó cubierto y el resto va al **backlog de bita** con
   `bita backlog add`: ni un issue nuevo, ni una subtarea, ni una lista de
   pendientes en el comentario. Mismas reglas de redacción que la descripción: sin
   primera persona, sin segunda persona, sin reparto del trabajo. **Pásale la
   prueba de olfato antes de enviarlo.**
5. Cierra el issue: `getTransitionsForJiraIssue` y elige **por lo que devuelva**,
   nunca por nombre a ciegas. Ver abajo. Sáltalo solo si el usuario pidió dejarlas
   abiertas.
6. `bita link <entryIds...> --issue <ISSUE-KEY>`, en una sola llamada por grupo.
   Es una transacción local: o quedan atadas todas o ninguna.
7. `bita docs page link <pageId> --issue <ISSUE-KEY> --summary "<el summary del
   issue>" --status "<el estado en que quedó>" --status-category <categoría>`,
   **una llamada por cada página de `pages[]`**. Esto no se pregunta ni se
   pospone: es lo que hace que la página enseñe las tareas que salieron de ella,
   y este es el único momento en que tienes el estado a mano —después habría que
   volver a pedírselo a Jira—. La categoría es la `to.statusCategory.key` de la
   transición que aplicaste (`done` si lo cerraste), o la del estado en que
   nació si lo dejaste abierto.

   La relación es de muchos a muchos y por eso se ata en los dos sentidos: un
   grupo con dos páginas ata las dos al mismo issue, y una página que ya tenía
   issues de corridas anteriores los conserva. Repetir la llamada con la misma
   clave **actualiza** la fila, no la duplica, así que volver a atar es seguro.

   Un grupo sin `pages[]` —trabajo viejo, que sólo trae `docs[]`— no tiene página
   donde atar: sáltalo y dilo en el resumen final, para que se vea que quedó sin
   documentar.

Al terminar, una tabla con una fila por tarea y una columna por paso —crear,
asignar, fechar, estimar, worklog, comentar, cerrar, atar las entradas, atar la
página—,
la key enlazada y el total registrado. Debajo, lo que se saltó y por qué. Es el
único sitio donde se ve que un paso no corrió, así que una casilla vacía se deja
vacía: no se rellena por simetría.

### Elegir la transición de cierre

1. Filtra las transiciones cuyo `to.statusCategory.key === "done"`.
2. Si queda **una**, úsala.
3. Si quedan **varias**, elige por el **nombre del estado destino (`to.name`)**,
   nunca por el nombre de la transición. No son lo mismo y confundirlos cancela
   trabajo: en **VBGLOBAL la transición se llama «Listo» pero su `to.name` es
   «Cancelado»**, y la de cierre real es «Closed» → «Cerrada».

   - Orden de preferencia sobre `to.name`: Finalizada, Finalizado, Cerrada,
     Cerrado, Hecho, Completada, Terminado, Done.
   - **Descarta siempre** los `to.name` que suenen a abandono o a paso
     intermedio: Cancelado, Cancelada, Duplicado, No se hará, Rechazado,
     READY TO TEST, Ready to test.
   - Si tras eso sigue habiendo varias, **pregunta**. Propónla en la
     confirmación la primera vez y guárdala en el mapeo.
4. Si **ninguna** está en categoría `done`, da **un solo salto** hacia una
   `indeterminate` y vuelve a consultar. Máximo dos saltos. Nunca iteres
   transiciones a ver cuál pega: cada intento dispara notificaciones y
   automatizaciones.
5. Si la transición **pide campos obligatorios**: rellena `resolution` solo si hay
   un único candidato evidente. En cualquier otro caso deja el issue abierto y
   repórtalo. Una resolución mal puesta contamina las métricas del equipo.

## El cronómetro en vivo

### Cuándo proponerlo

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

### Arrancar

```
bita start                    # en blanco, al principio de la sesion
bita start "<título corto>"   # o con titulo, si ya se sabe
```

El título es la clave de agrupación y el summary del issue: corto y reconocible.
El proyecto sale del repo mapeado; si no lo está, el CLI falla con
`REPO_NOT_MAPPED` y el comando exacto para arreglarlo. La entrada nace sin fila en
`jira_links`, así que ya está pendiente en este pipeline.

**Pueden correr varios cronómetros a la vez** y `start` nunca se niega. Eso es
deliberado: mide dos trabajos en paralelo en vez de forzar una elección falsa.

### Reuniones

Una reunión lleva tipo, para que la grabe [recap](https://github.com/KikeDeAlba/recap)
por el hook de bita:

```
bita start "<título>" --kind remote-meeting      # Meet, Zoom, Teams, llamada, videollamada
bita start "<título>" --kind in-person-meeting   # presencial, en sala, en oficina
bita amend <id> --kind remote-meeting            # a un contador que ya corre
bita amend <id> --kind none                      # deja de ser reunión
```

`bita setup` instala recap (app, CLI, plugin, modelos y hook). Si `bita hooks`
no lo muestra, sugiere correr `bita setup` antes de prometer que se grabará.

Elige el tipo por el contexto; si no queda claro si es remota o presencial,
pregunta solo eso. `start`, `stop`, `cancel` y un `amend` que cambia el tipo
disparan los hooks de `bita hooks`: con recap configurado, arrancar graba, parar
procesa la grabación y deja la minuta en la sección «Reunión» del documento, y
cancelar descarta la grabación. `meta.hooksFired` dice cuántos se lanzaron; si
es 0 en una reunión, no hay hook configurado y no se está grabando, así que
dilo.

### Varios a la vez, y cuándo partir

1. **Cambia el proyecto → arranca otro cronómetro.** El proyecto elige el
   tablero; equivocarse manda horas al equipo de al lado.
2. Mismo proyecto, tema distinto, y lo nuevo dura ≥20 min → arranca otro.
3. Mismo proyecto, mismo tema → déjalo correr.
4. Interrupciones de menos de ~10 min → déjalo correr. Partir en bloques de
   cuatro minutos hace los worklogs ilegibles y caen en `zero-duration`.

**Solo cuenta el tiempo atendido.** Un despliegue que tarda 40 minutos solo con
el usuario encima cuenta; si se fue, no. Ante la duda, pregunta antes de parar.

Con varios corriendo, `bita ls` los enseña con su id. Para saber qué hay abierto
antes de proponer nada, míralo: es gratis.

### La página

La unidad de documentación es la **página**, no el bloque de tiempo. Una página
cuenta **cómo está algo hoy**, en presente. Las páginas cuelgan de un espacio
—que es el proyecto— y pueden anidarse:

```
bita docs page new "<título>" --project <X> [--parent <id>]
bita docs page show <id>
bita docs page write <id> --md <archivo> [--section "<H2>"]
bita docs page link <id> --issue <KEY> --summary "…" --status "…" --status-category <cat>
```

**La ruta la da el CLI, nunca la inventes.** Corren varios cronómetros a la vez
y varias sesiones a la vez.

**No hay secciones obligatorias ni un orden fijo.** Los encabezados los pide el
contenido: si la página habla de credenciales, un encabezado será «Dónde viven»
y otro «Cómo llegan al contenedor». Como orientación y no como lista a rellenar,
suelen aparecer: qué es, cómo funciona, qué se decidió y sigue vigente, qué
límites tiene, cómo se verifica. Una sección con «N/A» es ruido: si no hay nada
que decir, no existe el encabezado.

**Cuando algo deja de ser cierto se reescribe, no se añade una corrección
debajo.** Una página que acumula «actualización: ya no es así» deja de servir
para lo que existe. Nada de entradas fechadas en el cuerpo, nada de «hoy hice»:
para eso está el registro.

**Una página es un documento formal del estado actual, y nada más.** Ni
«Pendiente», ni «Hallazgos», ni «Lo que falta», ni «Próximos pasos», ni
bitácora: esas secciones convierten la descripción de un sistema en una lista de
tareas, y acaban copiadas en Jira y en Confluence. `bita docs page write` avisa
con `BACKLOG_SECTION_IN_PAGE` si aparece una. Un límite conocido que es parte de
cómo funciona el sistema hoy («el NAT vive en una sola AZ») sí se describe en la
página, como hecho; lo que alguien tiene que hacer, no.

GFM plano, más tablas, bloques ```mermaid``` y bloques ```drawio``` (ver
«Diagramas»). Sin macros ni HTML. El H1 igual al título.

### Pendientes y hallazgos: el backlog de bita

Lo que queda por hacer y lo que se descubrió de paso se registra **aparte**, en
el backlog **de bita** —la tabla local que la app de escritorio enseña como
lista entre proyectos—, **nunca en Jira**. En Jira solo existe el trabajo que se
hizo y se midió; un pendiente convertido en issue es una tarea que nadie pidió y
que queda abierta en el tablero de un equipo.

```
bita backlog add --kind pending --title "<qué falta, en una línea>" [--md <archivo>]
bita backlog add --kind finding --title "<el hecho, en una línea>" [--md <archivo>]
bita backlog ls [--project X] [--page <id>]
bita backlog resolve <CLAVE> --resolution "<cómo quedó>"
```

Cada ítem tiene una **clave** corta: la clave del proyecto y un correlativo,
como `STI-14` (`bita backlog ls` la enseña en la primera columna y la app de
escritorio la deja copiar). Esa es la forma de nombrarlo. Cuando el usuario dice
«cierra STI-14», «resuelve DPO-3» o pega la clave sola con esa intención, es
`bita backlog resolve STI-14 --resolution "<cómo quedó>"` —la resolución sale de
lo que se hizo en la sesión; si no hay de dónde sacarla, se pregunta—. Esas
claves son de bita, **no son issues de Jira** aunque se parezcan: nunca se buscan
ni se cierran en Jira. La clave del proyecto se cambia con
`bita project key <proyecto> <CLAVE>`.

Sin `--page` ni `--project`, el ítem cuelga del cronómetro que corre y de su
página. El título es una frase que se entiende sola en una lista con otros
proyectos; el detalle, en `--md`. La misma redacción de siempre: sin primera ni
segunda persona, sin «te toca».

- **Pendiente** es trabajo que falta y alguien tiene que hacer.
- **Hallazgo** es algo que se descubrió y merece atención —un riesgo, un costo
  inútil, un residuo— aunque no sea parte del trabajo en curso.

Antes de proponer un ítem nuevo, mira `bita backlog ls --page <id>`: si ya está,
no se duplica. Cuando el trabajo resuelve uno, `bita backlog resolve <CLAVE>` en
el mismo bloque. Las páginas viejas que todavía traen esas secciones se limpian con
`bita backlog extract --page <id>` (primero con `--dry-run`).

### Subpáginas

Una página que crece deja de leerse. Cuando pasa de unas **seis secciones**, o
una sección tiene su propio árbol de `###`, o describe un subsistema que se
entiende solo (la red, las credenciales, el pipeline), **pártela**: el padre
queda como visión general con un párrafo por hijo, y cada parte es una página
hija con `bita docs page new "<título>" --parent <id>`. `docs page write` avisa
con `PAGE_SHOULD_SPLIT`. Hasta cinco niveles de profundidad; dos o tres suelen
bastar.

### Diagramas

Dos herramientas, según lo que haga falta dibujar:

| Qué | Con qué |
|---|---|
| Flowchart, estados, un flujo de pocos pasos | **mermaid**, en un bloque ```` ```mermaid ```` dentro de la página |
| **Diagrama de secuencia, siempre** | **mermaid** (`sequenceDiagram`), sin excepción, por elaborado que sea |
| Arquitectura, red, infraestructura, cualquier diagrama con muchos grupos, iconos de servicios o una disposición cuidada | **draw.io**, con el MCP de draw.io |

Un diagrama de draw.io es un archivo `.drawio` junto a la página, no texto en ella:

```
bita docs page asset path <pageId> <nombre>.drawio --create   la ruta donde va el XML
bita docs diagrams render <pageId>                          PNG 2x de cada diagrama de la página
bita docs diagrams ls <pageId>                              qué hay y si su render está al día
```

1. Escribe el XML de draw.io (mxGraph) en la ruta que dio el CLI.
2. Ábrelo con el MCP de draw.io para revisarlo en el editor; si se corrige ahí,
   guarda el resultado en el mismo archivo.
3. En la página, donde va el diagrama, un bloque con el nombre del archivo:

   ````
   ```drawio
   <nombre>.drawio
   ```
   ````

4. `bita docs diagrams render <pageId>`. Sin draw.io Desktop falla con
   `DRAWIO_MISSING`: `bita setup` lo instala.

El render de mermaid usa `mermaid-cli` con el Chrome instalado; el de draw.io,
draw.io Desktop. Los dos quedan en `<página>.assets/` en tema claro, y solo se
vuelve a renderizar lo que cambió. La app de escritorio enseña los dos.

### Enlaces

Lo que se consultó o se tocó fuera del repo —páginas de Confluence, issues de
Jira, hojas de estimación— queda atado a la página. El hook `ref` registra solo
lo que pasa por los conectores de Atlassian y Google Drive mientras corre un
cronómetro. Lo demás se ata a mano:

```
bita docs page ref add <id> --url <URL> --title "<qué es>" [--kind confluence|jira|drive|link]
```

### El registro de trabajo

Lo que pasó en cada bloque **no va al cuerpo de la página**. Va en una línea o
dos, en pasado, al parar:

```
bita start "<título>" --page <id>        el bloque nace colgado de su página
bita stop <id> --did "<qué pasó>"        y se cierra diciendo qué pasó
bita log --from … --for … --did "…"      lo mismo para un bloque ya pasado
```

`--did` describe el **resultado**, no la edición. La fecha y la duración no se
escriben: ya están medidas.

La regla que decide entre los dos: **si lo que acabas de hacer cambia cómo se
describe el sistema, edita la página; si sólo cuenta lo que pasó, va a `--did`.**

Y la que dice si el bloque valió: **si al cerrarlo la página no cambió, o no
aprendiste nada, o no lo escribiste.**

### Mientras el reloj corre

**La página se edita mientras trabajas, no al parar.** Al parar ya no te
acuerdas del porqué, y el porqué es la mitad del valor.

Toca la página cuando cierres un paso que dejó algo en disco, cuando termines
una verificación —y entonces deja escrito cómo se verifica **ahora**,
sustituyendo lo que dijera antes—, cuando cambies de enfoque —reescribiendo la
decisión vigente, con la descartada en una línea si aclara algo— y cuando
descubras algo no obvio del entorno, que es estado del mundo y por tanto de la
página. Si lo que descubriste no describe el sistema sino que pide acción, es un
hallazgo o un pendiente: `bita backlog add`.

No un encabezado por cada cosa: crea uno nuevo sólo si vas a volver al mismo
tema tres veces. Y nada de prosa por `argv` —el quoting se rompe y el texto
queda en `ps`—: el cuerpo entra por `--md <archivo>`.

El hook `checkpoint` avisa cuando un cronómetro lleva tres archivos tocados o
cuarenta y cinco minutos sin documentar, y se calla en cuanto la página cambia.

### Parar

```
bita stop <id> --did "<qué pasó en este bloque>"
```

**Pasa siempre el id cuando haya más de uno corriendo.** Sin id y con varios
abiertos, `stop` falla con `AMBIGUOUS_TIMER` en vez de adivinar. `--all` los para
todos, pero entonces no se escribe ningún `--did`: un bloque pertenece a un
trabajo.

Antes de parar, una última pasada por la página: lo que antes era «Verificación»
se dice en presente, como se verifica hoy; lo que queda por hacer va al backlog
de bita con `bita backlog add`, nunca a la página ni como un TODO enterrado en la prosa.
Si la página no se tocó en todo el bloque, escríbela ahora.

**La página alimenta el requerimiento y el comentario de resultados en Jira, y
lo que se publique en Confluence.** Antes de guardarla, revisa que no lleve
rutas absolutas con nombres internos, secretos ni pegotes de log, y pásale la
prueba de olfato de «Cómo se escribe lo que se publica».

## Publicar en Confluence

Cuando se publica documentación de bita en Confluence, se publica **el estado
actual**, como documento formal. Nada de pendientes, hallazgos, bitácora,
próximos pasos ni referencias a tareas de Jira como trabajo en curso: eso vive
en el backlog de bita, y el trabajo hecho, en Jira.

- **El árbol se refleja.** Una página de bita con hijas es una página de
  Confluence con subpáginas, en el mismo orden. Si la página de bita todavía es
  monolítica, pártela primero (ver «Subpáginas»): se publica la estructura, no
  un documento largo.
- **La página raíz es un índice con contexto**: qué es el sistema, para quién,
  un diagrama de conjunto si ayuda, y un párrafo por subpágina con su enlace. No
  repite lo que dicen las hijas.
- **Cada subpágina se lee sola**: su propio párrafo de entrada, sin «como se vio
  arriba».
- Estructura formal y estable: qué es, cómo está compuesto, cómo funciona, cómo
  se opera y cómo se verifica, según pida el contenido. Tablas para inventarios,
  Mermaid para flujos.
- **Diagramas: siempre como imagen, nunca como código.** Ni un bloque mermaid ni
  XML de draw.io en el cuerpo de la página. El orden es:
  1. Crea o actualiza la página con el texto, dejando cada diagrama en su lugar.
  2. `bita confluence publish-diagrams <pageId de bita> --to <id de la página de Confluence> --json`
     renderiza lo que haga falta y sube cada diagrama como PNG 2x más su fuente
     (`.mmd` o `.drawio`) como adjunto, para poder editarlo después. Devuelve los
     diagramas en el orden de la página, cada uno con su fragmento listo.
  3. Coloca cada imagen donde va su diagrama. Ver «Cómo entra la imagen» abajo.
  Si falla con `CONFLUENCE_LOGIN_REQUIRED` o `CONFLUENCE_AUTH`, **para** y pide al
    usuario que corra `bita confluence login` en una terminal (o, desde el agente
  Code, `! pbpaste | bita confluence login --token-stdin --email <correo>` con el
  token copiado): el token no lo escribes tú.
- **Cómo entra la imagen.** Probado en gruposti: el conector acepta ADF y
  Confluence convierte cada nodo `media` en un `<ac:image>` ligado a su adjunto.
  1. Al escribir el texto deja, donde va cada diagrama, un párrafo marcador
     (`DIAGRAMA-1`, `DIAGRAMA-2`…) en el orden de la página de bita.
  2. Después de `publish-diagrams`, lee la página con `getConfluencePage` en
     `contentFormat: "adf"`, sustituye cada párrafo marcador por el `image.adf`
     del diagrama con el mismo `index` (un nodo `mediaSingle`, ya con su
     `fileId`, su `collection` y el tamaño a la mitad del PNG 2x), y guárdala con
     `updateConfluencePage` en `contentFormat: "adf"`.
  3. Vuelve a leerla y confirma que no quedó ningún marcador.
  Volver a publicar reemplaza los adjuntos con el mismo nombre, así que una
  página actualizada no acumula imágenes viejas.
- La misma prueba de olfato que para Jira, pregunta 4 incluida.
- Al crear o actualizar la página, el hook `ref` la ata sola a la página de bita
  del cronómetro. Si no corría ninguno, átala a mano con `bita docs page ref add`.

## Manejo de fallos

| Falla en | Qué queda | Qué hacer |
|---|---|---|
| `createJiraIssue` | Nada escrito, entradas pendientes | Reintentar es seguro |
| `timetracking` | Issue sin estimación | Continuar sin ella y avisar |
| worklog **parcial** | Issue con worklogs incompletos | `bita link` **solo** las entradas que sí quedaron, anotar la key, reanudar sobre ese issue |
| transición | Issue correcto, abierto | **Atar igual**: el tiempo ya está registrado, y dejarlas pendientes duplicaría worklogs |
| `bita link` | Jira sí, bita no | **Detén la corrida entera** y enseña el comando exacto para repararlo |

`bita link` es local y transaccional, así que fallar ahí es raro: significa que la
base no se puede escribir. Cuando pase, el tiempo ya está en Jira y las entradas
siguen pendientes, así que **una segunda corrida duplicaría los worklogs**.
Adviértelo explícitamente. Los worklogs de Jira **no se pueden borrar** con el
conector, así que un duplicado se limpia a mano en la UI.

Si te equivocaste de issue, `bita link <ids> --unlink` devuelve las entradas a
pendientes; el worklog de Jira hay que quitarlo a mano.

Antes de crear un issue, un `searchJiraIssuesUsingJql` de aviso
(`project = X AND summary ~ "..." AND reporter = currentUser() AND created >= -30d`)
detecta posibles duplicados. **Avisa, no decide**: es una búsqueda difusa.

## Resumen final

Una fila por tarea con ocho marcas — crear, **asignar**, **fechar**, estimar,
worklog, **comentar**, cerrar, atar — el enlace al issue y el total. Cualquier inconsistencia
va **arriba**, no al final.

## Reglas de agrupación

Esta sección es editable a mano; es la palanca principal para ajustar el
comportamiento.

- Clave de agrupación: **proyecto + título**, a lo largo de todo el rango.
  Un grupo puede cruzar días y no se parte por eso.
- El título se compara sin espacios de más y sin puntuación final; por defecto **se
  distinguen mayúsculas** (`--case-insensitive` las une).
- El CLI **no fusiona por similitud**. "Refactor pagos" y "refactor de pagos" son
  dos tareas. Si ves títulos casi iguales, sugiere la fusión en la propuesta y
  deja que decida el usuario.
- **Unificar contadores.** Cuando varios cronómetros son un mismo trabajo —la
  misma sesión partida, o títulos distintos para la misma tarea—, se unifican
  antes de volcar, con confirmación:

  ```
  bita merge <ids...> --dry-run                  enseña cómo quedaría
  bita merge <ids...> [--into <id>] [--title "…"] [--project X]
  ```

  Queda **una entrada** con el título y el proyecto elegidos, sus páginas, sus
  `--did`, sus archivos y sus enlaces juntos, y **cada bloque original como
  segmento**: Jira recibe una sola tarea con un worklog por bloque, con sus
  horas reales. Solo entradas pendientes y paradas. Después se opera sobre la
  entrada que queda; los ids de los segmentos responden `ENTRY_MERGED`.
- Cuidado con títulos genéricos ("daily", "junta", "soporte"): pueden colapsar
  semanas en un issue gigante. El rango de fechas por grupo lo hace visible en la
  propuesta.

## El conector de Atlassian en OpenCode

Jira y Confluence se operan mediante el MCP oficial de Atlassian. `bita setup`
lo registra en la configuración global de OpenCode, pero la autenticación se
hace fuera de `bita` desde `/mcps`.

Las herramientas pueden aparecer con el prefijo `atlassian_` o dentro del grupo
`tools.atlassian`, según la configuración de Code Mode. Usa la herramienta Jira
equivalente disponible en el servidor y no inventes una variante por diferencias
de nombres.
