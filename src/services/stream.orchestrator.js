/**
 * Orquestador principal de streams.
 *
 * Flujo de una petición de Stremio (`{ type, id }`):
 *   1. Resuelve el título con `resolver.service.js` (variantes es/original/inglés).
 *   2. Selecciona los scrapers activos (Películas, Anime, Doramas, Telenovelas,
 *      Caricaturas) compatibles con el tipo solicitado.
 *   3. Los ejecuta EN PARALELO con `Promise.allSettled`, cada uno con su propio
 *      timeout y `AbortSignal`.
 *   4. Normaliza, limpia y deduplica los enlaces (URL, infoHash, externalUrl…).
 *   5. Devuelve SIEMPRE `{ streams: [...] }` (vacío si nada sirve) para que
 *      Stremio reciba un HTTP 200 válido y nunca muestre errores de conexión.
 *
 * Un scraper que lanza, tarda de más o devuelve basura no afecta al resto: se
 * registra la advertencia, se marca en `/health` y se continúa.
 *
 * Variables de entorno:
 *   SCRAPER_TIMEOUT_MS           Timeout por scraper (7000 ms).
 *   STREAM_RESOLVE_TIMEOUT_MS    Timeout del resolvedor de títulos (9000 ms).
 *   STREAM_MAX_RESULTS           Máximo de streams devueltos (50).
 *   STREAM_SORT_BY_QUALITY       `false` desactiva el orden por calidad.
 *
 * @example
 * import { createStreamOrchestrator } from './stream.orchestrator.js';
 * import { getActiveScrapers } from '../scrapers/registry.js';
 *
 * const orchestrator = createStreamOrchestrator({ scrapers: getActiveScrapers() });
 * const { streams } = await orchestrator.getStreams({ type: 'series', id: 'tt0903747:1:1' });
 */

import {
	getActiveScrapers,
	normalizeCategories,
	normalizeContentTypes
} from '../scrapers/registry.js';
import { normalizeMediaType, resolver as sharedResolver } from './resolver.service.js';

/** Timeout por defecto de cada scraper (ms). */
export const DEFAULT_SCRAPER_TIMEOUT_MS = 7000;

/** Timeout por defecto para resolver títulos (ms). */
export const DEFAULT_RESOLVE_TIMEOUT_MS = 9000;

/** Número máximo de streams devueltos a Stremio. */
export const DEFAULT_MAX_STREAMS = 50;

/** Parámetros de seguimiento que no afectan al recurso apuntado por una URL. */
const TRACKING_PARAMS = new Set([
	'utm_source',
	'utm_medium',
	'utm_campaign',
	'utm_term',
	'utm_content',
	'utm_id',
	'fbclid',
	'gclid',
	'dclid',
	'msclkid',
	'yclid',
	'igshid',
	'mc_cid',
	'mc_eid',
	'ref',
	'ref_src',
	'_ga',
	'_gl'
]);

