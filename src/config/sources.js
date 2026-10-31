/**
 * Configuración central de fuentes y espejos del addon.
 *
 * Cada fuente declara un `baseUrl` (dominio principal) y una lista ordenada de
 * `mirrors` (espejos de respaldo). `BaseScraper` usa `resolveMirrors()` para
 * obtener la lista efectiva y aplica failover en ese mismo orden.
 *
 * Una fuente se puede sobreescribir en tiempo de despliegue (sin tocar código)
 * mediante variables de entorno:
 *
 *   ADDON_MIRRORS_JIKAN="https://api.jikan.moe/v4,https://mi-espejo.tld/v4"
 *   ADDON_DISABLED_SOURCES="example_streams,anilist"
 *
 * Nota: los dominios con TLD `.example` son marcadores de posición (RFC 2606).
 * Reemplázalos por dominios reales antes de habilitar la fuente.
 *
 * @typedef {'metadata' | 'catalog' | 'stream'} SourceCategory
 *
 * @typedef {Object} SourceConfig
 * @property {string} id                    Identificador único (minúsculas, `a-z0-9_-`).
 * @property {string} name                  Nombre legible para logs.
 * @property {SourceCategory} category       Tipo de contenido que provee.
 * @property {string} [scraper]             Clave del scraper que la implementa.
 * @property {boolean} [enabled]            Si es `false` nunca se instancia.
 * @property {number} [priority]            Menor = se ejecuta antes.
 * @property {string} [baseUrl]             Dominio principal (sin barra final).
 * @property {string[]} [mirrors]           Espejos de respaldo, en orden.
 * @property {Record<string, string>} [headers] Cabeceras extra por fuente.
 * @property {string} [referer]             Referer fijo; admite `{mirror}`.
 * @property {number} [timeout]             Timeout por petición (máx. 4000 ms).
 * @property {string} [notes]               Documentación libre de la fuente.
 */

/** Timeout estricto por petición (milisegundos). */
export const DEFAULT_TIMEOUT_MS = 4000;

/**
 * Techo duro de timeout. Ninguna fuente puede pedir más de 4 s: si lo intenta,
 * se recorta silenciosamente al máximo permitido.
 */
export const MAX_TIMEOUT_MS = 4000;

/** Tiempo que un espejo queda en cuarentena tras fallar repetidamente. */
export const MIRROR_COOLDOWN_MS = 60_000;

/** Fallos consecutivos antes de poner un espejo en cuarentena. */
export const MIRROR_FAILURE_THRESHOLD = 2;

/**
 * Fuentes conocidas por el addon.
 *
 * Las dos primeras apuntan a APIs públicas reales y legítimas de metadatos de
 * anime (Jikan y AniList). `example_streams` es una plantilla deshabilitada que
 * muestra cómo declarar un proveedor con varios espejos.
 *
 * @type {Record<string, SourceConfig>}
 */
export const SOURCES = {
	jikan: {
		id: 'jikan',
		name: 'Jikan (MyAnimeList)',
		category: 'metadata',
		scraper: 'jikan',
		enabled: true,
		priority: 10,
		baseUrl: 'https://api.jikan.moe/v4',
		mirrors: ['https://api.jikan.moe/v4'],
		headers: {
			Accept: 'application/json'
		},
		notes: 'API REST pública. Límite aproximado: 3 req/s y 60 req/min.'
	},

	anilist: {
		id: 'anilist',
		name: 'AniList GraphQL',
		category: 'metadata',
		scraper: 'anilist',
		enabled: true,
		priority: 20,
		baseUrl: 'https://graphql.anilist.co',
		mirrors: ['https://graphql.anilist.co'],
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/json'
		},
		notes: 'Endpoint GraphQL (requiere POST). Sirve como respaldo de metadatos.'
	},

	example_streams: {
		id: 'example_streams',
		name: 'Proveedor de ejemplo (plantilla)',
		category: 'stream',
		scraper: 'example-streams',
		enabled: false,
		priority: 100,
		baseUrl: 'https://primary.provider.example',
		// El orden importa: el primer espejo se intenta siempre primero.
		mirrors: [
			'https://primary.provider.example',
			'https://mirror-1.provider.example',
			'https://mirror-2.provider.example'
		],
		headers: {
			Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
		},
		referer: '{mirror}/',
		timeout: DEFAULT_TIMEOUT_MS,
		notes:
			'Plantilla deshabilitada. Sustituye los dominios `.example` por los reales y activa la fuente.'
	}
};

/** Categorías válidas de una fuente. */
export const SOURCE_CATEGORIES = Object.freeze(['metadata', 'catalog', 'stream']);

/**
 * Normaliza un identificador de fuente (`My Source!` -> `my_source`).
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeSourceId(value) {
	return String(value ?? '')
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '_')
		.replace(/^_+|_+$/g, '');
}

/**
 * Valida y normaliza una URL de espejo. Acepta valores sin esquema
 * (`midominio.tld` -> `https://midominio.tld`) y descarta entradas inválidas.
 *
 * @param {unknown} raw
 * @returns {string | null} URL absoluta sin barra final, o `null`.
 */
