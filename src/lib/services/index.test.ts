/**
 * Tests de los guards de admin (TASK-026).
 *
 * `requireAdmin(ctx)` (load) y `requireAdminAction(ctx)` (actions) reemplazan los
 * checks manuales `if (ctx.user.role !== 'admin')` de category/account/settings.
 */
import { describe, it, expect } from 'vitest';
import { requireAdmin, requireAdminAction } from './index';
import type { ServiceCtx } from './index';

function ctxWithRole(role: 'admin' | 'general' | undefined): ServiceCtx {
	return { user: role ? { role } : undefined } as unknown as ServiceCtx;
}

describe('requireAdmin', () => {
	it('no hace nada si el usuario es admin', () => {
		expect(() => requireAdmin(ctxWithRole('admin'))).not.toThrow();
	});

	it('lanza error(403) si el usuario no es admin', () => {
		try {
			requireAdmin(ctxWithRole('general'));
			expect.unreachable('debería haber lanzado');
		} catch (err) {
			expect((err as { status: number }).status).toBe(403);
		}
	});

	it('lanza error(403) si no hay usuario', () => {
		try {
			requireAdmin(ctxWithRole(undefined));
			expect.unreachable('debería haber lanzado');
		} catch (err) {
			expect((err as { status: number }).status).toBe(403);
		}
	});
});

describe('requireAdminAction', () => {
	it('devuelve null si el usuario es admin', () => {
		expect(requireAdminAction(ctxWithRole('admin'))).toBeNull();
	});

	it('devuelve fail(403) si el usuario no es admin', () => {
		const denied = requireAdminAction(ctxWithRole('general'));

		expect(denied).not.toBeNull();
		expect(denied?.status).toBe(403);
		expect(denied?.data).toEqual({ error: 'Access denied' });
	});

	it('devuelve fail(403) si no hay usuario', () => {
		const denied = requireAdminAction(ctxWithRole(undefined));

		expect(denied?.status).toBe(403);
		expect(denied?.data).toEqual({ error: 'Access denied' });
	});
});