export class StreamOrchestrator {
	/**
	 * @param {Object} [options]
	 * @param {Array<object> | (() => Array<object>)} [options.scrapers] Scrapers o descriptores. Por defecto, el registro.
	 * @param {object} [options.resolver] Resolvedor de títulos (inyectable en tests).
	 * @param {number} [options.scraperTimeoutMs]
	 * @param {number} [options.resolveTimeoutMs]
	 * @param {number} [options.maxStreams]
	 * @param {boolean} [options.sortByQuality]
	 * @param {Pick<Console, 'info' | 'warn' | 'debug' | 'error'>} [options.logger]
	 */
	constructor(options = {}) {
		this.logger = options.logger ?? console;
		this.resolver = options.resolver ?? sharedResolver;

		this.scraperTimeoutMs = toPositiveNumber(
			options.scraperTimeoutMs ?? process.env.SCRAPER_TIMEOUT_MS,
			DEFAULT_SCRAPER_TIMEOUT_MS
		);
		this.resolveTimeoutMs = toPositiveNumber(
			options.resolveTimeoutMs ?? process.env.STREAM_RESOLVE_TIMEOUT_MS,
			DEFAULT_RESOLVE_TIMEOUT_MS
		);
		this.maxStreams = Math.floor(
			toPositiveNumber(options.maxStreams ?? process.env.STREAM_MAX_RESULTS, DEFAULT_MAX_STREAMS)
		);
		this.sortByQuality =
			options.sortByQuality ?? process.env.STREAM_SORT_BY_QUALITY !== 'false';

		/** @type {Map<string, any>} Estado de la última ejecución por scraper. */
		this.state = new Map();

		/** Contadores acumulados (expuestos en `/health`). */
		this.stats = {
			requests: 0,
			streams: 0,
			duplicates: 0,
			scraperRuns: 0,
			scraperFailures: 0,
			timeouts: 0,
			lastRunMs: 0
		};

		const providedScrapers =
			typeof options.scrapers === 'function' ? options.scrapers() : options.scrapers;

		this.scrapers = normalizeScraperEntries(
			Array.isArray(providedScrapers) ? providedScrapers : getActiveScrapers(),
			(message) => this.warn(message)
		);
	}

	/**
	 * Obtiene los streams de una petición de Stremio.
	 *
	 * Nunca lanza: cualquier fallo se traduce en `{ streams: [] }`.
	 *
	 * @param {{ type: string, id: string, extra?: object, signal?: AbortSignal, categories?: string[] } | string} request
	 *   Objeto de petición (o `type` si se usa la firma posicional).
	 * @param {string} [id] Solo si `request` es el tipo.
	 * @returns {Promise<{ streams: object[] }>}
	 */
	async getStreams(request, id) {
		const startedAt = Date.now();
		this.stats.requests += 1;

		try {
			const normalizedRequest = normalizeRequest(request, id);
			if (!normalizedRequest) {
				this.warn('petición de streams inválida; se responde vacío.');
				return emptyStreams();
			}

			const mediaType = normalizeMediaType(normalizedRequest.type);
			if (!mediaType) {
				this.warn(`tipo de contenido no soportado ("${normalizedRequest.type}"); se responde vacío.`);
				return emptyStreams();
			}

			if (!normalizedRequest.id) {
				this.warn('petición de streams sin id; se responde vacío.');
				return emptyStreams();
			}

			const scrapers = this.selectScrapers(mediaType, normalizedRequest.categories);
			// Sin scrapers no hay nada que resolver: respuesta vacía inmediata.
			if (scrapers.length === 0) return emptyStreams();

			const resolution = await this.resolveTitles(normalizedRequest.id, mediaType);
			const context = buildScraperContext(normalizedRequest, resolution, mediaType);

			const starts = [];
			const tasks = scrapers.map((entry) => {
				starts.push(Date.now());
				return this.runScraper(entry, context, normalizedRequest.signal);
			});

			// Aislamiento total: una promesa rechazada no cancela al resto.
			const outcomes = await Promise.allSettled(tasks);

			const collected = [];
			let succeeded = 0;

			outcomes.forEach((outcome, index) => {
				const entry = scrapers[index];
				const durationMs = Date.now() - starts[index];
				this.stats.scraperRuns += 1;

				if (outcome.status === 'rejected') {
					const timedOut = outcome.reason?.code === 'SCRAPER_TIMEOUT';
					this.stats.scraperFailures += 1;
					if (timedOut) this.stats.timeouts += 1;

					this.recordState(entry, {
						status: timedOut ? 'timeout' : 'error',
						streams: 0,
						durationMs,
						error: describeError(outcome.reason)
					});

					this.warn(
						`scraper "${entry.id}" ${timedOut ? 'agotó su tiempo' : 'falló'} tras ${durationMs} ms (${describeError(outcome.reason)}). Se continúa con el resto.`
					);
					return;
				}

				succeeded += 1;
				const streams = sanitizeScraperResult(outcome.value, entry, (message) =>
					this.warn(`scraper "${entry.id}": ${message}`)
				);

				this.recordState(entry, {
					status: 'ok',
					streams: streams.length,
					durationMs,
					error: null
				});

				collected.push(...streams);
			});

			const { streams: uniqueStreams, duplicates } = dedupeStreams(collected);
			const ordered = this.sortStreams(uniqueStreams);
			const streams = ordered.slice(0, this.maxStreams);

			this.stats.streams += streams.length;
			this.stats.duplicates += duplicates;
			this.stats.lastRunMs = Date.now() - startedAt;

			this.info(
				`${normalizedRequest.type}/${normalizedRequest.id}: ${succeeded}/${scrapers.length} scrapers, ` +
					`${streams.length} streams, ${duplicates} duplicados, ${this.stats.lastRunMs} ms`
			);

			return { streams };
		} catch (error) {
			this.warn(
				`error inesperado orquestando streams (${describeError(error)}). Se responde con streams vacíos.`
			);
			return emptyStreams();
		}
	}

