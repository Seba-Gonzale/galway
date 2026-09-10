import { fail } from '@sveltejs/kit';
import { eq, asc, like, count } from 'drizzle-orm';
import * as schema from '$lib/server/db/schema';
import { logAudit } from '$lib/server/audit';
import { supplierSchema } from '$lib/validation';
import { paginate, parseImportCsv, requireRecords } from '$lib/services/shared';
import type { ServiceCtx } from '$lib/services';

export async function listSuppliers(ctx: ServiceCtx, search: string, page: number) {
	const whereClause = search ? like(schema.suppliers.name, `%${search}%`) : undefined;

	const {
		rows: suppliers,
		extra: [allProducts, supplierProductRows],
		...pagination
	} = await paginate({
		page,
		count: () => ctx.db.select({ count: count() }).from(schema.suppliers).where(whereClause),
		rows: (limit, offset) =>
			ctx.db
				.select({
					id: schema.suppliers.id,
					name: schema.suppliers.name,
					tel: schema.suppliers.tel,
					fax: schema.suppliers.fax,
					zipcode: schema.suppliers.zipcode,
					address: schema.suppliers.address,
					email: schema.suppliers.email
				})
				.from(schema.suppliers)
				.where(whereClause)
				.orderBy(asc(schema.suppliers.name))
				.limit(limit)
				.offset(offset),
		extra: () =>
			Promise.all([
				ctx.db
					.select({
						id: schema.products.id,
						code: schema.products.code,
						name: schema.products.name,
						unit: schema.products.unit
					})
					.from(schema.products)
					.orderBy(asc(schema.products.code)),
				ctx.db
					.select({
						supplier_id: schema.supplierProducts.supplier_id,
						product_id: schema.supplierProducts.product_id
					})
					.from(schema.supplierProducts)
			])
	});

	const supplierProductMap: Record<string, string[]> = {};
	for (const row of supplierProductRows) {
		if (!supplierProductMap[row.supplier_id]) supplierProductMap[row.supplier_id] = [];
		supplierProductMap[row.supplier_id].push(row.product_id);
	}

	return {
		suppliers,
		allProducts,
		supplierProductMap,
		...pagination,
		searchQuery: search
	};
}

export async function createSupplier(
	ctx: ServiceCtx,
	data: {
		name: string;
		tel: string | null;
		fax: string | null;
		zipcode: string | null;
		address: string | null;
		email: string | null;
	}
) {
	const parsed = supplierSchema.safeParse(data);
	if (!parsed.success) return fail(400, { error: parsed.error.issues[0].message });
	const { name, tel, fax, zipcode, address, email } = parsed.data;

	try {
		await ctx.db.insert(schema.suppliers).values({ name, tel, fax, zipcode, address, email });
		await logAudit({
			db: ctx.db,
			user_id: ctx.user.id,
			user_name: ctx.user.name,
			action: 'create',
			target_type: 'supplier',
			target_label: name
		});
		return { success: true };
	} catch (err) {
		console.error('Failed to create supplier:', err);
		return fail(500, { error: 'Failed to create supplier' });
	}
}

export async function updateSupplier(
	ctx: ServiceCtx,
	data: {
		id: string;
		name: string;
		tel: string | null;
		fax: string | null;
		zipcode: string | null;
		address: string | null;
		email: string | null;
	}
) {
	if (!data.id) return fail(400, { error: 'ID is required' });
	const parsed = supplierSchema.safeParse(data);
	if (!parsed.success) return fail(400, { error: parsed.error.issues[0].message });
	const { name, tel, fax, zipcode, address, email } = parsed.data;

	try {
		await ctx.db
			.update(schema.suppliers)
			.set({ name, tel, fax, zipcode, address, email, updated_at: new Date().toISOString() })
			.where(eq(schema.suppliers.id, data.id));
		await logAudit({
			db: ctx.db,
			user_id: ctx.user.id,
			user_name: ctx.user.name,
			action: 'update',
			target_type: 'supplier',
			target_id: data.id,
			target_label: name
		});
		return { success: true };
	} catch (err) {
		console.error('Failed to update supplier:', err);
		return fail(500, { error: 'Failed to update supplier' });
	}
}

