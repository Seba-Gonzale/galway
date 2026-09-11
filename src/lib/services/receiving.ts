import { error, redirect, fail } from '@sveltejs/kit';
import { eq, desc, count, like, asc, or } from 'drizzle-orm';
import * as schema from '$lib/server/db/schema';
import { logAudit } from '$lib/server/audit';
import { notifyLowStockForProducts } from '$lib/services/email';
import {
	nextSequentialNumber,
	adjustInventory,
	upsertInventoryDelta,
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
				slip_number: schema.receivingSlips.slip_number,
				received_at: schema.receivingSlips.received_at,
				supplier_name: schema.suppliers.name
			})
			.from(schema.receivingSlips)
			.leftJoin(schema.suppliers, eq(schema.receivingSlips.supplier_id, schema.suppliers.id))
			.where(eq(schema.receivingSlips.id, id)),
		ctx.db
			.select({
				product_code: schema.products.code,
				product_name: schema.products.name,
				quantity: schema.receivingSlipDetails.quantity,
				unit: schema.products.unit
			})
			.from(schema.receivingSlipDetails)
			.leftJoin(schema.products, eq(schema.receivingSlipDetails.product_id, schema.products.id))
			.where(eq(schema.receivingSlipDetails.slip_id, id))
			.orderBy(schema.receivingSlipDetails.line_no)
	]);
	if (!slipRows[0]) error(404, 'Receiving slip not found');
	return { slip: slipRows[0], details };
}

export async function listReceivingSlips(ctx: ServiceCtx, search = '', page = 1) {
	const whereClause = search
		? or(
				like(schema.receivingSlips.slip_number, `%${search}%`),
				like(schema.suppliers.name, `%${search}%`)
			)
		: undefined;

	const {
		rows: slips,
		extra: [suppliers, products],
		...pagination
	} = await paginate({
		page,
		count: () =>
			ctx.db
				.select({ count: count() })
				.from(schema.receivingSlips)
				.leftJoin(schema.suppliers, eq(schema.receivingSlips.supplier_id, schema.suppliers.id))
				.where(whereClause),
		rows: (limit, offset) =>
			ctx.db
				.select({
					id: schema.receivingSlips.id,
					slip_number: schema.receivingSlips.slip_number,
					received_at: schema.receivingSlips.received_at,
					supplier_id: schema.receivingSlips.supplier_id,
					supplier_name: schema.suppliers.name,
					item_count: count(schema.receivingSlipDetails.id),
					user_name: schema.accounts.name
				})
				.from(schema.receivingSlips)
				.leftJoin(schema.suppliers, eq(schema.receivingSlips.supplier_id, schema.suppliers.id))
				.leftJoin(schema.accounts, eq(schema.receivingSlips.account_id, schema.accounts.id))
				.leftJoin(
					schema.receivingSlipDetails,
					eq(schema.receivingSlips.id, schema.receivingSlipDetails.slip_id)
				)
				.where(whereClause)
				.groupBy(schema.receivingSlips.id)
				.orderBy(desc(schema.receivingSlips.received_at))
				.limit(limit)
				.offset(offset),
		extra: () =>
			Promise.all([
				ctx.db
					.select({ id: schema.suppliers.id, name: schema.suppliers.name })
					.from(schema.suppliers)
					.orderBy(asc(schema.suppliers.name)),
				ctx.db
					.select({
						id: schema.products.id,
						code: schema.products.code,
						name: schema.products.name,
						unit: schema.products.unit
					})
					.from(schema.products)
					.orderBy(asc(schema.products.code))
			])
	});

	return {
		slips,
		suppliers,
		products,
		...pagination,
		searchQuery: search
	};
}

