/**
 * Servicio de resolución de IDs de Stremio -> variantes de título.
 *
 * Entrada: un id de Stremio (`tt0133093`, `tmdb:603`, `kitsu:7442`), opcionalmente
 * con temporada/episodio (`tt0903747:5:14`), y el tipo (`movie` | `series`).
 *
 * Salida: un objeto con título en español (Latino y España), título original y
 * título en inglés, más una lista `searchTitles` ordenada en cascada para que los
 * scrapers prueben varios nombres cuando la fuente principal no devuelve nada:
 *
 *   1. Español (Latinoamérica)  4. Romaji (si la fuente lo aporta)
 *   2. Español (genérico)       5. Original
 *   3. Español (España)         6. Inglés
 *   7. Títulos alternativos
 *
 * Además de `es`, `original` y `english`, `titles` incluye `esLatam`, `esSpain`
 * y `romaji` (Kitsu), y el resultado trae `titleSlugs` listos para URLs.
 *
 * Fuentes de datos:
 *  - TMDB (recomendada): resuelve IMDb y TMDB, traducciones es-MX / es-ES / en-US.
 *  - Kitsu (sin API key): resuelve ids `kitsu:*` (canonicalTitle, titles.en…).
 *
 * El servicio nunca lanza: si no hay API key, la API falla o expira el tiempo,
 * devuelve un resultado con `ok: false`, `searchTitles: []` y `error` descriptivo.
 *
 * Variables de entorno:
 *   TMDB_API_KEY / TMDB_ACCESS_TOKEN  Credenciales de TMDB (v3 o v4).
 *   TMDB_LANGUAGE                     Idioma base a pedir (por defecto `es-MX`).
 *   RESOLVER_TIMEOUT_MS               Presupuesto total por resolución (8000 ms).
 *   RESOLVER_CACHE_TTL_MS             TTL de caché en memoria (6 h).
 *   RESOLVER_CACHE_MAX_ENTRIES        Entradas máximas de caché (500).
 *
 * @example
 * import { createResolver } from './resolver.service.js';
 *
 * const resolver = createResolver();
 * const info = await resolver.resolve('tt0133093', { type: 'movie' });
 * // info.searchTitles -> ['Matrix', 'The Matrix']
 */

import { BaseScraper } from '../scrapers/base.scraper.js';
import { isAsciiText, normalizeTitle, slugify } from '../utils/sanitizer.js';

export const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
export const KITSU_BASE_URL = 'https://kitsu.io/api/edge';

export const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_CACHE_MAX_ENTRIES = 500;
export const DEFAULT_RESOLVE_TIMEOUT_MS = 8000;

/** Proveedores que el servicio puede resolver. */
export const PROVIDERS = Object.freeze(['imdb', 'tmdb', 'kitsu']);
const MOVIE_TYPES = Object.freeze(['movie', 'movies', 'film', 'pelicula', 'película']);
const SERIES_TYPES = Object.freeze(['series', 'tv', 'show', 'tvshow', 'serie']);

/* ---------------------------------------------------------------------- *
 * Parseo de IDs de Stremio
 * ---------------------------------------------------------------------- */

/**
 * @typedef {Object} ParsedStremioId
 * @property {string} raw            ID original recibido.
 * @property {'imdb'|'tmdb'|'kitsu'|'unknown'} provider
 * @property {string|null} providerId
 * @property {number|null} season
 * @property {number|null} episode
 * @property {boolean} [inferred]    `true` si el proveedor se dedujo (id numérico).
 */

/**
 * Interpreta un ID de Stremio.
 *
 * Formatos soportados:
 *   tt0133093 · tt0903747:5:14 · imdb:tt0133093
 *   tmdb:603 · tmdb:1399:1:2
 *   kitsu:7442 · kitsu:7442:1
 *   603 (numérico -> TMDB, por convención)
 *
 * @param {unknown} rawId
 * @returns {ParsedStremioId}
 */