	/**
	 * Resuelve los títulos de la petición. Un fallo aquí no impide scrapear.
	 *
	 * @param {string} id
	 * @param {'movie'|'series'} mediaType
	 * @returns {Promise<any | null>}
	 */
	async resolveTitles(id, mediaType) {
		try {
			return await withTimeout(
				this.resolver.resolve(id, { type: mediaType }),
				this.resolveTimeoutMs,
				() => timeoutError(`El resolvedor de títulos excedió ${this.resolveTimeoutMs} ms.`, 'RESOLVER_TIMEOUT')
			);
		} catch (error) {
			this.warn(
				`no se pudieron resolver títulos para "${id}" (${describeError(error)}). Se continúa sin variantes.`
			);
			return null;
		}
	}

	/**
	 * Scrapers activos compatibles con el tipo y, opcionalmente, la categoría.
	 *
	 * @param {'movie'|'series'} mediaType
	 * @param {string[]} [categories]
	 * @returns {object[]}
	 */
	selectScrapers(mediaType, categories) {
		const categoryFilter = normalizeCategories(categories);

		return this.scrapers.filter((entry) => {
			if (entry.enabled === false) return false;

			const typeOk =
				entry.contentTypes.length === 0 || entry.contentTypes.includes(mediaType);
			if (!typeOk) return false;

			const categoryOk =
				categoryFilter.length === 0 ||
				entry.categories.length === 0 ||
				entry.categories.some((category) => categoryFilter.includes(category));

			return categoryOk;
		});
	}

	/**
	 * Ejecuta un scraper con timeout propio y sin propagar nunca su error al
	 * flujo general (el rechazo lo absorbe `Promise.allSettled`).
	 *
	 * @param {any} entry
	 * @param {object} baseContext
	 * @param {AbortSignal} [externalSignal]
	 * @returns {Promise<any>}
	 */
	runScraper(entry, baseContext, externalSignal) {
		const timeoutMs = entry.timeoutMs ?? this.scraperTimeoutMs;
		const controller = new AbortController();
		const context = {
			...baseContext,
			signal: controller.signal,
			timeoutMs
		};

		const invocation = Promise.resolve().then(() => {
			const instance = entry.instance;

			if (typeof instance.scrape === 'function') return instance.scrape(context);
			if (typeof instance.getStreams === 'function') return instance.getStreams(context);
			if (typeof instance.safeScrape === 'function') return instance.safeScrape(context);

			throw new TypeError(`El scraper "${entry.id}" no implementa scrape() ni getStreams().`);
		});

		return new Promise((resolve, reject) => {
			let finished = false;
			let timer;

			const cleanup = () => {
				clearTimeout(timer);
				externalSignal?.removeEventListener?.('abort', onExternalAbort);
			};

			const finish = (settle, value) => {
				if (finished) return;
				finished = true;
				cleanup();
				settle(value);
			};

			const onExternalAbort = () => {
				controller.abort();
				finish(reject, timeoutError('La petición de streams fue cancelada.', 'ABORT_ERR'));
			};

			timer = setTimeout(() => {
				controller.abort();
				finish(
					reject,
					timeoutError(`El scraper "${entry.id}" excedió ${timeoutMs} ms.`, 'SCRAPER_TIMEOUT')
				);
			}, timeoutMs);
			timer.unref?.();

			if (externalSignal) {
				if (externalSignal.aborted) {
					onExternalAbort();
					return;
				}
				externalSignal.addEventListener('abort', onExternalAbort, { once: true });
			}

			// `invocation` siempre tiene manejadores: si llega tarde tras el timeout,
			// su rechazo queda absorbido aquí (sin unhandledRejection).
			invocation.then(
				(value) => finish(resolve, value),
				(error) => finish(reject, error)
			);
		});
	}

