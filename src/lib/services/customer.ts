import { fail } from '@sveltejs/kit';
import { eq, asc, count } from 'drizzle-orm';
import * as schema from '$lib/server/db/schema';
import { auditLog, handleDbError } from '$lib/services/shared';
import { customerSchema } from '$lib/validation';
import type { ServiceCtx } from '$lib/services';
import type { Customer } from '$lib/types/shipping';

export async function listCustomers(ctx: ServiceCtx) {
	const rows = await ctx.db
		.select({
			id: schema.customers.id,
			name: schema.customers.name,
			tel: schema.customers.tel,
			zipcode: schema.customers.zipcode,
			address: schema.customers.address,
			email: schema.customers.email,
			note: schema.customers.note,
			slip_count: count(schema.shippingSlips.id),
		})
		.from(schema.customers)
		.leftJoin(schema.shippingSlips, eq(schema.shippingSlips.customer_id, schema.customers.id))
		.groupBy(schema.customers.id)
		.orderBy(asc(schema.customers.name));

	return { customers: rows as Customer[] };
}

export async function createCustomer(
	ctx: ServiceCtx,
	data: { name: string; tel: string | null; zipcode: string | null; address: string | null; email: string | null; note: string | null }
) {
	const parsed = customerSchema.safeParse(data);
	if (!parsed.success) return fail(400, { error: parsed.error.issues[0].message });
	const { name, tel, zipcode, address, email, note } = parsed.data;

	const now = new Date().toISOString();
	try {
		await ctx.db.insert(schema.customers).values({ name, tel, zipcode, address, email, note, created_at: now, updated_at: now });
		await auditLog(ctx, 'create', 'customer', { target_label: name });
		return { success: true };
	} catch (err) {
		return handleDbError(err, 'customer', 'create');
	}
}

export async function updateCustomer(
	ctx: ServiceCtx,
	data: { id: string; name: string; tel: string | null; zipcode: string | null; address: string | null; email: string | null; note: string | null }
) {
	if (!data.id) return fail(400, { error: 'ID is required' });
	const parsed = customerSchema.safeParse(data);
	if (!parsed.success) return fail(400, { error: parsed.error.issues[0].message });
	const { name, tel, zipcode, address, email, note } = parsed.data;

	try {
		await ctx.db
			.update(schema.customers)
			.set({ name, tel, zipcode, address, email, note, updated_at: new Date().toISOString() })
			.where(eq(schema.customers.id, data.id));
		await auditLog(ctx, 'update', 'customer', { target_id: data.id, target_label: name });
		return { success: true };
	} catch (err) {
		return handleDbError(err, 'customer', 'update');
	}
}

export async function deleteCustomer(ctx: ServiceCtx, id: string) {
	if (!id) return fail(400, { error: 'ID is required' });

	try {
		const [target] = await ctx.db.select({ name: schema.customers.name }).from(schema.customers).where(eq(schema.customers.id, id));
		await ctx.db.delete(schema.customers).where(eq(schema.customers.id, id));
		await auditLog(ctx, 'delete', 'customer', { target_id: id, target_label: target?.name });
		return { success: true };
	} catch (err) {
		return handleDbError(err, 'customer', 'delete');
	}
}
