---
description: Actualiza la documentación del trabajo y después para el cronómetro
argument-hint: [id, vacío si solo hay uno, o "all"]
allowed-tools: Bash(bita stop:*), Bash(bita ls:*), Bash(bita docs:*), Bash(bita note:*), Bash(bita backlog:*), Bash(bita amend:*), Bash(recap wait:*), Bash(recap status:*), Read, Write, Edit
---

Corriendo ahora mismo:

!`bita ls`

**Parar es el último paso, no el primero.** Antes va la documentación: es lo que
acaba en la descripción del issue de Jira, y una vez parado el cronómetro ya no
te acuerdas del porqué. Sin ella el issue queda con un título y nada más.

**Cuál parar.** `$ARGUMENTS` manda. Si viene vacío:

- Un solo cronómetro corriendo → ese.
- Varios → **pregúntame cuál**, listándolos con su id y su tiempo. No adivines:
  la página que vas a actualizar pertenece a un trabajo concreto y colgarla del
  equivocado la vuelve mentira.
- Si viene `all`, para todos con `bita stop --all` y **no escribas ningún
  `--did`**: un bloque pertenece a un solo trabajo.

## 0. Si es una reunión, no documentes: para y espera

Si el cronómetro que vas a parar tiene `kind` `remote-meeting` o
`in-person-meeting` (míralo con `bita ls --json`), **sáltate los pasos 1 y 2**.
recap ya graba la reunión y, al parar, hace lo demás sin que nadie se lo pida:

- transcribe y escribe la minuta;
- le pone al contador un título real y, si estaba vacío, el proyecto;
- crea la página en ese proyecto, o agrega la sección a la página que ya
  tenía, y la escribe;
- pasa los pendientes y las preguntas abiertas al backlog;
- deja la minuta en la sección «Reunión» del documento de la entrada.

```
bita stop <id> --json            # sin --did y sin escribir la página
recap wait --bita-entry <id> --json
```

`recap wait` tarda de uno a cinco minutos en una reunión de una hora: córrelo
con un timeout amplio (15 min). Si `meta.hooksFired` del stop es 0, recap no se
enteró y no hay grabación: dilo y para ahí.

Con el resultado de `recap wait` (`data.wrapup`) responde:

- el título que quedó;
- el proyecto;
- la página;
- cuántos pendientes y hallazgos se crearon;
- la duración.

Si una etapa falló, muestra su error y sugiere `recap process <id>`.

**Si `wrapup.projectResolved` es false**, la transcripción no dejó claro el
proyecto. Pregunta solo «¿De qué proyecto fue?» y, con la respuesta:

```
bita amend <id> --project <X>
bita docs page move <pageId> --project <X>
bita backlog edit <CLAVE> --project <X>      # uno por cada clave de wrapup.backlogKeys
```

Nada más: no reescribas la página ni la minuta.

## 1. Primero, la página

Mira qué dice hoy y actualízala con lo que cambió en este bloque:

```
bita docs page show <pageId>
bita docs page write <pageId> --md <archivo> [--section "<H2>"]
```

La página es un documento formal que cuenta **cómo está algo ahora**, en
presente. Concretamente:

- Lo que ibas a escribir como «Verificación» se dice como **cómo se verifica
  hoy**, con el comando y el resultado real, sustituyendo lo que dijera antes.
- **Nada de «Pendiente», «Hallazgos», «Lo que falta» ni «Próximos pasos» en la
  página.** Lo que queda por hacer y lo que se descubrió de paso van al
  backlog de bita —no a Jira—, un ítem por cosa:

  ```
  bita backlog ls --page <pageId>
  bita backlog add --kind pending|finding --title "<una línea>" [--md <archivo>]
  bita backlog resolve <CLAVE> --resolution "<cómo quedó>"   # la clave de ls, como STI-14
  ```

  Mira antes si ya existe, y resuelve los que este bloque cerró.
- Lo que dejó de ser cierto **se reescribe**, no se corrige debajo.
- Si la página ya pasa de unas seis secciones, o `docs page write` avisa
  `PAGE_SHOULD_SPLIT`, parte lo que se entiende solo en páginas hijas con
  `bita docs page new "<título>" --parent <pageId>`.
- Los enlaces que el hook no vio —una hoja de estimación, una URL externa— se
  atan con `bita docs page ref add <pageId> --url <URL> --title "<qué es>"`.

Si la página no se tocó en todo el bloque, escríbela ahora: qué es, cómo
funciona y cómo se verifica. Si el bloque no tiene página todavía, créala:

```
bita docs page new "<título>" --project <X> [--parent <id>]
bita docs page link <pageId> --entry <id>
```

Nada de prosa por `argv`: el quoting se rompe y el texto queda en `ps`. El
cuerpo entra siempre por `--md <archivo>`.

**Relee antes de seguir.** Que no lleve secretos, rutas absolutas con nombres
internos ni pegotes de log. Y pásale la prueba de olfato de la skill: nada de
«se acordó con el usuario», «según lo solicitado», «decidimos», «creo que», «yo
hice» ni «esto lo ejecutas tú». Lo van a leer otros en Jira y en Confluence.

## 2. Después, parar

```
bita stop <id> --did "<qué pasó en este bloque>"
```

Una línea o dos, en pasado, el resultado y no la edición. La fecha y la duración
no se escriben: ya están medidas.

**Si la página no cambió, dilo en voz alta antes de parar**: o no aprendiste nada
en dos horas, o aprendiste algo y no lo escribiste. Casi siempre es lo segundo.

Responde con el id, el título, el tiempo que quedó registrado, qué cambió en la
página y, si siguen corriendo otros, cuáles.