	/**
	 * Ordena por calidad (4K > 1080p > 720p > 480p > CAM) manteniendo estable
	 * el orden original entre streams de la misma calidad.
	 *
	 * @param {object[]} streams
	 * @returns {object[]}
	 */
	sortStreams(streams) {
		if (!this.sortByQuality) return streams;

		return streams
			.map((stream, index) => ({ stream, index, score: qualityScore(stream) }))
			.sort((a, b) => b.score - a.score || a.index - b.index)
			.map((item) => item.stream);
	}

	/**
	 * Estado de scrapers y contadores para `/health`.
	 *
	 * @returns {object}
	 */
	health() {
		return {
			scrapers: this.scrapers.map((entry) => ({
				id: entry.id,
				name: entry.name,
				categories: entry.categories,
				contentTypes: entry.contentTypes,
				priority: entry.priority,
				enabled: entry.enabled,
				...(this.state.get(entry.id) ?? { status: 'idle' })
			})),
			stats: { ...this.stats },
			maxStreams: this.maxStreams,
			scraperTimeoutMs: this.scraperTimeoutMs
		};
	}

	/**
	 * Middleware Express que SIEMPRE responde 200 con `{ streams }`.
	 * Pensado para montarse directamente en `/stream/:type/:id.json`.
	 *
	 * @returns {import('express').RequestHandler}
	 */
	createStreamHandler() {
		return (req, res) => {
			const controller = new AbortController();
			const onClose = () => controller.abort();

			res.once?.('close', onClose);

			const respond = (payload) => {
				if (res.headersSent) return;
				res.status(200).json(payload ?? emptyStreams());
			};

			this.getStreams({
				type: req?.params?.type,
				id: req?.params?.id,
				extra: req?.query ?? {},
				signal: controller.signal
			})
				.then(respond)
				.catch((error) => {
					this.warn(`fallo respondiendo streams: ${describeError(error)}. Se responde vacío.`);
					respond(emptyStreams());
				})
				.finally(() => {
					res.off?.('close', onClose);
				});
		};
	}

	/**
	 * @param {any} entry
	 * @param {object} state
	 */
	recordState(entry, state) {
		this.state.set(entry.id, { ...state, lastRunAt: new Date().toISOString() });
	}

	/** @param {string} message */
	warn(message) {
		this.logger?.warn?.(`[streams] ${message}`);
	}

	/** @param {string} message */
	info(message) {
		this.logger?.info?.(`[streams] ${message}`);
	}

	/** @param {string} message */
	debug(message) {
		this.logger?.debug?.(`[streams] ${message}`);
	}
}

/* ---------------------------------------------------------------------- *
 * Normalización de scrapers y de la petición
 * ---------------------------------------------------------------------- */

/**
 * @param {unknown} input
 * @param {unknown} id
 * @returns {{ type: string, id: string, extra: object, signal?: AbortSignal, categories?: string[] } | null}
 */
function normalizeRequest(input, id) {
	if (typeof input === 'string') {
		return {
			type: input,
			id: id === undefined || id === null ? '' : String(id),
			extra: {}
		};
	}

	if (!input || typeof input !== 'object') return null;

	return {
		type: String(input.type ?? ''),
		id: String(input.id ?? input.stremioId ?? ''),
		extra: input.extra && typeof input.extra === 'object' ? input.extra : {},
		signal: toAbortSignal(input.signal),
		categories: input.categories
	};
}

