import { fail } from '@sveltejs/kit';
import type { ActionFailure } from '@sveltejs/kit';
import type { BatchItem } from 'drizzle-orm/batch';
import { runBatches } from './batch';
import type { DB } from '$lib/services';

export type LineItem = { product_id: string; quantity: number };
export type DetailRow = LineItem & { line_no: number };

export type LineItemValidation = LineItem[] | ActionFailure<{ error: string }>;

/**
 * Filtra las líneas válidas (`product_id` presente y `quantity > 0`) y devuelve
 * `fail(400)` si no queda ninguna.
 *
 * Reemplaza el patrón repetido en create/update de purchasing, receiving y shipping:
 *   const validDetails = data.details.filter((d) => d.product_id && d.quantity > 0);
 *   if (validDetails.length === 0) return fail(400, { error: '...' });
 *
 * Uso:
 *   const validDetails = validateLineItems(data.details);
 *   if (!Array.isArray(validDetails)) return validDetails;
 *
 * @param errorMessage permite conservar el texto de cada call site
 */
export function validateLineItems(
	details: LineItem[],
	errorMessage = 'At least one valid line item is required'
): LineItemValidation {
	const valid = details.filter((d) => d.product_id && d.quantity > 0);
	return valid.length > 0 ? valid : fail(400, { error: errorMessage });
}

/**
 * Inserta las líneas de detalle respetando el `line_no` correlativo (i + 1) y
 * dejando la FK del padre al call site.
 *
 * Reemplaza el bucle repetido:
 *   for (let i = 0; i < validDetails.length; i++) {
 *     await db.insert(details).values({ parent_id, product_id: ..., line_no: i + 1, quantity: ... });
 *   }
 *
 * Los inserts se envían con `db.batch()` (mismo SQL, mismo orden, sin N+1), así
 * que `buildInsert` debe devolver el statement **sin** await.
 *
 * @param buildInsert recibe { product_id, line_no, quantity } y arma el insert con la FK
 */
export async function insertDetails(
	db: DB,
	items: LineItem[],
	buildInsert: (row: DetailRow) => BatchItem<'sqlite'>
): Promise<void> {
	if (items.length === 0) return;

	await runBatches(
		db,
		items.map((d, i) =>
			buildInsert({
				product_id: d.product_id,
				line_no: i + 1,
				quantity: d.quantity
			})
		)
	);
}

/**
 * Borra la fila padre cuando fallaron los hijos (rollback best-effort):
 * no hace nada si todavía no hay id y nunca lanza, para no enmascarar el error original.
 *
 * Reemplaza el patrón repetido:
 *   if (slipId)
 *     await db.delete(parent).where(eq(parent.id, slipId)).catch(() => {});
 */
export async function tryCleanup(
	id: string | null | undefined,
	remove: (id: string) => PromiseLike<unknown>
): Promise<void> {
	if (!id) return;
	try {
		await remove(id);
	} catch {
		// rollback best-effort: el error original es el que se debe devolver
	}
}
