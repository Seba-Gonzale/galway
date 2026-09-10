import { error, redirect, fail } from '@sveltejs/kit';
import { eq, desc, count, like, asc, or } from 'drizzle-orm';
import * as schema from '$lib/server/db/schema';
import { logAudit } from '$lib/server/audit';
import { notifyLowStockForProducts } from '$lib/services/email';
import {
	nextSequentialNumber,
	adjustInventory,
	paginate,
	validateLineItems,
	insertDetails,
	tryCleanup,
	parseImportCsv,
	requireRecords,
	productCodeMap,
	mapProductQuantities
} from '$lib/services/shared';
import type { ServiceCtx } from '$lib/services';

export async function getSlipExportData(ctx: ServiceCtx, id: string) {
	const [slipRows, details] = await Promise.all([
		ctx.db
			.select({
				slip_number: schema.shippingSlips.slip_number,
				shipped_at: schema.shippingSlips.shipped_at
			})
			.from(schema.shippingSlips)
			.where(eq(schema.shippingSlips.id, id)),
		ctx.db
			.select({
				product_code: schema.products.code,
				product_name: schema.products.name,
				quantity: schema.shippingSlipDetails.quantity,
				unit: schema.products.unit
			})
			.from(schema.shippingSlipDetails)
			.leftJoin(schema.products, eq(schema.shippingSlipDetails.product_id, schema.products.id))
			.where(eq(schema.shippingSlipDetails.slip_id, id))
			.orderBy(schema.shippingSlipDetails.line_no)
	]);
	if (!slipRows[0]) error(404, 'Shipping slip not found');
	return { slip: slipRows[0], details };
}

export async function listShippingSlips(ctx: ServiceCtx, search = '', page = 1) {
	const whereClause = search
		? or(
				like(schema.shippingSlips.slip_number, `%${search}%`),
				like(schema.customers.name, `%${search}%`)
			)
		: undefined;

	const {
		rows: slips,
		extra: products,
		...pagination
	} = await paginate({
		page,
		count: () =>
			ctx.db
				.select({ count: count() })
				.from(schema.shippingSlips)
				.leftJoin(schema.customers, eq(schema.shippingSlips.customer_id, schema.customers.id))
				.where(whereClause),
		rows: (limit, offset) =>
			ctx.db
				.select({
					id: schema.shippingSlips.id,
					slip_number: schema.shippingSlips.slip_number,
					shipped_at: schema.shippingSlips.shipped_at,
					customer_name: schema.customers.name,
					item_count: count(schema.shippingSlipDetails.id),
					user_name: schema.accounts.name
				})
				.from(schema.shippingSlips)
				.leftJoin(schema.accounts, eq(schema.shippingSlips.account_id, schema.accounts.id))
				.leftJoin(schema.customers, eq(schema.shippingSlips.customer_id, schema.customers.id))
				.leftJoin(
					schema.shippingSlipDetails,
					eq(schema.shippingSlips.id, schema.shippingSlipDetails.slip_id)
				)
				.where(whereClause)
				.groupBy(schema.shippingSlips.id)
				.orderBy(desc(schema.shippingSlips.shipped_at))
				.limit(limit)
				.offset(offset),
		extra: () =>
			ctx.db
				.select({
					id: schema.products.id,
					code: schema.products.code,
					name: schema.products.name,
					unit: schema.products.unit
				})
				.from(schema.products)
				.orderBy(asc(schema.products.code))
	});

	return {
		slips,
		products,
		...pagination,
		searchQuery: search
	};
}

export async function getShippingSlip(ctx: ServiceCtx, id: string) {
	const [slipRows, details, products] = await Promise.all([
		ctx.db
			.select({
				id: schema.shippingSlips.id,
				slip_number: schema.shippingSlips.slip_number,
				shipped_at: schema.shippingSlips.shipped_at,
				customer_id: schema.shippingSlips.customer_id,
				customer_name: schema.customers.name,
				account_id: schema.shippingSlips.account_id,
				user_name: schema.accounts.name,
				note: schema.shippingSlips.note,
				created_at: schema.shippingSlips.created_at,
				item_count: count(schema.shippingSlipDetails.id)
			})
			.from(schema.shippingSlips)
			.leftJoin(schema.accounts, eq(schema.shippingSlips.account_id, schema.accounts.id))
			.leftJoin(schema.customers, eq(schema.shippingSlips.customer_id, schema.customers.id))
			.leftJoin(
				schema.shippingSlipDetails,
				eq(schema.shippingSlips.id, schema.shippingSlipDetails.slip_id)
			)
			.where(eq(schema.shippingSlips.id, id))
			.groupBy(schema.shippingSlips.id),
		ctx.db
			.select({
				id: schema.shippingSlipDetails.id,
				product_id: schema.shippingSlipDetails.product_id,
				product_code: schema.products.code,
				product_name: schema.products.name,
				quantity: schema.shippingSlipDetails.quantity,
				unit: schema.products.unit
			})
			.from(schema.shippingSlipDetails)
			.leftJoin(schema.products, eq(schema.shippingSlipDetails.product_id, schema.products.id))
			.where(eq(schema.shippingSlipDetails.slip_id, id))
			.orderBy(schema.shippingSlipDetails.line_no),
		ctx.db
			.select({
				id: schema.products.id,
				code: schema.products.code,
				name: schema.products.name,
				unit: schema.products.unit
			})
			.from(schema.products)
			.orderBy(asc(schema.products.code))
	]);

	if (!slipRows[0]) error(404, 'Shipping slip not found');
	return { slip: slipRows[0], details, products };
}

