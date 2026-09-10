export const DEFAULT_ITEMS_PER_PAGE = 20;

export type CountQuery = () => PromiseLike<{ count: number }[]>;
export type RowsQuery<T> = (limit: number, offset: number) => PromiseLike<T[]>;
export type ExtraQuery<X> = () => PromiseLike<X>;

export type PaginateOptions<T, X = undefined> = {
	page: number;
	itemsPerPage?: number;
	/** Query que devuelve el total de filas (sin paginar). */
	count: CountQuery;
	/** Query de la página actual; recibe limit y offset ya calculados. */
	rows: RowsQuery<T>;
	/** Consultas adicionales que hoy corren en el mismo Promise.all (catálogos, etc.). */
	extra?: ExtraQuery<X>;
};

export type Paginated<T, X = undefined> = {
	rows: T[];
	extra: X;
	totalItems: number;
	itemsPerPage: number;
	currentPage: number;
};

/**
 * Centraliza la paginación de las funciones `list*`: calcula `itemsPerPage`,
 * `currentPage` y `offset`, y ejecuta el count en paralelo con la consulta de
 * la página (más cualquier consulta adicional del llamador).
 *
 * Reemplaza el patrón repetido:
 *   const itemsPerPage = 20;
 *   const currentPage = Math.max(1, page);
 *   const offset = (currentPage - 1) * itemsPerPage;
 *   const [countResult, rows] = await Promise.all([...]);
 *
 * @param options.count  query de total (`select({ count: count() })`)
 * @param options.rows   query de la página; recibe (limit, offset)
 * @param options.extra  consulta(s) extra a correr en el mismo Promise.all
 */
export async function paginate<T, X = undefined>(
	options: PaginateOptions<T, X>
): Promise<Paginated<T, X>> {
	const itemsPerPage = options.itemsPerPage ?? DEFAULT_ITEMS_PER_PAGE;
	const currentPage = Math.max(1, options.page);
	const offset = (currentPage - 1) * itemsPerPage;

	const [countResult, rows, extra] = await Promise.all([
		options.count(),
		options.rows(itemsPerPage, offset),
		options.extra ? options.extra() : (undefined as X)
	]);

	return {
		rows,
		extra,
		totalItems: countResult[0]?.count ?? 0,
		itemsPerPage,
		currentPage
	};
}
