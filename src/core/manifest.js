/**
 * Manifest del addon (protocolo Stremio).
 *
 * Se construye sin dependencias del SDK para poder servirse como JSON plano
 * desde Express y para validarlo al arrancar (`validateManifest`), de modo que
 * un manifest inválido falle en el despliegue y no en el cliente Stremio.
 *
 * Variables de entorno opcionales:
 *   ADDON_ID, ADDON_VERSION, ADDON_NAME, ADDON_DESCRIPTION, ADDON_LOGO
 */

/** Identificador del addon (formato inverso de dominio). */
export const ADDON_ID = process.env.ADDON_ID || 'org.jikan.stremio';

/** Versión semver del addon. */
export const ADDON_VERSION = process.env.ADDON_VERSION || '0.1.0';

const ADDON_NAME = process.env.ADDON_NAME || 'Jikan Addon';
const ADDON_DESCRIPTION =
	process.env.ADDON_DESCRIPTION ||
	'Catálogo, metadatos y streams de anime a través de Jikan (MyAnimeList) y AniList.';
const ADDON_LOGO =
	process.env.ADDON_LOGO || 'https://jikan.moe/favicon/android-chrome-192x192.png';

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Tipos de contenido soportados por Stremio que expone el addon. */
export const SUPPORTED_TYPES = Object.freeze(['series', 'movie']);

/** Prefijos de id que puede resolver el addon. */
export const SUPPORTED_ID_PREFIXES = Object.freeze(['jikan:', 'tt']);

/**
 * Manifest base. Los `idPrefixes` se declaran por recurso (no a nivel global)
 * para que el catálogo pueda usar `jikan:*` y los streams acepten también
 * ids de IMDb (`tt*`).
 */
const BASE_MANIFEST = Object.freeze({
	id: ADDON_ID,
	version: ADDON_VERSION,
	name: ADDON_NAME,
	description: ADDON_DESCRIPTION,
	logo: ADDON_LOGO,
	resources: [
		{ name: 'catalog', types: ['series', 'movie'], idPrefixes: ['jikan:'] },
		{ name: 'meta', types: ['series', 'movie'], idPrefixes: ['jikan:', 'tt'] },
		{ name: 'stream', types: ['series', 'movie'], idPrefixes: ['jikan:', 'tt'] }
	],
	types: ['series', 'movie'],
	catalogs: [
		{
			type: 'series',
			id: 'jikan:top',
			name: 'Jikan · Top anime',
			extra: [
				{ name: 'search', isRequired: false },
				{ name: 'genre', isRequired: false },
				{ name: 'skip', isRequired: false }
			]
		},
		{
			type: 'movie',
			id: 'jikan:movies',
			name: 'Jikan · Películas',
			extra: [{ name: 'skip', isRequired: false }]
		}
	],
	behaviorHints: {
		adult: false,
		p2p: false
	}
});

/**
 * Crea una copia del manifest aplicando overrides superficiales.
 *
 * @param {Partial<typeof BASE_MANIFEST>} [overrides]
 * @returns {typeof BASE_MANIFEST}
 * @throws {TypeError} Si el manifest resultante no cumple el protocolo.
 */
export function createManifest(overrides = {}) {
	const manifest = {
		...BASE_MANIFEST,
		...overrides,
		behaviorHints: { ...BASE_MANIFEST.behaviorHints, ...(overrides.behaviorHints ?? {}) }
	};

	validateManifest(manifest);
	return manifest;
}

/**
 * Valida los campos obligatorios del protocolo Stremio.
 *
 * @param {any} manifest
 * @returns {true}
 * @throws {TypeError}
 */
export function validateManifest(manifest) {
	const fail = (message) => {
		throw new TypeError(`Manifest inválido: ${message}`);
	};

	if (!manifest || typeof manifest !== 'object') fail('se esperaba un objeto.');

	if (typeof manifest.id !== 'string' || manifest.id.trim() === '') {
		fail('`id` es obligatorio y debe ser una cadena no vacía.');
	}

	if (typeof manifest.version !== 'string' || !SEMVER_PATTERN.test(manifest.version)) {
		fail('`version` debe ser semver (p. ej. "1.0.0").');
	}

	if (typeof manifest.name !== 'string' || manifest.name.trim() === '') {
		fail('`name` es obligatorio.');
	}

	if (!Array.isArray(manifest.types) || manifest.types.length === 0) {
		fail('`types` debe ser un array con al menos un tipo.');
	}

	if (!Array.isArray(manifest.resources) || manifest.resources.length === 0) {
		fail('`resources` debe ser un array con al menos un recurso.');
	}

	if (!Array.isArray(manifest.catalogs)) {
		fail('`catalogs` debe ser un array (puede estar vacío).');
	}

	for (const resource of manifest.resources) {
		const isString = typeof resource === 'string';
		const isFullResource =
			resource &&
			typeof resource === 'object' &&
			typeof resource.name === 'string' &&
			Array.isArray(resource.types);

		if (!isString && !isFullResource) {
			fail('cada recurso debe ser una cadena o un objeto { name, types }.');
		}
	}

	for (const catalog of manifest.catalogs) {
		if (!catalog || typeof catalog.type !== 'string' || typeof catalog.id !== 'string') {
			fail('cada catálogo requiere `type` e `id` de tipo cadena.');
		}
	}

	return true;
}

/**
 * Indica si un manifest es válido sin lanzar excepciones.
 *
 * @param {any} manifest
 * @returns {boolean}
 */
export function isValidManifest(manifest) {
	try {
		validateManifest(manifest);
		return true;
	} catch {
		return false;
	}
}

/** Manifest listo para servir en `/manifest.json`. */
export const manifest = createManifest();

export default manifest;
