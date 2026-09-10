import { fail } from '@sveltejs/kit';
import { eq, asc, like, or, and, count } from 'drizzle-orm';
import * as schema from '$lib/server/db/schema';
import { logAudit } from '$lib/server/audit';
import { handleDbError, paginate, parseImportCsv, requireRecords } from '$lib/services/shared';
import { productSchema } from '$lib/validation';
import type { ServiceCtx } from '$lib/services';

export async function listProducts(
	ctx: ServiceCtx,
	search: string,
	page: number,
	category: string
) {
	const searchCondition = search
		? or(like(schema.products.code, `%${search}%`), like(schema.products.name, `%${search}%`))
		: undefined;
	const categoryCondition = category ? eq(schema.products.category_id, category) : undefined;
	const whereClause =
		searchCondition && categoryCondition
			? and(searchCondition, categoryCondition)
			: (searchCondition ?? categoryCondition);

	const {
		rows: products,
		extra: categories,
		...pagination
	} = await paginate({
		page,
		count: () => ctx.db.select({ count: count() }).from(schema.products).where(whereClause),
		rows: (limit, offset) =>
			ctx.db
				.select({
					id: schema.products.id,
					code: schema.products.code,
					name: schema.products.name,
					unit: schema.products.unit,
					description: schema.products.description,
					category_id: schema.products.category_id,
					category_name: schema.productCategories.name,
					min_quantity: schema.products.min_quantity
				})
				.from(schema.products)
				.leftJoin(
					schema.productCategories,
					eq(schema.products.category_id, schema.productCategories.id)
				)
				.where(whereClause)
				.orderBy(asc(schema.products.code))
				.limit(limit)
				.offset(offset),
		extra: () =>
			ctx.db
				.select({ id: schema.productCategories.id, name: schema.productCategories.name })
				.from(schema.productCategories)
				.orderBy(asc(schema.productCategories.name))
	});

	return {
		products,
		categories,
		...pagination,
		searchQuery: search,
		categoryFilter: category
	};
}

export async function createProduct(
	ctx: ServiceCtx,
	data: {
		code: string;
		name: string;
		unit: string;
		description: string | null;
		category_id: string | null;
		min_quantity: number;
	}
) {
	const parsed = productSchema.safeParse(data);
	if (!parsed.success) return fail(400, { error: parsed.error.issues[0].message });
	const { code, name, unit, description, category_id, min_quantity } = parsed.data;

	const now = new Date().toISOString();
	let productId: string | null = null;
	try {
		const [product] = await ctx.db
			.insert(schema.products)
			.values({ code, name, unit, description, category_id: category_id ?? null, min_quantity })
			.returning({ id: schema.products.id });
		productId = product.id;
		await ctx.db
			.insert(schema.inventory)
			.values({ product_id: product.id, quantity: 0, updated_at: now })
			.onConflictDoNothing();
	} catch (err) {
		if (productId)
			await ctx.db
				.delete(schema.products)
				.where(eq(schema.products.id, productId))
				.catch(() => {});
		return handleDbError(err, 'product', 'create', 'That product code is already in use');
	}
	await logAudit({
		db: ctx.db,
		user_id: ctx.user.id,
		user_name: ctx.user.name,
		action: 'create',
		target_type: 'product',
		target_label: `${code} ${name}`
	});
	return { success: true };
}

export async function updateProduct(
	ctx: ServiceCtx,
	data: {
		id: string;
		code: string;
		name: string;
		unit: string;
		description: string | null;
		category_id: string | null;
		min_quantity: number;
	}
) {
	if (!data.id) return fail(400, { error: 'ID is required' });
	const parsed = productSchema.safeParse(data);
	if (!parsed.success) return fail(400, { error: parsed.error.issues[0].message });
	const { code, name, unit, description, category_id, min_quantity } = parsed.data;

	try {
		await ctx.db
			.update(schema.products)
			.set({
				code,
				name,
				unit,
				description,
				category_id: category_id ?? null,
				min_quantity,
				updated_at: new Date().toISOString()
			})
			.where(eq(schema.products.id, data.id));
		await logAudit({
			db: ctx.db,
			user_id: ctx.user.id,
			user_name: ctx.user.name,
			action: 'update',
			target_type: 'product',
			target_id: data.id,
			target_label: `${code} ${name}`
		});
		return { success: true };
	} catch (err) {
		return handleDbError(err, 'product', 'update', 'That product code is already in use');
	}
}