export async function getShippingSlipForEdit(ctx: ServiceCtx, id: string) {
	const base = await getShippingSlip(ctx, id);
	const [accounts, customers] = await Promise.all([
		ctx.db
			.select({ id: schema.accounts.id, name: schema.accounts.name })
			.from(schema.accounts)
			.orderBy(asc(schema.accounts.name)),
		ctx.db
			.select({ id: schema.customers.id, name: schema.customers.name })
			.from(schema.customers)
			.orderBy(asc(schema.customers.name))
	]);
	return { ...base, accounts, customers, isAdmin: ctx.user.role === 'admin' };
}

export async function getShippingSlipForNew(ctx: ServiceCtx) {
	const [products, customers] = await Promise.all([
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
			.select({ id: schema.customers.id, name: schema.customers.name })
			.from(schema.customers)
			.orderBy(asc(schema.customers.name))
	]);
	return { products, customers };
}

export async function createShippingSlip(
	ctx: ServiceCtx,
	data: {
		shipped_at: string;
		customer_id: string | null;
		note: string;
		details: { product_id: string; quantity: number }[];
	}
) {
	if (!data.shipped_at) return fail(400, { error: 'Shipped date is required' });

	const validDetails = validateLineItems(data.details);
	if (!Array.isArray(validDetails)) return validDetails;

	const slip_number = await nextSequentialNumber(
		ctx.db,
		schema.shippingSlips,
		schema.shippingSlips.slip_number,
		'SHP',
		data.shipped_at
	);
	const now = new Date().toISOString();
	let slipId: string | null = null;
	try {
		const [slip] = await ctx.db
			.insert(schema.shippingSlips)
			.values({
				slip_number,
				shipped_at: data.shipped_at,
				customer_id: data.customer_id,
				account_id: ctx.user.id,
				note: data.note
			})
			.returning({ id: schema.shippingSlips.id });
		slipId = slip.id;
		await insertDetails(validDetails, (row) =>
			ctx.db.insert(schema.shippingSlipDetails).values({ slip_id: slip.id, ...row })
		);
		await adjustInventory(ctx.db, validDetails, '-', now);
	} catch (err) {
		await tryCleanup(slipId, (id) =>
			ctx.db.delete(schema.shippingSlips).where(eq(schema.shippingSlips.id, id))
		);
		if (isSlipNumberConflict(err))
			return fail(409, { error: 'Slip number conflict. Please try again.' });
		throw err;
	}

	await logAudit({
		db: ctx.db,
		user_id: ctx.user.id,
		user_name: ctx.user.name,
		action: 'create',
		target_type: 'shipping_slip',
		detail: {
			shipped_at: data.shipped_at,
			customer_id: data.customer_id,
			item_count: validDetails.length
		}
	});
	notifyLowStockForProducts(
		ctx,
		validDetails.map((d) => d.product_id)
	);
	redirect(303, '/shipping');
}

