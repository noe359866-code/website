/**
 * Motor genérico de scraping HTML con Cheerio.
 *
 * Hereda de `BaseScraper`, por lo que ya incluye User-Agent de navegador,
 * timeout estricto, failover de espejos y manejo de errores. Su objetivo es
 * reutilizar la misma lógica de búsqueda en varias fuentes **propias o con
 * licencia**, configurando solo la ruta de búsqueda y los selectores.
 *
 * NO incluye selectores de sitios concretos: cada despliegue debe aportar los
 * suyos para fuentes sobre las que tenga derechos.
 *
 * Flujo:
 *   1. Construye consultas a partir de las variantes de título del resolvedor.
 *   2. Busca cada variante con failover de espejos (corta en cuanto hay resultados).
 *   3. Entra en cada resultado y extrae reproductores `<video>/<source>` y embeds.
 *   4. Devuelve streams de Stremio; ante cualquier fallo, `[]`.
 *
 * @example
 * import { HtmlScraper } from '../html.scraper.js';
 * import { getSource } from '../../config/sources.js';
 *
 * const scraper = new HtmlScraper(getSource('mi_fuente'), {
 *   searchPath: (query) => `buscar?q=${encodeURIComponent(query)}`,
 *   selectors: {
 *     result: '.resultado',
 *     resultLink: 'a.titulo',
 *     resultTitle: '.titulo',
 *     media: 'video source[src], iframe[src]'
 *   },
 *   contentTypes: ['movie']
 * });
 */

import * as cheerio from 'cheerio';

import { BaseScraper } from './base.scraper.js';
import { normalizeTitle } from '../utils/sanitizer.js';