export function parseStremioId(rawId) {
	const raw = String(rawId ?? '').trim();

	/** @type {ParsedStremioId} */
	const unknown = { raw, provider: 'unknown', providerId: null, season: null, episode: null };
	if (!raw) return unknown;

	// IMDb, con temporada/episodio opcionales (Stremio: tt0903747:5:14).
	const imdb = raw.match(/^(?:imdb:)?(tt\d{5,})(?::(\d+))?(?::(\d+))?$/i);
	if (imdb) {
		return {
			raw,
			provider: 'imdb',
			providerId: imdb[1].toLowerCase(),
			season: toInt(imdb[2]),
			episode: toInt(imdb[3])
		};
	}

	const tmdb = raw.match(/^tmdb:(\d+)(?::(\d+))?(?::(\d+))?$/i);
	if (tmdb) {
		return {
			raw,
			provider: 'tmdb',
			providerId: tmdb[1],
			season: toInt(tmdb[2]),
			episode: toInt(tmdb[3])
		};
	}

	const kitsu = raw.match(/^kitsu:(\d+)(?::(\d+))?(?::(\d+))?$/i);
	if (kitsu) {
		return {
			raw,
			provider: 'kitsu',
			providerId: kitsu[1],
			season: toInt(kitsu[2]),
			episode: toInt(kitsu[3])
		};
	}

	// Los addons de anime usan a veces el id numérico de TMDB sin prefijo.
	const numeric = raw.match(/^(\d+)$/);
	if (numeric) {
		return { raw, provider: 'tmdb', providerId: numeric[1], season: null, episode: null, inferred: true };
	}

	return unknown;
}

/**
 * Normaliza el tipo de contenido al vocabulario de Stremio.
 *
 * @param {unknown} type
 * @returns {'movie'|'series'|null}
 */
export function normalizeMediaType(type) {
	const value = String(type ?? '').trim().toLowerCase();
	if (!value) return null;
	if (MOVIE_TYPES.includes(value)) return 'movie';
	if (SERIES_TYPES.includes(value)) return 'series';
	return null;
}

/* ---------------------------------------------------------------------- *
 * Clientes HTTP (TMDB / Kitsu)
 * ---------------------------------------------------------------------- */

/**
 * Crea el cliente de TMDB. Soporta API key v3 (`api_key`) o token v4 (Bearer).
 *
 * @param {Object} [options]
 * @param {string} [options.apiKey]        Por defecto `TMDB_API_KEY`.
 * @param {string} [options.accessToken]   Por defecto `TMDB_ACCESS_TOKEN`.
 * @param {string} [options.language]      Idioma base (por defecto `es-MX`).
 * @param {Console} [options.logger]
 * @returns {Object} Cliente con `enabled`, `findByImdb()` y `getDetails()`.
 */
export function createTmdbClient(options = {}) {
	const apiKey = options.apiKey ?? process.env.TMDB_API_KEY ?? null;
	const accessToken = options.accessToken ?? process.env.TMDB_ACCESS_TOKEN ?? null;
	const language = options.language ?? process.env.TMDB_LANGUAGE ?? 'es-MX';
	const enabled = Boolean(apiKey || accessToken);

	const http = new BaseScraper(
		{
			id: 'tmdb',
			name: 'TMDB',
			category: 'metadata',
			baseUrl: options.baseUrl ?? TMDB_BASE_URL,
			mirrors: [options.baseUrl ?? TMDB_BASE_URL],
			headers: { Accept: 'application/json' }
		},
		{ logger: options.logger ?? console }
	);

	/**
	 * @param {string} path
	 * @param {Record<string, any>} params
	 * @param {AbortSignal} [signal]
	 * @returns {Promise<any | null>}
	 */
	async function request(path, params, signal) {
		if (!enabled) return null;

		const authParams = accessToken ? {} : { api_key: apiKey };
		const authHeaders = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};

		return http.get(path, {
			params: { ...authParams, ...params },
			headers: authHeaders,
			signal
		});
	}

	return {
		name: 'tmdb',
		enabled,
		language,

		/**
		 * Traduce un IMDb id a TMDB (`/find`). Prefiere el tipo indicado.
		 *
		 * @param {string} imdbId
		 * @param {{ signal?: AbortSignal, type?: 'movie'|'series'|null }} [opts]
		 * @returns {Promise<{ tmdbId: string, mediaType: 'movie'|'tv' } | null>}
		 */
		async findByImdb(imdbId, { signal, type } = {}) {
			const data = await request(
				`find/${encodeURIComponent(imdbId)}`,
				{ external_source: 'imdb_id' },
				signal
			);
			if (!data) return null;

			const movie = firstOf(data.movie_results);
			const tv = firstOf(data.tv_results);
			const ordered = type === 'series' ? [tv, movie] : [movie, tv];
			const found = ordered.find(Boolean);

			if (!found) return null;

			return {
				tmdbId: String(found.id),
				mediaType: found === tv ? 'tv' : 'movie'
			};
		},

		/**
		 * Detalles de una película o serie, con traducciones y títulos alternativos.
		 *
		 * @param {'movie'|'tv'} mediaType
		 * @param {string} tmdbId
		 * @param {{ signal?: AbortSignal, language?: string }} [opts]
		 * @returns {Promise<any | null>}
		 */
		async getDetails(mediaType, tmdbId, { signal, language: lang } = {}) {
			const path = `${mediaType === 'tv' ? 'tv' : 'movie'}/${encodeURIComponent(tmdbId)}`;
			return request(
				path,
				{
					language: lang ?? language,
					append_to_response: 'translations,alternative_titles'
				},
				signal
			);
		}
	};
}

