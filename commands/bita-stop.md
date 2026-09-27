---
description: Actualiza la documentación del trabajo y después para el cronómetro
argument-hint: [id, vacío si solo hay uno, o "all"]
allowed-tools: Bash(bita stop:*), Bash(bita ls:*), Bash(bita docs:*), Bash(bita note:*), Bash(bita backlog:*), Read, Write, Edit
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
  backlog, un ítem por cosa:

  ```
  bita backlog ls --page <pageId>
  bita backlog add --kind pending|finding --title "<una línea>" [--md <archivo>]
  bita backlog resolve <id> --resolution "<cómo quedó>"
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
