/**
 * Registro de scrapers activos del addon.
 *
 * El orquestador de streams no conoce implementaciones concretas: recibe una
 * lista de scrapers y los ejecuta en paralelo. Este módulo centraliza el alta,
 * la baja y el filtrado por categoría/tipo de contenido.
 *
 * Categorías: Películas, Anime, Doramas, Telenovelas y Caricaturas.
 *
 * Contrato de un scraper:
 *   - `scrape(context)` o `getStreams(context)` -> stream[] | { streams: [] }
 *     (`BaseScraper` ya aporta `scrape()` y `safeScrape()`).
 *   - Metadatos opcionales: `id`, `name`, `categories`, `contentTypes`,
 *     `priority`, `enabled`, `timeoutMs`.
 *
 * `contentTypes` vacío = todos los tipos (`movie` y `series`).
 * `categories` vacío = participa en todas las categorías.
 *
 * @example
 * import { registerScraper } from './registry.js';
 * import { AnimeScraper } from './anime.scraper.js';
 *
 * registerScraper(new AnimeScraper(), { categories: ['anime'], contentTypes: ['series'], priority: 10 });
 */

/** Categorías soportadas (clave estable -> etiqueta en español). */
export const SCRAPER_CATEGORIES = Object.freeze({
	movies: 'Películas',
	anime: 'Anime',
	doramas: 'Doramas',
	telenovelas: 'Telenovelas',
	cartoons: 'Caricaturas'
});

const CATEGORY_KEYS = Object.freeze(Object.keys(SCRAPER_CATEGORIES));

/** @type {Map<string, any>} id -> descriptor */
const registry = new Map();

/**
 * Registra un scraper. Si el id ya existe, lo reemplaza.
 *
 * @param {object} scraper Instancia (o descriptor `{ scraper, ...meta }`).
 * @param {object} [metadata] Metadatos que sobreescriben los del scraper.
 * @param {string} [metadata.id]
 * @param {string} [metadata.name]
 * @param {string[]} [metadata.categories] Claves de `SCRAPER_CATEGORIES`.
 * @param {Array<'movie'|'series'>} [metadata.contentTypes]
 * @param {number} [metadata.priority] Menor = antes.
 * @param {boolean} [metadata.enabled]
 * @param {number} [metadata.timeoutMs]
 * @returns {object} Descriptor normalizado.
 * @throws {TypeError} Si no es un scraper válido.
 */
export function registerScraper(scraper, metadata = {}) {
	// Acepta tanto una instancia como un descriptor ya normalizado.
	const previous = scraper?.scraper || scraper?.instance ? scraper : null;
	const instance = previous?.scraper ?? previous?.instance ?? scraper;

	if (!instance || typeof instance !== 'object') {
		throw new TypeError('registerScraper requiere una instancia de scraper.');
	}

	const runnable =
		typeof instance.scrape === 'function' ||
		typeof instance.safeScrape === 'function' ||
		typeof instance.getStreams === 'function';

	if (!runnable) {
		throw new TypeError(
			`El scraper "${describeInstance(instance)}" debe implementar scrape(), safeScrape() o getStreams().`
		);
	}

	const pick = (key) => metadata[key] ?? previous?.[key] ?? instance[key];

	const id = normalizeScraperId(pick('id') ?? instance.name ?? instance.constructor?.name ?? '');

	if (!id) {
		throw new TypeError('El scraper necesita un `id` (o un `name`) para registrarse.');
	}

	const descriptor = Object.freeze({
		id,
		name: String(pick('name') ?? id).trim() || id,
		categories: normalizeCategories(pick('categories') ?? instance.category),
		contentTypes: normalizeContentTypes(pick('contentTypes') ?? instance.contentType),
		priority: toPriority(pick('priority')),
		timeoutMs: toPositiveNumber(pick('timeoutMs')),
		enabled: pick('enabled') !== false,
		scraper: instance
	});

	registry.set(id, descriptor);

	return descriptor;
}

/**
 * Registra varios scrapers de una vez.
 *
 * @param {Array<object>} scrapers
 * @returns {object[]} Descriptores registrados.
 */