export async function updateShippingSlip(
	ctx: ServiceCtx,
	id: string,
	data: {
		shipped_at: string;
		customer_id: string | null;
		note: string;
		account_id?: string;
		details: { product_id: string; quantity: number }[];
	}
) {
	if (!data.shipped_at) return fail(400, { error: 'Shipped date is required' });

	const validDetails = validateLineItems(data.details);
	if (!Array.isArray(validDetails)) return validDetails;

	const now = new Date().toISOString();
	const updateFields: Record<string, unknown> = {
		shipped_at: data.shipped_at,
		note: data.note,
		customer_id: data.customer_id
	};
	if (data.account_id) updateFields.account_id = data.account_id;

	try {
		const oldDetails = await ctx.db
			.select({
				product_id: schema.shippingSlipDetails.product_id,
				quantity: schema.shippingSlipDetails.quantity
			})
			.from(schema.shippingSlipDetails)
			.where(eq(schema.shippingSlipDetails.slip_id, id));
		await ctx.db
			.update(schema.shippingSlips)
			.set(updateFields)
			.where(eq(schema.shippingSlips.id, id));
		await ctx.db
			.delete(schema.shippingSlipDetails)
			.where(eq(schema.shippingSlipDetails.slip_id, id));
		await adjustInventory(ctx.db, oldDetails, '+', now);
		await insertDetails(validDetails, (row) =>
			ctx.db.insert(schema.shippingSlipDetails).values({ slip_id: id, ...row })
		);
		await adjustInventory(ctx.db, validDetails, '-', now);
	} catch (err) {
		console.error('Failed to update shipping slip:', err);
		return fail(500, { error: 'Failed to update shipping slip' });
	}

	await logAudit({
		db: ctx.db,
		user_id: ctx.user.id,
		user_name: ctx.user.name,
		action: 'update',
		target_type: 'shipping_slip',
		target_id: id,
		detail: { item_count: validDetails.length }
	});
	notifyLowStockForProducts(
		ctx,
		validDetails.map((d) => d.product_id)
	);
	redirect(303, `/shipping/${id}`);
}

export async function deleteShippingSlip(ctx: ServiceCtx, id: string) {
	const now = new Date().toISOString();
	try {
		const oldDetails = await ctx.db
			.select({
				product_id: schema.shippingSlipDetails.product_id,
				quantity: schema.shippingSlipDetails.quantity
			})
			.from(schema.shippingSlipDetails)
			.where(eq(schema.shippingSlipDetails.slip_id, id));
		await ctx.db.delete(schema.shippingSlips).where(eq(schema.shippingSlips.id, id));
		await adjustInventory(ctx.db, oldDetails, '+', now);
	} catch (err) {
		console.error('Failed to delete shipping slip:', err);
		return fail(500, { error: 'Failed to delete shipping slip' });
	}

	await logAudit({
		db: ctx.db,
		user_id: ctx.user.id,
		user_name: ctx.user.name,
		action: 'delete',
		target_type: 'shipping_slip',
		target_id: id
	});
	redirect(303, '/shipping');
}

export async function importShippingSlips(ctx: ServiceCtx, csvText: string, date: string) {
	if (!date) return fail(400, { error: 'Please select a shipped date' });

	const parsed = parseImportCsv(csvText, [
		{ key: 'code', names: ['Product Code'], required: true },
		{ key: 'quantity', names: ['Quantity'], required: true }
	]);
	if (!('dataRows' in parsed)) return parsed;

	const productMap = await productCodeMap(ctx.db);
	const detailRecords = requireRecords(
		mapProductQuantities(parsed.dataRows, parsed.index, productMap)
	);
	if (!Array.isArray(detailRecords)) return detailRecords;

	const slip_number = await nextSequentialNumber(
		ctx.db,
		schema.shippingSlips,
		schema.shippingSlips.slip_number,
		'SHP',
		date
	);
	const now = new Date().toISOString();
	let slipId: string | null = null;
	try {
		const [slip] = await ctx.db
			.insert(schema.shippingSlips)
			.values({ slip_number, shipped_at: date, account_id: ctx.user.id, note: '' })
			.returning({ id: schema.shippingSlips.id });
		slipId = slip.id;
		await insertDetails(detailRecords, (row) =>
			ctx.db.insert(schema.shippingSlipDetails).values({ slip_id: slip.id, ...row })
		);
		await adjustInventory(ctx.db, detailRecords, '-', now);
		await logAudit({
			db: ctx.db,
			user_id: ctx.user.id,
			user_name: ctx.user.name,
			action: 'import',
			target_type: 'shipping_slip',
			detail: { count: detailRecords.length, date }
		});
		notifyLowStockForProducts(
			ctx,
			detailRecords.map((d) => d.product_id)
		);
		return { success: true, count: detailRecords.length };
	} catch (err) {
		await tryCleanup(slipId, (id) =>
			ctx.db.delete(schema.shippingSlips).where(eq(schema.shippingSlips.id, id))
		);
		if (isSlipNumberConflict(err))
			return fail(409, { error: 'Slip number conflict. Please try again.' });
		console.error('Failed to import shipping slips:', err);
		return fail(500, { error: 'Failed to import shipping slips' });
	}
}

function isSlipNumberConflict(err: unknown): boolean {
	const msg = String(err);
	return msg.includes('UNIQUE constraint failed') && msg.includes('slip_number');
}
