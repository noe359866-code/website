/**
 * Agregador de scrapers por categoría.
 *
 * Cada categoría expone una fábrica (`createMovieScrapers`, `createAnimeScrapers`…)
 * que devuelve descriptores `{ scraper, categories, contentTypes, priority }`.
 * `registerBuiltInScrapers()` los da de alta en `registry.js`, de donde los lee
 * el orquestador de streams.
 *
 * Solo deben registrarse fuentes legales (dominio público, catálogos con
 * licencia o proveedores propios). Las categorías sin fuentes autorizadas
 * permanecen vacías y el orquestador simplemente no las consulta.
 */

import { registerScraper } from './registry.js';
import { createMovieScrapers } from './movies/index.js';
import { createAnimeScrapers } from './anime/index.js';
import { createDoramaScrapers } from './doramas/index.js';
import { createTelenovelaScrapers } from './telenovelas/index.js';
import { createCartoonScrapers } from './cartoons/index.js';

export { HtmlScraper } from './html.scraper.js';
export { ArchiveOrgScraper } from './movies/archive-org.scraper.js';
export { createMovieScrapers } from './movies/index.js';
export { createAnimeScrapers } from './anime/index.js';
export { createDoramaScrapers } from './doramas/index.js';
export { createTelenovelaScrapers } from './telenovelas/index.js';
export { createCartoonScrapers } from './cartoons/index.js';

/**
 * Scrapers integrados, sin registrar.
 *
 * @returns {Array<{ scraper: object, categories: string[], contentTypes: string[], priority: number }>}
 */
export function getBuiltInScrapers() {
	return [
		...createMovieScrapers(),
		...createAnimeScrapers(),
		...createDoramaScrapers(),
		...createTelenovelaScrapers(),
		...createCartoonScrapers()
	];
}

/**
 * Registra los scrapers integrados en el registro global.
 *
 * Es idempotente: registrar dos veces el mismo id reemplaza el descriptor.
 *
 * @returns {object[]} Descriptores registrados.
 */
export function registerBuiltInScrapers() {
	const registered = [];

	for (const entry of getBuiltInScrapers()) {
		try {
			registered.push(
				registerScraper(entry.scraper, {
					categories: entry.categories,
					contentTypes: entry.contentTypes,
					priority: entry.priority
				})
			);
		} catch (error) {
			console.warn(
				`[scrapers] no se pudo registrar ${entry?.scraper?.id ?? 'un scraper'}: ${error?.message ?? error}`
			);
		}
	}

	return registered;
}

export default registerBuiltInScrapers;
