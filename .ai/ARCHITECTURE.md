> **Último commit:** `7d3cd6a` — `refactor: extract audit log listing into listAuditLogs service`

## Índice

1. [Stack](#stack)
2. [Tree](#tree)
3. [Logic](#logic)
4. [Styling Convention](#styling-convention)
5. [Design Issues](#design-issues-current-status)
6. [Decisiones (ADR)](#decisiones-adr)
7. [API / Rutas](#api--rutas)
8. [Runbook](#runbook)
9. [Roadmap (pendiente)](#roadmap-pendiente)

## Stack

> Versiones exactas en `package.json` (Bun como package manager).

- **SvelteKit** 2 + **Svelte** 5 (Runes mode: `$state`, `$derived`, `$effect`, `$props`) — `@sveltejs/kit ^2.50.2`, `svelte ^5.51.0`
- **Adapter**: `@sveltejs/adapter-cloudflare ^7.2.6` (SSR en Cloudflare Pages, runtime Workers) + wrangler `^4.63.0`
- **Database**: Cloudflare D1 (binding `DB`, SQLite) vía **Drizzle ORM** `^0.45.1` + `drizzle-kit ^0.31.8`
- **Lenguaje**: TypeScript `^5.9.3`, ESLint 9 flat config, Prettier 3 (prettier-plugin-svelte)
- **Estilos**: **SCSS custom** (`sass-embedded ^1.97.3`, `<style lang="scss">`), **NO Tailwind en runtime**. Design system con CSS variables en `src/app.scss`.
- **Iconos**: `@lucide/svelte ^0.575.0`
- **Validación**: `zod ^4.4.3` (runtime)
- **Testing**: Vitest 4 (2 proyectos: browser Playwright para `.svelte.spec`, Node para `.test`) + Playwright 1.58 E2E
- **Deploy**: Cloudflare Pages (integration git). `compatibility_date: 2026-02-24`, flag `nodejs_als` (AsyncLocalStorage).
- **CSP**: nonce mode (`svelte.config.js`), nonce inyectado vía `%sveltekit.nonce%` en `app.html`.

## Tree

```
galway/
├── .dev.vars.example      # env local (DB, email provider, keys) gitignored en .dev.vars
├── .env.example
├── .mcp.json
├── drizzle/               # migraciones D1 (0000..0009) + meta/_journal.json
├── drizzle.config.ts      # apunta a src/lib/server/db/schema.ts
├── e2e/                   # Playwright tests (demo.test.ts)
├── scripts/               # seed.sql, seed-plan6.sql, gen-password-hash.ts
├── src/
│   ├── app.html           # shell HTML, inline anti-FOUC para theme+locale, nonce
│   ├── app.scss           # design system: CSS vars light/dark, reset, base
│   ├── app.d.ts           # App.Platform (env, ctx, caches), App.Locals (user, locale)
│   ├── hooks.server.ts    # sesión, headers de seguridad, locale cookie, getPlatformProxy en dev
│   ├── demo.spec.ts       # placeholder vitest
│   ├── lib/
│   │   ├── index.ts       # barrel vacío ($lib)
│   │   ├── theme.svelte.ts# runes: 'light'|'dark'|'system', localStorage
│   │   ├── assets/favicon.svg
│   │   ├── i18n/
│   │   │   ├── index.ts           # re-export
│   │   │   ├── index.svelte.ts     # $state locale, t(key) dot-path
│   │   │   ├── en.ts               # diccionario inglés (~465 líneas)
│   │   │   └── ja.ts               # diccionario japonés
│   │   ├── types/         # shared, account, product, supplier, purchasing, receiving, shipping, inventory
│   │   ├── validation/index.ts# schemas Zod (account, profile, settings, supplier, product, customer, category)
│   │   ├── utils/
│   │   │   ├── index.ts
│   │   │   ├── csv.ts              # escapeCSV (anti formula-injection), generateCSV, parseCSV (BOM/CRLF)
│   │   │   ├── csv.test.ts
│   │   │   ├── format.ts           # formatDate, formatDateTime (ja-JP)
│   │   │   └── format.test.ts
│   │   ├── ui/            # 21 componentes Svelte 5 (barrel index.ts)
│   │   │   ├── Button, Input, Textarea, Label, Select, SearchableSelect, SearchBar
│   │   │   ├── Card, Modal, ConfirmDialog, Table, Pagination, Sidebar
│   │   │   ├── ProfileEditor, AccountEditor
│   │   │   ├── WBSForm, ReceivingSlipForm, ShippingSlipForm
│   │   │   ├── SelectChip, CsvImportDialog, SlipCsvImportDialog, DetailCsvImport
│   │   ├── server/
│   │   │   ├── db/
│   │   │   │   ├── schema.ts       # Drizzle schema: 14+ tablas SQLite
│   │   │   │   └── index.ts        # getDb(d1) -> drizzle(d1, { schema })
│   │   │   ├── auth/
│   │   │   │   ├── index.ts        # hashPassword (PBKDF2-SHA256), verifyPassword, createSession,
│   │   │   │   │                   #   deleteSession, getSession (cookie 'session')
│   │   │   │   ├── auth.test.ts
│   │   │   │   └── hooks.test.ts
│   │   │   ├── email/
│   │   │   │   ├── index.ts        # EmailProvider interface + createEmailProvider factory
│   │   │   │   ├── resend.ts, ses.ts (Web Crypto HMAC), smtp.ts (relay HTTP), cloudflare.ts (SEND_EMAIL binding)
│   │   │   │   └── templates.ts     # welcome, passwordChanged, adminAlert (en/ja)
│   │   │   └── audit.ts            # logAudit() -> insert audit_logs (no rompe la app si falla)
│   │   └── services/      # capa de negocio (13 módulos)
│   │       ├── index.ts           # ServiceCtx type, makeCtx(platform, locals, request)
│   │       ├── shared/            # helpers compartidos: error.ts (handleDbError), audit.ts (auditLog),
│   │       │                      #   numbering.ts (nextSequentialNumber: PO-/RCV-/SHP-YYYY-NNN),
│   │       │                      #   inventory.ts (upsertInventoryDelta / adjustInventory),
│   │       │                      #   pagination.ts (paginate: count + rows + extra en paralelo),
│   │       │                      #   details.ts (validateLineItems / insertDetails / tryCleanup),
│   │       │                      #   import.ts (parseImportCsv / requireRecords / productCodeMap / mapProductQuantities)
│   │       ├── account.ts, product.ts, category.ts, supplier.ts
│   │       ├── purchasing.ts       # PO FSM, convert-to-receiving
│   │       ├── receiving.ts, shipping.ts   # ajuste de inventario
│   │       ├── inventory.ts, inventory_schedule.ts
│   │       ├── customer.ts, settings.ts, reports.ts
│   │       ├── dashboard.ts        # loadDashboard(ctx): 8 queries del dashboard (TASK-024)
│   │       ├── audit.ts            # listAuditLogs(ctx, filters): paginación + filtros (TASK-025)
│   │       ├── email.ts            # orquestación (welcome, passwordChanged, lowStockAlert)
│   │       ├── product.test.ts, supplier.test.ts
│   └── routes/
│       ├── +layout.svelte         # root: theme apply, favicon, app.scss
│       ├── page.svelte.spec.ts
│       ├── login/  +page.server.ts (rate limit 5/15min), +page.svelte
│       ├── logout/ +server.ts     # GET logout
│       └── (app)/                 # grupo protegido (redirect 302 a /login si no hay user)
│           ├── +layout.server.ts  # guard
│           ├── +layout.svelte     # Sidebar + ConfirmDialog(signout) + i18n init
│           ├── +page.svelte|server.ts  # Dashboard (stats, low-stock, today receiving/shipping)
│           ├── suppliers/         # list, CRUD actions, export/+server.ts (CSV)
│           ├── products/          # list, CRUD, export/+server.ts (BOM UTF-8)
│           ├── categories/        # CRUD (admin)
│           ├── purchasing/        # list, new, [id] (detail+convert), [id]/edit
│           ├── receiving/         # list, new, [id] (detail+print WBSForm), [id]/edit, [id]/export, import
│           ├── shipping/          # list, new, [id], [id]/edit, [id]/export, [id]/print, import
│           ├── customers/         # CRUD
│           ├── inventory/         # list, stocktake, import, export
│           ├── inventory-schedules/# CRUD schedules
│           ├── reports/           # charts + rankings
│           ├── accounts/          # CRUD (admin)
│           ├── profile/           # view/edit + change password
│           ├── audit-logs/        # viewer con filtros (admin)
│           └── settings/          # settings + sendTestEmail (admin)
├── static/
├── svelte.config.js      # adapter-cloudflare + CSP nonce + prerender off
├── vite.config.ts       # vitest 2 proyectos (client browser, server node)
├── eslint.config.js     # flat config (svelte, typescript-eslint, prettier)
├── playwright.config.ts
├── wrangler.jsonc       # D1 binding "DB" (galway-db), send_email "SEND_EMAIL", migrations_dir ./drizzle
├── .prettierrc         # useTabs, singleQuote, trailingComma none, printWidth 100
└── README.md
```

## Logic

1. **Data Source – D1 (Drizzle)**: El esquema vive en `src/lib/server/db/schema.ts` (14+ tablas SQLite: `accounts`, `sessions`, `login_rate_limits`, `suppliers`, `products`, `product_categories`, `supplier_products`, `receiving_slips`/`receiving_slip_details`, `purchase_orders`/`purchase_order_details`, `customers`, `shipping_slips`/`shipping_slip_details`, `inventory`, `inventory_schedules`, `audit_logs`, `settings`). Acceso: `getDb(d1: D1Database)` → `drizzle(d1, { schema })`. En services se usa `makeCtx(platform, locals, request?)` que resuelve `db = getDb(platform.env.DB)`. En dev, `hooks.server.ts` inyecta `getPlatformProxy()` para simular D1.
2. **Migrations & Seed**: `drizzle/` contiene migraciones `0000..0009` (`drizzle-kit generate` → `db:generate`). Aplicación: `bun run db:migrate:local` (`wrangler d1 migrations apply galway-db --local`) y `db:migrate:remote`. Seeds: `scripts/seed.sql` (3 accounts, 8 suppliers, 12 products, 22 supplier-product, 13 receiving, 7 shipping, inventory calculado), `scripts/seed-plan6.sql`, `scripts/gen-password-hash.ts` (PBKDF2-SHA256 100k iter). Credenciales: `admin@example.com`/`admin123` (admin), `suzuki@example.com`/`general123`, `sato@example.com`/`general123`.
3. **Auth / Sessions**: Login (`src/routes/login/+page.server.ts`) → rate limit por IP (5 intentos / 15 min lock en `login_rate_limits`) → lookup por email → `verifyPassword()` (PBKDF2-SHA256, 100k iter, Web Crypto) → `createSession()` (token 64-char hex via `crypto.getRandomValues`, insert en `sessions`, expira 7 días) → cookie `session` (httpOnly, sameSite lax, secure en prod). `hooks.server.ts` resuelve sesión en cada request (`getSession` JOIN sessions+accounts) y setea `event.locals.user = { id, name, email, role, created_at }`. Guard `(app)/+layout.server.ts` redirige a `/login` si no hay user. Logout borra sesión y cookie. Cambio de password invalida todas las sesiones y re-emite token. Roles: `admin` (CRUD accounts/categories/settings/audit, edición de otros usuarios en slips) vs `general` (CRUD de datos operativos + profile).
4. **Services layer**: `src/lib/services/*` son la capa de negocio; cada `+page.server.ts`/`+server.ts` construye `ctx = makeCtx(event.platform, event.locals, event.request)` y delega. `logAudit()` se llama en operaciones CRUD y nunca rompe el flujo si falla el insert.
5. **Inventory adjustments**: Receiving create → `inventory.quantity += line.quantity` (UPSERT). Receiving edit/delete → reversa cantidad vieja y aplica nueva. Shipping create → `inventory.quantity -= line.quantity`. Shipping edit/delete → reversa + re-aplica. PO → receiving incrementa inventario.
6. **Slip numbering**: autoincremental por año dentro de transacción: `PO-YYYY-NNN`, `RCV-YYYY-NNN`, `SHP-YYYY-NNN`.
7. **Email**: `createEmailProvider()` factory selecciona provider según env (Resend / AWS SES con firma HMAC-SHA256 Web Crypto / SMTP relay HTTP / Cloudflare `SEND_EMAIL` binding con `EmailMessage`). `services/email.ts` orquesta welcome, passwordChanged, adminAlert y `notifyLowStockForProducts` (fire-and-forget). Rate limit en memoria (Map, 10/min) para alerts.
8. **i18n**: `src/lib/i18n/index.svelte.ts` con `$state locale` y `t(key)` (dot-path lookup sobre `en.ts`/`ja.ts`). Locale se persiste en cookie y se inicializa en `(app)/+layout.svelte`.
9. **Security Headers** (`hooks.server.ts`): `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`, `Strict-Transport-Security` (solo prod). CSP nonce-mode en `svelte.config.js`.
10. **Shared service helpers** (`src/lib/services/shared/`, PHASE-05): `handleDbError(err, entity, action, conflictMessage?)` centraliza el `catch` de las operaciones de servicios (UNIQUE → `fail(409)` con mensaje propio; resto → `console.error` + `fail(500)`). `auditLog(ctx, action, target_type, options?)` envuelve `logAudit()` infiriendo `db`/`user_id`/`user_name` desde el `ServiceCtx`. `nextSequentialNumber(db, table, column, prefix, date)` genera `PREFIX-YYYY-NNN` (PO/RCV/SHP). Aplicados primero en `category.ts` y `customer.ts` (TASK-018); se extienden al resto de servicios en TASK-019..023.
11. **Ajuste de inventario** (`src/lib/services/shared/inventory.ts`, TASK-020): existen **dos** helpers con semántica distinta, deliberadamente NO unificados porque el código original usaba dos estrategias SQL diferentes:
    - `upsertInventoryDelta(db, items, sign, now)` — `INSERT ... ON CONFLICT DO UPDATE`: crea la fila de `inventory` si el producto no tenía una. La usan las operaciones que **suman** stock y históricamente creaban la fila: `createReceivingSlip`, la parte "aplicar" de `updateReceivingSlip`, `importReceivingSlips` y `convertToReceivingSlip`.
    - `adjustInventory(db, items, sign, now)` — `UPDATE` simple: **no hace nada** si la fila no existe. La usan shipping (resta) y todas las **reversiones** de editar/borrar.
      `sign` es `'+' | '-'` explícito en el call site (no `'in'/'out'`), para que el signo sea legible y auditable. `stocktake()` e `importInventory()` (en `services/inventory.ts`) **no** usan estos helpers: fijan cantidades absolutas, no deltas.
12. **Paginación** (`src/lib/services/shared/pagination.ts`, TASK-021): `paginate({ page, itemsPerPage?, count, rows, extra? })` devuelve `{ rows, extra, totalItems, itemsPerPage, currentPage }`. Calcula `itemsPerPage` (default `20`, `30` en `listAccounts`), `currentPage = Math.max(1, page)` y el `offset`, y ejecuta el count en paralelo con la consulta de la página y con las consultas `extra` (catálogos: categorías, productos, proveedores), preservando el `Promise.all` que tenía cada `list*`. Las 7 funciones `list*` (`product`, `supplier`, `purchasing`, `receiving`, `shipping`, `inventory`, `account`) mantienen exactamente su shape de retorno: solo reemplazan el bloque `itemsPerPage`/`currentPage`/`offset` por el spread de `...pagination`.
13. **Líneas de detalle** (`src/lib/services/shared/details.ts`, TASK-022): tres helpers que cubren el create/update/import de `purchasing`, `receiving` y `shipping`:
    - `validateLineItems(details, errorMessage?)` — filtra `product_id && quantity > 0` y devuelve `fail(400)` si no queda ninguna (mensaje por defecto `'At least one valid line item is required'`; `convertToReceivingSlip` pasa el suyo propio). El call site hace `if (!Array.isArray(validDetails)) return validDetails;`.
    - `insertDetails(items, insertRow)` — reemplaza el bucle de inserción y asigna el `line_no` correlativo (`i + 1`); la FK del padre (`order_id` / `slip_id`) la arma el call site en `insertRow`, así no se pierde el tipado de Drizzle.
    - `tryCleanup(id, remove)` — rollback best-effort de la fila padre cuando fallaron los hijos: no hace nada si el id está vacío y **nunca lanza**, para no enmascarar el error original (409 por número duplicado incluido).
14. **Imports CSV** (`src/lib/services/shared/import.ts`, TASK-023): framework común de los 5 imports (`product`, `supplier`, `inventory`, `receiving`, `shipping`). **No** toca `src/lib/utils/csv.ts` (protected): solo lo usa.
    - `parseImportCsv(csvText, columns, mode?)` — valida el modo (`append`/`replace`), exige header + al menos una fila (`'CSV has no data (requires a header row plus at least one data row)'`) y resuelve los índices por `key`, devolviendo `fail(400)` con el mensaje de cada columna (`CSV must include a "X" column`, o el `missingMessage` propio — `importInventory` acepta `Quantity` **o** `Stock`). Las columnas opcionales quedan en `-1`. Call site: `if (!('dataRows' in parsed)) return parsed;`.
    - `requireRecords(records, message?)` — `fail(400) 'No valid data found'` si el lote quedó vacío.
    - `productCodeMap(db)` — `Map<code, id>` de todos los productos.
    - `mapProductQuantities(dataRows, index, productMap, { allowZero })` — arma las líneas `{ product_id, quantity }` descartando códigos inexistentes y cantidades inválidas; `allowZero: true` solo en `importInventory` (acepta 0), receiving/shipping exigen `> 0`.
15. **Dashboard** (`src/lib/services/dashboard.ts`, TASK-024): `loadDashboard(ctx)` encapsula las 8 queries que antes estaban inline en `src/routes/(app)/+page.server.ts` (conteos de suppliers/products, receiving/shipping del mes, low stock, receiving/shipping de hoy y settings). Devuelve `{ supplierCount, productCount, receivingCountThisMonth, shippingCountThisMonth, lowStockItems, todayReceiving, todayShipping }` — el mismo shape de antes — y respeta el setting `low_stock_alert_enabled`. La ruta ahora solo hace `loadDashboard(makeCtx(platform!, locals))`.
16. **Audit logs** (`src/lib/services/audit.ts`, TASK-025): `listAuditLogs(ctx, filters)` con `filters = { action?, target?, user?, page?, itemsPerPage? }` (30 por página, como la ruta) devuelve `{ logs, totalItems, itemsPerPage, currentPage, filterAction, filterTarget, filterUser }`. Usa `paginate()` y selecciona **columnas explícitas** (id, user_id, user_name, action, target_type, target_id, target_label, detail, created_at) en vez del `select()` que antes traía todo. El check de admin (`error(403)`) sigue en `src/routes/(app)/audit-logs/+page.server.ts`, que ahora solo parsea los search params y llama al servicio.

## Styling Convention

- **NO Tailwind en runtime**. Design system propio en `src/app.scss` (~313 líneas): reset manual, CSS variables en `:root` (`--space-*`, `--radius-*`, `--shadow-*`, `--transition-*`, `--sidebar-width: 240px`, `--header-height: 56px`, z-index layers) y themes light/dark (`[data-theme='light'|'dark']` + `@media (prefers-color-scheme: dark)` para `system`).
- **Theme switching**: `src/lib/theme.svelte.ts` (`$state('system')` + localStorage); inline script anti-FOUC en `app.html`; `+layout.svelte` aplica `data-theme` al `<html>` vía `$effect()`.
- **Componentes**: usan `<style lang="scss">` con nesting, variables y media queries. Reutilizar componentes de `src/lib/ui` y CSS vars del tema; evitar valores hardcodeados.
- **Prettier**: `useTabs`, `singleQuote`, `trailingComma: none`, `printWidth: 100`.

## Design Issues (current status)

- Sistema de diseño consistente y con soporte dark mode; los formularios y tablas dependen de componentes `src/lib/ui` compartidos.
- Inventario es derivado de slips (receiving/shipping); la consistencia depende de que los ajustes sean reversibles en edit/delete. Riesgo de desvío si se editan slips fuera de los servicios.
- Emails en dev caen a HTTP providers (Resend/SES/SMTP relay); en prod usa `SEND_EMAIL` binding. Verificar configuración de binding en dashboard de Pages.

## Decisiones (ADR)

- **Drizzle ORM sobre SQL crudo**: tipado en schema y queries; migraciones generadas con `drizzle-kit`.
- **Capa services sobre acceso directo en routes**: aísla lógica de negocio, facilita tests con `getPlatformProxy()` y auditoría centralizada.
- **Web Crypto para todo lo cripto** (PBKDF2, HMAC, random): compatibilidad con Workers (sin `node:crypto`).
- **SCSS custom en vez de Tailwind**: control fino del design system y evitar peso de utilidades en runtime.
- **`nodejs_als` compatibility flag**: habilita AsyncLocalStorage si se requiere contexto por request.

## API / Rutas

Todas las rutas bajo `(app)/` requieren sesión. Acciones vía SvelteKit form actions (`?/...`) en `+page.server.ts` y endpoints `+server.ts` para export CSV. Resumen de rutas en [Tree](#tree) y [Logic](#logic) punto 4-6. Números de remito/PO autogenerados por año.

## Runbook

- **Dev**: `bun install` → `bun run db:migrate:local` → `bun run db:seed:local` → `bun run db:seed-plan6:local` → `bun run dev` (http://localhost:5173). Requiere `.dev.vars` (ver `.dev.vars.example`).
- **Checks**: `bun run check` (type check), `bun run lint`, `bun run format`, `bun run test:unit` (Vitest), `bun run test:e2e` (Playwright).
- **Migraciones remoto**: `bun run db:migrate:remote` tras cambiar `schema.ts` y `bun run db:generate`.
- **Deploy**: `git push` a `main` dispara build + deploy en Cloudflare Pages. No usar `wrangler pages deploy`.
- **D1 local**: Miniflare (vía wrangler) provee SQLite local; `worker-configuration.d.ts` tipa los bindings.

## Roadmap (pendiente)

Fases 01–04 completadas (ver `.ai/PLAN.json`). Próximas tareas a definir en `STATE.json` (`current.task = null`).