/**
 * @param {unknown} value
 * @returns {AbortSignal | undefined}
 */
function toAbortSignal(value) {
	return typeof AbortSignal !== 'undefined' && value instanceof AbortSignal ? value : undefined;
}

/**
 * Normaliza descriptores (`{ scraper, ... }`) e instancias sueltas a un mismo
 * formato interno, descartando los que no son ejecutables.
 *
 * @param {Array<object>} inputs
 * @param {(message: string) => void} warn
 * @returns {object[]}
 */
function normalizeScraperEntries(inputs, warn) {
	/** @type {Map<string, object>} */
	const byId = new Map();

	for (const input of inputs) {
		if (!input) continue;

		const instance = input.scraper ?? input.instance ?? input;
		const runnable =
			instance &&
			(typeof instance.scrape === 'function' ||
				typeof instance.getStreams === 'function' ||
				typeof instance.safeScrape === 'function');

		if (!runnable) {
			warn(`se ignora un scraper inválido: ${String(instance?.id ?? instance ?? 'desconocido')}.`);
			continue;
		}

		const id = normalizeScraperId(input.id ?? instance.id ?? instance.name ?? instance.constructor?.name);
		if (!id) {
			warn('se ignora un scraper sin id.');
			continue;
		}

		if (byId.has(id)) {
			warn(`scraper duplicado "${id}"; se conserva el primero.`);
			continue;
		}

		byId.set(id, {
			id,
			name: String(input.name ?? instance.name ?? id).trim() || id,
			categories: normalizeCategories(input.categories ?? instance.categories ?? instance.category),
			contentTypes: normalizeContentTypes(
				input.contentTypes ?? instance.contentTypes ?? instance.contentType
			),
			priority: Number.isFinite(Number(input.priority ?? instance.priority))
				? Number(input.priority ?? instance.priority)
				: 100,
			timeoutMs: toOptionalTimeout(input.timeoutMs ?? instance.timeoutMs),
			enabled: input.enabled !== false && instance.enabled !== false,
			instance
		});
	}

	return [...byId.values()].sort((a, b) => a.priority - b.priority);
}

/**
 * Construye el contexto que recibe cada scraper.
 *
 * @param {object} request
 * @param {any} resolution
 * @param {'movie'|'series'} mediaType
 * @returns {object}
 */
function buildScraperContext(request, resolution, mediaType) {
	const titles = resolution?.titles ?? {
		es: null,
		esLatam: null,
		esSpain: null,
		original: null,
		english: null,
		romaji: null
	};
	const searchTitles = Array.isArray(resolution?.searchTitles) ? resolution.searchTitles : [];

	return {
		type: mediaType,
		id: request.id,
		stremioId: request.id,
		season: resolution?.season ?? null,
		episode: resolution?.episode ?? null,
		provider: resolution?.provider ?? null,
		providerId: resolution?.providerId ?? null,
		ids: resolution?.ids ?? {},
		titles,
		searchTitles,
		titleSlugs: Array.isArray(resolution?.titleSlugs) ? resolution.titleSlugs : [],
		primaryTitle: titles.es ?? titles.esLatam ?? searchTitles[0] ?? null,
		resolved: Boolean(resolution?.ok),
		extra: request.extra ?? {}
	};
}

/* ---------------------------------------------------------------------- *
 * Limpieza y deduplicación de streams
 * ---------------------------------------------------------------------- */

/**
 * Normaliza la salida de un scraper (`[]`, `{ streams: [] }` o basura).
 *
 * @param {unknown} value
 * @param {object} entry
 * @param {(message: string) => void} [warn]
 * @returns {object[]}
 */