/**
 * Crea el cliente de Kitsu (API JSON:API, sin credenciales).
 *
 * @param {Object} [options]
 * @param {string} [options.baseUrl]
 * @param {Console} [options.logger]
 * @returns {Object} Cliente con `getAnime()`.
 */
export function createKitsuClient(options = {}) {
	const baseUrl = options.baseUrl ?? process.env.KITSU_BASE_URL ?? KITSU_BASE_URL;

	const http = new BaseScraper(
		{
			id: 'kitsu',
			name: 'Kitsu',
			category: 'metadata',
			baseUrl,
			mirrors: [baseUrl],
			headers: { Accept: 'application/vnd.api+json' }
		},
		{ logger: options.logger ?? console }
	);

	return {
		name: 'kitsu',
		enabled: true,

		/**
		 * Atributos de un anime de Kitsu.
		 *
		 * @param {string} kitsuId
		 * @param {{ signal?: AbortSignal }} [opts]
		 * @returns {Promise<any | null>}
		 */
		async getAnime(kitsuId, { signal } = {}) {
			const data = await http.get(`anime/${encodeURIComponent(kitsuId)}`, { signal });
			return data?.data?.attributes ?? null;
		}
	};
}

/* ---------------------------------------------------------------------- *
 * Extracción de variantes de título
 * ---------------------------------------------------------------------- */

/**
 * Extrae las variantes de título de una respuesta de TMDB.
 *
 * @param {any} data Respuesta de `/movie/{id}` o `/tv/{id}`.
 * @param {'movie'|'tv'} mediaType
 * @param {string} [language='es-MX'] Idioma base solicitado.
 * @returns {{ titles: ReturnType<typeof emptyTitles>, alternatives: string[] }}
 */
export function extractTmdbTitles(data, mediaType, language = 'es-MX') {
	if (!data) return { titles: emptyTitles(), alternatives: [] };

	const isTv = mediaType === 'tv';
	const base = cleanText(isTv ? data.name : data.title);
	const original = cleanText(isTv ? data.original_name : data.original_title);
	const translations = Array.isArray(data.translations?.translations)
		? data.translations.translations
		: [];

	/** @param {string} lang @param {string} [region] */
	const translationFor = (lang, region) =>
		translations.find(
			(entry) =>
				entry?.iso_639_1 === lang && (region ? entry?.iso_3166_1 === region : true)
		);

	/** @param {any} entry */
	const translationName = (entry) => cleanText(entry?.data?.title ?? entry?.data?.name);

	const spanishMx = translationName(translationFor('es', 'MX'));
	const spanishEs = translationName(translationFor('es', 'ES'));
	const spanishAny = spanishMx || spanishEs || translationName(translationFor('es'));

	const english =
		translationName(translationFor('en', 'US')) ||
		translationName(translationFor('en', 'GB')) ||
		translationName(translationFor('en')) ||
		(data.original_language === 'en' ? original : null);

	// Pedimos `language=es-MX`: si TMDB devolvió algo distinto del título original,
	// es la mejor aproximación disponible al título en español.
	const localized = String(language).toLowerCase().startsWith('es')
		? base && normalizeTitle(base) !== normalizeTitle(original)
			? base
			: null
		: null;

	const esLatam = spanishMx ?? localized ?? spanishAny ?? null;
	const esSpain = spanishEs ?? null;
	const es = spanishMx ?? spanishEs ?? spanishAny ?? localized ?? null;

	const alternativeTitles =
		data.alternative_titles?.titles ?? data.alternative_titles?.results ?? [];
	const alternatives = uniqueTitles(alternativeTitles.map((entry) => entry?.title));

	const titles = {
		es,
		esLatam,
		esSpain,
		original: original ?? base ?? null,
		english: english ?? null,
		romaji: null
	};

	return { titles, alternatives: excludeTitles(alternatives, titles) };
}