export async function deleteSupplier(ctx: ServiceCtx, id: string) {
	if (!id) return fail(400, { error: 'ID is required' });

	try {
		const [target] = await ctx.db
			.select({ name: schema.suppliers.name })
			.from(schema.suppliers)
			.where(eq(schema.suppliers.id, id));
		await ctx.db.delete(schema.suppliers).where(eq(schema.suppliers.id, id));
		await logAudit({
			db: ctx.db,
			user_id: ctx.user.id,
			user_name: ctx.user.name,
			action: 'delete',
			target_type: 'supplier',
			target_id: id,
			target_label: target?.name
		});
		return { success: true };
	} catch (err) {
		console.error('Failed to delete supplier:', err);
		return fail(500, { error: 'Failed to delete supplier' });
	}
}

export async function getSupplierProducts(ctx: ServiceCtx, supplierId: string) {
	const linked = await ctx.db
		.select({ product_id: schema.supplierProducts.product_id })
		.from(schema.supplierProducts)
		.where(eq(schema.supplierProducts.supplier_id, supplierId));
	const linkedIds = linked.map((r) => r.product_id);

	const allProducts = await ctx.db
		.select({
			id: schema.products.id,
			code: schema.products.code,
			name: schema.products.name,
			unit: schema.products.unit
		})
		.from(schema.products)
		.orderBy(asc(schema.products.code));

	return { linkedIds, allProducts };
}

export async function setSupplierProducts(
	ctx: ServiceCtx,
	supplierId: string,
	productIds: string[]
) {
	try {
		await ctx.db
			.delete(schema.supplierProducts)
			.where(eq(schema.supplierProducts.supplier_id, supplierId));
		if (productIds.length > 0) {
			await ctx.db
				.insert(schema.supplierProducts)
				.values(productIds.map((product_id) => ({ supplier_id: supplierId, product_id })));
		}
		return { success: true };
	} catch (err) {
		console.error('Failed to update supplier products:', err);
		return fail(500, { error: 'Failed to update supplier products' });
	}
}

export async function getExportData(ctx: ServiceCtx, search: string) {
	const whereClause = search ? like(schema.suppliers.name, `%${search}%`) : undefined;
	return ctx.db
		.select()
		.from(schema.suppliers)
		.where(whereClause)
		.orderBy(asc(schema.suppliers.name));
}

export async function importSuppliers(ctx: ServiceCtx, csvText: string, mode: string) {
	const parsed = parseImportCsv(
		csvText,
		[
			{ key: 'name', names: ['Supplier Name'], required: true },
			{ key: 'tel', names: ['Phone'] },
			{ key: 'fax', names: ['FAX'] },
			{ key: 'zipcode', names: ['Zip Code'] },
			{ key: 'address', names: ['Address'] },
			{ key: 'email', names: ['Email'] }
		],
		mode
	);
	if (!('dataRows' in parsed)) return parsed;
	const { dataRows, index } = parsed;

	const records = requireRecords(
		dataRows
			.filter((row) => row[index.name]?.trim())
			.map((row) => ({
				name: row[index.name].trim(),
				tel: index.tel >= 0 ? row[index.tel]?.trim() || null : null,
				fax: index.fax >= 0 ? row[index.fax]?.trim() || null : null,
				zipcode: index.zipcode >= 0 ? row[index.zipcode]?.trim() || null : null,
				address: index.address >= 0 ? row[index.address]?.trim() || null : null,
				email: index.email >= 0 ? row[index.email]?.trim() || null : null
			}))
	);
	if (!Array.isArray(records)) return records;

	try {
		if (mode === 'replace') await ctx.db.delete(schema.suppliers);
		await ctx.db.insert(schema.suppliers).values(records);
	} catch (err) {
		console.error('Failed to import suppliers:', err);
		return fail(500, { error: 'Failed to import suppliers' });
	}
	await logAudit({
		db: ctx.db,
		user_id: ctx.user.id,
		user_name: ctx.user.name,
		action: 'import',
		target_type: 'supplier',
		detail: { count: records.length, mode }
	});
	return { success: true, count: records.length };
}