export async function deleteProduct(ctx: ServiceCtx, id: string) {
	if (!id) return fail(400, { error: 'ID is required' });

	try {
		const [target] = await ctx.db
			.select({ code: schema.products.code, name: schema.products.name })
			.from(schema.products)
			.where(eq(schema.products.id, id));
		await ctx.db.delete(schema.products).where(eq(schema.products.id, id));
		await logAudit({
			db: ctx.db,
			user_id: ctx.user.id,
			user_name: ctx.user.name,
			action: 'delete',
			target_type: 'product',
			target_id: id,
			target_label: target ? `${target.code} ${target.name}` : id
		});
		return { success: true };
	} catch (err) {
		console.error('Failed to delete product:', err);
		return fail(500, { error: 'Failed to delete product' });
	}
}

export async function getExportData(ctx: ServiceCtx, search: string, category: string) {
	const searchCondition = search
		? or(like(schema.products.code, `%${search}%`), like(schema.products.name, `%${search}%`))
		: undefined;
	const categoryCondition = category ? eq(schema.products.category_id, category) : undefined;
	const whereClause =
		searchCondition && categoryCondition
			? and(searchCondition, categoryCondition)
			: (searchCondition ?? categoryCondition);

	return ctx.db
		.select({
			code: schema.products.code,
			name: schema.products.name,
			category_name: schema.productCategories.name,
			unit: schema.products.unit,
			description: schema.products.description,
			min_quantity: schema.products.min_quantity
		})
		.from(schema.products)
		.leftJoin(
			schema.productCategories,
			eq(schema.products.category_id, schema.productCategories.id)
		)
		.where(whereClause)
		.orderBy(asc(schema.products.code));
}

export async function importProducts(ctx: ServiceCtx, csvText: string, mode: string) {
	const parsed = parseImportCsv(
		csvText,
		[
			{ key: 'code', names: ['Product Code'], required: true },
			{ key: 'name', names: ['Product Name'], required: true },
			{ key: 'unit', names: ['Unit'], required: true },
			{ key: 'description', names: ['Description'] }
		],
		mode
	);
	if (!('dataRows' in parsed)) return parsed;
	const { dataRows, index } = parsed;

	const records = requireRecords(
		dataRows
			.filter((row) => row[index.code]?.trim() && row[index.name]?.trim())
			.map((row) => ({
				code: row[index.code].trim(),
				name: row[index.name].trim(),
				unit: row[index.unit]?.trim() || '',
				description: index.description >= 0 ? row[index.description]?.trim() || null : null
			}))
	);
	if (!Array.isArray(records)) return records;

	const now = new Date().toISOString();
	try {
		if (mode === 'replace') await ctx.db.delete(schema.products);
		const inserted = await ctx.db
			.insert(schema.products)
			.values(records)
			.returning({ id: schema.products.id });
		for (const p of inserted) {
			await ctx.db
				.insert(schema.inventory)
				.values({ product_id: p.id, quantity: 0, updated_at: now })
				.onConflictDoNothing();
		}
	} catch (err) {
		return handleDbError(err, 'product', 'import', 'Duplicate product codes detected');
	}
	await logAudit({
		db: ctx.db,
		user_id: ctx.user.id,
		user_name: ctx.user.name,
		action: 'import',
		target_type: 'product',
		detail: { count: records.length, mode }
	});
	return { success: true, count: records.length };
}
