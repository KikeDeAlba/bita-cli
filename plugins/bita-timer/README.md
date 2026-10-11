# bita-timer

Mod de Claude Code que dibuja una banda sobre el prompt con los cronómetros de
bita que están corriendo:

```
⏱ Revisar MR · bita · 1:25
```

- Un cronómetro: título · proyecto · tiempo transcurrido (`h:mm`). Sin título
  se muestra `sin título`; sin proyecto, se omite.
- Varios: se listan todos, del más reciente al más antiguo, separados por `|`.
  Si no caben en el ancho de la banda, se condensan en el más reciente más un
  resumen: `Revisar MR · bita · 1:25  +2 más · 3:10 en total`.
- Sin cronómetros corriendo, o si bita no está instalado, la banda no aparece.

## Costo

Cero tokens: el mod no llama al modelo ni agrega texto a la conversación; solo
dibuja. Requiere Claude Code 2.1.287 o posterior y no aplica en `claude -p`,
Codex, opencode ni Gemini.

## Cómo se actualiza

- Lee `bita ls --json` al arrancar la sesión y después cada 30 segundos.
- También relee poco después de cada llamada a Bash cuyo comando ejecute
  `bita` (`bita start`, `cd repo && bita stop`, `~/.local/bin/bita ls`, etc.).
- El tiempo transcurrido avanza con el reloj local (se revisa cada 15
  segundos), sin lanzar procesos.
- Si bita falla un momento (por ejemplo, la base está bloqueada), la banda
  conserva lo último que leyó. Si bita no está instalado, deja de buscarlo
  durante 5 minutos, salvo que se ejecute un comando `bita`.

El binario se busca como lo haría el shell de Claude (en el `PATH`) y, si no
está ahí, en `~/Library/pnpm/bin/bita` y `~/.local/bin/bita`.

## Instalación

Es opcional y va aparte del plugin `bita`; ambos se publican en el
marketplace del repositorio (`.claude-plugin/marketplace.json`). Desde el
prompt de Claude Code:

```
/plugin marketplace add KikeDeAlba/bita-cli
/plugin install bita-timer@bita
```

O desde la terminal, junto con el plugin `bita`:

```sh
bita setup --mod
```

Para probarlo desde una copia local del repositorio, sin instalarlo:

```sh
claude --plugin-dir plugins/bita-timer
```

## Desarrollo

```sh
claude plugin validate plugins/bita-timer
claude plugin test plugins/bita-timer
node --test test/bita-timer.test.ts
```

La lógica de lectura y formato vive en `hooks/timers.ts` (sin dependencias) y
la cubren las pruebas de `test/bita-timer.test.ts`; `hooks/register.tsx` solo
conecta los eventos de Claude Code con esa lógica, y `tests/band.test.ts` lo
prueba contra el motor de Claude Code.