/** Extensiones que Stremio puede reproducir de forma directa. */
const MEDIA_EXTENSION = /\.(mp4|webm|mkv|m3u8|mpd|mov|m4v)(?:[?#].*)?$/i;

export class HtmlScraper extends BaseScraper {
	/**
	 * @param {import('../config/sources.js').SourceConfig | string} source
	 * @param {Object} options
	 * @param {string | ((query: string) => string)} [options.searchPath='search?q={query}']
	 *   Ruta de búsqueda relativa al espejo; admite `{query}` o una función.
	 * @param {Object} [options.selectors]
	 * @param {string} [options.selectors.result] Contenedor de cada resultado.
	 * @param {string} [options.selectors.resultLink] Enlace dentro del resultado.
	 * @param {string} [options.selectors.resultTitle] Título dentro del resultado.
	 * @param {string} [options.selectors.media] Selector de reproductores.
	 * @param {number} [options.maxQueries=3] Variantes de título a probar.
	 * @param {number} [options.maxResults=10] Streams máximos devueltos.
	 * @param {number} [options.maxResultsPerQuery=5] Resultados visitados por búsqueda.
	 * @param {Object} [options.requestOptions] Opciones extra para Axios.
	 */
	constructor(source, options = {}) {
		super(source, options);

		if (!source) {
			throw new TypeError('HtmlScraper requiere una fuente configurada.');
		}

		this.searchPath = options.searchPath ?? 'search?q={query}';
		this.selectors = {
			result: '.result',
			resultLink: 'a',
			resultTitle: '.title',
			media: 'video[src], video source[src], iframe[src], a[href]',
			...(options.selectors ?? {})
		};

		this.maxQueries = toPositiveInt(options.maxQueries, 3);
		this.maxResults = toPositiveInt(options.maxResults, 10);
		this.maxResultsPerQuery = toPositiveInt(options.maxResultsPerQuery, 5);
		this.requestOptions = { responseType: 'text', ...(options.requestOptions ?? {}) };
	}

	/** Un scraper de listas siempre devuelve `[]`, nunca `null`. */
	emptyResult() {
		return [];
	}

	/**
	 * Busca por variantes de título y devuelve streams de Stremio.
	 *
	 * @param {Object} [context] Contexto del orquestador.
	 * @param {string[]} [context.searchTitles]
	 * @param {Object} [context.titles]
	 * @returns {Promise<object[]>}
	 */
	async scrape(context = {}) {
		if (!this.searchPath) {
			this.warn('no hay ruta de búsqueda configurada; se devuelve [].');
			return [];
		}

		try {
			const queries = this.buildQueries(context);
			if (queries.length === 0) {
				this.debug('sin títulos para buscar; se devuelve [].');
				return [];
			}

			const streams = [];

			for (const query of queries.slice(0, this.maxQueries)) {
				if (streams.length >= this.maxResults) break;

				try {
					const found = await this.search(query);
					if (found.length > 0) {
						streams.push(...found);
						this.info(`"${query}" -> ${found.length} stream(s).`);
					}
				} catch (error) {
					this.warn(`la búsqueda "${query}" falló: ${this.describeError(error)}.`);
				}
			}

			return dedupeStreams(streams).slice(0, this.maxResults);
		} catch (error) {
			this.warn(`error inesperado scrapeando: ${this.describeError(error)}. Se devuelve [].`);
			return [];
		}
	}

	/**
	 * Busca un título concreto y visita sus resultados.
	 *
	 * @param {string} query
	 * @returns {Promise<object[]>}
	 */
	async search(query) {
		const path = this.buildSearchPath(query);
		const html = await this.get(path, this.requestOptions);

		if (typeof html !== 'string' || html.trim() === '') return [];

		const $ = cheerio.load(html);
		const results = this.parseSearchResults($, query);

		if (results.length === 0) return [];

		const streams = [];

		for (const result of results.slice(0, this.maxResultsPerQuery)) {
			try {
				// `path` es relativo cuando el enlace pertenece a un espejo, para
				// que BaseScraper aplique el failover también en la ficha.
				const detail = await this.get(result.path, this.requestOptions);
				if (typeof detail !== 'string' || detail.trim() === '') continue;

				streams.push(...this.parseDetail(cheerio.load(detail), result));
			} catch (error) {
				this.warn(`no se pudo abrir ${result.url}: ${this.describeError(error)}.`);
			}
		}

		return streams;
	}

	/**
	 * @param {string} query
	 * @returns {string}
	 */
	buildSearchPath(query) {
		if (typeof this.searchPath === 'function') return this.searchPath(query);
		return String(this.searchPath).replace('{query}', encodeURIComponent(query));
	}

	/**
	 * Variantes de título deduplicadas, en el orden de la cascada del resolvedor.
	 *
	 * @param {Object} [context]
	 * @returns {string[]}
	 */
	buildQueries(context = {}) {
		const candidates = [
			...(Array.isArray(context.searchTitles) ? context.searchTitles : []),
			context.titles?.es,
			context.titles?.esLatam,
			context.titles?.original,
			context.titles?.english
		];

		return dedupeTitles(candidates);
	}

	/**
	 * Extrae los enlaces de los resultados de búsqueda.
	 *
	 * @param {cheerio.CheerioAPI} $
	 * @param {string} query
	 * @returns {Array<{ url: string, title: string }>}
	 */
	parseSearchResults($, query) {
		const results = [];
		const $items = $(this.selectors.result);

		$items.each((_, element) => {
			try {
				const $item = $(element);
				const $link = $item.find(this.selectors.resultLink).first();
				const href = $link.attr('href') ?? $item.attr('href');
				const url = this.toAbsoluteUrl(href);
				const path = this.toRequestPath(href);

				if (!url || !path) return;

				const title =
					cleanText($item.find(this.selectors.resultTitle).first().text()) ??
					cleanText($link.attr('title')) ??
					cleanText($link.text()) ??
					query;

				results.push({ url, path, title });
			} catch {
				// Un resultado malformado no invalida el resto.
			}
		});

		return results;
	}

	/**
	 * Extrae reproductores directos y embeds de una ficha.
	 *
	 * @param {cheerio.CheerioAPI} $
	 * @param {{ url: string, title: string }} result
	 * @returns {object[]}
	 */
	parseDetail($, result) {
		const streams = [];
		const seen = new Set();
		const add = (stream) => {
			const key = stream.url ?? stream.externalUrl;
			if (!key || seen.has(key)) return;
			seen.add(key);
			streams.push(stream);
		};

		$(this.selectors.media).each((_, element) => {
			try {
				const $element = $(element);
				const tag = String(element.tagName ?? element.name ?? '').toLowerCase();
				const raw = $element.attr('src') ?? $element.attr('href') ?? $element.attr('data-src');
				const url = this.toAbsoluteUrl(raw);

				if (!url) return;

				const title = result.title || this.name;

				if (MEDIA_EXTENSION.test(url) || tag === 'source' || tag === 'video') {
					add({ name: this.name, title, url });
					return;
				}

				if (tag === 'iframe') {
					add({ name: `${this.name} (embed)`, title, externalUrl: url });
				}
			} catch {
				// Ignora reproductores malformados.
			}
		});

		// Datos estructurados (JSON-LD) con contentUrl / embedUrl.
		$('script[type="application/ld+json"]').each((_, element) => {
			try {
				const raw = $(element).text();
				if (!raw) return;

				const parsed = JSON.parse(raw);
				const entries = Array.isArray(parsed) ? parsed : [parsed];

				for (const entry of entries) {
					for (const key of ['contentUrl', 'embedUrl']) {
						const url = this.toAbsoluteUrl(entry?.[key]);
						if (!url) continue;

						if (key === 'contentUrl' || MEDIA_EXTENSION.test(url)) {
							add({ name: this.name, title: result.title || this.name, url });
						} else {
							add({
								name: `${this.name} (embed)`,
								title: result.title || this.name,
								externalUrl: url
							});
						}
					}
				}
			} catch {
				// JSON-LD inválido: se ignora.
			}
		});

		return streams;
	}

	/**
	 * Base para resolver enlaces: el espejo que acaba de responder, o el principal.
	 *
	 * @returns {string | null}
	 */
	currentBase() {
		const base = this.lastMirror ?? this.source.baseUrl ?? this.mirrors[0];
		if (!base) return null;
		return base.endsWith('/') ? base : `${base}/`;
	}

	/**
	 * Convierte un href relativo en absoluto y descarta esquemas peligrosos.
	 *
	 * @param {string | undefined} value
	 * @returns {string | null}
	 */
	toAbsoluteUrl(value) {
		if (typeof value !== 'string') return null;

		const href = value.trim();
		if (!href || href.startsWith('#') || /^(javascript|data|blob|magnet):/i.test(href)) {
			return null;
		}

		try {
			const base = this.currentBase();
			if (!base) return null;

			const url = new URL(href, base);
			if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

			return url.toString();
		} catch {
			return null;
		}
	}

	/**
	 * Ruta a usar al pedir una ficha: relativa si el enlace apunta a uno de los
	 * espejos (para conservar el failover), absoluta si es un dominio externo.
	 *
	 * @param {string | undefined} value
	 * @returns {string | null}
	 */
	toRequestPath(value) {
		if (typeof value !== 'string') return null;

		const href = value.trim();
		if (!href || href.startsWith('#') || /^(javascript|data|blob|magnet|mailto):/i.test(href)) {
			return null;
		}

		try {
			const base = this.currentBase();
			if (!base) return null;

			const absolute = new URL(href, base);
			if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') return null;

			const belongsToMirror = this.mirrors.some((mirror) => {
				try {
					return new URL(mirror).host === absolute.host;
				} catch {
					return false;
				}
			});

			return belongsToMirror ? `${absolute.pathname}${absolute.search}` : absolute.toString();
		} catch {
			return null;
		}
	}
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function cleanText(value) {
	if (typeof value !== 'string') return null;
	const text = value.replace(/\s+/g, ' ').trim();
	return text || null;
}

/**
 * @param {Array<unknown>} candidates
 * @returns {string[]}
 */
function dedupeTitles(candidates) {
	const seen = new Set();
	const titles = [];

	for (const candidate of candidates) {
		const title = cleanText(candidate);
		if (!title) continue;

		const key = normalizeTitle(title) || title.toLowerCase();
		if (seen.has(key)) continue;

		seen.add(key);
		titles.push(title);
	}

	return titles;
}

/**
 * @param {object[]} streams
 * @returns {object[]}
 */
function dedupeStreams(streams) {
	const seen = new Set();
	const unique = [];

	for (const stream of streams) {
		const key = stream?.url ?? stream?.externalUrl;
		if (!key || seen.has(key)) continue;
		seen.add(key);
		unique.push(stream);
	}

	return unique;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function toPositiveInt(value, fallback) {
	const number = Number(value);
	return Number.isInteger(number) && number > 0 ? number : fallback;
}

export default HtmlScraper;