/**
 * Extrae las variantes de título de los atributos de un anime de Kitsu.
 *
 * @param {any} attributes
 * @returns {{ titles: ReturnType<typeof emptyTitles>, alternatives: string[] }}
 */
export function extractKitsuTitles(attributes) {
	if (!attributes) return { titles: emptyTitles(), alternatives: [] };

	const map = attributes.titles && typeof attributes.titles === 'object' ? attributes.titles : {};
	const canonical = cleanText(attributes.canonicalTitle);

	const original = cleanText(map.ja_jp) ?? cleanText(map.ja) ?? canonical ?? null;
	const english =
		cleanText(map.en) ??
		cleanText(map.en_us) ??
		cleanText(map.en_jp) ??
		(isAsciiText(canonical) && canonical !== original ? canonical : null);

	// El romaji (canonicalTitle, p. ej. "Shingeki no Kyojin") suele funcionar mejor
	// que el título japonés al buscar en fuentes de anime.
	const romaji =
		isAsciiText(canonical) &&
		normalizeTitle(canonical) !== normalizeTitle(original) &&
		normalizeTitle(canonical) !== normalizeTitle(english)
			? canonical
			: null;

	const spanish =
		cleanText(map.es) ?? cleanText(map.es_es) ?? cleanText(map.es_mx) ?? null;

	const alternatives = Array.isArray(attributes.abbreviatedTitles)
		? attributes.abbreviatedTitles.map(cleanText)
		: [];

	const titles = {
		es: spanish,
		esLatam: spanish,
		esSpain: null,
		original,
		english: english ?? null,
		romaji
	};

	return { titles, alternatives: excludeTitles(uniqueTitles(alternatives), titles) };
}

/**
 * Tipo de contenido a partir del subtipo de Kitsu.
 *
 * @param {any} attributes
 * @returns {'movie'|'series'|null}
 */
export function kitsuMediaType(attributes) {
	const subtype = String(attributes?.subtype ?? '').toLowerCase();
	if (!subtype) return null;
	return subtype === 'movie' ? 'movie' : 'series';
}

/* ---------------------------------------------------------------------- *
 * Servicio
 * ---------------------------------------------------------------------- */

export class TitleResolver {
	/**
	 * @param {Object} [options]
	 * @param {'movie'|'series'|'tv'} [options.type] Tipo por defecto para `resolve()`.
	 * @param {string} [options.language] Idioma base de TMDB (por defecto `es-MX`).
	 * @param {number} [options.timeoutMs] Presupuesto total por resolución.
	 * @param {number} [options.cacheTtlMs]
	 * @param {number} [options.cacheMaxEntries]
	 * @param {Console} [options.logger]
	 * @param {{ tmdb?: object, kitsu?: object }} [options.clients] Inyección para tests.
	 */
	constructor(options = {}) {
		this.logger = options.logger ?? console;
		this.language = options.language ?? process.env.TMDB_LANGUAGE ?? 'es-MX';
		this.defaultType = normalizeMediaType(options.type);
		this.timeoutMs = positiveNumber(options.timeoutMs ?? process.env.RESOLVER_TIMEOUT_MS, DEFAULT_RESOLVE_TIMEOUT_MS);
		this.cacheTtlMs = positiveNumber(options.cacheTtlMs ?? process.env.RESOLVER_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS);
		this.cacheMaxEntries = positiveNumber(options.cacheMaxEntries ?? process.env.RESOLVER_CACHE_MAX_ENTRIES, DEFAULT_CACHE_MAX_ENTRIES);

		this.clients = {
			tmdb: options.clients?.tmdb ?? createTmdbClient({ logger: this.logger, language: this.language }),
			kitsu: options.clients?.kitsu ?? createKitsuClient({ logger: this.logger })
		};

		/** @type {Map<string, { result: any, expiresAt: number }>} */
		this.cache = new Map();
	}

