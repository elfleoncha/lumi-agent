# Contribuir

Gracias por pasarte. Antes de abrir un PR:

1. **Nada personal.** Ejecuta `npm run check:secrets` (busca rutas, IDs y tokens).
2. **Sintaxis**: `npm run lint`.
3. **Que arranque**: `./scripts/smoke-test.sh` (usa un puerto libre y una config
   temporal; no toca tu instalación).
4. Cuenta **qué** cambias y **por qué** en el PR. Si toca seguridad, dilo.

## Estilo

- JavaScript moderno, módulos ESM, sin dependencias nuevas si se puede evitar.
- El panel web es vanilla a propósito: nada de frameworks ni build step.
- Comentarios en español (el autor es español), código en inglés.
- Los textos de la UI, en español; si añades algo visible, deja el hueco para
  traducirlo.

## Ideas que encajan

- Traducciones de la interfaz (en/fr/de).
- Conectores nuevos (Matrix, Telegram...) reutilizando `SessionPool`.
- Mejor manejo de errores del proveedor de modelo.
- Tests de la capa HTTP.