export function sanitizeScraperResult(value, entry, warn) {
	const raw = Array.isArray(value)
		? value
		: value && Array.isArray(value.streams)
			? value.streams
			: [];

	const streams = [];
	for (const item of raw) {
		try {
			const stream = sanitizeStream(item, entry);
			if (stream) streams.push(stream);
		} catch (error) {
			warn?.(`stream descartado por formato inválido (${error?.message ?? error}).`);
		}
	}

	return streams;
}

/**
 * Limpia un stream individual y descarta los que no son reproducibles.
 *
 * @param {any} raw
 * @param {{ id?: string, name?: string }} [meta] Scraper de origen.
 * @returns {object | null}
 */
export function sanitizeStream(raw, meta = {}) {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

	const fallbackName = cleanText(meta.name, 160) ?? cleanText(meta.id, 160) ?? 'Stream';

	let url = toHttpUrl(raw.url);
	let externalUrl = toHttpUrl(raw.externalUrl);
	let infoHash = normalizeInfoHash(raw.infoHash);
	let sources = normalizeSources(raw.sources);

	// Un magnet en `url` no es reproducible por Stremio: se convierte a infoHash.
	if (!infoHash && typeof raw.url === 'string' && raw.url.trim().toLowerCase().startsWith('magnet:')) {
		const magnet = parseMagnet(raw.url);
		if (magnet) {
			infoHash = magnet.infoHash;
			if (sources.length === 0) sources = magnet.sources;
			url = null;
		}
	}

	const ytId =
		typeof raw.ytId === 'string' && /^[A-Za-z0-9_-]{6,20}$/.test(raw.ytId.trim())
			? raw.ytId.trim()
			: null;

	if (!url && !infoHash && !externalUrl && !ytId) return null;

	const stream = { name: cleanText(raw.name, 160) ?? fallbackName };

	const title = cleanText(raw.title, 400);
	if (title) stream.title = title;

	const description = cleanText(raw.description, 800);
	if (description) stream.description = description;

	if (url) stream.url = url;
	if (externalUrl) stream.externalUrl = externalUrl;
	if (infoHash) stream.infoHash = infoHash;

	const fileIdx = toNonNegativeInt(raw.fileIdx);
	if (fileIdx !== null) stream.fileIdx = fileIdx;

	if (ytId) stream.ytId = ytId;
	if (sources.length > 0) stream.sources = sources;

	const behaviorHints = normalizeBehaviorHints(raw.behaviorHints);
	if (behaviorHints) stream.behaviorHints = behaviorHints;

	const headers = normalizeHeaders(raw.headers);
	if (headers) stream.headers = headers;

	const subtitles = normalizeSubtitles(raw.subtitles);
	if (subtitles) stream.subtitles = subtitles;

	return stream;
}

/**
 * Elimina duplicados conservando el primer stream de cada enlace.
 *
 * @param {object[]} streams
 * @returns {{ streams: object[], duplicates: number }}
 */
export function dedupeStreams(streams) {
	const seen = new Set();
	const unique = [];
	let duplicates = 0;

	for (const stream of streams) {
		const key = streamKey(stream);

		if (!key) continue;

		if (seen.has(key)) {
			duplicates += 1;
			continue;
		}

		seen.add(key);
		unique.push(stream);
	}

	return { streams: unique, duplicates };
}

/**
 * Clave de unicidad de un stream: torrent (hash + índice de archivo), URL,
 * enlace externo o vídeo de YouTube.
 *
 * @param {any} stream
 * @returns {string | null}
 */
export function streamKey(stream) {
	if (!stream) return null;

	if (stream.infoHash) {
		const fileIdx = Number.isInteger(stream.fileIdx) ? stream.fileIdx : 0;
		return `torrent:${String(stream.infoHash).toLowerCase()}:${fileIdx}`;
	}

	if (stream.url) return `url:${normalizeUrlForKey(stream.url)}`;
	if (stream.externalUrl) return `external:${normalizeUrlForKey(stream.externalUrl)}`;
	if (stream.ytId) return `yt:${stream.ytId}`;

	return null;
}

/**
 * Puntúa la calidad de un stream a partir de su texto (0 = CAM, 4 = 4K).
 *
 * @param {any} stream
 * @returns {number}
 */