	/**
	 * Resuelve un ID de Stremio a sus variantes de título.
	 *
	 * @param {string} stremioId
	 * @param {Object} [options]
	 * @param {'movie'|'series'|'tv'} [options.type] Tipo de contenido (pista).
	 * @param {boolean} [options.cache=true] Usar/guardar en caché.
	 * @returns {Promise<any>} Resultado normalizado; nunca lanza.
	 */
	async resolve(stremioId, options = {}) {
		const parsed = parseStremioId(stremioId);
		const type = normalizeMediaType(options.type) ?? this.defaultType;
		const cacheKey = `${parsed.provider}:${parsed.providerId}:${type ?? 'any'}:${this.language}`;

		if (options.cache !== false) {
			const cached = this.readCache(cacheKey);
			if (cached) return cached;
		}

		if (parsed.provider === 'unknown') {
			this.warn(`ID no reconocido: "${parsed.raw}"`);
			return this.failure(parsed, type, `ID de Stremio no reconocido: "${parsed.raw}"`);
		}

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		timer.unref?.();

		try {
			let result;
			if (parsed.provider === 'imdb') {
				result = await this.resolveFromImdb(parsed, type, controller.signal);
			} else if (parsed.provider === 'tmdb') {
				result = await this.resolveFromTmdb(parsed, type, controller.signal);
			} else {
				result = await this.resolveFromKitsu(parsed, type, controller.signal);
			}

			if (result.ok && options.cache !== false) {
				this.writeCache(cacheKey, result);
			}

			return result;
		} catch (error) {
			this.warn(`fallo resolviendo "${parsed.raw}": ${error?.message ?? error}`);
			return this.failure(parsed, type, `Error inesperado al resolver el título: ${error?.message ?? error}`);
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * IMDb -> TMDB -> variantes de título.
	 *
	 * @param {ParsedStremioId} parsed
	 * @param {'movie'|'series'|null} type
	 * @param {AbortSignal} signal
	 * @returns {Promise<any>}
	 */
	async resolveFromImdb(parsed, type, signal) {
		const ids = { imdb: parsed.providerId };

		if (!this.clients.tmdb.enabled) {
			return this.failure(
				parsed,
				type,
				'TMDB_API_KEY o TMDB_ACCESS_TOKEN no configurada: no se pueden resolver títulos para IDs IMDb.',
				{ ids, source: 'tmdb' }
			);
		}

		const match = await this.clients.tmdb.findByImdb(parsed.providerId, { signal, type });
		if (!match) {
			return this.failure(parsed, type, `IMDb ${parsed.providerId} sin coincidencia en TMDB.`, {
				ids,
				source: 'tmdb'
			});
		}

		const data = await this.clients.tmdb.getDetails(match.mediaType, match.tmdbId, {
			signal,
			language: this.language
		});
		if (!data) {
			return this.failure(parsed, type, `TMDB no devolvió detalles para ${match.tmdbId}.`, {
				ids: { ...ids, tmdb: match.tmdbId },
				source: 'tmdb'
			});
		}

		const { titles, alternatives } = extractTmdbTitles(data, match.mediaType, this.language);

		return buildResult({
			parsed,
			mediaType: match.mediaType === 'tv' ? 'series' : 'movie',
			source: 'tmdb',
			ids: { ...ids, tmdb: match.tmdbId },
			titles,
			alternatives
		});
	}

	/**
	 * TMDB id -> variantes de título. Si el tipo es ambiguo, prueba película y
	 * luego serie (o al revés según la pista recibida).
	 *
	 * @param {ParsedStremioId} parsed
	 * @param {'movie'|'series'|null} type
	 * @param {AbortSignal} signal
	 * @returns {Promise<any>}
	 */
	async resolveFromTmdb(parsed, type, signal) {
		const ids = { tmdb: parsed.providerId };

		if (!this.clients.tmdb.enabled) {
			return this.failure(parsed, type, 'TMDB_API_KEY o TMDB_ACCESS_TOKEN no configurada.', {
				ids,
				source: 'tmdb'
			});
		}

		const primary = type === 'series' ? 'tv' : 'movie';
		const secondary = primary === 'movie' ? 'tv' : 'movie';

		let mediaType = primary;
		let data = await this.clients.tmdb.getDetails(primary, parsed.providerId, {
			signal,
			language: this.language
		});

		if (!data && !signal.aborted) {
			mediaType = secondary;
			data = await this.clients.tmdb.getDetails(secondary, parsed.providerId, {
				signal,
				language: this.language
			});
		}

		if (!data) {
			return this.failure(parsed, type, `TMDB no devolvió datos para el id ${parsed.providerId}.`, {
				ids,
				source: 'tmdb'
			});
		}

		const { titles, alternatives } = extractTmdbTitles(data, mediaType, this.language);

		return buildResult({
			parsed,
			mediaType: mediaType === 'tv' ? 'series' : 'movie',
			source: 'tmdb',
			ids,
			titles,
			alternatives
		});
	}

	/**
	 * Kitsu id -> variantes de título.
	 *
	 * @param {ParsedStremioId} parsed
	 * @param {'movie'|'series'|null} type
	 * @param {AbortSignal} signal
	 * @returns {Promise<any>}
	 */
	async resolveFromKitsu(parsed, type, signal) {
		const ids = { kitsu: parsed.providerId };

		const attributes = await this.clients.kitsu.getAnime(parsed.providerId, { signal });
		if (!attributes) {
			return this.failure(parsed, type, `Kitsu no devolvió datos para el id ${parsed.providerId}.`, {
				ids,
				source: 'kitsu'
			});
		}

		const { titles, alternatives } = extractKitsuTitles(attributes);
		const mediaType = kitsuMediaType(attributes) ?? type;

		return buildResult({
			parsed,
			mediaType,
			source: 'kitsu',
			ids,
			titles,
			alternatives
		});
	}

	/**
	 * Resultado de fallo (nunca lanza).
	 *
	 * @param {ParsedStremioId} parsed
	 * @param {'movie'|'series'|null} type
	 * @param {string} error
	 * @param {{ ids?: object, source?: string|null }} [extra]
	 * @returns {any}
	 */
	failure(parsed, type, error, { ids = {}, source = null } = {}) {
		return buildResult({ parsed, mediaType: type, source, ids, error });
	}

	/**
	 * Lee una entrada vigente de la caché y devuelve una copia defensiva.
	 *
	 * @param {string} key
	 * @returns {any | null}
	 */
	readCache(key) {
		const entry = this.cache.get(key);
		if (!entry) return null;

		if (entry.expiresAt <= Date.now()) {
			this.cache.delete(key);
			return null;
		}

		return cloneResult(entry.result, true);
	}

	/**
	 * Guarda un resultado en la caché con TTL, podando la entrada más antigua
	 * cuando se alcanza el máximo.
	 *
	 * @param {string} key
	 * @param {any} result
	 */
	writeCache(key, result) {
		if (this.cache.size >= this.cacheMaxEntries) {
			const oldestKey = this.cache.keys().next().value;
			if (oldestKey !== undefined) this.cache.delete(oldestKey);
		}

		this.cache.set(key, { result, expiresAt: Date.now() + this.cacheTtlMs });
	}

	/**
	 * Vacía la caché en memoria.
	 *
	 * @returns {number} Entradas eliminadas.
	 */
	clearCache() {
		const size = this.cache.size;
		this.cache.clear();
		return size;
	}

	/** @param {string} message */
	warn(message) {
		this.logger?.warn?.(`[resolver] ${message}`);
	}
}

/* ---------------------------------------------------------------------- *
 * Utilidades internas
 * ---------------------------------------------------------------------- */

/**
 * Construye el objeto de resultado normalizado.
 *
 * @param {Object} params
 * @param {ParsedStremioId} params.parsed
 * @param {'movie'|'series'|null} params.mediaType
 * @param {string|null} [params.source]
 * @param {{ imdb?: string|null, tmdb?: string|null, kitsu?: string|null }} [params.ids]
 * @param {ReturnType<typeof emptyTitles>} [params.titles]
 * @param {string[]} [params.alternatives]
 * @param {string|null} [params.error]
 * @returns {any}
 */
function buildResult({
	parsed,
	mediaType,
	source = null,
	ids = {},
	titles = emptyTitles(),
	alternatives = [],
	error = null
}) {
	const normalizedTitles = {
		es: cleanText(titles.es),
		esLatam: cleanText(titles.esLatam),
		esSpain: cleanText(titles.esSpain),
		original: cleanText(titles.original),
		english: cleanText(titles.english),
		romaji: cleanText(titles.romaji)
	};

	// Orden de cascada: primero lo más probable para una fuente en español y,
	// tras los títulos en español, el romaji (más buscable que el japonés).
	const searchTitles = uniqueTitles([
		normalizedTitles.esLatam,
		normalizedTitles.es,
		normalizedTitles.esSpain,
		normalizedTitles.romaji,
		normalizedTitles.original,
		normalizedTitles.english,
		...alternatives
	]);

	const titleSlugs = uniqueTitles(searchTitles.map((title) => slugify(title)));

	return {
		ok: searchTitles.length > 0,
		stremioId: parsed.raw,
		provider: parsed.provider,
		providerId: parsed.providerId,
		mediaType,
		season: parsed.season,
		episode: parsed.episode,
		ids: {
			imdb: cleanText(ids.imdb),
			tmdb: ids.tmdb != null ? String(ids.tmdb) : null,
			kitsu: ids.kitsu != null ? String(ids.kitsu) : null
		},
		titles: normalizedTitles,
		alternatives: excludeTitles(uniqueTitles(alternatives), normalizedTitles),
		searchTitles,
		titleSlugs,
		source,
		error,
		cached: false
	};
}

/** @returns {{ es: null, esLatam: null, esSpain: null, original: null, english: null, romaji: null }} */
function emptyTitles() {
	return { es: null, esLatam: null, esSpain: null, original: null, english: null, romaji: null };
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function cleanText(value) {
	if (typeof value !== 'string') return null;
	const text = value.replace(/\s+/g, ' ').trim();
	return text.length > 0 ? text : null;
}

/**
 * Deduplica títulos conservando el orden y la caja originales.
 *
 * @param {Array<string | null | undefined>} values
 * @returns {string[]}
 */
function uniqueTitles(values) {
	const seen = new Set();
	const output = [];

	for (const value of values) {
		const title = cleanText(value);
		if (!title) continue;

		const key = normalizeTitle(title) || title.toLowerCase();
		if (seen.has(key)) continue;

		seen.add(key);
		output.push(title);
	}

	return output;
}

/**
 * Quita de `candidates` los títulos que ya están en `titles`.
 *
 * @param {string[]} candidates
 * @param {ReturnType<typeof emptyTitles>} titles
 * @returns {string[]}
 */
function excludeTitles(candidates, titles) {
	const main = new Set(
		Object.values(titles)
			.filter(Boolean)
			.map((title) => normalizeTitle(title) || String(title).toLowerCase())
	);

	return candidates.filter((title) => !main.has(normalizeTitle(title) || title.toLowerCase()));
}

/**
 * Copia defensiva para no exponer la referencia guardada en caché.
 *
 * @param {any} result
 * @param {boolean} [cached=false]
 * @returns {any}
 */
function cloneResult(result, cached = false) {
	return {
		...result,
		ids: { ...result.ids },
		titles: { ...result.titles },
		alternatives: [...result.alternatives],
		searchTitles: [...result.searchTitles],
		titleSlugs: [...result.titleSlugs],
		cached
	};
}

/**
 * @param {any} list
 * @returns {any | null}
 */
function firstOf(list) {
	return Array.isArray(list) && list.length > 0 ? list[0] : null;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function toInt(value) {
	if (value === undefined || value === null) return null;
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveNumber(value, fallback) {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? number : fallback;
}

/** Instancia compartida (lazy: los clientes no hacen red hasta `resolve()`). */
export const resolver = new TitleResolver();

/**
 * Atajo sobre la instancia compartida.
 *
 * @param {string} stremioId
 * @param {Parameters<TitleResolver['resolve']>[1]} [options]
 * @returns {Promise<any>}
 */
export function resolveTitle(stremioId, options) {
	return resolver.resolve(stremioId, options);
}

/**
 * Crea una nueva instancia (útil para tests o configuración por despliegue).
 *
 * @param {ConstructorParameters<typeof TitleResolver>[0]} [options]
 * @returns {TitleResolver}
 */
export function createResolver(options) {
	return new TitleResolver(options);
}

export default TitleResolver;
