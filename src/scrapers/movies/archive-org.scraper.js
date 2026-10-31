/**
 * Scraper de ejemplo sobre una fuente legal: Internet Archive.
 *
 * Consulta la colección pública `feature_films` (películas de dominio público
 * o con licencia de la biblioteca) mediante la API oficial, y devuelve
 * enlaces directos a los archivos de vídeo de cada ítem.
 *
 * Sirve como referencia de implementación real de `BaseScraper`:
 *   - usa la lista de espejos de `src/config/sources.js`;
 *   - aplica timeout y User-Agent de la clase base;
 *   - aísla los errores y devuelve `[]` si algo falla.
 *
 * No se scrapea HTML ni se extraen enlaces de reproductores de terceros.
 *
 * @example
 * import { ArchiveOrgScraper } from './archive-org.scraper.js';
 * const scraper = new ArchiveOrgScraper();
 * const streams = await scraper.safeScrape({ searchTitles: ['Metropolis'] });
 */

import { BaseScraper } from '../base.scraper.js';
import { getSource } from '../../config/sources.js';

/** Contenedores de vídeo que Stremio reproduce directamente. */
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.ogv', '.mkv', '.m4v', '.mov']);

/** Colección de películas de la biblioteca (dominio público). */
const DEFAULT_COLLECTION = 'feature_films';

export class ArchiveOrgScraper extends BaseScraper {
	/**
	 * @param {import('../../config/sources.js').SourceConfig | string} [source]
	 * @param {Object} [options]
	 * @param {string} [options.collection='feature_films']
	 * @param {number} [options.maxQueries=2]
	 * @param {number} [options.maxResults=6]
	 */
	constructor(source = getSource('archive_org'), options = {}) {
		super(source, options);

		this.collection = options.collection ?? DEFAULT_COLLECTION;
		this.maxQueries = toPositiveInt(options.maxQueries, 2);
		this.maxResults = toPositiveInt(options.maxResults, 6);
	}

	/** Lista vacía si no hay resultados o falla la fuente. */
	emptyResult() {
		return [];
	}

	/**
	 * @param {Object} [context]
	 * @param {string[]} [context.searchTitles]
	 * @returns {Promise<object[]>}
	 */
	async scrape(context = {}) {
		try {
			const queries = dedupeTitles(context.searchTitles).slice(0, this.maxQueries);
			if (queries.length === 0) {
				this.debug('sin títulos para consultar; se devuelve [].');
				return [];
			}

			const streams = [];

			for (const title of queries) {
				if (streams.length >= this.maxResults) break;

				try {
					const found = await this.searchTitle(title);
					streams.push(...found);
				} catch (error) {
					this.warn(`la búsqueda "${title}" falló: ${this.describeError(error)}.`);
				}
			}

			return dedupeByUrl(streams).slice(0, this.maxResults);
		} catch (error) {
			this.warn(`error inesperado consultando Archive.org: ${this.describeError(error)}.`);
			return [];
		}
	}

	/**
	 * Busca en la API de Archive.org y resuelve los archivos de cada ítem.
	 *
	 * @param {string} title
	 * @returns {Promise<object[]>}
	 */
	async searchTitle(title) {
		const data = await this.get('advancedsearch.php', {
			params: {
				q: `title:("${escapeQuery(title)}") AND mediatype:movies AND collection:(${this.collection})`,
				'fl[]': ['identifier', 'title', 'year'],
				rows: 4,
				page: 1,
				output: 'json'
			}
		});

		const docs = data?.response?.docs;
		if (!Array.isArray(docs) || docs.length === 0) return [];

		const streams = [];

		for (const doc of docs) {
			if (!doc?.identifier) continue;

			try {
				const found = await this.streamsForItem(doc);
				streams.push(...found);
			} catch (error) {
				this.warn(`no se pudo leer el ítem ${doc.identifier}: ${this.describeError(error)}.`);
			}

			if (streams.length >= this.maxResults) break;
		}

		return streams;
	}

	/**
	 * Obtiene los archivos de vídeo públicos de un ítem.
	 *
	 * @param {{ identifier: string, title?: string }} doc
	 * @returns {Promise<object[]>}
	 */
	async streamsForItem(doc) {
		const metadata = await this.get(`metadata/${encodeURIComponent(doc.identifier)}`);
		if (!metadata) return [];

		// Respeta ítems restringidos explícitamente.
		if (String(metadata?.metadata?.['access-restricted-item'] ?? '').toLowerCase() === 'true') {
			return [];
		}

		const files = Array.isArray(metadata.files) ? metadata.files : [];
		const rawTitle = metadata?.metadata?.title ?? doc.title ?? doc.identifier;
		const itemTitle = Array.isArray(rawTitle) ? rawTitle[0] : String(rawTitle);

		const streams = [];

		for (const file of files) {
			if (!file || typeof file.name !== 'string' || file.private === true) continue;

			const extension = extensionOf(file.name);
			if (!VIDEO_EXTENSIONS.has(extension)) continue;

			const url = this.downloadUrl(doc.identifier, file.name);
			if (!url) continue;

			streams.push({
				name: this.name,
				title: normalizeSpaces(`${itemTitle} · ${extension.slice(1).toUpperCase()}`),
				url
			});

			if (streams.length >= 2) break; // Un par de archivos por ítem es suficiente.
		}

		return streams;
	}

	/**
	 * Construye la URL de descarga a partir del espejo configurado.
	 *
	 * @param {string} identifier
	 * @param {string} fileName
	 * @returns {string | null}
	 */
	downloadUrl(identifier, fileName) {
		try {
			// Descarga desde el espejo que sirvió los metadatos, si se conoce.
			const base = this.lastMirror ?? this.mirrors[0] ?? this.source.baseUrl;
			if (!base) return null;

			const encodedPath = fileName.split('/').map(encodeURIComponent).join('/');
			return new URL(
				`download/${encodeURIComponent(identifier)}/${encodedPath}`,
				base.endsWith('/') ? base : `${base}/`
			).toString();
		} catch {
			return null;
		}
	}
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function escapeQuery(value) {
	return String(value ?? '')
		.replace(/["\\]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * @param {string} fileName
 * @returns {string}
 */
function extensionOf(fileName) {
	const dot = fileName.lastIndexOf('.');
	return dot >= 0 ? fileName.slice(dot).toLowerCase() : '';
}

/**
 * @param {string} value
 * @returns {string}
 */
function normalizeSpaces(value) {
	return value.replace(/\s+/g, ' ').trim();
}

/**
 * @param {Array<unknown>} values
 * @returns {string[]}
 */
function dedupeTitles(values) {
	const seen = new Set();
	const titles = [];

	for (const value of values ?? []) {
		const title = normalizeSpaces(String(value ?? ''));
		if (!title) continue;
		const key = title.toLowerCase();
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
function dedupeByUrl(streams) {
	const seen = new Set();
	const unique = [];

	for (const stream of streams) {
		if (!stream?.url || seen.has(stream.url)) continue;
		seen.add(stream.url);
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

export default ArchiveOrgScraper;