export async function getReceivingSlipForNew(ctx: ServiceCtx) {
	const [suppliers, products] = await Promise.all([
		ctx.db
			.select({ id: schema.suppliers.id, name: schema.suppliers.name })
			.from(schema.suppliers)
			.orderBy(asc(schema.suppliers.name)),
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
	return { suppliers, products };
}

export async function getReceivingSlip(ctx: ServiceCtx, id: string) {
	const [slipRows, details, suppliers, products] = await Promise.all([
		ctx.db
			.select({
				id: schema.receivingSlips.id,
				slip_number: schema.receivingSlips.slip_number,
				received_at: schema.receivingSlips.received_at,
				supplier_id: schema.receivingSlips.supplier_id,
				supplier_name: schema.suppliers.name,
				account_id: schema.receivingSlips.account_id,
				user_name: schema.accounts.name,
				note: schema.receivingSlips.note,
				created_at: schema.receivingSlips.created_at,
				item_count: count(schema.receivingSlipDetails.id)
			})
			.from(schema.receivingSlips)
			.leftJoin(schema.suppliers, eq(schema.receivingSlips.supplier_id, schema.suppliers.id))
			.leftJoin(schema.accounts, eq(schema.receivingSlips.account_id, schema.accounts.id))
			.leftJoin(
				schema.receivingSlipDetails,
				eq(schema.receivingSlips.id, schema.receivingSlipDetails.slip_id)
			)
			.where(eq(schema.receivingSlips.id, id))
			.groupBy(schema.receivingSlips.id),
		ctx.db
			.select({
				id: schema.receivingSlipDetails.id,
				product_id: schema.receivingSlipDetails.product_id,
				product_code: schema.products.code,
				product_name: schema.products.name,
				quantity: schema.receivingSlipDetails.quantity,
				unit: schema.products.unit
			})
			.from(schema.receivingSlipDetails)
			.leftJoin(schema.products, eq(schema.receivingSlipDetails.product_id, schema.products.id))
			.where(eq(schema.receivingSlipDetails.slip_id, id))
			.orderBy(schema.receivingSlipDetails.line_no),
		ctx.db
			.select({ id: schema.suppliers.id, name: schema.suppliers.name })
			.from(schema.suppliers)
			.orderBy(asc(schema.suppliers.name)),
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

	if (!slipRows[0]) error(404, 'Receiving slip not found');
	return { slip: slipRows[0], details, suppliers, products };
}

export async function getReceivingSlipForEdit(ctx: ServiceCtx, id: string) {
	const [base, accounts] = await Promise.all([
		getReceivingSlip(ctx, id),
		ctx.db
			.select({ id: schema.accounts.id, name: schema.accounts.name })
			.from(schema.accounts)
			.orderBy(asc(schema.accounts.name))
	]);
	return { ...base, accounts, isAdmin: ctx.user.role === 'admin' };
}

export async function createReceivingSlip(
	ctx: ServiceCtx,
	data: {
		received_at: string;
		supplier_id: string;
		note: string;
		details: { product_id: string; quantity: number }[];
	}
) {
	if (!data.received_at) return fail(400, { error: 'Received date is required' });
	if (!data.supplier_id) return fail(400, { error: 'Supplier is required' });

	const validDetails = validateLineItems(data.details);
	if (!Array.isArray(validDetails)) return validDetails;

	const slip_number = await nextSequentialNumber(
		ctx.db,
		schema.receivingSlips,
		schema.receivingSlips.slip_number,
		'RCV',
		data.received_at
	);
	const now = new Date().toISOString();
	let slipId: string | null = null;
	try {
		const [slip] = await ctx.db
			.insert(schema.receivingSlips)
			.values({
				slip_number,
				received_at: data.received_at,
				supplier_id: data.supplier_id,
				account_id: ctx.user.id,
				note: data.note
			})
			.returning({ id: schema.receivingSlips.id });
		slipId = slip.id;
		await insertDetails(ctx.db, validDetails, (row) =>
			ctx.db.insert(schema.receivingSlipDetails).values({ slip_id: slip.id, ...row })
		);
		await upsertInventoryDelta(ctx.db, validDetails, '+', now);
	} catch (err) {
		await tryCleanup(slipId, (id) =>
			ctx.db.delete(schema.receivingSlips).where(eq(schema.receivingSlips.id, id))
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
		target_type: 'receiving_slip',
		detail: {
			supplier_id: data.supplier_id,
			received_at: data.received_at,
			item_count: validDetails.length
		}
	});
	notifyLowStockForProducts(
		ctx,
		validDetails.map((d) => d.product_id)
	);
	redirect(303, '/receiving');
}

export async function updateReceivingSlip(
	ctx: ServiceCtx,
	id: string,
	data: {
		received_at: string;
		supplier_id: string;
		note: string;
		account_id?: string;
		details: { product_id: string; quantity: number }[];
	}
) {
	if (!data.received_at) return fail(400, { error: 'Received date is required' });
	if (!data.supplier_id) return fail(400, { error: 'Supplier is required' });

	const validDetails = validateLineItems(data.details);
	if (!Array.isArray(validDetails)) return validDetails;

	const now = new Date().toISOString();
	const updateFields: Record<string, unknown> = {
		received_at: data.received_at,
		supplier_id: data.supplier_id,
		note: data.note
	};
	if (data.account_id) updateFields.account_id = data.account_id;

	try {
		const oldDetails = await ctx.db
			.select({
				product_id: schema.receivingSlipDetails.product_id,
				quantity: schema.receivingSlipDetails.quantity
			})
			.from(schema.receivingSlipDetails)
			.where(eq(schema.receivingSlipDetails.slip_id, id));
		await ctx.db
			.update(schema.receivingSlips)
			.set(updateFields)
			.where(eq(schema.receivingSlips.id, id));
		await ctx.db
			.delete(schema.receivingSlipDetails)
			.where(eq(schema.receivingSlipDetails.slip_id, id));
		await adjustInventory(ctx.db, oldDetails, '-', now);
		await insertDetails(ctx.db, validDetails, (row) =>
			ctx.db.insert(schema.receivingSlipDetails).values({ slip_id: id, ...row })
		);
		await upsertInventoryDelta(ctx.db, validDetails, '+', now);
	} catch (err) {
		console.error('Failed to update receiving slip:', err);
		return fail(500, { error: 'Failed to update receiving slip' });
	}

	await logAudit({
		db: ctx.db,
		user_id: ctx.user.id,
		user_name: ctx.user.name,
		action: 'update',
		target_type: 'receiving_slip',
		target_id: id,
		detail: { item_count: validDetails.length }
	});
	notifyLowStockForProducts(
		ctx,
		validDetails.map((d) => d.product_id)
	);
	redirect(303, `/receiving/${id}`);
}

export async function deleteReceivingSlip(ctx: ServiceCtx, id: string) {
	const now = new Date().toISOString();
	let oldDetails: { product_id: string; quantity: number }[] = [];
	try {
		oldDetails = await ctx.db
			.select({
				product_id: schema.receivingSlipDetails.product_id,
				quantity: schema.receivingSlipDetails.quantity
			})
			.from(schema.receivingSlipDetails)
			.where(eq(schema.receivingSlipDetails.slip_id, id));
		await ctx.db.delete(schema.receivingSlips).where(eq(schema.receivingSlips.id, id));
		await adjustInventory(ctx.db, oldDetails, '-', now);
	} catch (err) {
		console.error('Failed to delete receiving slip:', err);
		return fail(500, { error: 'Failed to delete receiving slip' });
	}

	await logAudit({
		db: ctx.db,
		user_id: ctx.user.id,
		user_name: ctx.user.name,
		action: 'delete',
		target_type: 'receiving_slip',
		target_id: id
	});
	notifyLowStockForProducts(
		ctx,
		oldDetails.map((d) => d.product_id)
	);
	redirect(303, '/receiving');
}

export async function importReceivingSlips(
	ctx: ServiceCtx,
	csvText: string,
	date: string,
	supplierId: string
) {
	if (!date) return fail(400, { error: 'Please select a received date' });
	if (!supplierId) return fail(400, { error: 'Please select a supplier' });

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
		schema.receivingSlips,
		schema.receivingSlips.slip_number,
		'RCV',
		date
	);
	const now = new Date().toISOString();
	let slipId: string | null = null;
	try {
		const [slip] = await ctx.db
			.insert(schema.receivingSlips)
			.values({
				slip_number,
				received_at: date,
				supplier_id: supplierId,
				account_id: ctx.user.id,
				note: ''
			})
			.returning({ id: schema.receivingSlips.id });
		slipId = slip.id;
		await insertDetails(ctx.db, detailRecords, (row) =>
			ctx.db.insert(schema.receivingSlipDetails).values({ slip_id: slip.id, ...row })
		);
		await upsertInventoryDelta(ctx.db, detailRecords, '+', now);
		await logAudit({
			db: ctx.db,
			user_id: ctx.user.id,
			user_name: ctx.user.name,
			action: 'import',
			target_type: 'receiving_slip',
			detail: { count: detailRecords.length, date }
		});
		notifyLowStockForProducts(
			ctx,
			detailRecords.map((d) => d.product_id)
		);
		return { success: true, count: detailRecords.length };
	} catch (err) {
		await tryCleanup(slipId, (id) =>
			ctx.db.delete(schema.receivingSlips).where(eq(schema.receivingSlips.id, id))
		);
		if (isSlipNumberConflict(err))
			return fail(409, { error: 'Slip number conflict. Please try again.' });
		console.error('Failed to import receiving slips:', err);
		return fail(500, { error: 'Failed to import receiving slips' });
	}
}

function isSlipNumberConflict(err: unknown): boolean {
	const msg = String(err);
	return msg.includes('UNIQUE constraint failed') && msg.includes('slip_number');
}