export function registerScrapers(scrapers = []) {
	if (!Array.isArray(scrapers)) {
		throw new TypeError('registerScrapers espera un array de scrapers.');
	}

	return scrapers.map((scraper) => registerScraper(scraper));
}

/**
 * Elimina un scraper por id.
 *
 * @param {string} id
 * @returns {boolean} `true` si existía.
 */
export function unregisterScraper(id) {
	return registry.delete(normalizeScraperId(id));
}

/** Elimina todos los scrapers registrados. */
export function clearScrapers() {
	registry.clear();
}

/**
 * Lista todos los scrapers registrados (incluidos los deshabilitados).
 *
 * @returns {object[]} Descriptores ordenados por prioridad.
 */
export function listScrapers() {
	return [...registry.values()].sort(byPriority);
}

/**
 * Devuelve los scrapers activos, filtrados por tipo de contenido y categoría.
 *
 * @param {object} [options]
 * @param {'movie'|'series'|'tv'} [options.type] Tipo solicitado por Stremio.
 * @param {string[]} [options.categories] Si se indica, solo esas categorías.
 * @param {boolean} [options.enabledOnly=true]
 * @returns {object[]} Descriptores ordenados por prioridad.
 */
export function getActiveScrapers({ type, categories, enabledOnly = true } = {}) {
	const mediaType = normalizeContentType(type);
	const categoryFilter = normalizeCategories(categories);

	return [...registry.values()]
		.filter((entry) => (enabledOnly ? entry.enabled : true))
		.filter(
			(entry) =>
				!mediaType || entry.contentTypes.length === 0 || entry.contentTypes.includes(mediaType)
		)
		.filter(
			(entry) =>
				categoryFilter.length === 0 ||
				entry.categories.length === 0 ||
				entry.categories.some((category) => categoryFilter.includes(category))
		)
		.sort(byPriority);
}

/**
 * Indica si hay al menos un scraper activo.
 *
 * @returns {boolean}
 */
export function hasScrapers() {
	return [...registry.values()].some((entry) => entry.enabled);
}

/**
 * Normaliza una lista de categorías, descartando claves desconocidas.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function normalizeCategories(value) {
	const list = Array.isArray(value) ? value : value ? [value] : [];

	return [
		...new Set(
			list
				.map((category) => String(category ?? '').trim().toLowerCase())
				.filter((category) => CATEGORY_KEYS.includes(category))
		)
	];
}

/**
 * Normaliza los tipos de contenido a `movie` / `series`.
 *
 * @param {unknown} value
 * @returns {Array<'movie'|'series'>}
 */
export function normalizeContentTypes(value) {
	const list = Array.isArray(value) ? value : value ? [value] : [];
	const result = new Set();

	for (const item of list) {
		const normalized = normalizeContentType(item);
		if (normalized) result.add(normalized);
	}

	return [...result];
}

/**
 * @param {unknown} value
 * @returns {'movie'|'series'|null}
 */
function normalizeContentType(value) {
	const type = String(value ?? '').trim().toLowerCase();
	if (['movie', 'movies', 'film', 'pelicula', 'película'].includes(type)) return 'movie';
	if (['series', 'serie', 'tv', 'show'].includes(type)) return 'series';
	return null;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeScraperId(value) {
	return String(value ?? '')
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function toPriority(value) {
	const number = Number(value);
	return Number.isFinite(number) ? number : 100;
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function toPositiveNumber(value) {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? number : undefined;
}

/**
 * @param {unknown} instance
 * @returns {string}
 */
function describeInstance(instance) {
	return String(instance?.id ?? instance?.name ?? instance?.constructor?.name ?? 'anónimo');
}

/**
 * @param {any} a
 * @param {any} b
 * @returns {number}
 */
function byPriority(a, b) {
	return a.priority - b.priority;
}

export default {
	SCRAPER_CATEGORIES,
	registerScraper,
	registerScrapers,
	unregisterScraper,
	clearScrapers,
	listScrapers,
	getActiveScrapers,
	hasScrapers,
	normalizeCategories,
	normalizeContentTypes
};