export function qualityScore(stream) {
	const text = `${stream?.name ?? ''} ${stream?.title ?? ''} ${stream?.description ?? ''}`.toLowerCase();

	if (/\b(cam|hdcam|hdts|ts|telesync|screener|scr)\b/.test(text)) return 0;
	if (/\b(4k|2160p|uhd)\b/.test(text)) return 4;
	if (/\b(1080p|fhd|fullhd)\b/.test(text)) return 3;
	if (/\b(720p|hd)\b/.test(text)) return 2;
	if (/\b(480p|360p|240p|sd)\b/.test(text)) return 1;

	return 2;
}

/**
 * @returns {{ streams: [] }}
 */
export function emptyStreams() {
	return { streams: [] };
}

/* ---------------------------------------------------------------------- *
 * Utilidades internas
 * ---------------------------------------------------------------------- */

/**
 * Normaliza una URL para comparar (sin hash, sin trackers, parámetros ordenados).
 *
 * @param {string} value
 * @returns {string}
 */
function normalizeUrlForKey(value) {
	try {
		const url = new URL(value);
		url.hash = '';
		url.hostname = url.hostname.toLowerCase();

		for (const key of [...url.searchParams.keys()]) {
			if (TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
		}
		url.searchParams.sort();

		const path = url.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
		return `${url.protocol}//${url.host}${path}${url.search}`;
	} catch {
		return String(value ?? '').trim().toLowerCase();
	}
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function toHttpUrl(value) {
	if (typeof value !== 'string') return null;

	const trimmed = value.trim();
	if (!/^https?:\/\//i.test(trimmed)) return null;

	try {
		const url = new URL(trimmed);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
		return url.toString();
	} catch {
		return null;
	}
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function normalizeInfoHash(value) {
	if (typeof value !== 'string') return null;

	let hash = value.trim();
	const magnetMatch = /urn:btih:([a-z0-9]+)/i.exec(hash);
	if (magnetMatch) hash = magnetMatch[1];

	if (/^[a-f0-9]{40}$/i.test(hash)) return hash.toLowerCase();
	if (/^[a-z2-7]{32}$/i.test(hash)) return hash.toUpperCase();

	return null;
}

/**
 * @param {string} value
 * @returns {{ infoHash: string, sources: string[] } | null}
 */
function parseMagnet(value) {
	try {
		const magnet = new URL(value);
		if (magnet.protocol !== 'magnet:') return null;

		let infoHash = null;
		for (const xt of magnet.searchParams.getAll('xt')) {
			const match = /^urn:btih:([a-z0-9]+)$/i.exec(xt);
			if (!match) continue;
			infoHash = normalizeInfoHash(match[1]);
			if (infoHash) break;
		}

		if (!infoHash) return null;

		const sources = magnet.searchParams
			.getAll('tr')
			.map((tracker) => tracker.trim())
			.filter(Boolean)
			.slice(0, 20);

		return { infoHash, sources };
	} catch {
		return null;
	}
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeSources(value) {
	if (!Array.isArray(value)) return [];

	const sources = value
		.filter((item) => typeof item === 'string')
		.map((item) => item.trim())
		.filter((item) => item.length > 0 && item.length <= 2048);

	return [...new Set(sources)].slice(0, 20);
}

/**
 * @param {unknown} value
 * @returns {object | null}
 */
function normalizeBehaviorHints(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

	const hints = {};

	const bingeGroup = cleanText(value.bingeGroup, 160);
	if (bingeGroup) hints.bingeGroup = bingeGroup;

	if (typeof value.notWebReady === 'boolean') hints.notWebReady = value.notWebReady;

	const filename = cleanText(value.filename, 260);
	if (filename) hints.filename = filename;

	const videoHash = cleanText(value.videoHash, 128);
	if (videoHash) hints.videoHash = videoHash;

	if (Number.isFinite(value.videoSize) && value.videoSize >= 0) {
		hints.videoSize = Number(value.videoSize);
	}

	const whitelist = Array.isArray(value.countryWhitelist)
		? value.countryWhitelist
				.filter((code) => typeof code === 'string' && code.trim().length > 0)
				.map((code) => code.trim().toUpperCase())
				.slice(0, 20)
		: [];

	if (whitelist.length > 0) hints.countryWhitelist = whitelist;

	if (value.proxyHeaders && typeof value.proxyHeaders === 'object') {
		const request = normalizeStringRecord(value.proxyHeaders.request);
		const response = normalizeStringRecord(value.proxyHeaders.response);
		if (request || response) {
			hints.proxyHeaders = {
				...(request ? { request } : {}),
				...(response ? { response } : {})
			};
		}
	}

	return Object.keys(hints).length > 0 ? hints : null;
}

/**
 * @param {unknown} value
 * @returns {Record<string, string> | null}
 */
function normalizeHeaders(value) {
	return normalizeStringRecord(value, 40);
}

/**
 * @param {unknown} value
 * @param {number} [maxKeys=40]
 * @returns {Record<string, string> | null}
 */
function normalizeStringRecord(value, maxKeys = 40) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

	const record = {};
	let count = 0;

	for (const [key, raw] of Object.entries(value)) {
		if (count >= maxKeys) break;
		if (typeof raw !== 'string') continue;

		const header = key.trim();
		if (!header || header.length > 128) continue;

		record[header] = raw.trim().slice(0, 2048);
		count += 1;
	}

	return count > 0 ? record : null;
}

/**
 * @param {unknown} value
 * @returns {object[] | null}
 */
function normalizeSubtitles(value) {
	if (!Array.isArray(value)) return null;

	const subtitles = [];

	for (const item of value.slice(0, 20)) {
		if (!item || typeof item !== 'object') continue;

		const url = toHttpUrl(item.url);
		const lang = cleanText(item.lang, 20);
		if (!url || !lang) continue;

		const subtitle = {
			id: cleanText(item.id, 80) ?? `sub-${subtitles.length}`,
			url,
			lang
		};

		const name = cleanText(item.name, 80);
		if (name) subtitle.name = name;

		subtitles.push(subtitle);
	}

	return subtitles.length > 0 ? subtitles : null;
}

/**
 * @param {unknown} value
 * @param {number} [maxLength=400]
 * @returns {string | null}
 */
function cleanText(value, maxLength = 400) {
	if (typeof value !== 'string') return null;

	const text = value
		.replace(/[\u0000-\u001f\u007f]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

	if (!text) return null;

	return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function toNonNegativeInt(value) {
	if (value === null || value === undefined || value === '') return null;
	const number = Number(value);
	return Number.isInteger(number) && number >= 0 ? number : null;
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function toOptionalTimeout(value) {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? number : undefined;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function toPositiveNumber(value, fallback) {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? number : fallback;
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
 * @param {any} error
 * @returns {string}
 */
function describeError(error) {
	if (!error) return 'error desconocido';

	const parts = [];
	if (error.code) parts.push(String(error.code));
	parts.push(error.message ?? String(error));

	return parts.join(' · ');
}

/**
 * @param {string} message
 * @param {string} code
 * @returns {Error & { code: string }}
 */
function timeoutError(message, code) {
	const error = new Error(message);
	error.code = code;
	return error;
}

/**
 * Carrera entre una promesa y un temporizador. Los manejadores quedan
 * enganchados a la promesa original, así un rechazo tardío no queda suelto.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {() => Error} onTimeout
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, onTimeout) {
	return new Promise((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(onTimeout());
		}, ms);
		timer.unref?.();

		promise.then(
			(value) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(error);
			}
		);
	});
}

/**
 * Crea una instancia del orquestador.
 *
 * @param {ConstructorParameters<typeof StreamOrchestrator>[0]} [options]
 * @returns {StreamOrchestrator}
 */
export function createStreamOrchestrator(options) {
	return new StreamOrchestrator(options);
}

export default StreamOrchestrator;
