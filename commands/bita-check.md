---
description: Anota un checkpoint en el documento del cronómetro que está corriendo
argument-hint: [id, vacío si solo hay uno]
allowed-tools: Bash(bita ls:*), Bash(bita note:*), Bash(bita docs:*), Bash(bita backlog:*), Read, Write, Edit
---

Corriendo ahora mismo:

!`bita ls`

Escribe en el documento de la entrada lo que ha pasado desde el último
checkpoint. **El documento no se escribe al parar**: al parar ya no te acuerdas
del porqué, y el porqué es la mitad del valor.

**Cuál.** `$ARGUMENTS` manda. Si viene vacío y solo hay uno corriendo, ese; si
hay varios, **pregúntame cuál**. Un checkpoint colgado del cronómetro
equivocado convierte dos páginas en mentira.

**Qué haces**, según lo que acabe de pasar:

- un paso cerrado que dejó algo en disco → actualiza la parte de la página que
  ese paso dejó obsoleta
- una verificación terminada → deja escrito en la página **cómo se verifica
  ahora**, con el comando y el resultado real, sustituyendo lo que dijera antes
- un cambio de enfoque → reescribe la decisión vigente; la descartada cabe en
  una línea si aclara por qué
- algo no obvio —comportamiento raro, límite del entorno, causa raíz— que
  describe cómo funciona el sistema → es estado del mundo, así que va a la
  página, donde un lector lo buscaría
- algo que pide acción o que se descubrió de paso —un riesgo, un residuo, un
  paso que falta— → al backlog de bita (no a Jira), no a la página:
  `bita backlog add --kind pending|finding --title "<una línea>" [--md <archivo>]`
- un enlace que el hook no vio → `bita docs page ref add <pageId> --url <URL> --title "<qué es>"`

**Qué no entra.** Una edición no es un checkpoint. Los archivos tocados se
registran solos: **no los escribas a mano**. Y no creas un encabezado nuevo por
cada cosa: crea uno solo si vas a volver al mismo tema tres veces.

**Cómo.** La página del cronómetro, y el cuerpo por archivo:

```
bita docs page show <pageId>
bita docs page write <pageId> --md <archivo> [--section "<H2>"]
```

Nada de prosa por `argv`: el quoting se rompe y el texto queda en `ps`.

**Escríbelo como documentación técnica, no como acta.** En presente, contando
cómo está la cosa. Nada de «se acordó con el usuario», «según lo solicitado»,
«decidimos», «creo que», «yo hice» ni «esto lo ejecutas tú»: esto acaba en Jira
y en Confluence, donde lo leerán otros. Si no se comprobó, no digas que sí.
Nada de secciones «Pendiente» ni «Hallazgos» en la página: eso es el backlog de bita, no Jira.

Responde en una línea: qué cambió en la página. Nada más.
