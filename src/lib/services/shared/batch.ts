import type { BatchItem } from 'drizzle-orm/batch';
import type { DB } from '$lib/services';

/**
 * Tamaño de cada lote enviado con `db.batch()`. D1 no documenta un máximo de
 * statements por batch, así que se corta en bloques para que un slip con cientos
 * de líneas (imports CSV) no arme un batch desproporcionado.
 */
export const BATCH_CHUNK_SIZE = 50;

/**
 * Ejecuta los statements en uno o más `db.batch()` (un round trip por lote).
 *
 * D1 ejecuta los statements del batch **en orden**, así que el resultado es el
 * mismo que el bucle `for (...) await ...` que reemplaza, incluso si dos líneas
 * afectan al mismo producto.
 */
export async function runBatches(db: DB, statements: BatchItem<'sqlite'>[]): Promise<void> {
	for (let i = 0; i < statements.length; i += BATCH_CHUNK_SIZE) {
		const chunk = statements.slice(i, i + BATCH_CHUNK_SIZE);
		if (chunk.length === 0) continue;
		await db.batch(chunk as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
	}
}
