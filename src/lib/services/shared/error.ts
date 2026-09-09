import { fail } from '@sveltejs/kit';

/**
 * Centraliza el manejo de errores de las operaciones de servicios.
 *
 * Reemplaza el patrón repetido:
 *   } catch (err: any) {
 *     if (err?.message?.includes('UNIQUE')) return fail(409, { error: '...' });
 *     console.error('Failed to <action> <entity>:', err);
 *     return fail(500, { error: 'Failed to <action> <entity>' });
 *   }
 *
 * @param entity   nombre de la entidad, tal como aparece en el mensaje (ej. 'category')
 * @param action   verbo en infinitivo (create / update / delete / import ...)
 * @param conflictMessage si se provee, un error UNIQUE se devuelve como 409 con este mensaje
 */
export function handleDbError(
	err: unknown,
	entity: string,
	action: string,
	conflictMessage?: string
) {
	const message = String((err as { message?: unknown } | null)?.message ?? err);

	if (conflictMessage && message.includes('UNIQUE')) {
		return fail(409, { error: conflictMessage });
	}

	console.error(`Failed to ${action} ${entity}:`, err);
	return fail(500, { error: `Failed to ${action} ${entity}` });
}
