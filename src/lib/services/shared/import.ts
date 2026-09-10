import { fail } from '@sveltejs/kit';
import type { ActionFailure } from '@sveltejs/kit';
import { parseCSV } from '$lib/utils/csv';
import * as schema from '$lib/server/db/schema';
import type { DB } from '$lib/services';
import type { LineItem } from './details';

export type ImportFailure = ActionFailure<{ error: string }>;

export type ImportColumn<K extends string = string> = {
	/** clave con la que el call site pide el índice de la columna */
	key: K;
	/** nombres de header aceptados (se comparan con trim()) */
	names: string[];
	/** si es requerida, su ausencia devuelve fail(400) */
	required?: boolean;
	/** mensaje al faltar una columna requerida; por defecto CSV must include a "<names[0]>" column */
	missingMessage?: string;
};

export type ParsedImport<K extends string = string> = {
	dataRows: string[][];
	/** índice de cada columna por key; -1 si no estaba en el header */
	index: Record<K, number>;
};

/**
 * Punto de entrada común de los 5 imports CSV: valida el modo (append/replace),
 * parsea el CSV, exige header + al menos una fila de datos y resuelve los índices
 * de columna, devolviendo `fail(400)` con el mensaje de siempre.
 *
 * Uso:
 *   const parsed = parseImportCsv(csvText, [{ key: 'code', names: ['Product Code'], required: true }], mode);
 *   if (!('dataRows' in parsed)) return parsed;
 *
 * @param mode si se indica, valida que sea 'append' o 'replace'
 */
export function parseImportCsv<K extends string>(
	csvText: string,
	columns: ImportColumn<K>[],
	mode?: string
): ParsedImport<K> | ImportFailure {
	if (mode !== undefined && mode !== 'append' && mode !== 'replace')
		return fail(400, { error: 'Invalid import mode' });

	const rows = parseCSV(csvText);
	if (rows.length < 2)
		return fail(400, {
			error: 'CSV has no data (requires a header row plus at least one data row)'
		});

	const [header, ...dataRows] = rows;
	const index = {} as Record<K, number>;

	for (const column of columns) {
		const idx = header.findIndex((h) => column.names.includes(h.trim()));
		index[column.key] = idx;
		if (idx === -1 && column.required) {
			return fail(400, {
				error: column.missingMessage ?? `CSV must include a "${column.names[0]}" column`
			});
		}
	}

	return { dataRows, index };
}

/**
 * Devuelve `fail(400)` si el lote quedó vacío; si no, el mismo array.
 *
 * Uso:
 *   const records = requireRecords(mapped);
 *   if (!Array.isArray(records)) return records;
 */
export function requireRecords<T>(
	records: T[],
	errorMessage = 'No valid data found'
): T[] | ImportFailure {
	return records.length > 0 ? records : fail(400, { error: errorMessage });
}

/**
 * Mapa `code -> id` de todos los productos, que los imports usan para resolver
 * el "Product Code" del CSV.
 */
export async function productCodeMap(db: DB): Promise<Map<string, string>> {
	const allProducts = await db
		.select({ id: schema.products.id, code: schema.products.code })
		.from(schema.products);
	return new Map(allProducts.map((p) => [p.code, p.id]));
}

/**
 * Convierte las filas del CSV en líneas `{ product_id, quantity }`, descartando
 * códigos inexistentes y cantidades inválidas.
 *
 * @param options.allowZero true en `importInventory` (acepta quantity 0); false en
 *   receiving/shipping, que exigen quantity > 0
 */
export function mapProductQuantities(
	dataRows: string[][],
	index: { code: number; quantity: number },
	productMap: Map<string, string>,
	options: { allowZero?: boolean } = {}
): LineItem[] {
	const records: LineItem[] = [];

	for (const row of dataRows) {
		const code = row[index.code]?.trim();
		const qty = parseFloat(row[index.quantity]?.trim() ?? '');
		if (!code || isNaN(qty) || (options.allowZero ? qty < 0 : qty <= 0)) continue;
		const productId = productMap.get(code);
		if (!productId) continue;
		records.push({ product_id: productId, quantity: qty });
	}

	return records;
}