export function normalizeUrl(raw) {
	if (typeof raw !== 'string') return null;

	let value = raw.trim();
	if (!value || value.includes(' ')) return null;
	if (!/^https?:\/\//i.test(value)) value = `https://${value}`;

	try {
		const url = new URL(value);
		if (!url.hostname) return null;
		url.hash = '';
		return url.toString().replace(/\/$/, '');
	} catch {
		return null;
	}
}

/**
 * Devuelve una fuente normalizada a partir de su id (o de un objeto fuente).
 *
 * @param {string | Partial<SourceConfig>} sourceOrId
 * @returns {SourceConfig | null}
 */
export function getSource(sourceOrId) {
	if (!sourceOrId) return null;

	if (typeof sourceOrId === 'string') {
		const key = normalizeSourceId(sourceOrId);
		const found =
			SOURCES[key] ??
			Object.values(SOURCES).find((source) => normalizeSourceId(source.id) === key);
		return found ? normalizeSource(found) : null;
	}

	return normalizeSource(sourceOrId);
}

/**
 * Normaliza una definición de fuente, rellenando valores por defecto y
 * unificando `baseUrl` + `mirrors` en una sola lista ordenada y sin duplicados.
 *
 * @param {Partial<SourceConfig>} source
 * @param {string} [fallbackId]
 * @returns {SourceConfig & { mirrors: string[], timeout: number, enabled: boolean, priority: number }}
 */
export function normalizeSource(source = {}, fallbackId = 'unnamed') {
	const raw = source && typeof source === 'object' ? source : {};
	const id = normalizeSourceId(raw.id) || normalizeSourceId(fallbackId) || 'unnamed';

	const baseUrl = normalizeUrl(raw.baseUrl);
	const candidates = [
		baseUrl,
		...(Array.isArray(raw.mirrors) ? raw.mirrors.map((mirror) => normalizeUrl(mirror)) : [])
	];

	const mirrors = dedupe(candidates.filter(Boolean));

	const timeout = clampTimeout(raw.timeout);
	const category = SOURCE_CATEGORIES.includes(raw.category) ? raw.category : 'stream';

	return {
		...raw,
		id,
		name: String(raw.name ?? id).trim() || id,
		category,
		enabled: raw.enabled !== false,
		priority: Number.isFinite(Number(raw.priority)) ? Number(raw.priority) : 100,
		baseUrl: baseUrl ?? mirrors[0] ?? null,
		mirrors,
		headers: raw.headers && typeof raw.headers === 'object' ? { ...raw.headers } : {},
		timeout
	};
}

/**
 * Lista las fuentes configuradas y normalizadas.
 *
 * @param {{ category?: SourceCategory, enabledOnly?: boolean }} [options]
 * @returns {Array<ReturnType<typeof normalizeSource>>}
 */
export function listSources({ category, enabledOnly = true } = {}) {
	return Object.values(SOURCES)
		.map((source) => normalizeSource(source))
		.filter((source) => (category ? source.category === category : true))
		.filter((source) => (enabledOnly ? source.enabled : true))
		.sort((a, b) => a.priority - b.priority);
}

/**
 * Indica si una fuente está habilitada, respetando `enabled` y la variable
 * de entorno `ADDON_DISABLED_SOURCES`.
 *
 * @param {Partial<SourceConfig> | string} sourceOrId
 * @returns {boolean}
 */
export function isSourceEnabled(sourceOrId) {
	const source = getSource(sourceOrId);
	if (!source || source.enabled === false) return false;

	const disabled = readList(process.env.ADDON_DISABLED_SOURCES).map(normalizeSourceId);
	return !disabled.includes(source.id);
}

/**
 * Resuelve la lista efectiva de espejos de una fuente.
 *
 * Orden de precedencia:
 *  1. `ADDON_MIRRORS_<ID>` (lista separada por comas) si está definida.
 *  2. `baseUrl` seguido de `mirrors`.
 *
 * @param {Partial<SourceConfig> | string} sourceOrId
 * @returns {string[]} URLs absolutas, en orden de intento.
 */
export function resolveMirrors(sourceOrId) {
	const source = getSource(sourceOrId);
	if (!source) return [];

	const envMirrors = readList(process.env[`ADDON_MIRRORS_${source.id.toUpperCase()}`])
		.map(normalizeUrl)
		.filter(Boolean);

	if (envMirrors.length > 0) return dedupe(envMirrors);

	return dedupe([source.baseUrl, ...(source.mirrors ?? [])].filter(Boolean));
}

/**
 * Recorta un timeout al rango permitido por el addon (mín. 500 ms, máx. 4000 ms).
 *
 * @param {unknown} value
 * @returns {number}
 */
export function clampTimeout(value) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
	return Math.min(Math.max(Math.round(parsed), 500), MAX_TIMEOUT_MS);
}

/**
 * @param {string[]} values
 * @returns {string[]}
 */
function dedupe(values) {
	return [...new Set(values)];
}

/**
 * Convierte una variable de entorno tipo lista en un array limpio.
 *
 * @param {string | undefined} value
 * @returns {string[]}
 */
function readList(value) {
	if (!value) return [];
	return String(value)
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean);
}

export default SOURCES;
