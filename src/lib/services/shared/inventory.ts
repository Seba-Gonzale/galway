import { sql, eq } from 'drizzle-orm';
import * as schema from '$lib/server/db/schema';
import { runBatches } from './batch';
import type { DB } from '$lib/services';

export type InventoryDelta = { product_id: string; quantity: number };
export type InventorySign = '+' | '-';

function signedQuantity(sign: InventorySign, quantity: number): number {
	return sign === '+' ? quantity : -quantity;
}

function deltaExpression(sign: InventorySign, quantity: number) {
	return sign === '+'
		? sql`${schema.inventory.quantity} + ${quantity}`
		: sql`${schema.inventory.quantity} - ${quantity}`;
}

/**
 * Aplica un delta al inventario con UPSERT: si el producto todavía no tiene fila
 * en `inventory`, la crea usando el delta como cantidad inicial.
 *
 * Se usa en las operaciones que suman stock (receiving create/update/import y
 * la conversión de orden de compra), que son las que históricamente creaban la fila.
 *
 * Los statements se envían con `db.batch()` (un round trip por lote, en orden) en
 * lugar de un `await` por línea: mismo SQL, mismo resultado, sin N+1.
 */
export async function upsertInventoryDelta(
	db: DB,
	items: InventoryDelta[],
	sign: InventorySign,
	now: string
): Promise<void> {
	if (items.length === 0) return;

	await runBatches(
		db,
		items.map((d) =>
			db
				.insert(schema.inventory)
				.values({
					product_id: d.product_id,
					quantity: signedQuantity(sign, d.quantity),
					updated_at: now
				})
				.onConflictDoUpdate({
					target: schema.inventory.product_id,
					set: { quantity: deltaExpression(sign, d.quantity), updated_at: now }
				})
		)
	);
}

/**
 * Aplica un delta al inventario con UPDATE: solo afecta productos que ya tienen
 * fila en `inventory`. Si la fila no existe, la operación no hace nada.
 *
 * Se usa en shipping (resta de stock) y en las reversiones de editar/borrar,
 * que históricamente no creaban la fila.
 *
 * Igual que `upsertInventoryDelta`, se ejecuta con `db.batch()`.
 */
export async function adjustInventory(
	db: DB,
	items: InventoryDelta[],
	sign: InventorySign,
	now: string
): Promise<void> {
	if (items.length === 0) return;

	await runBatches(
		db,
		items.map((d) =>
			db
				.update(schema.inventory)
				.set({ quantity: deltaExpression(sign, d.quantity), updated_at: now })
				.where(eq(schema.inventory.product_id, d.product_id))
		)
	);
}
