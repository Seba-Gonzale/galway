import { like, desc } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { DB } from '$lib/services';

/**
 * Genera el siguiente número secuencial con formato `PREFIX-YYYY-NNN`
 * (ej. PO-2026-001, RCV-2026-001, SHP-2026-001).
 *
 * Reemplaza las implementaciones duplicadas que existían en
 * purchasing.ts (PO), receiving.ts (RCV) y shipping.ts (SHP).
 *
 * @param table   tabla que contiene la columna de número (ej. schema.receivingSlips)
 * @param column  columna de texto del número (ej. schema.receivingSlips.slip_number)
 * @param prefix  prefijo del comprobante (PO / RCV / SHP)
 * @param date    fecha ISO de la que se toma el año
 */
export async function nextSequentialNumber(
	db: DB,
	table: SQLiteTable,
	column: SQLiteColumn,
	prefix: string,
	date: string
): Promise<string> {
	const year = new Date(date).getFullYear();
	const [last] = await db
		.select({ n: column })
		.from(table)
		.where(like(column, `${prefix}-${year}-%`))
		.orderBy(desc(column))
		.limit(1);

	const lastNum = last ? parseInt(String(last.n).split('-')[2], 10) : 0;
	return `${prefix}-${year}-${String(lastNum + 1).padStart(3, '0')}`;
}
